import { randomBytes, randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { jwtVerify, SignJWT } from "jose";
import { db } from "../db/connection";
import { instances } from "../db/schema";
import * as cloudflare from "../lib/cloudflare";
import { HETZNER_SNAPSHOT_ID, INSTANCE_BASE_DOMAIN } from "../lib/constants";
import { encrypt } from "../lib/crypto";
import { env } from "../lib/env";
import { recordEvent } from "../lib/events";
import * as hetzner from "../lib/hetzner";
import { generateAgentName } from "../lib/names";
import { payerStore } from "../lib/payer-store";
import { provisionInputSchema, provisionListQuerySchema } from "../lib/schemas";
import { logger } from "../logger";
import { buildUserData, toInstanceResponse } from "./instances";

export const provisionRoutes = new Hono();

async function signAccessToken(
  wallet: string,
  instanceId: number,
  expiresAt: Date,
): Promise<string> {
  const secret = new TextEncoder().encode(env.JWT_SECRET);
  return new SignJWT({ sub: wallet, instanceId, type: "provision" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(secret);
}

async function verifyAccessToken(
  token: string,
  expectedInstanceId: number,
): Promise<{ wallet: string } | null> {
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    if (
      payload.type !== "provision" ||
      payload.instanceId !== expectedInstanceId ||
      typeof payload.sub !== "string"
    ) {
      return null;
    }
    return { wallet: payload.sub };
  } catch {
    return null;
  }
}

// POST /provision - Create instance (x402 payment, no JWT auth)
provisionRoutes.post("/provision", async (c) => {
  const payer = payerStore.getStore()?.payer;
  if (!payer) {
    return c.json({ error: "Could not determine payer wallet" }, 500);
  }

  const body = await c.req.json().catch(() => ({}));
  const input = provisionInputSchema.safeParse(body);
  if (!input.success) {
    return c.json({ error: "Invalid input", details: input.error.issues }, 400);
  }

  // Validate Telegram bot token early if provided
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
    recordEvent("instance.create_failed", { type: "wallet", id: payer }, null, {
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
      id: result.server.id,
      name,
      ownerWallet: payer,
      status: "provisioning",
      ip: result.server.public_net.ipv4.ip,
      gatewayToken: encrypt(gatewayToken),
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
    { type: "wallet", id: payer },
    { type: "instance", id: String(row.id) },
    {
      name: row.name,
      ownerWallet: payer,
      ip: row.ip,
      expiresAt: row.expiresAt.toISOString(),
    },
  );

  const accessToken = await signAccessToken(payer, row.id, expiresAt);

  return c.json({ ...toInstanceResponse(row), accessToken }, 201);
});

// GET /provision/:id - Poll instance status + access URLs
provisionRoutes.get("/provision/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return c.json({ error: "Missing access token" }, 401);
  }

  const auth = await verifyAccessToken(token, id);
  if (!auth) {
    return c.json({ error: "Invalid or expired access token" }, 401);
  }

  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);

  const instanceResp = toInstanceResponse(row);
  const resp: Record<string, unknown> = { ...instanceResp };

  if (row.status === "running" || row.status === "minting") {
    const instanceHost = `${row.name}.${INSTANCE_BASE_DOMAIN}`;
    const terminalPath = row.terminalToken ? `/terminal/${row.terminalToken}/` : "/terminal/";
    resp.chatUrl = `https://${instanceHost}/chat#token=${instanceResp.gatewayToken}`;
    resp.terminalUrl = `https://${instanceHost}${terminalPath}`;
  }

  return c.json(resp);
});

// GET /provision - List instances by wallet (signature auth)
provisionRoutes.get("/provision", async (c) => {
  const wallet = c.req.query("wallet");
  const signature = c.req.query("signature");
  const timestampStr = c.req.query("timestamp");

  if (!wallet || !signature || !timestampStr) {
    return c.json({ error: "Missing wallet, signature, or timestamp" }, 400);
  }

  const parsed = provisionListQuerySchema.safeParse({
    wallet,
    signature,
    timestamp: Number(timestampStr),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  }

  const { timestamp } = parsed.data;
  const age = Date.now() - timestamp;
  if (age > 5 * 60 * 1000 || age < -60_000) {
    return c.json({ error: "Timestamp expired" }, 400);
  }

  const message = `List AgentBox instances\nTimestamp: ${timestamp}`;
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = Buffer.from(parsed.data.signature, "base64");
  const publicKeyBytes = bs58.decode(parsed.data.wallet);

  const valid = await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const rows = await db
    .select()
    .from(instances)
    .where(and(eq(instances.ownerWallet, parsed.data.wallet), isNull(instances.deletedAt)));

  return c.json({ instances: rows.map(toInstanceResponse) });
});

// POST /provision/:id/extend - Extend instance (x402 payment + access token)
provisionRoutes.post("/provision/:id/extend", async (c) => {
  const id = Number(c.req.param("id"));
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return c.json({ error: "Missing access token" }, 401);
  }

  const auth = await verifyAccessToken(token, id);
  if (!auth) {
    return c.json({ error: "Invalid or expired access token" }, 401);
  }

  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), isNull(instances.deletedAt)));
  if (!row) return c.json({ error: "Instance not found" }, 404);

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
    { type: "wallet", id: auth.wallet },
    { type: "instance", id: String(id) },
    { newExpiresAt: newExpiry.toISOString() },
  );

  const accessToken = await signAccessToken(auth.wallet, id, newExpiry);

  return c.json({ ...toInstanceResponse(updated), accessToken });
});
