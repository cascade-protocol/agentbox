import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { healthRoutes } from "./routes/health";
import { instanceRoutes } from "./routes/instances";

const app = new Hono();

app.route("/", healthRoutes);
app.route("/api", instanceRoutes);

const port = Number(process.env.PORT) || 3000;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`AgentBox API running at http://localhost:${info.port}`);
});

export default app;
