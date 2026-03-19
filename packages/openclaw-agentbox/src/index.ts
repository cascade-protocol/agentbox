import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import type { KeyPairSigner } from "@solana/kit";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createX402ProxyHandler,
  ExactSvmScheme,
  loadSvmWallet,
  type X402ProxyHandler,
  x402Client,
} from "x402-proxy";
import { createStatusCommand, createUpdateCommand, createWalletCommand } from "./commands.js";
import {
  createBalanceTool,
  createLaunchTokenTool,
  createPaymentTool,
  createSwapTool,
  createTokenInfoTool,
  type ModelEntry,
  SOL_MAINNET,
} from "./tools.js";
import { deriveEvmKeypair, deriveSolanaKeypair } from "./wallet.js";
import { createX402RouteHandler } from "./x402-route.js";

const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(dirname(new URL(import.meta.url).pathname), "../package.json"), "utf-8"),
).version as string;

type ProviderConfig = {
  baseUrl: string;
  upstreamUrl?: string;
  models: Array<Omit<ModelEntry, "provider">>;
};

function parseProviders(config: Record<string, unknown>): {
  models: ModelEntry[];
  upstreamOrigins: string[];
} {
  const raw = (config.providers ?? {}) as Record<string, ProviderConfig>;
  const models: ModelEntry[] = [];
  const upstreamOrigins: string[] = [];
  for (const [name, prov] of Object.entries(raw)) {
    if (prov.upstreamUrl) upstreamOrigins.push(prov.upstreamUrl);
    for (const m of prov.models) {
      models.push({ ...m, provider: name });
    }
  }
  return { models, upstreamOrigins };
}

export function register(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const rawKeypairPath = (config.keypairPath as string) || "~/.openclaw/agentbox/wallet-sol.json";
  const keypairPath = rawKeypairPath.startsWith("~/")
    ? join(homedir(), rawKeypairPath.slice(2))
    : rawKeypairPath;
  const rpcUrl = (config.rpcUrl as string) || "https://api.mainnet-beta.solana.com";
  const dashboardUrl = (config.dashboardUrl as string) || "";
  const bagsApiKey = (config.bagsApiKey as string) || "";
  const { models: allModels, upstreamOrigins } = parseProviders(config);
  const historyPath = join(dirname(keypairPath), "history.jsonl");

  if (allModels.length === 0) {
    api.logger.error("openclaw-agentbox: no providers configured");
    return;
  }

  // registerProvider() only handles auth flows (OAuth, API key, device code).
  // The actual model catalog comes from models.providers in openclaw.json.
  const raw = (config.providers ?? {}) as Record<string, ProviderConfig>;
  for (const [name, prov] of Object.entries(raw)) {
    api.registerProvider({
      id: name,
      label: `${name} (x402)`,
      auth: [],
      models: {
        baseUrl: prov.baseUrl,
        api: "openai-completions",
        authHeader: false,
        models: prov.models as Array<
          Omit<ModelEntry, "provider"> & { input: Array<"text" | "image"> }
        >,
      },
    });
  }

  api.logger.info(
    `openclaw-agentbox: ${Object.keys(raw).join(", ")} - ${allModels.length} models, ${upstreamOrigins.length} x402 endpoints`,
  );

  // --- Mutable state shared across tools, commands, and the HTTP handler ---

  let walletAddress: string | null = null;
  let signerRef: KeyPairSigner | null = null;
  let proxyRef: X402ProxyHandler | null = null;
  let walletLoading = false;

  // --- Wallet loader (idempotent, safe to call from both service and eager path) ---

  async function ensureWalletLoaded(): Promise<void> {
    if (walletLoading || walletAddress) return;
    walletLoading = true;
    try {
      const signer = await loadSvmWallet(keypairPath);
      walletAddress = signer.address;
      signerRef = signer;
      api.logger.info(`x402: wallet ${signer.address}`);
    } catch (err) {
      walletLoading = false;
      api.logger.error(`x402: failed to load keypair from ${keypairPath}: ${err}`);
      return;
    }

    const client = new x402Client();
    client.register(SOL_MAINNET, new ExactSvmScheme(signerRef!, { rpcUrl }));
    proxyRef = createX402ProxyHandler({ client });

    const upstreamOrigin = upstreamOrigins[0];
    if (upstreamOrigin) {
      const handler = createX402RouteHandler({
        upstreamOrigin,
        proxy: proxyRef,
        getWalletAddress: () => walletAddress,
        historyPath,
        allModels,
        logger: api.logger,
      });
      api.registerHttpRoute({
        path: "/x402",
        match: "prefix",
        auth: "plugin",
        handler,
      });
      api.logger.info(`x402: HTTP route registered for ${upstreamOrigin}`);
    }
  }

  // Eager load: survives hot-reload where service start() is not re-called
  ensureWalletLoaded();

  // Service: ensures wallet is loaded during normal boot lifecycle
  api.registerService({
    id: "x402-wallet",
    async start() {
      await ensureWalletLoaded();
    },
    async stop() {},
  });

  // --- Tools ---

  const toolCtx = {
    getWalletAddress: () => walletAddress,
    getSigner: () => signerRef,
    rpcUrl,
    bagsApiKey,
    historyPath,
    get proxy(): X402ProxyHandler {
      if (!proxyRef) throw new Error("x402 proxy not initialized yet");
      return proxyRef;
    },
    allModels,
  };

  api.registerTool(createBalanceTool(toolCtx));
  api.registerTool(createPaymentTool(toolCtx));
  api.registerTool(createSwapTool(toolCtx));
  api.registerTool(createLaunchTokenTool(toolCtx));
  api.registerTool(createTokenInfoTool());

  // --- Commands ---

  const cmdCtx = {
    getWalletAddress: () => walletAddress,
    getSigner: () => signerRef,
    rpcUrl,
    dashboardUrl,
    historyPath,
    allModels,
    pluginVersion: PLUGIN_VERSION,
  };

  api.registerCommand(createWalletCommand(cmdCtx));
  api.registerCommand(createStatusCommand(cmdCtx));
  api.registerCommand(createUpdateCommand(cmdCtx));

  // --- CLI: wallet generation ---

  api.registerCli(
    ({ program }) => {
      const agentbox = program.command("agentbox").description("agentbox plugin commands");
      agentbox
        .command("generate")
        .description("Generate Solana + EVM wallets from a single BIP-39 mnemonic")
        .option("-o, --output <dir>", "Output directory for wallet files")
        .action((opts: { output?: string }) => {
          if (!opts.output) {
            console.error("Usage: openclaw agentbox generate --output <dir>");
            process.exit(1);
          }
          const dir = opts.output;
          mkdirSync(dir, { recursive: true });

          const mnemonic = generateMnemonic(english, 256);
          const sol = deriveSolanaKeypair(mnemonic);
          const evm = deriveEvmKeypair(mnemonic);

          const keypairBytes = new Uint8Array(64);
          keypairBytes.set(sol.secretKey, 0);
          keypairBytes.set(sol.publicKey, 32);
          writeFileSync(
            join(dir, "wallet-sol.json"),
            `${JSON.stringify(Array.from(keypairBytes))}\n`,
            { mode: 0o600 },
          );

          writeFileSync(join(dir, "wallet-evm.key"), `${evm.privateKey}\n`, { mode: 0o600 });
          writeFileSync(join(dir, "mnemonic"), `${mnemonic}\n`, { mode: 0o600 });

          console.log(sol.address);
        });
    },
    { commands: ["agentbox"] },
  );
}
