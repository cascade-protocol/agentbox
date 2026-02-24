import { randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import { and, eq, isNull, lte } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { jwtVerify, SignJWT } from "jose";
import { db } from "../db/connection";
import { instances } from "../db/schema";
import * as cloudflare from "../lib/cloudflare";
import {
  HETZNER_SNAPSHOT_ID,
  LLM_DEFAULT_MODEL,
  LLM_PROVIDER_NAME,
  LLM_PROVIDER_URL,
} from "../lib/constants";
import { decrypt, encrypt } from "../lib/crypto";
import { env } from "../lib/env";
import { recordEvent } from "../lib/events";
import * as hetzner from "../lib/hetzner";
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
  createInstanceInputSchema,
  instanceConfigQuerySchema,
  provisioningUpdateInputSchema,
  telegramSetupInputSchema,
  updateAgentMetadataInputSchema,
  updateInstanceInputSchema,
  withdrawInputSchema,
} from "../lib/schemas";
import { withVM } from "../lib/ssh";
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
    telegramBotUsername: row.telegramBotUsername,
    snapshotId: row.snapshotId,
    provisioningStep: row.provisioningStep,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function buildUserData(opts: {
  apiBaseUrl: string;
  callbackToken: string;
  terminalToken: string;
  telegramBotToken?: string;
}): string {
  const envLines = [
    `API_BASE_URL="${opts.apiBaseUrl}"`,
    `CALLBACK_SECRET="${opts.callbackToken}"`,
    `TERMINAL_TOKEN="${opts.terminalToken}"`,
  ];
  if (opts.telegramBotToken) {
    envLines.push(`TELEGRAM_BOT_TOKEN="${opts.telegramBotToken}"`);
  }

  const lines = [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    "mkdir -p /etc/agentbox",
    "SERVER_ID=$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)",
    "",
    "cat > /etc/agentbox/callback.env << 'ENVEOF'",
    ...envLines,
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
  const entity = { type: "instance", id: String(row.id) };
  const system = { type: "system", id: "backend" };

  if (!row.vmWallet) {
    logger.error(`Instance ${row.id} missing vmWallet for SATI minting`);
    await db.update(instances).set({ status: "running" }).where(eq(instances.id, row.id));
    recordEvent("instance.running", system, entity, {});
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
    logger.error(`Failed to fund VM wallet SOL ${row.vmWallet}: ${String(solResult.reason)}`);
    recordEvent("instance.funding_failed", system, entity, {
      asset: "SOL",
      error: String(solResult.reason),
    });
  }
  if (usdcResult.status === "rejected") {
    logger.error(`Failed to fund VM wallet USDC ${row.vmWallet}: ${String(usdcResult.reason)}`);
    recordEvent("instance.funding_failed", system, entity, {
      asset: "USDC",
      error: String(usdcResult.reason),
    });
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
    recordEvent("instance.minted", system, entity, { mint, ownerWallet: row.ownerWallet });
    recordEvent("instance.running", system, entity, {});
  } catch (err) {
    logger.error(`SATI mint failed for instance ${row.id}`, {
      error: err instanceof Error ? err.message : String(err),
      context:
        err instanceof Error ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : undefined,
    });
    await db.update(instances).set({ status: "running" }).where(eq(instances.id, row.id));
    recordEvent("instance.mint_failed", system, entity, {
      error: err instanceof Error ? err.message : String(err),
    });
    recordEvent("instance.running", system, entity, {});
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

  recordEvent("auth.signed_in", { type: "wallet", id: input.data.solanaWalletAddress }, null, {});

  return c.json({ token, isAdmin: input.data.solanaWalletAddress === env.PAY_TO_ADDRESS });
});

// POST /instances - Create instance (wallet from JWT used as ownerWallet)
instanceRoutes.post("/instances", auth, async (c) => {
  const wallet = c.get("walletAddress");

  if (!env.HETZNER_API_TOKEN || !HETZNER_SNAPSHOT_ID) {
    return c.json({ error: "Hetzner is not configured" }, 503);
  }

  // Parse optional body (telegramBotToken)
  const body = await c.req.json().catch(() => ({}));
  const input = createInstanceInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  // Validate bot token early if provided
  let telegramBotToken: string | undefined;
  let telegramBotUsername: string | undefined;
  if (input.data.telegramBotToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${input.data.telegramBotToken}/getMe`);
      const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
      if (!data.ok) {
        return c.json({ error: "Invalid Telegram bot token" }, 400);
      }
      telegramBotToken = input.data.telegramBotToken;
      telegramBotUsername = data.result?.username;
    } catch {
      return c.json({ error: "Failed to validate bot token with Telegram" }, 502);
    }

    // Clear stale webhook so long polling works at boot
    try {
      await fetch(`https://api.telegram.org/bot${telegramBotToken}/deleteWebhook`);
    } catch {
      // Non-critical
    }
  }

  let name = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateAgentName();
    const [existing] = await db
      .select({ id: instances.id })
      .from(instances)
      .where(and(eq(instances.name, candidate), isNull(instances.deletedAt)))
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
    telegramBotToken,
  });

  let result: Awaited<ReturnType<typeof hetzner.createServer>>;
  try {
    result = await hetzner.createServer(name, userData);
  } catch (err) {
    logger.error(`Hetzner create failed: ${String(err)}`);
    recordEvent("instance.create_failed", { type: "wallet", id: wallet }, null, {
      error: String(err),
    });
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
      telegramBotToken: telegramBotToken ? encrypt(telegramBotToken) : null,
      telegramBotUsername: telegramBotUsername ?? null,
      snapshotId: HETZNER_SNAPSHOT_ID,
      nftMint: null,
      vmWallet: null,
      provisioningStep: "vm_created",
      expiresAt,
    })
    .returning();

  recordEvent(
    "instance.created",
    { type: "wallet", id: wallet },
    { type: "instance", id: String(row.id) },
    {
      name: row.name,
      ownerWallet: wallet,
      ip: row.ip,
      expiresAt: row.expiresAt.toISOString(),
    },
  );

  return c.json(toInstanceResponse(row), 201);
});

// GET /instances - List instances (wallet-scoped, admin can see all with ?all=true)
instanceRoutes.get("/instances", auth, async (c) => {
  const wallet = c.get("walletAddress");
  const showAll = c.req.query("all") === "true" && isAdmin(wallet);
  const rows = showAll
    ? await db.select().from(instances).where(isNull(instances.deletedAt))
    : await db
        .select()
        .from(instances)
        .where(and(eq(instances.ownerWallet, wallet), isNull(instances.deletedAt)));
  return c.json({ instances: rows.map(toInstanceResponse) });
});

// GET /instances/expiring - List expiring instances (wallet-scoped)
instanceRoutes.get("/instances/expiring", auth, async (c) => {
  const wallet = c.get("walletAddress");
  const days = Number(c.req.query("days") ?? 3);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const showAll = c.req.query("all") === "true" && isAdmin(wallet);
  const rows = await db
    .select()
    .from(instances)
    .where(and(lte(instances.expiresAt, cutoff), isNull(instances.deletedAt)));
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

  recordEvent(
    "instance.step_reported",
    { type: "vm", id: String(input.data.serverId) },
    { type: "instance", id: String(input.data.serverId) },
    { step: input.data.step },
  );

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

  recordEvent(
    "instance.callback_received",
    { type: "vm", id: String(row.id) },
    { type: "instance", id: String(row.id) },
    { vmWallet: input.data.solanaWalletAddress, gatewayToken: input.data.gatewayToken },
  );

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
    recordEvent("sync.requested", { type: "wallet", id: wallet }, null, { claimed, recovered });
    const rows = await db
      .select()
      .from(instances)
      .where(and(eq(instances.ownerWallet, wallet), isNull(instances.deletedAt)));

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

  // Decrypt telegram bot token if stored at creation time
  let telegramBotToken: string | undefined;
  if (row.telegramBotToken) {
    try {
      telegramBotToken = decrypt(row.telegramBotToken);
    } catch {
      logger.warn(`Failed to decrypt telegram token for instance ${row.id} in config endpoint`);
    }
  }

  return c.json({
    hostname,
    terminalToken: row.terminalToken,
    telegramBotToken,
    provider: {
      name: LLM_PROVIDER_NAME,
      url: LLM_PROVIDER_URL,
      defaultModel: LLM_DEFAULT_MODEL,
      rpcUrl: env.SOLANA_RPC_URL || null,
    },
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

  const [existing] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!existing) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(existing, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const [row] = await db
    .update(instances)
    .set({ name: input.data.name })
    .where(eq(instances.id, id))
    .returning();

  recordEvent(
    "instance.renamed",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(id) },
    { newName: input.data.name },
  );

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

  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
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
    recordEvent(
      "instance.agent_updated",
      { type: "wallet", id: c.get("walletAddress") },
      { type: "instance", id: String(id) },
      { name: input.data.name, description: input.data.description },
    );
    return c.json({ ok: true });
  } catch (err) {
    logger.error(`Failed to update agent metadata for instance ${id}: ${String(err)}`);
    return c.json({ error: "Failed to update agent metadata" }, 500);
  }
});

// GET /instances/:id - Get instance details
instanceRoutes.get("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  return c.json(toInstanceResponse(row));
});

// DELETE /instances/:id - Delete instance
instanceRoutes.delete("/instances/:id", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const wallet = c.get("walletAddress");
  const delEntity = { type: "instance", id: String(id) };
  await db.update(instances).set({ status: "deleting" }).where(eq(instances.id, id));
  recordEvent("instance.deletion_started", { type: "wallet", id: wallet }, delEntity, {});

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

  await db
    .update(instances)
    .set({ status: "deleted", deletedAt: new Date() })
    .where(eq(instances.id, id));
  recordEvent("instance.deleted", { type: "wallet", id: wallet }, delEntity, {});
  return c.json({ ok: true });
});

// POST /instances/:id/mint - Retry NFT minting
instanceRoutes.post("/instances/:id/mint", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
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
  recordEvent(
    "instance.mint_retried",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(row.id) },
    {},
  );

  void mintAndFinalize(row).catch((err) => {
    logger.error(`Manual mint retry failed for instance ${row.id}: ${String(err)}`);
  });

  return c.json({ ok: true });
});

// POST /instances/:id/restart - Restart VM
instanceRoutes.post("/instances/:id/restart", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  try {
    await hetzner.restartServer(id);
  } catch (err) {
    logger.error(`Failed to restart Hetzner server ${id}: ${String(err)}`);
    return c.json({ error: "Failed to restart server" }, 502);
  }

  recordEvent(
    "instance.restarted",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(id) },
    {},
  );

  return c.json({ ok: true });
});

// POST /instances/:id/extend - Extend expiry
instanceRoutes.post("/instances/:id/extend", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
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

  recordEvent(
    "instance.extended",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(id) },
    { newExpiresAt: newExpiry.toISOString() },
  );

  return c.json(toInstanceResponse(updated));
});

// GET /instances/:id/access - Access credentials
instanceRoutes.get("/instances/:id/access", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const instanceHost = `${row.name}.${env.INSTANCE_BASE_DOMAIN}`;
  const terminalPath = row.terminalToken ? `/terminal/${row.terminalToken}/` : "/terminal/";
  return c.json({
    ...toInstanceResponse(row),
    chatUrl: `https://${instanceHost}/chat#token=${row.gatewayToken}`,
    terminalUrl: `https://${instanceHost}${terminalPath}`,
  });
});

// GET /instances/:id/health - Probe instance health
instanceRoutes.get("/instances/:id/health", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
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

// POST /instances/:id/telegram - Write Telegram bot config via SSH
instanceRoutes.post("/instances/:id/telegram", auth, async (c) => {
  if (!env.SSH_PRIVATE_KEY) {
    return c.json({ error: "SSH access is not configured" }, 503);
  }

  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const input = telegramSetupInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (row.status !== "running") {
    return c.json({ error: "Instance is not running" }, 409);
  }

  const token = input.data.telegramBotToken;

  // Resolve bot username and validate token via getMe
  let botUsername: string | undefined;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (!data.ok) {
      return c.json({ error: "Invalid Telegram bot token" }, 400);
    }
    botUsername = data.result?.username;
  } catch {
    return c.json({ error: "Failed to validate bot token with Telegram" }, 502);
  }

  // Clear any stale webhook so long polling works
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  } catch {
    logger.warn(`Failed to delete webhook for instance ${id}, proceeding anyway`);
  }

  const configPath = "/home/openclaw/.openclaw/openclaw.json";

  try {
    await withVM(row.ip, async (vm) => {
      // biome-ignore lint/suspicious/noExplicitAny: openclaw config is untyped JSON
      const cfg = await vm.readJson<any>(configPath);
      cfg.channels ??= {};
      cfg.channels.telegram = {
        enabled: true,
        botToken: token,
        dmPolicy: "open",
        allowFrom: ["*"],
        groups: { "*": { requireMention: true } },
        ackReaction: "\u{1F44B}",
      };
      cfg.plugins ??= {};
      cfg.plugins.entries ??= {};
      cfg.plugins.entries.telegram = { enabled: true };
      await vm.writeJson(configPath, cfg, "openclaw");
      await vm.restart("openclaw-gateway");
    });
  } catch (err) {
    logger.error(`Telegram SSH config failed for instance ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Failed to configure Telegram on instance" }, 500);
  }

  // Store encrypted token + username in DB
  await db
    .update(instances)
    .set({ telegramBotToken: encrypt(token), telegramBotUsername: botUsername ?? null })
    .where(eq(instances.id, id));

  recordEvent(
    "instance.telegram_configured",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(id) },
    {},
  );

  return c.json({ ok: true, botUsername, status: "starting" });
});

// GET /instances/:id/telegram/status - Check if Telegram bot is actively polling
instanceRoutes.get("/instances/:id/telegram/status", auth, async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  if (!row.telegramBotToken) {
    return c.json({ status: "not_configured" });
  }

  let token: string;
  try {
    token = decrypt(row.telegramBotToken);
  } catch {
    logger.error(`Failed to decrypt telegram token for instance ${id}`);
    return c.json({ status: "error", error: "Stored token is corrupted" });
  }

  // Resolve bot username
  let botUsername: string | undefined;
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meData = (await meRes.json()) as { ok: boolean; result?: { username?: string } };
    if (!meData.ok) {
      return c.json({ status: "error", error: "Token is invalid or revoked" });
    }
    botUsername = meData.result?.username;
  } catch {
    return c.json({ status: "error", error: "Failed to reach Telegram API" });
  }

  // Probe getUpdates with timeout=0 for instant response.
  // 409 = gateway is actively polling (bot is live).
  // 200 = nobody is polling yet (bot still starting).
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=0&timeout=0`);
    if (res.status === 409) {
      return c.json({ status: "live", botUsername });
    }
    return c.json({ status: "starting", botUsername });
  } catch {
    return c.json({ status: "starting", botUsername });
  }
});

const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// POST /instances/:id/withdraw - Withdraw SOL or USDC from VM wallet to owner
instanceRoutes.post("/instances/:id/withdraw", auth, async (c) => {
  if (!env.SSH_PRIVATE_KEY) {
    return c.json({ error: "SSH access is not configured" }, 503);
  }

  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const input = withdrawInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (row.status !== "running") {
    return c.json({ error: "Instance is not running" }, 409);
  }

  const { token, amount } = input.data;
  const dest = row.ownerWallet;

  try {
    const result = await withVM(
      row.ip,
      async (vm) => {
        let cmd: string;
        if (token === "USDC") {
          cmd = `su - openclaw -c 'spl-token transfer ${USDC_MINT_ADDRESS} ${amount} ${dest} --fund-recipient --allow-unfunded-recipient'`;
        } else {
          cmd = `su - openclaw -c 'solana transfer ${dest} ${amount} --allow-unfunded-recipient'`;
        }

        const { stdout, stderr, code } = await vm.exec(cmd);
        if (code !== 0) {
          throw new Error(stderr.trim() || `Transfer failed with exit code ${code}`);
        }

        // Parse tx signature from CLI output (last non-empty line typically contains it)
        const lines = stdout.trim().split("\n");
        const signature = lines[lines.length - 1]?.trim() ?? "";
        return { signature };
      },
      60_000,
    );

    recordEvent(
      "instance.withdrawal",
      { type: "wallet", id: c.get("walletAddress") },
      { type: "instance", id: String(id) },
      { token, amount, destination: dest },
    );

    return c.json({ ok: true, signature: result.signature });
  } catch (err) {
    logger.error(`Withdrawal failed for instance ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: err instanceof Error ? err.message : "Withdrawal failed" }, 500);
  }
});
