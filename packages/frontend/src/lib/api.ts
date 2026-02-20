import type { WalletSession } from "@solana/client";
import { createWalletTransactionSigner } from "@solana/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

export type Instance = {
  id: number;
  name: string;
  userId: string;
  status: string;
  ip: string;
  solanaWalletAddress: string | null;
  gatewayToken: string;
  agentId?: string | null;
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

const API_URL = import.meta.env.VITE_API_URL ?? "";
const INSTANCE_BASE_DOMAIN = import.meta.env.VITE_INSTANCE_BASE_DOMAIN ?? "agentbox.fyi";
const HELIUS_KEY = import.meta.env.VITE_HELIUS_API_KEY ?? "";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

export function instanceUrls(name: string, gatewayToken?: string) {
  const host = `${name}.${INSTANCE_BASE_DOMAIN}`;
  return {
    chat: gatewayToken ? `https://${host}/overview?token=${gatewayToken}` : `https://${host}`,
    terminal: `https://${host}/terminal/`,
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

export function setToken(token: string) {
  localStorage.setItem("agentbox-token", token);
}

export function clearToken() {
  localStorage.removeItem("agentbox-token");
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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? "Request failed");
  }

  return res.json();
}

function createPaymentFetch(session: WalletSession) {
  const { signer } = createWalletTransactionSigner(session);
  const client = new x402Client();
  client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl: RPC_URL }));
  return wrapFetchWithPayment(fetch, client);
}

export const api = {
  instances: {
    list: (all?: boolean) =>
      request<{ instances: Instance[] }>(`/instances${all ? "?all=true" : ""}`),
    get: (id: number) => request<Instance>(`/instances/${id}`),
    create: async (session: WalletSession) => {
      const payFetch = createPaymentFetch(session);
      const res = await payFetch(`${API_URL}/api/instances`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) {
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
    delete: (id: number) => request<{ ok: boolean }>(`/instances/${id}`, { method: "DELETE" }),
    restart: (id: number) =>
      request<{ ok: boolean }>(`/instances/${id}/restart`, { method: "POST" }),
    extend: (id: number) => request<Instance>(`/instances/${id}/extend`, { method: "POST" }),
    access: (id: number) => request<InstanceAccess>(`/instances/${id}/access`),
    health: (id: number) => request<InstanceHealth>(`/instances/${id}/health`),
    expiring: (days?: number) =>
      request<{ instances: Instance[] }>(`/instances/expiring${days ? `?days=${days}` : ""}`),
  },
};
