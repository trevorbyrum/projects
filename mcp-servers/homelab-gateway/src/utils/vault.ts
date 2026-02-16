/**
 * Shared HashiCorp Vault KV v2 helpers.
 * Used by blueprints.ts and recipes.ts for recipe/template storage.
 */

const VAULT_ADDR = process.env.VAULT_ADDR || "http://Vault:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";
const VAULT_MOUNT = process.env.VAULT_MOUNT || "homelab";

export async function vaultGet(path: string): Promise<any> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/data/${path}`, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Vault GET ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data?.data || null;
}

export async function vaultPut(path: string, data: Record<string, any>): Promise<void> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/data/${path}`, {
    method: "POST",
    headers: { "X-Vault-Token": VAULT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`Vault PUT ${res.status}: ${await res.text()}`);
}

export async function vaultDelete(path: string): Promise<void> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/metadata/${path}`, {
    method: "DELETE",
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Vault DELETE ${res.status}: ${await res.text()}`);
}

export async function vaultList(prefix: string): Promise<string[]> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/metadata/${prefix}?list=true`, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Vault LIST ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data?.keys || [];
}
