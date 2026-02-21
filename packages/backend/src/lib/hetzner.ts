import { logger } from "../logger";
import { env } from "./env";

const API_BASE = "https://api.hetzner.cloud/v1";

function headers() {
  if (!env.HETZNER_API_TOKEN) {
    throw new Error("HETZNER_API_TOKEN is not configured");
  }
  return {
    Authorization: `Bearer ${env.HETZNER_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

type HetznerServer = {
  id: number;
  name: string;
  status: string;
  public_net: {
    ipv4: { ip: string };
  };
};

type CreateServerResponse = {
  server: HetznerServer;
  action: { id: number; status: string };
  root_password: string;
};

type GetServerResponse = {
  server: HetznerServer;
};

type ActionResponse = {
  action: { id: number; status: string };
};

export async function createServer(name: string, userData: string): Promise<CreateServerResponse> {
  const sshKeyIds = env.HETZNER_SSH_KEY_IDS
    ? env.HETZNER_SSH_KEY_IDS.split(",").map(Number)
    : undefined;

  const locations = env.HETZNER_LOCATIONS.split(",").map((l) => l.trim());

  for (const location of locations) {
    const res = await fetch(`${API_BASE}/servers`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name,
        server_type: env.HETZNER_SERVER_TYPE,
        image: Number(env.HETZNER_SNAPSHOT_ID),
        location,
        start_after_create: true,
        user_data: userData,
        ...(sshKeyIds && { ssh_keys: sshKeyIds }),
      }),
    });

    if (res.ok) {
      if (location !== locations[0]) {
        logger.info(`Hetzner: created in fallback location ${location}`);
      }
      return (await res.json()) as CreateServerResponse;
    }

    const body = await res.text();
    const isUnavailable = res.status === 412 && body.includes("resource_unavailable");
    if (!isUnavailable) {
      logger.error(`Hetzner create server failed (${res.status}): ${body}`);
      throw new Error(`Hetzner create server failed (${res.status})`);
    }
    logger.warn(`Hetzner: ${location} unavailable, trying next location...`);
  }

  throw new Error(
    `Hetzner create server failed: no capacity in any location (${locations.join(", ")})`,
  );
}

export async function getServer(id: number): Promise<GetServerResponse> {
  const res = await fetch(`${API_BASE}/servers/${id}`, {
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(`Hetzner get server failed (${res.status}): ${body}`);
    throw new Error(`Hetzner get server failed (${res.status})`);
  }

  return (await res.json()) as GetServerResponse;
}

export async function deleteServer(id: number): Promise<ActionResponse> {
  const res = await fetch(`${API_BASE}/servers/${id}`, {
    method: "DELETE",
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(`Hetzner delete server failed (${res.status}): ${body}`);
    throw new Error(`Hetzner delete server failed (${res.status})`);
  }

  return (await res.json()) as ActionResponse;
}

export async function restartServer(id: number): Promise<ActionResponse> {
  const res = await fetch(`${API_BASE}/servers/${id}/actions/reboot`, {
    method: "POST",
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(`Hetzner restart server failed (${res.status}): ${body}`);
    throw new Error(`Hetzner restart server failed (${res.status})`);
  }

  return (await res.json()) as ActionResponse;
}
