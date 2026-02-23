import type { TransactionSigner } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toast } from "sonner";

export type Instance = {
  id: number;
  name: string;
  ownerWallet: string;
  status: string;
  ip: string;
  nftMint?: string | null;
  vmWallet?: string | null;
  gatewayToken?: string;
  terminalToken?: string | null;
  provisioningStep?: string | null;
  createdAt: string;
  expiresAt: string;
};

export type InstanceAccess = Instance & {
  ssh: string;
  chatUrl: string;
  terminalUrl: string;
  rootPassword: string | null;
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
    get: (id: number) => request<Instance>(`/instances/${id}`),
    create: async (signer: TransactionSigner) => {
      const payFetch = createPaymentFetch(signer);
      const res = await payFetch(`${API_URL}/instances`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        handleUnauthorized(res.status);
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new ApiError(res.status, body.error ?? "Request failed");
      }
      return res.json() as Promise<Instance>;
    },
    update: (id: number, data: { name: string }) =>
      request<Instance>(`/instances/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    updateAgent: (id: number, data: { name?: string; description?: string }) =>
      request<{ ok: boolean }>(`/instances/${id}/agent`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: number) => request<{ ok: boolean }>(`/instances/${id}`, { method: "DELETE" }),
    mint: (id: number) => request<{ ok: boolean }>(`/instances/${id}/mint`, { method: "POST" }),
    restart: (id: number) =>
      request<{ ok: boolean }>(`/instances/${id}/restart`, { method: "POST" }),
    extend: (id: number) => request<Instance>(`/instances/${id}/extend`, { method: "POST" }),
    access: (id: number) => request<InstanceAccess>(`/instances/${id}/access`),
    health: (id: number) => request<InstanceHealth>(`/instances/${id}/health`),
    expiring: (days?: number) =>
      request<{ instances: Instance[] }>(`/instances/expiring${days ? `?days=${days}` : ""}`),
    sync: () =>
      request<{ claimed: number; recovered: number; instances: Instance[] }>(`/instances/sync`, {
        method: "POST",
      }),
  },
};
