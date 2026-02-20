import { randomUUID, webcrypto } from "node:crypto";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import { eq, lte } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { jwtVerify, SignJWT } from "jose";
import { db } from "../db/connection";
import { instances } from "../db/schema";
import * as cloudflare from "../lib/cloudflare";
import { env } from "../lib/env";
import * as hetzner from "../lib/hetzner";
import { authInputSchema, callbackInputSchema, updateInstanceInputSchema } from "../lib/schemas";

// @noble/ed25519 v2 requires SHA-512 configuration
if (!ed.etc.sha512Async) {
  ed.etc.sha512Async = async (...msgs: Uint8Array[]) => {
    const merged = ed.etc.concatBytes(...msgs);
    return new Uint8Array(await webcrypto.subtle.digest("SHA-512", merged));
  };
}

type AppEnv = { Variables: { walletAddress: string } };

export const instanceRoutes = new Hono<AppEnv>();

const auth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = header.slice(7);

  // Operator token (dev/admin bypass)
  if (token === env.OPERATOR_TOKEN) {
    c.set("walletAddress", "operator");
    return next();
  }

  // JWT wallet auth
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.sub !== "string") {
      return c.json({ error: "Invalid token" }, 401);
    }
    c.set("walletAddress", payload.sub);
    return next();
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

function isAdmin(wallet: string): boolean {
  return wallet === "operator" || wallet === env.PAY_TO_ADDRESS;
}

function isOwner(row: typeof instances.$inferSelect, wallet: string): boolean {
  return isAdmin(wallet) || row.userId === wallet;
}

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

// POST /api/instances/auth - Wallet sign-in (no bearer auth)
instanceRoutes.post("/instances/auth", async (c) => {
  const body = await c.req.json();
  const input = authInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const age = Date.now() - input.data.timestamp;
  if (age > 5 * 60 * 1000 || age < -60_000) {
    return c.json({ error: "Timestamp expired" }, 400);
  }

  const message = `Sign in to AgentBox\nTimestamp: ${input.data.timestamp}`;
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = Buffer.from(input.data.signature, "base64");
  const publicKeyBytes = bs58.decode(input.data.walletAddress);

  const valid = await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const secret = new TextEncoder().encode(env.JWT_SECRET);
  const token = await new SignJWT({ sub: input.data.walletAddress })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("24h")
    .setIssuedAt()
    .sign(secret);

  return c.json({ token, isAdmin: input.data.walletAddress === env.PAY_TO_ADDRESS });
});

// POST /api/instances - Create instance (wallet from JWT used as userId)
instanceRoutes.post("/instances", auth, async (c) => {
  const wallet = c.get("walletAddress");

  if (!env.HETZNER_API_TOKEN || !env.HETZNER_SNAPSHOT_ID) {
    return c.json({ error: "Hetzner is not configured" }, 503);
  }

  const shortId = randomUUID().slice(0, 8);
  const sanitizedWallet = wallet
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, 12);
  const name = `agentbox-${sanitizedWallet}-${shortId}`;

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
      userId: wallet,
      status: "provisioning",
      ip: result.server.public_net.ipv4.ip,
      gatewayToken: "pending",
      rootPassword: result.root_password,
      expiresAt,
    })
    .returning();

  return c.json(toInstanceResponse(row), 201);
});

// GET /api/instances - List instances (wallet-scoped, admin can see all with ?all=true)
instanceRoutes.get("/instances", auth, async (c) => {
  const wallet = c.get("walletAddress");
  const showAll = c.req.query("all") === "true" && isAdmin(wallet);
  const rows = showAll
    ? await db.select().from(instances)
    : await db.select().from(instances).where(eq(instances.userId, wallet));
  return c.json({ instances: rows.map(toInstanceResponse) });
});

// GET /api/instances/expiring - List expiring instances (wallet-scoped)
instanceRoutes.get("/instances/expiring", auth, async (c) => {
  const wallet = c.get("walletAddress");
  const days = Number(c.req.query("days") ?? 3);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const showAll = c.req.query("all") === "true" && isAdmin(wallet);
  const rows = await db.select().from(instances).where(lte(instances.expiresAt, cutoff));
  const filtered = showAll ? rows : rows.filter((r) => r.userId === wallet);
  return c.json({ instances: filtered.map(toInstanceResponse) });
});

// POST /api/instances/callback - VM cloud-init callback (secret-based, no bearer auth)
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

  const [existing] = await db.select().from(instances).where(eq(instances.id, id));
  if (!existing) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(existing, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const [row] = await db
    .update(instances)
    .set({ name: input.data.name })
    .where(eq(instances.id, id))
    .returning();

  return c.json(toInstanceResponse(row));
});

// GET /api/instances/:id - Get instance details
instanceRoutes.get("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  return c.json(toInstanceResponse(row));
});

// DELETE /api/instances/:id - Delete instance
instanceRoutes.delete("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  await db.update(instances).set({ status: "deleting" }).where(eq(instances.id, id));

  try {
    await hetzner.deleteServer(id);
  } catch (err) {
    console.error(`Failed to delete Hetzner server ${id}:`, err);
  }

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
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  try {
    await hetzner.restartServer(id);
  } catch (err) {
    console.error(`Failed to restart Hetzner server ${id}:`, err);
    return c.json({ error: "Failed to restart server" }, 502);
  }

  return c.json({ ok: true });
});

// POST /api/instances/:id/extend - Extend expiry
instanceRoutes.post("/instances/:id/extend", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

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
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

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
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

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
