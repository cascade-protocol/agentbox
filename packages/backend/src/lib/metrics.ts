import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { count, isNotNull } from "drizzle-orm";
import client from "prom-client";
import { db } from "../db/connection";
import { instances } from "../db/schema";
import { logger } from "../logger";
import { env } from "./env";

export const register = client.register;

client.collectDefaultMetrics({ register });

// --- Operational (ephemeral - correct for request-scoped metrics) ---

export const httpRequestDuration = new client.Histogram({
  name: "agentbox_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// --- Product state (DB-backed, refreshed every 60s) ---

const instancesByStatus = new client.Gauge({
  name: "agentbox_instances",
  help: "Instance count by status",
  labelNames: ["status"] as const,
});

const instancesTotal = new client.Gauge({
  name: "agentbox_instances_total",
  help: "Total instances ever created (all statuses including deleted)",
});

const instancesMinted = new client.Gauge({
  name: "agentbox_instances_minted",
  help: "Instances with a minted SATI NFT",
});

// --- Wallet health (chain-backed, refreshed every 5min) ---

const walletSolLamports = new client.Gauge({
  name: "agentbox_wallet_sol_lamports",
  help: "SOL balance in lamports",
  labelNames: ["wallet"] as const,
});

const walletUsdcMicro = new client.Gauge({
  name: "agentbox_wallet_usdc_micro",
  help: "USDC balance in micro-units (1 USDC = 1_000_000)",
  labelNames: ["wallet"] as const,
});

// --- Refresh functions ---

const TRACKED_STATUSES = [
  "provisioning",
  "minting",
  "running",
  "stopped",
  "error",
  "deleting",
  "deleted",
] as const;

export async function refreshDbGauges(): Promise<void> {
  try {
    const rows = await db
      .select({ status: instances.status, count: count() })
      .from(instances)
      .groupBy(instances.status);

    for (const status of TRACKED_STATUSES) {
      instancesByStatus.set({ status }, 0);
    }

    let total = 0;
    for (const row of rows) {
      instancesByStatus.set({ status: row.status }, row.count);
      total += row.count;
    }
    instancesTotal.set(total);

    const [mintedResult] = await db
      .select({ value: count() })
      .from(instances)
      .where(isNotNull(instances.nftMint));
    instancesMinted.set(mintedResult?.value ?? 0);
  } catch (err) {
    logger.warn(`Failed to refresh DB gauges: ${String(err)}`);
  }
}

export async function refreshChainGauges(): Promise<void> {
  try {
    const { getSati, getHotWallet, USDC_MINT } = await import("./sati");
    const rpc = getSati().getRpc();
    const treasuryAddress = address(env.PAY_TO_ADDRESS);

    const fetches: Promise<void>[] = [];

    // Treasury SOL
    fetches.push(
      rpc
        .getBalance(treasuryAddress)
        .send()
        .then(({ value }) => walletSolLamports.set({ wallet: "treasury" }, Number(value)))
        .catch((err: unknown) => {
          logger.warn(`Chain gauge treasury SOL: ${String(err)}`);
        }),
    );

    // Treasury USDC
    fetches.push(
      getUsdcBalance(rpc, treasuryAddress, USDC_MINT)
        .then((micro) => walletUsdcMicro.set({ wallet: "treasury" }, micro))
        .catch((err: unknown) => {
          logger.warn(`Chain gauge treasury USDC: ${String(err)}`);
        }),
    );

    // Hot wallet (only if configured)
    try {
      const hotWallet = await getHotWallet();
      fetches.push(
        rpc
          .getBalance(hotWallet.address)
          .send()
          .then(({ value }) => walletSolLamports.set({ wallet: "hot" }, Number(value)))
          .catch((err: unknown) => {
            logger.warn(`Chain gauge hot SOL: ${String(err)}`);
          }),
      );
      fetches.push(
        getUsdcBalance(rpc, hotWallet.address, USDC_MINT)
          .then((micro) => walletUsdcMicro.set({ wallet: "hot" }, micro))
          .catch((err: unknown) => {
            logger.warn(`Chain gauge hot USDC: ${String(err)}`);
          }),
      );
    } catch {
      // Hot wallet not configured - skip
    }

    await Promise.allSettled(fetches);
  } catch (err) {
    logger.warn(`Failed to refresh chain gauges: ${String(err)}`);
  }
}

async function getUsdcBalance(
  rpc: ReturnType<ReturnType<typeof import("./sati").getSati>["getRpc"]>,
  owner: ReturnType<typeof address>,
  usdcMint: ReturnType<typeof address>,
): Promise<number> {
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint: usdcMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const { value } = await rpc.getTokenAccountBalance(ata).send();
  return Number(value.amount);
}
