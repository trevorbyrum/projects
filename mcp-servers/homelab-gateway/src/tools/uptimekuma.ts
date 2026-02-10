import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KUMA_API_URL = process.env.UPTIME_KUMA_API_URL || "http://Uptime-Kuma-API:8000";
const KUMA_API_USER = process.env.UPTIME_KUMA_API_USER || "";
const KUMA_API_PASS = process.env.UPTIME_KUMA_API_PASS || "";

let cachedToken: string | null = null;

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await fetch(`${KUMA_API_URL}/login/access-token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(KUMA_API_USER)}&password=${encodeURIComponent(KUMA_API_PASS)}`,
  });
  if (!res.ok) throw new Error(`Uptime-Kuma login failed: ${res.status} - ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  return cachedToken!;
}

async function kumaFetch(path: string, method = "GET", body?: any): Promise<any> {
  const token = await getToken();
  const res = await fetch(`${KUMA_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    cachedToken = null;
    const token2 = await getToken();
    const res2 = await fetch(`${KUMA_API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token2}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res2.ok) throw new Error(`Uptime-Kuma ${method} ${path}: ${res2.status} - ${await res2.text()}`);
    return res2.json();
  }
  if (!res.ok) throw new Error(`Uptime-Kuma ${method} ${path}: ${res.status} - ${await res.text()}`);
  return res.json();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  monitors: {
    description: "List all monitors and their current status",
    params: {},
    handler: async () => kumaFetch("/monitors"),
  },
  monitor: {
    description: "Get details for a specific monitor by ID",
    params: { id: "Monitor ID" },
    handler: async ({ id }) => kumaFetch(`/monitors/${id}`),
  },
  heartbeats: {
    description: "Get recent heartbeats (up/down history) for a monitor",
    params: { id: "Monitor ID", hours: "(optional) Hours of history, default 24" },
    handler: async ({ id, hours }) => {
      const h = hours || 24;
      return kumaFetch(`/monitors/${id}/beats?hours=${h}`);
    },
  },
  add_monitor: {
    description: "Add a new HTTP(s) monitor",
    params: {
      name: "Display name for the monitor",
      url: "URL to monitor",
      interval: "(optional) Check interval in seconds, default 60",
    },
    handler: async ({ name, url, interval }) => {
      return kumaFetch("/monitors", "POST", {
        name,
        url,
        type: "http",
        interval: interval || 60,
      });
    },
  },
  pause_monitor: {
    description: "Pause a monitor",
    params: { id: "Monitor ID" },
    handler: async ({ id }) => kumaFetch(`/monitors/${id}/pause`, "POST"),
  },
  resume_monitor: {
    description: "Resume a paused monitor",
    params: { id: "Monitor ID" },
    handler: async ({ id }) => kumaFetch(`/monitors/${id}/resume`, "POST"),
  },
  delete_monitor: {
    description: "Delete a monitor",
    params: { id: "Monitor ID" },
    handler: async ({ id }) => kumaFetch(`/monitors/${id}`, "DELETE"),
  },
  info: {
    description: "Get Uptime Kuma server info and version",
    params: {},
    handler: async () => kumaFetch("/info"),
  },
};

export function registerUptimeKumaTools(server: McpServer) {
  server.tool(
    "uptime_list",
    "List all available Uptime Kuma monitoring tools",
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
    "uptime_call",
    "Monitor service uptime and availability. Use uptime_list to see available tools.",
    {
      tool: z.string().describe("Tool name from uptime_list"),
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
