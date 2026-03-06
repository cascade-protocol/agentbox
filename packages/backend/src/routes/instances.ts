import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
  INSTANCE_BASE_DOMAIN,
  OPENCLAW_BASE_CONFIG,
  PAY_TO_ADDRESS,
  WORKSPACE_FILES,
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
  pairingApproveInputSchema,
  provisioningUpdateInputSchema,
  telegramSetupInputSchema,
  updateAgentMetadataInputSchema,
  updateInstanceInputSchema,
  withdrawInputSchema,
} from "../lib/schemas";
import { withVM } from "../lib/ssh";
import { deriveWallet, generateWallet } from "../lib/wallet";
import { logger } from "../logger";

/** Derive a per-instance Telegram webhook secret from the instance's callbackToken via HMAC. */
function deriveWebhookSecret(callbackToken: string): string {
  return createHmac("sha256", callbackToken).update("telegram-webhook").digest("hex").slice(0, 64);
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
  return wallet === env.OPERATOR_WALLET || wallet === PAY_TO_ADDRESS;
}

function isOwner(row: typeof instances.$inferSelect, wallet: string): boolean {
  return isAdmin(wallet) || row.ownerWallet === wallet;
}

/** Find active instance by name. */
async function findInstance(name: string) {
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.name, name), isNull(instances.deletedAt)));
  return row;
}

export function toInstanceResponse(row: typeof instances.$inferSelect) {
  let gatewayToken = row.gatewayToken;
  try {
    gatewayToken = decrypt(gatewayToken);
  } catch {
    // Legacy plaintext token or decryption failure - return as-is
  }
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    ownerWallet: row.ownerWallet,
    status: row.status,
    ip: row.ip,
    nftMint: row.nftMint,
    vmWallet: row.vmWallet,
    gatewayToken,
    terminalToken: row.terminalToken,
    telegramBotUsername: row.telegramBotUsername,
    snapshotId: row.snapshotId,
    provisioningStep: row.provisioningStep,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function buildUserData(opts: {
  apiBaseUrl: string;
  callbackToken: string;
  terminalToken: string;
}): string {
  const envLines = [
    `API_BASE_URL="${opts.apiBaseUrl}"`,
    `CALLBACK_SECRET="${opts.callbackToken}"`,
    `TERMINAL_TOKEN="${opts.terminalToken}"`,
  ];

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

export async function mintAndFinalize(row: typeof instances.$inferSelect): Promise<void> {
  const entity = { type: "instance", id: String(row.id) };
  const system = { type: "system", id: "backend" };

  if (!row.vmWallet) {
    logger.error(`Instance ${row.id} missing vmWallet for SATI minting`);
    await db.update(instances).set({ status: "running" }).where(eq(instances.id, row.id));
    recordEvent("instance.running", system, entity, {}, row.id);
    return;
  }

  const hostname = `${row.name}.${INSTANCE_BASE_DOMAIN}`;

  // Fund VM wallet (SOL + USDC) in parallel - await both so the agent
  // is fully operational before the instance transitions to "running".
  const [solResult, usdcResult] = await Promise.allSettled([
    fundVmWallet(row.vmWallet),
    fundVmWalletUsdc(row.vmWallet),
  ]);
  if (solResult.status === "rejected") {
    logger.error(`Failed to fund VM wallet SOL ${row.vmWallet}: ${String(solResult.reason)}`);
    recordEvent(
      "instance.funding_failed",
      system,
      entity,
      { asset: "SOL", error: String(solResult.reason) },
      row.id,
    );
  }
  if (usdcResult.status === "rejected") {
    logger.error(`Failed to fund VM wallet USDC ${row.vmWallet}: ${String(usdcResult.reason)}`);
    recordEvent(
      "instance.funding_failed",
      system,
      entity,
      { asset: "USDC", error: String(usdcResult.reason) },
      row.id,
    );
  }

  try {
    const { mint } = await mintAgentNft({
      ownerWallet: row.ownerWallet,
      vmWalletAddress: row.vmWallet,
      instanceName: row.name,
      hostname,
      instanceId: row.id,
    });

    await db
      .update(instances)
      .set({
        nftMint: mint,
        status: "running",
      })
      .where(eq(instances.id, row.id));

    logger.info(`Minted SATI NFT for instance ${row.id}: ${mint}`);
    recordEvent("instance.minted", system, entity, { mint, ownerWallet: row.ownerWallet }, row.id);
    recordEvent("instance.running", system, entity, {}, row.id);
  } catch (err) {
    logger.error(`SATI mint failed for instance ${row.id}`, {
      error: err instanceof Error ? err.message : String(err),
      context:
        err instanceof Error ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : undefined,
    });
    await db.update(instances).set({ status: "running" }).where(eq(instances.id, row.id));
    recordEvent(
      "instance.mint_failed",
      system,
      entity,
      { error: err instanceof Error ? err.message : String(err) },
      row.id,
    );
    recordEvent("instance.running", system, entity, {}, row.id);
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

  return c.json({ token, isAdmin: input.data.solanaWalletAddress === PAY_TO_ADDRESS });
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

    // Clear stale webhook from any previous deployment (gateway calls setWebhook on startup)
    try {
      await fetch(`https://api.telegram.org/bot${telegramBotToken}/deleteWebhook`);
    } catch {
      // Non-critical
    }
  }

  let name = "";
  if (input.data.name) {
    const [existing] = await db
      .select({ id: instances.id })
      .from(instances)
      .where(eq(instances.name, input.data.name))
      .limit(1);
    if (existing) {
      return c.json({ error: "Name is already taken" }, 409);
    }
    name = input.data.name;
  } else {
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
  }

  const hostname = `${name}.${INSTANCE_BASE_DOMAIN}`;
  const callbackToken = randomUUID();
  const terminalToken = randomUUID();
  const gatewayToken = randomBytes(32).toString("hex");

  // Generate wallet at provision time
  const walletData = generateWallet();
  const encryptedMnemonic = encrypt(walletData.mnemonic);

  const userData = buildUserData({
    apiBaseUrl: env.API_BASE_URL,
    callbackToken,
    terminalToken,
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

  if (env.CF_API_TOKEN) {
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
      serverId: result.server.id,
      primaryIpId: result.server.public_net.ipv4.id,
      location: result.server.datacenter.name.replace(/-dc\d+$/, ""),
      name,
      ownerWallet: wallet,
      status: "provisioning",
      ip: result.server.public_net.ipv4.ip,
      vmWallet: walletData.solana.address,
      encryptedMnemonic,
      gatewayToken: encrypt(gatewayToken),
      callbackToken,
      terminalToken,
      telegramBotToken: telegramBotToken ? encrypt(telegramBotToken) : null,
      telegramBotUsername: telegramBotUsername ?? null,
      arenaEnabled: input.data.arenaEnabled ?? false,
      snapshotId: HETZNER_SNAPSHOT_ID,
      nftMint: null,
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
      ip: row.ip ?? "",
      expiresAt: row.expiresAt.toISOString(),
    },
    row.id,
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
        eq(instances.serverId, input.data.serverId),
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
    { type: "instance", id: String(row.id) },
    { step: input.data.step },
    row.id,
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
      status: "minting",
      provisioningStep: null,
      callbackToken: null,
    })
    .where(
      and(
        eq(instances.serverId, input.data.serverId),
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
    {},
    row.id,
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

// GET /instances/config - VM fetches complete openclaw.json at boot (callback-token auth)
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
        eq(instances.serverId, query.data.serverId),
        eq(instances.status, "provisioning"),
        eq(instances.callbackToken, query.data.secret),
      ),
    );

  if (!row) {
    return c.json({ error: "Instance not found" }, 404);
  }

  const hostname = `${row.name}.${INSTANCE_BASE_DOMAIN}`;

  // Decrypt secrets stored at provision time
  let gatewayToken: string;
  try {
    gatewayToken = decrypt(row.gatewayToken);
  } catch {
    logger.error(`Failed to decrypt gateway token for instance ${row.id}`);
    return c.json({ error: "Internal error" }, 500);
  }

  let telegramBotToken: string | undefined;
  if (row.telegramBotToken) {
    try {
      telegramBotToken = decrypt(row.telegramBotToken);
    } catch {
      logger.warn(`Failed to decrypt telegram token for instance ${row.id}`);
    }
  }

  // Build complete openclaw.json - no init script merges needed
  // biome-ignore lint/suspicious/noExplicitAny: openclaw config is untyped JSON
  const config: any = structuredClone(OPENCLAW_BASE_CONFIG);

  // Gateway auth
  config.gateway.auth.token = gatewayToken;
  config.gateway.remote = { token: gatewayToken };
  config.gateway.controlUi.allowedOrigins = [`https://${hostname}`];

  // Plugin config
  config.plugins.entries["openclaw-x402"].config.dashboardUrl =
    `https://agentbox.fyi/instances/${row.name}`;
  if (env.SOLANA_RPC_URL) {
    config.plugins.entries["openclaw-x402"].config.rpcUrl = env.SOLANA_RPC_URL;
  }

  // Telegram (webhook mode - OpenClaw switches from long-polling to webhook when webhookUrl is set)
  if (telegramBotToken) {
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = telegramBotToken;
    config.channels.telegram.webhookUrl = `https://${hostname}/telegram-webhook`;
    // query.data.secret IS the callbackToken (used to auth this request)
    config.channels.telegram.webhookSecret = deriveWebhookSecret(query.data.secret);
    config.plugins.entries.telegram = { enabled: true };
  }

  const workspaceFiles = { ...WORKSPACE_FILES };

  // Store redacted config snapshot for audit
  const redactedConfig = structuredClone(config);
  redactedConfig.gateway.auth.token = "[REDACTED]";
  redactedConfig.gateway.remote.token = "[REDACTED]";
  if (redactedConfig.channels?.telegram?.botToken) {
    redactedConfig.channels.telegram.botToken = "[REDACTED]";
  }
  if (redactedConfig.channels?.telegram?.webhookSecret) {
    redactedConfig.channels.telegram.webhookSecret = "[REDACTED]";
  }

  await db
    .update(instances)
    .set({
      provisionConfig: { openclawConfig: redactedConfig, workspaceFiles },
    })
    .where(eq(instances.id, row.id));

  // Derive wallet data from stored mnemonic for delivery to VM
  let wallet:
    | {
        solanaKeypairJson: string;
        evmPrivateKeyHex: string;
        mnemonic: string;
        solanaAddress: string;
      }
    | undefined;
  if (row.encryptedMnemonic) {
    try {
      const mnemonic = decrypt(row.encryptedMnemonic);
      const wd = deriveWallet(mnemonic);
      wallet = {
        solanaKeypairJson: wd.solana.keypairJson,
        evmPrivateKeyHex: wd.evm.privateKeyHex,
        mnemonic: wd.mnemonic,
        solanaAddress: wd.solana.address,
      };
    } catch (err) {
      logger.error(`Failed to derive wallet for instance ${row.id}: ${String(err)}`);
    }
  }

  return c.json({
    hostname,
    terminalToken: row.terminalToken,
    gatewayToken,
    telegramBotToken,
    openclawConfig: config,
    workspaceFiles,
    wallet,
  });
});

// PATCH /instances/:name - Update instance name
instanceRoutes.patch("/instances/:name", auth, async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const input = updateInstanceInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const existing = await findInstance(name);
  if (!existing) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(existing, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const [row] = await db
    .update(instances)
    .set({ name: input.data.name })
    .where(eq(instances.id, existing.id))
    .returning();

  recordEvent(
    "instance.renamed",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(existing.id) },
    { newName: input.data.name },
    existing.id,
  );

  return c.json(toInstanceResponse(row));
});

// PATCH /instances/:name/agent - Update agent metadata
instanceRoutes.patch("/instances/:name/agent", auth, async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const input = updateAgentMetadataInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (!row.nftMint) return c.json({ error: "Agent NFT not yet minted" }, 400);
  if (!row.vmWallet) return c.json({ error: "VM wallet not available" }, 400);

  const hostname = `${row.name}.${INSTANCE_BASE_DOMAIN}`;

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
      { type: "instance", id: String(row.id) },
      { name: input.data.name, description: input.data.description },
      row.id,
    );
    return c.json({ ok: true });
  } catch (err) {
    logger.error(`Failed to update agent metadata for instance ${row.id}: ${String(err)}`);
    return c.json({ error: "Failed to update agent metadata" }, 500);
  }
});

// GET /instances/:name - Get instance details
instanceRoutes.get("/instances/:name", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  return c.json(toInstanceResponse(row));
});

// DELETE /instances/:name - Delete instance
instanceRoutes.delete("/instances/:name", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const wallet = c.get("walletAddress");
  const delEntity = { type: "instance", id: String(row.id) };
  await db.update(instances).set({ status: "deleting" }).where(eq(instances.id, row.id));
  recordEvent("instance.deletion_started", { type: "wallet", id: wallet }, delEntity, {}, row.id);

  if (row.serverId) {
    try {
      await hetzner.deleteServer(row.serverId);
    } catch (err) {
      logger.error(`Failed to delete Hetzner server ${row.serverId}: ${String(err)}`);
    }
  }

  if (row.primaryIpId) {
    try {
      await hetzner.deletePrimaryIp(row.primaryIpId);
    } catch (err) {
      logger.error(`Failed to delete primary IP ${row.primaryIpId}: ${String(err)}`);
    }
  }

  if (env.CF_API_TOKEN) {
    try {
      const hostname = `${row.name}.${INSTANCE_BASE_DOMAIN}`;
      await cloudflare.deleteDnsRecord(hostname);
    } catch (err) {
      logger.error(`Failed to delete DNS record for ${row.name}: ${String(err)}`);
    }
  }

  await db
    .update(instances)
    .set({ status: "deleted", deletedAt: new Date() })
    .where(eq(instances.id, row.id));
  recordEvent("instance.deleted", { type: "wallet", id: wallet }, delEntity, {}, row.id);
  return c.json({ ok: true });
});

// POST /instances/:name/mint - Retry NFT minting
instanceRoutes.post("/instances/:name/mint", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
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
    row.id,
  );

  void mintAndFinalize(row).catch((err) => {
    logger.error(`Manual mint retry failed for instance ${row.id}: ${String(err)}`);
  });

  return c.json({ ok: true });
});

// POST /instances/:name/restart - Restart VM
instanceRoutes.post("/instances/:name/restart", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (!row.serverId) return c.json({ error: "No server associated" }, 400);

  try {
    await hetzner.restartServer(row.serverId);
  } catch (err) {
    logger.error(`Failed to restart Hetzner server ${row.serverId}: ${String(err)}`);
    return c.json({ error: "Failed to restart server" }, 502);
  }

  recordEvent(
    "instance.restarted",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(row.id) },
    {},
    row.id,
  );

  return c.json({ ok: true });
});

// POST /instances/:name/rebuild - Rebuild instance with fresh VM, preserve wallet/IP/identity
instanceRoutes.post("/instances/:name/rebuild", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  if (row.status !== "running") {
    return c.json({ error: "Instance must be running to rebuild" }, 409);
  }
  if (!row.encryptedMnemonic) {
    return c.json({ error: "Instance has no stored wallet (legacy instance)" }, 400);
  }
  if (!row.serverId) {
    return c.json({ error: "No server associated" }, 400);
  }

  // Atomic status transition to prevent concurrent rebuilds
  const [locked] = await db
    .update(instances)
    .set({ status: "rebuilding" })
    .where(and(eq(instances.id, row.id), eq(instances.status, "running")))
    .returning();
  if (!locked) {
    return c.json({ error: "Instance is no longer running" }, 409);
  }

  const callbackToken = randomUUID();
  const terminalToken = randomUUID();
  const gatewayToken = randomBytes(32).toString("hex");

  const userData = buildUserData({
    apiBaseUrl: env.API_BASE_URL,
    callbackToken,
    terminalToken,
  });

  // Rebuild in-place: same server ID, same IP, reimaged disk
  try {
    await hetzner.rebuildServer(row.serverId, userData);
  } catch (err) {
    logger.error(`Failed to rebuild server ${row.serverId}: ${String(err)}`);
    await db.update(instances).set({ status: "running" }).where(eq(instances.id, row.id));
    return c.json({ error: "Failed to rebuild server" }, 502);
  }

  const [updated] = await db
    .update(instances)
    .set({
      status: "provisioning",
      gatewayToken: encrypt(gatewayToken),
      callbackToken,
      terminalToken,
      snapshotId: HETZNER_SNAPSHOT_ID,
      provisioningStep: "vm_created",
    })
    .where(eq(instances.id, row.id))
    .returning();

  recordEvent(
    "instance.rebuilt",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(row.id) },
    {},
    row.id,
  );

  return c.json(toInstanceResponse(updated));
});

// POST /instances/:name/extend - Extend expiry
instanceRoutes.post("/instances/:name/extend", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
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
    .where(eq(instances.id, row.id))
    .returning();

  recordEvent(
    "instance.extended",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(row.id) },
    { newExpiresAt: newExpiry.toISOString() },
    row.id,
  );

  return c.json(toInstanceResponse(updated));
});

// GET /instances/:name/access - Access credentials
instanceRoutes.get("/instances/:name/access", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  const instanceHost = `${row.name}.${INSTANCE_BASE_DOMAIN}`;
  const terminalPath = row.terminalToken ? `/terminal/${row.terminalToken}/` : "/terminal/";
  const instanceResp = toInstanceResponse(row);
  return c.json({
    ...instanceResp,
    chatUrl: `https://${instanceHost}/chat#token=${instanceResp.gatewayToken}`,
    terminalUrl: `https://${instanceHost}${terminalPath}`,
  });
});

// GET /instances/:name/health - Probe instance health
instanceRoutes.get("/instances/:name/health", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  let hetznerStatus = "unknown";
  if (row.serverId) {
    try {
      const server = await hetzner.getServer(row.serverId);
      hetznerStatus = server.server.status;
    } catch {
      // Hetzner API unavailable
    }
  }

  const healthy = hetznerStatus === "running" && row.status === "running";

  return c.json({
    healthy,
    hetznerStatus,
    instanceStatus: row.status,
    callbackReceived: row.vmWallet !== null,
  });
});

// POST /instances/:name/telegram - Write Telegram bot config via SSH
instanceRoutes.post("/instances/:name/telegram", auth, async (c) => {
  if (!env.SSH_PRIVATE_KEY) {
    return c.json({ error: "SSH access is not configured" }, 503);
  }

  const name = c.req.param("name");
  const body = await c.req.json();
  const input = telegramSetupInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (row.status !== "running") {
    return c.json({ error: "Instance is not running" }, 409);
  }
  if (!row.ip) {
    return c.json({ error: "Instance has no IP address" }, 400);
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

  // Clear stale webhook from any previous deployment (gateway calls setWebhook on startup)
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  } catch {
    logger.warn(`Failed to delete webhook for instance ${row.id}, proceeding anyway`);
  }

  if (!row.callbackToken) {
    return c.json({ error: "Instance missing callback token" }, 500);
  }

  const configPath = "/home/openclaw/.openclaw/openclaw.json";
  const hostname = `${row.name}.${INSTANCE_BASE_DOMAIN}`;
  const webhookSecret = deriveWebhookSecret(row.callbackToken);

  try {
    await withVM(row.ip, async (vm) => {
      // biome-ignore lint/suspicious/noExplicitAny: openclaw config is untyped JSON
      const cfg = await vm.readJson<any>(configPath);
      cfg.channels ??= {};
      cfg.channels.telegram = {
        ...cfg.channels.telegram,
        enabled: true,
        botToken: token,
        webhookUrl: `https://${hostname}/telegram-webhook`,
        webhookSecret,
      };
      cfg.plugins ??= {};
      cfg.plugins.entries ??= {};
      cfg.plugins.entries.telegram = { enabled: true };
      await vm.writeJson(configPath, cfg, "openclaw");
      await vm.restart("openclaw-gateway");
    });
  } catch (err) {
    logger.error(`Telegram SSH config failed for instance ${row.id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Failed to configure Telegram on instance" }, 500);
  }

  // Store encrypted token + username in DB
  await db
    .update(instances)
    .set({ telegramBotToken: encrypt(token), telegramBotUsername: botUsername ?? null })
    .where(eq(instances.id, row.id));

  recordEvent(
    "instance.telegram_configured",
    { type: "wallet", id: c.get("walletAddress") },
    { type: "instance", id: String(row.id) },
    {},
    row.id,
  );

  return c.json({ ok: true, botUsername, status: "starting" });
});

// GET /instances/:name/telegram/status - Check if Telegram bot is actively polling
instanceRoutes.get("/instances/:name/telegram/status", auth, async (c) => {
  const name = c.req.param("name");
  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);

  if (!row.telegramBotToken) {
    return c.json({ status: "not_configured" });
  }

  let token: string;
  try {
    token = decrypt(row.telegramBotToken);
  } catch {
    logger.error(`Failed to decrypt telegram token for instance ${row.id}`);
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

  // Check webhook status (webhook mode - gateway calls setWebhook on startup)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = (await res.json()) as {
      ok: boolean;
      result?: {
        url: string;
        pending_update_count: number;
        last_error_date?: number;
        last_error_message?: string;
      };
    };
    if (data.ok && data.result?.url) {
      const hasRecentError =
        data.result.last_error_date && Date.now() / 1000 - data.result.last_error_date < 300;
      return c.json({
        status: hasRecentError ? "degraded" : "live",
        botUsername,
        pendingUpdates: data.result.pending_update_count,
        lastError: hasRecentError ? data.result.last_error_message : undefined,
      });
    }
    return c.json({ status: "starting", botUsername });
  } catch {
    return c.json({ status: "starting", botUsername });
  }
});

const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// POST /instances/:name/withdraw - Withdraw SOL or USDC from VM wallet to owner
instanceRoutes.post("/instances/:name/withdraw", auth, async (c) => {
  if (!env.SSH_PRIVATE_KEY) {
    return c.json({ error: "SSH access is not configured" }, 503);
  }

  const name = c.req.param("name");
  const body = await c.req.json();
  const input = withdrawInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (row.status !== "running") {
    return c.json({ error: "Instance is not running" }, 409);
  }
  if (!row.ip) {
    return c.json({ error: "Instance has no IP address" }, 400);
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
      { type: "instance", id: String(row.id) },
      { token, amount, destination: dest },
      row.id,
    );

    return c.json({ ok: true, signature: result.signature });
  } catch (err) {
    logger.error(`Withdrawal failed for instance ${row.id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: err instanceof Error ? err.message : "Withdrawal failed" }, 500);
  }
});

// POST /instances/:name/pairing - Approve Telegram pairing code via SSH
instanceRoutes.post("/instances/:name/pairing", auth, async (c) => {
  if (!env.SSH_PRIVATE_KEY) {
    return c.json({ error: "SSH access is not configured" }, 503);
  }

  const name = c.req.param("name");
  const body = await c.req.json();
  const input = pairingApproveInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  const row = await findInstance(name);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!isOwner(row, c.get("walletAddress"))) return c.json({ error: "Forbidden" }, 403);
  if (row.status !== "running") {
    return c.json({ error: "Instance is not running" }, 409);
  }
  if (!row.ip) {
    return c.json({ error: "Instance has no IP address" }, 400);
  }

  const code = input.data.code;

  try {
    const result = await withVM(row.ip, async (vm) => {
      const {
        stdout,
        stderr,
        code: exitCode,
      } = await vm.exec(`sudo -u openclaw openclaw pairing approve telegram ${code} --notify`);
      if (exitCode !== 0) {
        const combined = `${stdout}\n${stderr}`;
        if (combined.includes("No pending pairing request")) {
          throw new Error("No pending pairing request found for this code");
        }
        throw new Error(stderr.trim() || `Pairing approval failed with exit code ${exitCode}`);
      }
      return { stdout: stdout.trim() };
    });

    if (!result.stdout.includes("Approved")) {
      return c.json({ error: "Pairing code not found or already used" }, 400);
    }

    recordEvent(
      "instance.pairing_approved",
      { type: "wallet", id: c.get("walletAddress") },
      { type: "instance", id: String(row.id) },
      {},
      row.id,
    );

    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No pending pairing request")) {
      return c.json({ error: msg }, 400);
    }
    logger.error(`Pairing approval failed for instance ${row.id}`, { error: msg });
    return c.json({ error: "Pairing approval failed" }, 500);
  }
});
