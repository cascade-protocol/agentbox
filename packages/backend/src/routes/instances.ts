import { Hono } from "hono";

export const instanceRoutes = new Hono();

instanceRoutes.get("/instances", (c) => {
  return c.json({ instances: [] });
});
