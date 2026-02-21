import "dotenv/config";
import type http from "node:http";
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
import { logger } from "./logger";
import { healthRoutes } from "./routes/health";
import { instanceRoutes } from "./routes/instances";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const app = new Hono();

function getProvisioningPreflightError(): string | null {
  if (!env.HETZNER_API_TOKEN || !env.HETZNER_SNAPSHOT_ID) {
    return "Hetzner is not configured";
  }

  try {
    const url = new URL(env.API_BASE_URL);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
      return "API_BASE_URL must be publicly reachable for VM callbacks (use ngrok/cloudflared in local dev)";
    }
  } catch {
    return "API_BASE_URL is invalid";
  }

  return null;
}

// Request logging - before all other middleware
app.use("/*", async (c, next) => {
  const { method } = c.req;
  const path = c.req.path;
  if (path === "/health") return next();

  const start = Date.now();
  logger.info(`--> ${method} ${path}`);
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  logger[level](`<-- ${method} ${path} ${status} ${ms}ms`);
});

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
const resourceServer = new x402ResourceServer([facilitator])
  .register(SOLANA_MAINNET, new ExactSvmScheme())
  .onAfterSettle(async (ctx) => {
    logger.info(`Payment settled via ${env.FACILITATOR_URL}`, {
      transaction: ctx.result.transaction,
    });
  });

const x402Payment = paymentMiddleware(
  {
    "POST /instances": {
      accepts: [
        {
          scheme: "exact",
          network: SOLANA_MAINNET,
          price: "$5",
          payTo: env.PAY_TO_ADDRESS,
        },
      ],
      description: "Provision AgentBox VM (14 days)",
      mimeType: "application/json",
    },
  },
  resourceServer,
);

// Skip x402 payment for operator token
app.use("/instances", async (c, next) => {
  if (c.req.method === "POST" && c.req.path === "/instances") {
    const preflightError = getProvisioningPreflightError();
    if (preflightError) {
      return c.json({ error: preflightError }, 503);
    }
  }

  const auth = c.req.header("Authorization");
  if (auth === `Bearer ${env.OPERATOR_TOKEN}`) {
    return next();
  }
  return x402Payment(c, next);
});

app.onError((err, c) => {
  logger.error(`Unhandled API error: ${String(err)}`);
  const isProd = process.env.NODE_ENV === "production";
  return c.json({ error: isProd ? "Internal Server Error" : String(err) }, 500);
});

app.route("/", healthRoutes);
app.route("/", instanceRoutes);

// Expiry cleanup - delete expired instances every hour
const cleanupInterval = setInterval(
  async () => {
    try {
      const expired = await db.select().from(instances).where(lte(instances.expiresAt, new Date()));

      for (const row of expired) {
        logger.info(`Cleaning up expired instance ${row.id} (${row.name})`);
        await db.update(instances).set({ status: "deleting" }).where(eq(instances.id, row.id));

        try {
          await hetzner.deleteServer(row.id);
        } catch (err) {
          logger.error(`Failed to delete Hetzner server ${row.id}: ${String(err)}`);
        }

        if (env.CF_API_TOKEN) {
          try {
            await cloudflare.deleteDnsRecord(`${row.name}.${env.INSTANCE_BASE_DOMAIN}`);
          } catch (err) {
            logger.error(`Failed to delete DNS for ${row.name}: ${String(err)}`);
          }
        }

        await db.delete(instances).where(eq(instances.id, row.id));
      }

      if (expired.length > 0) {
        logger.info(`Cleaned up ${expired.length} expired instance(s)`);
      }
    } catch (err) {
      logger.error(`Expiry cleanup failed: ${String(err)}`);
    }
  },
  60 * 60 * 1000,
);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(`AgentBox API running at http://localhost:${info.port}`);
}) as http.Server;

// Graceful shutdown - close server so tsx watch can restart without EADDRINUSE
function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  clearInterval(cleanupInterval);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
