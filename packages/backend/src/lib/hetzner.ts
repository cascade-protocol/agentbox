import { logger } from "../logger";
import {
  HETZNER_LOCATIONS,
  HETZNER_SERVER_TYPE,
  HETZNER_SNAPSHOT_ID,
  HETZNER_SSH_KEY_IDS,
} from "./constants";
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
    ipv4: { ip: string; id: number };
  };
  datacenter: { name: string };
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
  for (const location of HETZNER_LOCATIONS) {
    const res = await fetch(`${API_BASE}/servers`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name,
        server_type: HETZNER_SERVER_TYPE,
        image: Number(HETZNER_SNAPSHOT_ID),
        location,
        start_after_create: true,
        user_data: userData,
        ssh_keys: HETZNER_SSH_KEY_IDS,
      }),
    });

    if (res.ok) {
      if (location !== HETZNER_LOCATIONS[0]) {
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
    `Hetzner create server failed: no capacity in any location (${HETZNER_LOCATIONS.join(", ")})`,
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

export async function rebuildServer(serverId: number, userData: string): Promise<ActionResponse> {
  const res = await fetch(`${API_BASE}/servers/${serverId}/actions/rebuild`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      image: Number(HETZNER_SNAPSHOT_ID),
      user_data: userData,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(`Hetzner rebuild server failed (${res.status}): ${body}`);
    throw new Error(`Hetzner rebuild server failed (${res.status})`);
  }

  return (await res.json()) as ActionResponse;
}

export async function deletePrimaryIp(primaryIpId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/primary_ips/${primaryIpId}`, {
    method: "DELETE",
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(`Hetzner delete primary IP failed (${res.status}): ${body}`);
    throw new Error(`Hetzner delete primary IP failed (${res.status})`);
  }
}
