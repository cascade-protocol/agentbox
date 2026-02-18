export type Instance = {
  id: number;
  name: string;
  userId: string;
  status: string;
  ip: string;
  walletAddress: string | null;
  gatewayToken: string;
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

const INSTANCE_BASE_DOMAIN = "agentbox.cascade.fyi";

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
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? "Request failed");
  }

  return res.json();
}

export const api = {
  instances: {
    list: () => request<{ instances: Instance[] }>("/instances"),
    get: (id: number) => request<Instance>(`/instances/${id}`),
    create: (userId: string) =>
      request<Instance>("/instances", {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
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
