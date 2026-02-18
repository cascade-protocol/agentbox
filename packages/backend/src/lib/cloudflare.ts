import { env } from "./env";

const API_BASE = "https://api.cloudflare.com/client/v4";

function headers() {
  if (!env.CF_API_TOKEN) {
    throw new Error("CF_API_TOKEN is not configured");
  }
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
};

type CfResponse<T> = {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
};

export async function createDnsRecord(name: string, ip: string): Promise<DnsRecord> {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured");

  const res = await fetch(`${API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "A",
      name,
      content: ip,
      ttl: 60,
      proxied: false,
    }),
  });

  const body = (await res.json()) as CfResponse<DnsRecord>;
  if (!body.success) {
    throw new Error(
      `Cloudflare DNS create failed: ${body.errors.map((e) => e.message).join(", ")}`,
    );
  }

  return body.result;
}

export async function deleteDnsRecord(name: string): Promise<void> {
  if (!env.CF_ZONE_ID) throw new Error("CF_ZONE_ID is not configured");

  // Find the record by name first
  const searchRes = await fetch(
    `${API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    { headers: headers() },
  );

  const searchBody = (await searchRes.json()) as CfResponse<DnsRecord[]>;
  if (!searchBody.success) {
    throw new Error(
      `Cloudflare DNS search failed: ${searchBody.errors.map((e) => e.message).join(", ")}`,
    );
  }

  for (const record of searchBody.result) {
    await fetch(`${API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, {
      method: "DELETE",
      headers: headers(),
    });
  }
}
