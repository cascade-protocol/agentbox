import { randomUUID } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { db } from "../db/connection";
import { instances } from "../db/schema";
import * as cloudflare from "../lib/cloudflare";
import { env } from "../lib/env";
import * as hetzner from "../lib/hetzner";
import {
  callbackInputSchema,
  createInstanceInputSchema,
  updateInstanceInputSchema,
} from "../lib/schemas";

export const instanceRoutes = new Hono();

const auth = createMiddleware(async (c, next) => {
  if (c.req.header("Authorization") !== `Bearer ${env.OPERATOR_TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

function toInstanceResponse(row: typeof instances.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    status: row.status,
    ip: row.ip,
    walletAddress: row.walletAddress,
    gatewayToken: row.gatewayToken,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function buildUserData(opts: { callbackUrl: string; secret: string; hostname: string }): string {
  // cloud-init user_data that writes /etc/agentbox/callback.env and runs
  // the golden image init script. SERVER_ID comes from Hetzner metadata
  // since it's not known at user_data creation time.
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    "mkdir -p /etc/agentbox",
    "SERVER_ID=$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)",
    "",
    "cat > /etc/agentbox/callback.env << 'ENVEOF'",
    `CALLBACK_URL="${opts.callbackUrl}"`,
    `CALLBACK_SECRET="${opts.secret}"`,
    `INSTANCE_HOSTNAME="${opts.hostname}"`,
    "ENVEOF",
    "",
    "# SERVER_ID must be unquoted (numeric) so append outside heredoc",
    'echo "SERVER_ID=$SERVER_ID" >> /etc/agentbox/callback.env',
    "",
    "/usr/local/bin/agentbox-init.sh",
  ].join("\n");
}

// POST /api/instances - Create instance
instanceRoutes.post("/instances", auth, async (c) => {
  const body = await c.req.json();
  const input = createInstanceInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  if (!env.HETZNER_API_TOKEN || !env.HETZNER_SNAPSHOT_ID) {
    return c.json({ error: "Hetzner is not configured" }, 503);
  }

  const shortId = randomUUID().slice(0, 8);
  const sanitizedUserId = input.data.userId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const name = `agentbox-${sanitizedUserId}-${shortId}`;

  const callbackUrl = `${env.API_BASE_URL}/api/instances/callback`;
  const hostname = `${name}.${env.INSTANCE_BASE_DOMAIN}`;
  const userData = buildUserData({
    callbackUrl,
    secret: env.CALLBACK_SECRET,
    hostname,
  });

  let result: Awaited<ReturnType<typeof hetzner.createServer>>;
  try {
    result = await hetzner.createServer(name, userData);
  } catch (err) {
    console.error("Hetzner create failed:", err);
    return c.json({ error: "Failed to provision server" }, 502);
  }

  // Create DNS record: {name}.agentbox.cascade.fyi -> VM IP
  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    try {
      await cloudflare.createDnsRecord(hostname, result.server.public_net.ipv4.ip);
    } catch (err) {
      console.error("Cloudflare DNS create failed:", err);
    }
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const [row] = await db
    .insert(instances)
    .values({
      id: result.server.id,
      name,
      userId: input.data.userId,
      status: "provisioning",
      ip: result.server.public_net.ipv4.ip,
      gatewayToken: "pending", // real token set by VM callback
      rootPassword: result.root_password,
      expiresAt,
    })
    .returning();

  return c.json(toInstanceResponse(row), 201);
});

// GET /api/instances - List all instances
instanceRoutes.get("/instances", auth, async (c) => {
  const rows = await db.select().from(instances);
  return c.json({ instances: rows.map(toInstanceResponse) });
});

// GET /api/instances/expiring - List instances expiring within N days
instanceRoutes.get("/instances/expiring", auth, async (c) => {
  const days = Number(c.req.query("days") ?? 3);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const rows = await db.select().from(instances).where(lte(instances.expiresAt, cutoff));
  return c.json({ instances: rows.map(toInstanceResponse) });
});

// POST /api/instances/callback - VM cloud-init callback (validates secret, no bearer auth)
instanceRoutes.post("/instances/callback", async (c) => {
  const body = await c.req.json();
  const input = callbackInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  if (input.data.secret !== env.CALLBACK_SECRET) {
    return c.json({ error: "Invalid secret" }, 403);
  }

  const [row] = await db
    .update(instances)
    .set({
      walletAddress: input.data.walletAddress,
      gatewayToken: input.data.gatewayToken,
      status: "running",
    })
    .where(eq(instances.id, input.data.serverId))
    .returning();

  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  return c.json({ ok: true });
});

// PATCH /api/instances/:id - Update instance name
instanceRoutes.patch("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const input = updateInstanceInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const [row] = await db
    .update(instances)
    .set({ name: input.data.name })
    .where(eq(instances.id, id))
    .returning();

  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  return c.json(toInstanceResponse(row));
});

// GET /api/instances/:id - Get instance details
instanceRoutes.get("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }
  return c.json(toInstanceResponse(row));
});

// DELETE /api/instances/:id - Delete instance (tears down VM)
instanceRoutes.delete("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  await db.update(instances).set({ status: "deleting" }).where(eq(instances.id, id));

  try {
    await hetzner.deleteServer(id);
  } catch (err) {
    console.error(`Failed to delete Hetzner server ${id}:`, err);
  }

  // Clean up DNS record
  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    try {
      const hostname = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;
      await cloudflare.deleteDnsRecord(hostname);
    } catch (err) {
      console.error(`Failed to delete DNS record for ${row.name}:`, err);
    }
  }

  await db.delete(instances).where(eq(instances.id, id));
  return c.json({ ok: true });
});

// POST /api/instances/:id/restart - Restart VM
instanceRoutes.post("/instances/:id/restart", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  try {
    await hetzner.restartServer(id);
  } catch (err) {
    console.error(`Failed to restart Hetzner server ${id}:`, err);
    return c.json({ error: "Failed to restart server" }, 502);
  }

  return c.json({ ok: true });
});

// POST /api/instances/:id/extend - Extend expiry 30 days
instanceRoutes.post("/instances/:id/extend", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  const newExpiry = new Date(row.expiresAt);
  newExpiry.setDate(newExpiry.getDate() + 30);

  const [updated] = await db
    .update(instances)
    .set({ expiresAt: newExpiry })
    .where(eq(instances.id, id))
    .returning();

  return c.json(toInstanceResponse(updated));
});

// GET /api/instances/:id/access - Access credentials
instanceRoutes.get("/instances/:id/access", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  const instanceHost = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;
  return c.json({
    ...toInstanceResponse(row),
    ssh: `ssh root@${row.ip}`,
    chatUrl: `https://${instanceHost}/overview?token=${row.gatewayToken}`,
    terminalUrl: `https://${instanceHost}/terminal/`,
    rootPassword: row.rootPassword,
  });
});

// GET /api/instances/:id/health - Probe instance health
instanceRoutes.get("/instances/:id/health", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  let hetznerStatus = "unknown";
  try {
    const server = await hetzner.getServer(id);
    hetznerStatus = server.server.status;
  } catch {
    // Hetzner API unavailable
  }

  const healthy = hetznerStatus === "running" && row.status === "running";

  return c.json({
    healthy,
    hetznerStatus,
    instanceStatus: row.status,
    callbackReceived: row.walletAddress !== null,
  });
});
