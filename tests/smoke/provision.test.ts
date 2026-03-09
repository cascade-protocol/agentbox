import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { beforeAll, describe, expect, test } from "vitest";

try {
  process.loadEnvFile(`${import.meta.dirname}/.env`);
} catch {}

const WALLET_PATH = process.env.WALLET_PATH;
if (!WALLET_PATH) {
  console.error("Missing WALLET_PATH. Set it in tests/smoke/.env");
}
const API = process.env.SMOKE_API_URL || "https://local-be.agentbox.fyi";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const POLL_INTERVAL = 15_000;
const POLL_TIMEOUT_S = 600;

interface ProvisionResponse {
  id: string;
  name: string;
  accessToken: string;
}

interface PollResponse {
  status: string;
  provisioningStep?: string;
  gatewayToken?: string;
}

describe.skipIf(!WALLET_PATH)("provision e2e", () => {
  let x402Fetch: typeof fetch;

  beforeAll(async () => {
    const keypairBytes = new Uint8Array(JSON.parse(readFileSync(WALLET_PATH as string, "utf8")));
    const signer = await createKeyPairSignerFromBytes(keypairBytes);
    console.log("Wallet:", signer.address);
    console.log("API:", API);

    const client = new x402Client();
    registerExactSvmScheme(client, { signer });
    x402Fetch = wrapFetchWithPayment(fetch, client);
  });

  test("provision -> poll -> chat completions", async () => {
    // 1. Provision
    const res = await x402Fetch(`${API}/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TELEGRAM_BOT_TOKEN ? { telegramBotToken: TELEGRAM_BOT_TOKEN } : {}),
    });

    expect(res.status).toBe(201);
    const { id, name, accessToken } = (await res.json()) as ProvisionResponse;
    console.log(`Instance: ${name} (${id})`);

    // 2. Poll until running
    const startTime = Date.now();
    let instance: PollResponse = { status: "" };

    for (;;) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      expect(elapsed, "timed out waiting for instance").toBeLessThan(POLL_TIMEOUT_S);

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));

      const poll = await fetch(`${API}/provision/${id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      instance = (await poll.json()) as PollResponse;
      console.log(
        `[${elapsed}s] status=${instance.status} step=${instance.provisioningStep || "-"}`,
      );

      if (instance.status === "running") break;
      expect(instance.status).not.toBe("error");
      expect(instance.status).not.toBe("deleted");
    }

    // 3. Chat completions
    const chatRes = await fetch(`https://${name}.agentbox.fyi/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${instance.gatewayToken}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say hello in exactly 5 words." }],
      }),
    });

    expect(chatRes.status).toBe(200);
    const chatData = (await chatRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(chatData.choices?.[0]?.message?.content).toBeTruthy();
    console.log(`Agent says: ${chatData.choices?.[0]?.message?.content}`);

    // 4. Telegram webhook verification (when bot token provided)
    if (TELEGRAM_BOT_TOKEN) {
      const whRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
      const whData = (await whRes.json()) as {
        ok: boolean;
        result?: {
          url: string;
          pending_update_count: number;
          last_error_date?: number;
          last_error_message?: string;
        };
      };
      console.log(`Webhook URL: ${whData.result?.url || "NOT SET"}`);
      console.log(`Webhook error: ${whData.result?.last_error_message || "none"}`);

      expect(whData.ok).toBe(true);
      expect(whData.result?.url).toContain(name);
      expect(whData.result?.url).toContain("/telegram-webhook");
    }
  });
});
