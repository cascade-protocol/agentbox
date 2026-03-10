import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyPairSigner } from "@solana/kit";
import { appendHistory, formatTxLine, readHistory } from "x402-proxy";
import { checkAtaExists, getUsdcBalance, transferUsdc } from "./solana.js";
import { getWalletSnapshot, type ModelEntry, SOL_MAINNET } from "./tools.js";

const HISTORY_PAGE_SIZE = 5;
const STATUS_HISTORY_COUNT = 3;
const INLINE_HISTORY_TOKEN_THRESHOLD = 3;
const UPDATE_MARKER = join(homedir(), ".openclaw/.agentbox-updated");

const tokenSymbolCache = new Map<string, string>();

async function resolveTokenSymbols(mints: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const toResolve: string[] = [];

  for (const m of mints) {
    const cached = tokenSymbolCache.get(m);
    if (cached) {
      result.set(m, cached);
    } else {
      toResolve.push(m);
    }
  }

  if (toResolve.length === 0) return result;

  try {
    const res = await globalThis.fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${toResolve.join(",")}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return result;

    const pairs = (await res.json()) as Array<{
      baseToken?: { address?: string; symbol?: string };
    }>;

    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      const sym = pair.baseToken?.symbol;
      if (addr && sym && toResolve.includes(addr)) {
        tokenSymbolCache.set(addr, sym);
        result.set(addr, sym);
      }
    }
  } catch {
    // DexScreener unavailable - return what we have from cache
  }

  return result;
}

export type CommandContext = {
  getWalletAddress: () => string | null;
  getSigner: () => KeyPairSigner | null;
  rpcUrl: string;
  dashboardUrl: string;
  historyPath: string;
  allModels: Pick<ModelEntry, "provider" | "id" | "name">[];
  pluginVersion: string;
};

async function checkNpmLatestVersion(pkg: string): Promise<string | null> {
  try {
    const res = await globalThis.fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

async function handleSend(
  parts: string[],
  wallet: string,
  signer: KeyPairSigner | null,
  rpc: string,
  histPath: string,
): Promise<{ text: string }> {
  if (!signer) {
    return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
  }

  if (parts.length !== 2) {
    return {
      text: "Usage: `/x_wallet send <amount|all> <address>`\n\n  `/x_wallet send 0.5 7xKXtg...`\n  `/x_wallet send all 7xKXtg...`",
    };
  }

  const [amountStr, destAddr] = parts;
  if (destAddr.length < 32 || destAddr.length > 44) {
    return { text: `Invalid Solana address: ${destAddr}` };
  }

  try {
    const recipientHasAta = await checkAtaExists(rpc, destAddr);
    if (!recipientHasAta) {
      return {
        text: "Recipient does not have a USDC token account.\nThey need to receive USDC at least once to create one.",
      };
    }

    let amountRaw: bigint;
    let amountUi: string;
    if (amountStr.toLowerCase() === "all") {
      const balance = await getUsdcBalance(rpc, wallet);
      if (balance.raw === 0n) {
        return { text: "Wallet has no USDC to send." };
      }
      amountRaw = balance.raw;
      amountUi = balance.ui;
    } else {
      const amount = Number.parseFloat(amountStr);
      if (Number.isNaN(amount) || amount <= 0) {
        return { text: `Invalid amount: ${amountStr}` };
      }
      amountRaw = BigInt(Math.round(amount * 1e6));
      amountUi = amount.toString();
    }

    const sig = await transferUsdc(signer, rpc, destAddr, amountRaw);
    appendHistory(histPath, {
      t: Date.now(),
      ok: true,
      kind: "transfer",
      net: SOL_MAINNET,
      from: wallet,
      to: destAddr,
      tx: sig,
      amount: Number.parseFloat(amountUi),
      token: "USDC",
      label: `${destAddr.slice(0, 4)}...${destAddr.slice(-4)}`,
    });

    return {
      text: `Sent ${amountUi} USDC to \`${destAddr}\`\n[View transaction](https://solscan.io/tx/${sig})`,
    };
  } catch (err) {
    appendHistory(histPath, {
      t: Date.now(),
      ok: false,
      kind: "transfer",
      net: SOL_MAINNET,
      from: wallet,
      to: destAddr,
      token: "USDC",
      error: String(err).substring(0, 200),
    });
    const msg = String(err);
    const cause = (err as { cause?: { message?: string } }).cause?.message || "";
    const detail = cause || msg;
    if (detail.includes("insufficient") || detail.includes("lamports")) {
      return {
        text: "Send failed - insufficient SOL for fees\nBalance too low for transaction fees. Fund wallet with SOL.",
      };
    }
    return { text: `Send failed: ${detail}` };
  }
}

function handleHistory(histPath: string, page: number): { text: string } {
  const records = readHistory(histPath);
  const reversed = [...records].reverse();
  const totalTxs = reversed.length;
  const start = (page - 1) * HISTORY_PAGE_SIZE;
  const pageRecords = reversed.slice(start, start + HISTORY_PAGE_SIZE);

  if (pageRecords.length === 0) {
    return { text: page === 1 ? "No transactions yet." : "No more transactions." };
  }

  const rangeStart = start + 1;
  const rangeEnd = start + pageRecords.length;
  const lines: string[] = [`**History** (${rangeStart}-${rangeEnd})`, ""];
  for (const r of pageRecords) {
    lines.push(formatTxLine(r));
  }

  const nav: string[] = [];
  if (page > 1) {
    nav.push(`Newer: \`/x_wallet history${page === 2 ? "" : ` ${page - 1}`}\``);
  }
  if (start + HISTORY_PAGE_SIZE < totalTxs) {
    nav.push(`Older: \`/x_wallet history ${page + 1}\``);
  }
  if (nav.length > 0) {
    lines.push("", nav.join(" · "));
  }

  return { text: lines.join("\n") };
}

export function createWalletCommand(ctx: CommandContext) {
  return {
    name: "x_wallet",
    description: "Wallet balance, tokens, send USDC, transaction history",
    acceptsArgs: true,
    handler: async (cmdCtx: { args?: string }) => {
      const walletAddress = ctx.getWalletAddress();
      if (!walletAddress) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }

      const args = cmdCtx.args?.trim() ?? "";
      const parts = args.split(/\s+/).filter(Boolean);

      if (parts[0]?.toLowerCase() === "send") {
        return handleSend(
          parts.slice(1),
          walletAddress,
          ctx.getSigner(),
          ctx.rpcUrl,
          ctx.historyPath,
        );
      }

      if (parts[0]?.toLowerCase() === "history") {
        const pageArg = parts[1];
        const page = pageArg ? Math.max(1, Number.parseInt(pageArg, 10) || 1) : 1;
        return handleHistory(ctx.historyPath, page);
      }

      // Default: balance view
      try {
        const snap = await getWalletSnapshot(ctx.rpcUrl, walletAddress, ctx.historyPath);

        const solscanUrl = `https://solscan.io/account/${walletAddress}`;
        const lines: string[] = [
          `**[Wallet](${solscanUrl})**`,
          `\`${walletAddress}\``,
          "",
          `  ${snap.sol} SOL`,
          `  ${snap.ui} USDC`,
        ];
        if (snap.spend.today > 0) {
          lines.push(`  -${snap.spend.today.toFixed(2)} USDC today`);
        }

        if (snap.tokens.length > 0) {
          const displayTokens = snap.tokens.slice(0, 10);
          const symbols = await resolveTokenSymbols(displayTokens.map((t) => t.mint));
          lines.push("", "**Tokens**");
          for (const t of displayTokens) {
            const sym = symbols.get(t.mint);
            const label = sym ?? `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
            const amt = Number.parseFloat(t.amount).toLocaleString("en-US", {
              maximumFractionDigits: 0,
            });
            lines.push(`  ${amt} ${label}`);
          }
          if (snap.tokens.length > 10) {
            lines.push(`  ...and ${snap.tokens.length - 10} more`);
          }
        }

        if (snap.tokens.length <= INLINE_HISTORY_TOKEN_THRESHOLD) {
          const reversed = [...snap.records].reverse();
          const recentRecords = reversed.slice(0, STATUS_HISTORY_COUNT);
          if (recentRecords.length > 0) {
            lines.push("", "**Recent**");
            for (const r of recentRecords) {
              lines.push(formatTxLine(r));
            }
          }
        }

        lines.push("", "History: `/x_wallet history`");

        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `Failed to check balance: ${String(err)}` };
      }
    },
  };
}

export function createStatusCommand(ctx: CommandContext) {
  return {
    name: "x_status",
    description: "System overview: version, model, wallet",
    acceptsArgs: false,
    handler: async () => {
      const latestVersion = await checkNpmLatestVersion("openclaw-agentbox");
      const lines: string[] = [];

      if (existsSync(UPDATE_MARKER)) {
        try {
          const prev = readFileSync(UPDATE_MARKER, "utf-8").trim();
          lines.push(`Updated ${prev} -> v${ctx.pluginVersion}`);
          unlinkSync(UPDATE_MARKER);
        } catch {
          unlinkSync(UPDATE_MARKER);
        }
      }

      const hasPluginUpdate = latestVersion && latestVersion !== ctx.pluginVersion;
      lines.push(`agentbox v${ctx.pluginVersion}`);

      let hasSkillsUpdate = false;
      try {
        const checkOutput = execSync("npx skills check", {
          timeout: 15_000,
          stdio: "pipe",
          env: { ...process.env, INSTALL_INTERNAL_SKILLS: "1", NO_COLOR: "1" },
        })
          .toString()
          .trim();
        hasSkillsUpdate =
          checkOutput.includes("update available") || checkOutput.includes("Update");
      } catch {
        // ignore
      }

      if (hasPluginUpdate || hasSkillsUpdate) {
        const parts: string[] = [];
        if (hasPluginUpdate) parts.push(`plugin v${latestVersion}`);
        if (hasSkillsUpdate) parts.push("skills");
        lines.push(`Update available: ${parts.join(" + ")} - \`/x_update\``);
      }

      const defaultModel = ctx.allModels[0];
      if (defaultModel) {
        lines.push("", `**Model** - ${defaultModel.name} (${defaultModel.provider})`);
        const others = ctx.allModels.filter(
          (m) => m.id !== defaultModel.id || m.provider !== defaultModel.provider,
        );
        for (const m of others) {
          lines.push(`  switch: \`/model ${m.provider}/${m.id}\``);
        }
      }

      const walletAddress = ctx.getWalletAddress();
      const walletParts: string[] = [];
      if (walletAddress) {
        const solscanUrl = `https://solscan.io/account/${walletAddress}`;
        try {
          const snap = await getWalletSnapshot(ctx.rpcUrl, walletAddress, ctx.historyPath);
          walletParts.push(`[Wallet](${solscanUrl})`, `${snap.ui} USDC`);
          if (snap.spend.today > 0)
            walletParts.push(`-${snap.spend.today.toFixed(3)} USDC spent today`);
        } catch {
          walletParts.push(`[Wallet](${solscanUrl})`);
        }
        lines.push("", walletParts.join(" - "));
        const linkParts = ["/x_wallet"];
        if (ctx.dashboardUrl) linkParts.push(`[Dashboard](${ctx.dashboardUrl})`);
        lines.push(linkParts.join(" - "));
      } else {
        lines.push("", "Wallet not loaded yet");
      }

      return { text: lines.join("\n") };
    },
  };
}

export function createUpdateCommand(ctx: CommandContext) {
  return {
    name: "x_update",
    description: "Update agentbox plugin and skills, then restart gateway",
    acceptsArgs: false,
    handler: async () => {
      const latestVersion = await checkNpmLatestVersion("openclaw-agentbox");
      const hasPluginUpdate = latestVersion && latestVersion !== ctx.pluginVersion;
      const lines: string[] = [];
      let needsRestart = false;
      const skillsEnv = { ...process.env, INSTALL_INTERNAL_SKILLS: "1", NO_COLOR: "1" };

      try {
        const checkOutput = execSync("npx skills check", {
          timeout: 15_000,
          stdio: "pipe",
          env: skillsEnv,
        })
          .toString()
          .trim();
        const hasSkillUpdates =
          checkOutput.includes("update available") || checkOutput.includes("Update");

        if (hasSkillUpdates) {
          execSync("npx skills update", { timeout: 30_000, stdio: "pipe", env: skillsEnv });
          lines.push("Skills   updated");
        } else {
          lines.push("Skills   up to date");
        }
      } catch {
        lines.push("Skills   update failed (could not reach GitHub)");
      }

      if (hasPluginUpdate) {
        const extDir = join(homedir(), ".openclaw/extensions/openclaw-agentbox");
        try {
          execSync(`rm -rf ${extDir}`, { timeout: 5_000, stdio: "pipe" });
          execSync("openclaw plugins install openclaw-agentbox@latest", {
            timeout: 60_000,
            stdio: "pipe",
          });
          lines.push(`Plugin   v${ctx.pluginVersion} -> v${latestVersion}`);
          needsRestart = true;
        } catch (err) {
          lines.push(`Plugin   update failed: ${String(err)}`);
        }
      } else {
        lines.push(`Plugin   v${ctx.pluginVersion} (up to date)`);
      }

      if (needsRestart) {
        lines.push(
          "",
          "Restarting gateway - cold start takes ~60-90s. Run `/x_status` after to confirm.",
        );
        try {
          writeFileSync(UPDATE_MARKER, `v${ctx.pluginVersion}`);
        } catch {}
        setTimeout(() => process.exit(0), 2000);
      }

      return { text: lines.join("\n") };
    },
  };
}
