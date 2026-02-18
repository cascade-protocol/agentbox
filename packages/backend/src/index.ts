import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { env } from "./lib/env";
import { healthRoutes } from "./routes/health";
import { instanceRoutes } from "./routes/instances";

const app = new Hono();

app.route("/", healthRoutes);
app.route("/api", instanceRoutes);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`AgentBox API running at http://localhost:${info.port}`);
});

export default app;
