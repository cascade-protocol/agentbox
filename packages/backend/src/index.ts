import "dotenv/config";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { eq, lte } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

import { db } from "./db/connection";
import { instances } from "./db/schema";
import * as cloudflare from "./lib/cloudflare";
import { env } from "./lib/env";
import * as hetzner from "./lib/hetzner";
import { healthRoutes } from "./routes/health";
import { instanceRoutes } from "./routes/instances";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "PAYMENT-SIGNATURE",
      "Access-Control-Expose-Headers",
    ],
    exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
  }),
);
app.use("/*", secureHeaders());

// x402 payment gate on instance creation
const facilitator = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });
const resourceServer = new x402ResourceServer([facilitator]).register(
  SOLANA_MAINNET,
  new ExactSvmScheme(),
);

const x402Payment = paymentMiddleware(
  {
    "POST /instances": {
      accepts: [
        {
          scheme: "exact",
          network: SOLANA_MAINNET,
          price: "$1",
          payTo: env.PAY_TO_ADDRESS,
        },
      ],
      description: "Provision AgentBox VM (30 days)",
      mimeType: "application/json",
    },
  },
  resourceServer,
);

// Skip x402 payment for operator token
app.use("/instances", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth === `Bearer ${env.OPERATOR_TOKEN}`) {
    return next();
  }
  return x402Payment(c, next);
});

app.route("/", healthRoutes);
app.route("/", instanceRoutes);

// Expiry cleanup - delete expired instances every hour
setInterval(
  async () => {
    try {
      const expired = await db.select().from(instances).where(lte(instances.expiresAt, new Date()));

      for (const row of expired) {
        console.log(`Cleaning up expired instance ${row.id} (${row.name})`);
        await db.update(instances).set({ status: "deleting" }).where(eq(instances.id, row.id));

        try {
          await hetzner.deleteServer(row.id);
        } catch (err) {
          console.error(`Failed to delete Hetzner server ${row.id}:`, err);
        }

        if (env.CF_API_TOKEN) {
          try {
            await cloudflare.deleteDnsRecord(`${row.name}.${env.INSTANCE_BASE_DOMAIN}`);
          } catch (err) {
            console.error(`Failed to delete DNS for ${row.name}:`, err);
          }
        }

        await db.delete(instances).where(eq(instances.id, row.id));
      }

      if (expired.length > 0) {
        console.log(`Cleaned up ${expired.length} expired instance(s)`);
      }
    } catch (err) {
      console.error("Expiry cleanup failed:", err);
    }
  },
  60 * 60 * 1000,
);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`AgentBox API running at http://localhost:${info.port}`);
});

export default app;
