import type { TransactionSigner } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toast } from "sonner";

export type Instance = {
  id: string;
  serverId?: number | null;
  name: string;
  ownerWallet: string;
  status: string;
  ip: string | null;
  nftMint?: string | null;
  vmWallet?: string | null;
  gatewayToken?: string;
  terminalToken?: string | null;
  telegramBotUsername?: string | null;
  snapshotId?: string | null;
  provisioningStep?: string | null;
  createdAt: string;
  expiresAt: string;
};

export type InstanceAccess = Instance & {
  chatUrl: string;
  terminalUrl: string;
};

export type InstanceHealth = {
  healthy: boolean;
  hetznerStatus: string;
  instanceStatus: string;
  callbackReceived: boolean;
};

import { env } from "../env";

export const API_URL = env.apiUrl;
const INSTANCE_BASE_DOMAIN = env.instanceBaseDomain;
const HELIUS_KEY = env.heliusApiKey;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

export function instanceUrls(name: string, gatewayToken?: string, terminalToken?: string | null) {
  const host = `${name}.${INSTANCE_BASE_DOMAIN}`;
  const terminalPath = terminalToken ? `/terminal/${terminalToken}/` : "/terminal/";
  return {
    chat: gatewayToken ? `https://${host}/chat#token=${gatewayToken}` : `https://${host}`,
    terminal: `https://${host}${terminalPath}`,
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  return localStorage.getItem("agentbox-token");
}

export function getTokenWallet(): string | null {
  return localStorage.getItem("agentbox-wallet");
}

export function setToken(token: string, walletAddress: string) {
  localStorage.setItem("agentbox-token", token);
  localStorage.setItem("agentbox-wallet", walletAddress);
}

export function clearToken() {
  localStorage.removeItem("agentbox-token");
  localStorage.removeItem("agentbox-wallet");
  localStorage.removeItem("agentbox-admin");
}

export function getIsAdmin(): boolean {
  return localStorage.getItem("agentbox-admin") === "true";
}

export function setIsAdmin(value: boolean) {
  localStorage.setItem("agentbox-admin", String(value));
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

let handledUnauthorized = false;

function handleUnauthorized(status: number) {
  if (status !== 401 || handledUnauthorized) {
    return;
  }

  handledUnauthorized = true;
  clearToken();
  toast.error("Session expired, please reconnect");
  setTimeout(() => {
    window.location.reload();
  }, 300);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...options.headers,
    },
  });

  if (!res.ok) {
    handleUnauthorized(res.status);
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? "Request failed");
  }

  return res.json();
}

function createPaymentFetch(signer: TransactionSigner) {
  const client = new x402Client();
  client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl: RPC_URL }));
  return wrapFetchWithPayment(fetch, client);
}

export const api = {
  instances: {
    list: (all?: boolean) =>
      request<{ instances: Instance[] }>(`/instances${all ? "?all=true" : ""}`),
    get: (name: string) => request<Instance>(`/instances/${name}`),
    create: async (
      signer: TransactionSigner,
      opts?: { name?: string; telegramBotToken?: string; arenaEnabled?: boolean },
    ) => {
      const payFetch = createPaymentFetch(signer);
      const body: Record<string, string | boolean> = {};
      if (opts?.name) body.name = opts.name;
      if (opts?.telegramBotToken) body.telegramBotToken = opts.telegramBotToken;
      if (opts?.arenaEnabled) body.arenaEnabled = true;
      const res = await payFetch(`${API_URL}/instances`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        handleUnauthorized(res.status);
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        throw new ApiError(res.status, errBody.error ?? "Request failed");
      }
      return res.json() as Promise<Instance>;
    },
    update: (name: string, data: { name: string }) =>
      request<Instance>(`/instances/${name}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    updateAgent: (name: string, data: { name?: string; description?: string }) =>
      request<{ ok: boolean }>(`/instances/${name}/agent`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (name: string) => request<{ ok: boolean }>(`/instances/${name}`, { method: "DELETE" }),
    mint: (name: string) => request<{ ok: boolean }>(`/instances/${name}/mint`, { method: "POST" }),
    restart: (name: string) =>
      request<{ ok: boolean }>(`/instances/${name}/restart`, { method: "POST" }),
    rebuild: (name: string) => request<Instance>(`/instances/${name}/rebuild`, { method: "POST" }),
    extend: async (name: string, signer: TransactionSigner) => {
      const payFetch = createPaymentFetch(signer);
      const res = await payFetch(`${API_URL}/instances/${name}/extend`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        handleUnauthorized(res.status);
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        throw new ApiError(res.status, errBody.error ?? "Request failed");
      }
      return res.json() as Promise<Instance>;
    },
    access: (name: string) => request<InstanceAccess>(`/instances/${name}/access`),
    health: (name: string) => request<InstanceHealth>(`/instances/${name}/health`),
    expiring: (days?: number) =>
      request<{ instances: Instance[] }>(`/instances/expiring${days ? `?days=${days}` : ""}`),
    sync: () =>
      request<{ claimed: number; recovered: number; instances: Instance[] }>(`/instances/sync`, {
        method: "POST",
      }),
    telegram: (name: string, telegramBotToken: string) =>
      request<{ ok: boolean; botUsername?: string; status?: string }>(
        `/instances/${name}/telegram`,
        {
          method: "POST",
          body: JSON.stringify({ telegramBotToken }),
        },
      ),
    telegramStatus: (name: string) =>
      request<{
        status: "live" | "starting" | "error" | "not_configured";
        botUsername?: string;
        error?: string;
      }>(`/instances/${name}/telegram/status`),
    withdraw: (name: string, data: { token: "SOL" | "USDC"; amount: string }) =>
      request<{ ok: boolean; signature: string }>(`/instances/${name}/withdraw`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    pairing: (name: string, code: string) =>
      request<{ ok: boolean }>(`/instances/${name}/pairing`, {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
  },
};
