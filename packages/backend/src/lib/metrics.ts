import client from "prom-client";

export const register = client.register;

client.collectDefaultMetrics({ register });

export const httpRequestDuration = new client.Histogram({
  name: "agentbox_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const instancesProvisioned = new client.Counter({
  name: "agentbox_instances_provisioned_total",
  help: "Total instances provisioned",
  labelNames: ["status"] as const,
});

export const instancesActive = new client.Gauge({
  name: "agentbox_instances_active",
  help: "Currently active instances",
});

export const satiMintTotal = new client.Counter({
  name: "agentbox_sati_mint_total",
  help: "Total SATI NFT mint attempts",
  labelNames: ["result"] as const,
});

export const walletFundingTotal = new client.Counter({
  name: "agentbox_wallet_funding_total",
  help: "Total wallet funding attempts",
  labelNames: ["type", "result"] as const,
});

export const cleanupDeletedTotal = new client.Counter({
  name: "agentbox_cleanup_deleted_total",
  help: "Total instances deleted by cleanup",
});
