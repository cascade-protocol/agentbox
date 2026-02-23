import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import { and, eq, lte } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { jwtVerify, SignJWT } from "jose";
import { db } from "../db/connection";
import { instances } from "../db/schema";
import * as cloudflare from "../lib/cloudflare";
import { env } from "../lib/env";
import * as hetzner from "../lib/hetzner";
import { instancesProvisioned, satiMintTotal, walletFundingTotal } from "../lib/metrics";
import { generateAgentName } from "../lib/names";
import {
  fundVmWallet,
  fundVmWalletUsdc,
  mintAgentNft,
  syncWalletInstances,
  updateAgentMetadataForInstance,
} from "../lib/sati";
import {
  authInputSchema,
  callbackInputSchema,
  instanceConfigQuerySchema,
  provisioningUpdateInputSchema,
  updateAgentMetadataInputSchema,
  updateInstanceInputSchema,
} from "../lib/schemas";
import { logger } from "../logger";

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
    c.set("walletAddress", env.OPERATOR_WALLET);
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
  return wallet === env.OPERATOR_WALLET || wallet === env.PAY_TO_ADDRESS;
}

function isOwner(row: typeof instances.$inferSelect, wallet: string): boolean {
  return isAdmin(wallet) || row.ownerWallet === wallet;
}

const encryptionKey = Buffer.from(env.ENCRYPTION_KEY, "hex");

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Malformed ciphertext");
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(dataHex, "hex", "utf8") + decipher.final("utf8");
}

function toInstanceResponse(row: typeof instances.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    ownerWallet: row.ownerWallet,
    status: row.status,
    ip: row.ip,
    nftMint: row.nftMint,
    vmWallet: row.vmWallet,
    gatewayToken: row.gatewayToken,
    terminalToken: row.terminalToken,
    provisioningStep: row.provisioningStep,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function buildUserData(opts: {
  apiBaseUrl: string;
  callbackToken: string;
  terminalToken: string;
}): string {
  const lines = [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    "mkdir -p /etc/agentbox",
    "SERVER_ID=$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)",
    "",
    "cat > /etc/agentbox/callback.env << 'ENVEOF'",
    `API_BASE_URL="${opts.apiBaseUrl}"`,
    `CALLBACK_SECRET="${opts.callbackToken}"`,
    `TERMINAL_TOKEN="${opts.terminalToken}"`,
    "ENVEOF",
    "",
    "# SERVER_ID must be unquoted (numeric) so append outside heredoc",
    'echo "SERVER_ID=$SERVER_ID" >> /etc/agentbox/callback.env',
    "chmod 600 /etc/agentbox/callback.env",
    "",
    "/usr/local/bin/agentbox-init.sh",
  ];
  return lines.join("\n");
}

async function mintAndFinalize(row: typeof instances.$inferSelect): Promise<void> {
  if (!row.vmWallet) {
    logger.error(`Instance ${row.id} missing vmWallet for SATI minting`);
    await db.update(instances).set({ status: "running" }).where(eq(instances.id, row.id));
    return;
  }

  const hostname = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;

  // Fund VM wallet (SOL + USDC) in parallel - await both so the agent
  // is fully operational before the instance transitions to "running".
  const [solResult, usdcResult] = await Promise.allSettled([
    fundVmWallet(row.vmWallet),
    fundVmWalletUsdc(row.vmWallet),
  ]);
  if (solResult.status === "rejected") {
    walletFundingTotal.inc({ type: "sol", result: "error" });
    logger.error(`Failed to fund VM wallet SOL ${row.vmWallet}: ${String(solResult.reason)}`);
  }
  if (usdcResult.status === "rejected") {
    walletFundingTotal.inc({ type: "usdc", result: "error" });
    logger.error(`Failed to fund VM wallet USDC ${row.vmWallet}: ${String(usdcResult.reason)}`);
  }

  try {
    const { mint } = await mintAgentNft({
      ownerWallet: row.ownerWallet,
      vmWalletAddress: row.vmWallet,
      instanceName: row.name,
      hostname,
      serverId: row.id,
    });

    await db
      .update(instances)
      .set({
        nftMint: mint,
        status: "running",
      })
      .where(eq(instances.id, row.id));

    logger.info(`Minted SATI NFT for instance ${row.id}: ${mint}`);
  } catch (err) {
    satiMintTotal.inc({ result: "error" });
    logger.error(`SATI mint failed for instance ${row.id}`, {
      error: err instanceof Error ? err.message : String(err),
      context:
        err instanceof Error ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : undefined,
    });
    await db.update(instances).set({ status: "running" }).where(eq(instances.id, row.id));
  }
}

// POST /instances/auth - Wallet sign-in (no bearer auth)
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
  const publicKeyBytes = bs58.decode(input.data.solanaWalletAddress);

  const valid = await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const secret = new TextEncoder().encode(env.JWT_SECRET);
  const token = await new SignJWT({ sub: input.data.solanaWalletAddress })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("24h")
    .setIssuedAt()
    .sign(secret);

  return c.json({ token, isAdmin: input.data.solanaWalletAddress === env.PAY_TO_ADDRESS });
});

// POST /instances - Create instance (wallet from JWT used as ownerWallet)
instanceRoutes.post("/instances", auth, async (c) => {
  const wallet = c.get("walletAddress");

  if (!env.HETZNER_API_TOKEN || !env.HETZNER_SNAPSHOT_ID) {
    return c.json({ error: "Hetzner is not configured" }, 503);
  }

  let name = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateAgentName();
    const [existing] = await db
      .select({ id: instances.id })
      .from(instances)
      .where(eq(instances.name, candidate))
      .limit(1);
    if (!existing) {
      name = candidate;
      break;
    }
    logger.warn(`Name collision on "${candidate}", retrying (${attempt + 1}/5)`);
  }
  if (!name) {
    return c.json({ error: "Failed to generate unique name" }, 500);
  }

  const hostname = `${name}.${env.INSTANCE_BASE_DOMAIN}`;
  const callbackToken = randomUUID();
  const terminalToken = randomUUID();

  const userData = buildUserData({
    apiBaseUrl: env.API_BASE_URL,
    callbackToken,
    terminalToken,
  });

  let result: Awaited<ReturnType<typeof hetzner.createServer>>;
  try {
    result = await hetzner.createServer(name, userData);
  } catch (err) {
    instancesProvisioned.inc({ status: "error" });
    logger.error(`Hetzner create failed: ${String(err)}`);
    return c.json({ error: "Failed to provision server" }, 502);
  }

  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    try {
      await cloudflare.createDnsRecord(hostname, result.server.public_net.ipv4.ip);
    } catch (err) {
      logger.error(`Cloudflare DNS create failed: ${String(err)}`);
    }
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const [row] = await db
    .insert(instances)
    .values({
      id: result.server.id,
      name,
      ownerWallet: wallet,
      status: "provisioning",
      ip: result.server.public_net.ipv4.ip,
      gatewayToken: "pending",
      callbackToken,
      terminalToken,
      nftMint: null,
      vmWallet: null,
      provisioningStep: "vm_created",
      rootPassword: result.root_password ? encrypt(result.root_password) : null,
      expiresAt,
    })
    .returning();

  instancesProvisioned.inc({ status: "success" });
  return c.json(toInstanceResponse(row), 201);
});

// GET /instances - List instances (wallet-scoped, admin can see all with ?all=true)
instanceRoutes.get("/instances", auth, async (c) => {
  const wallet = c.get("walletAddress");
  const showAll = c.req.query("all") === "true" && isAdmin(wallet);
  const rows = showAll
    ? await db.select().from(instances)
    : await db.select().from(instances).where(eq(instances.ownerWallet, wallet));
  return c.json({ instances: rows.map(toInstanceResponse) });
});

// GET /instances/expiring - List expiring instances (wallet-scoped)
instanceRoutes.get("/instances/expiring", auth, async (c) => {
  const wallet = c.get("walletAddress");
  const days = Number(c.req.query("days") ?? 3);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const showAll = c.req.query("all") === "true" && isAdmin(wallet);
  const rows = await db.select().from(instances).where(lte(instances.expiresAt, cutoff));
  const filtered = showAll ? rows : rows.filter((r) => r.ownerWallet === wallet);
  return c.json({ instances: filtered.map(toInstanceResponse) });
});

// POST /instances/callback/step - VM provisioning step update (per-instance token)
instanceRoutes.post("/instances/callback/step", async (c) => {
  const body = await c.req.json();
  const input = provisioningUpdateInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const [row] = await db
    .update(instances)
    .set({
      provisioningStep: input.data.step,
    })
    .where(
      and(
        eq(instances.id, input.data.serverId),
        eq(instances.status, "provisioning"),
        eq(instances.callbackToken, input.data.secret),
      ),
    )
    .returning();

  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  return c.json({ ok: true });
});

// POST /instances/callback - VM cloud-init final callback (per-instance token)
instanceRoutes.post("/instances/callback", async (c) => {
  const body = await c.req.json();
  const input = callbackInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const [row] = await db
    .update(instances)
    .set({
      vmWallet: input.data.solanaWalletAddress,
      gatewayToken: input.data.gatewayToken,
      status: "minting",
      provisioningStep: null,
      callbackToken: null,
    })
    .where(
      and(
        eq(instances.id, input.data.serverId),
        eq(instances.status, "provisioning"),
        eq(instances.callbackToken, input.data.secret),
      ),
    )
    .returning();

  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  void mintAndFinalize(row).catch((err) => {
    logger.error(`Unexpected minting failure for instance ${row.id}: ${String(err)}`);
  });

  return c.json({ ok: true });
});

// POST /instances/sync - Sync wallet ownership from chain
instanceRoutes.post("/instances/sync", auth, async (c) => {
  const wallet = c.get("walletAddress");
  try {
    const { claimed, recovered } = await syncWalletInstances(wallet);
    const rows = await db.select().from(instances).where(eq(instances.ownerWallet, wallet));

    return c.json({
      claimed,
      recovered,
      instances: rows.map(toInstanceResponse),
    });
  } catch (err) {
    logger.error(`Failed to sync wallet ${wallet}: ${String(err)}`);
    return c.json({ error: "Failed to sync from chain" }, 500);
  }
});

// GET /instances/config - VM fetches dynamic config at boot (callback-token auth)
instanceRoutes.get("/instances/config", async (c) => {
  const query = instanceConfigQuerySchema.safeParse({
    serverId: c.req.query("serverId"),
    secret: c.req.query("secret"),
  });
  if (!query.success) {
    return c.json({ error: "Invalid input", details: query.error.issues }, 400);
  }

  const [row] = await db
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.id, query.data.serverId),
        eq(instances.status, "provisioning"),
        eq(instances.callbackToken, query.data.secret),
      ),
    );

  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  const hostname = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;

  let tls: { cert: string; key: string } | null = null;
  if (env.WILDCARD_CERT_PATH && env.WILDCARD_KEY_PATH) {
    try {
      const cert = readFileSync(env.WILDCARD_CERT_PATH, "utf-8");
      const key = readFileSync(env.WILDCARD_KEY_PATH, "utf-8");
      tls = { cert, key };
    } catch (err) {
      logger.error(`Failed to read wildcard cert for config endpoint: ${String(err)}`);
    }
  }

  return c.json({
    hostname,
    terminalToken: row.terminalToken,
    tls,
  });
});

// PATCH /instances/:id - Update instance name
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

// PATCH /instances/:id/agent - Update agent metadata
instanceRoutes.patch("/instances/:id/agent", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const input = updateAgentMetadataInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (!row.nftMint) return c.json({ error: "Agent NFT not yet minted" }, 400);
  if (!row.vmWallet) return c.json({ error: "VM wallet not available" }, 400);

  const hostname = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;

  try {
    await updateAgentMetadataForInstance({
      mint: row.nftMint,
      name: input.data.name,
      description: input.data.description,
      hostname,
      vmWalletAddress: row.vmWallet,
    });
    return c.json({ ok: true });
  } catch (err) {
    logger.error(`Failed to update agent metadata for instance ${id}: ${String(err)}`);
    return c.json({ error: "Failed to update agent metadata" }, 500);
  }
});

// GET /instances/:id - Get instance details
instanceRoutes.get("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  return c.json(toInstanceResponse(row));
});

// DELETE /instances/:id - Delete instance
instanceRoutes.delete("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  await db.update(instances).set({ status: "deleting" }).where(eq(instances.id, id));

  try {
    await hetzner.deleteServer(id);
  } catch (err) {
    logger.error(`Failed to delete Hetzner server ${id}: ${String(err)}`);
  }

  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    try {
      const hostname = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;
      await cloudflare.deleteDnsRecord(hostname);
    } catch (err) {
      logger.error(`Failed to delete DNS record for ${row.name}: ${String(err)}`);
    }
  }

  await db.delete(instances).where(eq(instances.id, id));
  return c.json({ ok: true });
});

// POST /instances/:id/mint - Retry NFT minting
instanceRoutes.post("/instances/:id/mint", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  if (row.nftMint) {
    return c.json({ error: "NFT already minted" }, 400);
  }
  if (!row.vmWallet) {
    return c.json({ error: "Instance not yet provisioned" }, 400);
  }
  if (row.status === "minting") {
    return c.json({ error: "Minting already in progress" }, 409);
  }

  await db.update(instances).set({ status: "minting" }).where(eq(instances.id, row.id));

  void mintAndFinalize(row).catch((err) => {
    logger.error(`Manual mint retry failed for instance ${row.id}: ${String(err)}`);
  });

  return c.json({ ok: true });
});

// POST /instances/:id/restart - Restart VM
instanceRoutes.post("/instances/:id/restart", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  try {
    await hetzner.restartServer(id);
  } catch (err) {
    logger.error(`Failed to restart Hetzner server ${id}: ${String(err)}`);
    return c.json({ error: "Failed to restart server" }, 502);
  }

  return c.json({ ok: true });
});

// POST /instances/:id/extend - Extend expiry
instanceRoutes.post("/instances/:id/extend", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const maxExpiry = new Date(row.createdAt);
  maxExpiry.setDate(maxExpiry.getDate() + 90);

  const newExpiry = new Date(row.expiresAt);
  newExpiry.setDate(newExpiry.getDate() + 7);

  if (newExpiry > maxExpiry) {
    return c.json({ error: "Maximum lifetime of 90 days reached" }, 400);
  }

  const [updated] = await db
    .update(instances)
    .set({ expiresAt: newExpiry })
    .where(eq(instances.id, id))
    .returning();

  return c.json(toInstanceResponse(updated));
});

// GET /instances/:id/access - Access credentials
instanceRoutes.get("/instances/:id/access", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(instances).where(eq(instances.id, id));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const instanceHost = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;
  const terminalPath = row.terminalToken ? `/terminal/${row.terminalToken}/` : "/terminal/";
  return c.json({
    ...toInstanceResponse(row),
    ssh: `ssh root@${row.ip}`,
    chatUrl: `https://${instanceHost}/overview#token=${row.gatewayToken}`,
    terminalUrl: `https://${instanceHost}${terminalPath}`,
    rootPassword: row.rootPassword ? decrypt(row.rootPassword) : null,
  });
});

// GET /instances/:id/health - Probe instance health
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
    callbackReceived: row.vmWallet !== null,
  });
});
