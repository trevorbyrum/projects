import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://Vault:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";
const VAULT_MOUNT = process.env.VAULT_MOUNT || "homelab";

async function vaultRequest(method: string, path: string, body?: any): Promise<any> {
  if (!VAULT_TOKEN) {
    throw new Error("Vault not configured - check VAULT_TOKEN env var");
  }
  
  const url = `${VAULT_ADDR}/v1/${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      "X-Vault-Token": VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vault ${method} ${path}: ${response.status} - ${error}`);
  }

  if (response.status === 204) return { success: true };
  return response.json();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  store: {
    description: "Store a secret in HashiCorp Vault (KV v2)",
    params: { path: "Secret path (e.g., 'openrouter', 'services/github')", data: "JSON object of key-value pairs to store" },
    handler: async ({ path, data }) => {
      const parsedData = typeof data === "string" ? JSON.parse(data) : data;
      const result = await vaultRequest("POST", `${VAULT_MOUNT}/data/${path}`, { data: parsedData });
      return { status: "stored", path: `${VAULT_MOUNT}/data/${path}`, version: result.data?.version, created_time: result.data?.created_time };
    },
  },
  get: {
    description: "Retrieve a secret from HashiCorp Vault",
    params: { path: "Secret path (e.g., 'openrouter')" },
    handler: async ({ path }) => {
      const result = await vaultRequest("GET", `${VAULT_MOUNT}/data/${path}`);
      return { path, data: result.data?.data, metadata: { version: result.data?.metadata?.version, created_time: result.data?.metadata?.created_time } };
    },
  },
  list: {
    description: "List secret paths in Vault at a given prefix",
    params: { path: "Path prefix to list (empty for root)" },
    handler: async ({ path }) => {
      const listPath = path ? `${VAULT_MOUNT}/metadata/${path}` : `${VAULT_MOUNT}/metadata`;
      const result = await vaultRequest("LIST", listPath);
      return { path: path || "/", keys: result.data?.keys || [] };
    },
  },
  delete: {
    description: "Delete a secret from Vault (soft delete, can be undeleted)",
    params: { path: "Secret path to delete" },
    handler: async ({ path }) => {
      await vaultRequest("DELETE", `${VAULT_MOUNT}/data/${path}`);
      return { status: "deleted", path };
    },
  },
};

export function registerVaultTools(server: McpServer) {
  server.tool(
    "vault_list",
    "List all available HashiCorp Vault secrets tools",
    {},
    async () => {
      const toolList = Object.entries(tools).map(([name, def]) => ({
        tool: name,
        description: def.description,
        params: def.params,
      }));
      return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
    }
  );

  server.tool(
    "vault_call",
    "Execute a Vault tool. Use vault_list to see available tools.",
    {
      tool: z.string().describe("Tool name from vault_list"),
      params: z.record(z.any()).optional().describe("Tool parameters as object"),
    },
    async ({ tool, params }) => {
      const toolDef = tools[tool];
      if (!toolDef) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
      }
      try {
        const result = await toolDef.handler(params || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
