// Full e2e test: provision -> poll -> chat completions
// Usage: node ops/e2e/provision.mjs /path/to/wallet.json [api-url]
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";

const walletPath = process.argv[2];
if (!walletPath) {
  console.error("Usage: node ops/e2e/provision.mjs /path/to/wallet.json [api-url]");
  process.exit(1);
}

const API = process.argv[3] || "https://dev-api.agentbox.fyi";

const keypairBytes = new Uint8Array(JSON.parse(readFileSync(walletPath, "utf8")));
const signer = await createKeyPairSignerFromBytes(keypairBytes);
console.log("Wallet:", signer.address);
console.log("API:", API);

const client = new x402Client();
registerExactSvmScheme(client, { signer });
const x402Fetch = wrapFetchWithPayment(fetch, client);

// 1. Provision
console.log("\n--- Step 1: POST /provision ---");
const res = await x402Fetch(`${API}/provision`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});

console.log("Status:", res.status);
const data = await res.json();
console.log("Response:", JSON.stringify(data, null, 2));

if (res.status !== 201) {
  console.error("FAILED: Expected 201, got", res.status);
  process.exit(1);
}

const { id, name, accessToken } = data;
console.log(`\nInstance: ${name} (${id})`);

// 2. Poll until running
console.log("\n--- Step 2: Polling ---");
const startTime = Date.now();
let instance;

while (true) {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  if (elapsed > 600) {
    console.error("TIMEOUT after 10 min");
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 15000));

  const poll = await fetch(`${API}/provision/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  instance = await poll.json();
  console.log(`[${elapsed}s] status=${instance.status} step=${instance.provisioningStep || "-"}`);

  if (instance.status === "running") break;
  if (instance.status === "error" || instance.status === "deleted") {
    console.error("FAILED:", instance.status);
    process.exit(1);
  }
}

console.log("\n--- Step 3: Chat Completions ---");
const { gatewayToken } = instance;
const chatApiUrl = `https://${name}.agentbox.fyi/v1/chat/completions`;

console.log(`URL: ${chatApiUrl}`);
console.log(`Token: ${gatewayToken ? gatewayToken.slice(0, 16) + "..." : "MISSING"}`);

const chatRes = await fetch(chatApiUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${gatewayToken}`,
  },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Say hello in exactly 5 words." }],
  }),
});

console.log("Chat status:", chatRes.status);
const chatData = await chatRes.json();
console.log("Chat response:", JSON.stringify(chatData, null, 2));

if (chatRes.status === 200 && chatData.choices?.[0]?.message?.content) {
  console.log("\n=== ALL TESTS PASSED ===");
  console.log(`Agent says: ${chatData.choices[0].message.content}`);
} else {
  console.error("FAILED: Unexpected chat response");
  process.exit(1);
}
