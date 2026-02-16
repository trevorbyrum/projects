/**
 * Monitoring tools — Prometheus metrics + Uptime Kuma availability.
 * Merged from prometheus.ts + uptimekuma.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Prometheus ──────────────────────────────────────────────

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://Prometheus:9090";

async function promFetch(path: string): Promise<any> {
  const res = await fetch(`${PROMETHEUS_URL}${path}`);
  if (!res.ok) throw new Error(`Prometheus ${path}: ${res.status} - ${await res.text()}`);
  return res.json();
}

const promTools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  query: {
    description: "Execute an instant PromQL query",
    params: { query: "PromQL expression", time: "(optional) Evaluation timestamp (RFC3339 or unix)" },
    handler: async ({ query, time }) => {
      const params = new URLSearchParams({ query });
      if (time) params.set("time", time);
      return promFetch(`/api/v1/query?${params}`);
    },
  },
  query_range: {
    description: "Execute a range PromQL query over a time window",
    params: {
      query: "PromQL expression",
      start: "Start timestamp (RFC3339 or unix)",
      end: "End timestamp (RFC3339 or unix)",
      step: "Query resolution step (e.g., '15s', '1m', '5m')",
    },
    handler: async ({ query, start, end, step }) => {
      const params = new URLSearchParams({ query, start, end, step: step || "60s" });
      return promFetch(`/api/v1/query_range?${params}`);
    },
  },
  targets: {
    description: "List all scrape targets and their health status",
    params: {},
    handler: async () => promFetch("/api/v1/targets"),
  },
  alerts: {
    description: "List all active alerts",
    params: {},
    handler: async () => promFetch("/api/v1/alerts"),
  },
  rules: {
    description: "List all alerting and recording rules",
    params: {},
    handler: async () => promFetch("/api/v1/rules"),
  },
  label_values: {
    description: "Get all values for a given label name (useful for discovering metrics)",
    params: { label: "Label name (e.g., '__name__' for all metric names, 'job' for all jobs)" },
    handler: async ({ label }) => promFetch(`/api/v1/label/${encodeURIComponent(label)}/values`),
  },
  series: {
    description: "Find time series matching a set of label matchers",
    params: { match: "Series selector (e.g., '{job=\"prometheus\"}')" },
    handler: async ({ match }) => {
      const params = new URLSearchParams({ "match[]": match });
      return promFetch(`/api/v1/series?${params}`);
    },
  },
  status: {
    description: "Get Prometheus server build info and runtime status",
    params: {},
    handler: async () => {
      const [build, runtime, tsdb] = await Promise.all([
        promFetch("/api/v1/status/buildinfo"),
        promFetch("/api/v1/status/runtimeinfo"),
        promFetch("/api/v1/status/tsdb"),
      ]);
      return { build: build.data, runtime: runtime.data, tsdb: tsdb.data };
    },
  },
};

// ── Uptime Kuma ─────────────────────────────────────────────

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

const kumaTools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
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
    handler: async ({ id, hours }) => kumaFetch(`/monitors/${id}/beats?hours=${hours || 24}`),
  },
  add_monitor: {
    description: "Add a new HTTP(s) monitor",
    params: {
      name: "Display name for the monitor",
      url: "URL to monitor",
      interval: "(optional) Check interval in seconds, default 60",
    },
    handler: async ({ name, url, interval }) => kumaFetch("/monitors", "POST", { name, url, type: "http", interval: interval || 60 }),
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

// ── Registration ────────────────────────────────────────────

function registerToolPair(
  server: McpServer,
  listName: string, listDesc: string,
  callName: string, callDesc: string,
  tools: Record<string, any>
) {
  server.tool(listName, listDesc, {}, async () => {
    const toolList = Object.entries(tools).map(([name, def]) => ({
      tool: name, description: def.description, params: def.params,
    }));
    return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
  });

  server.tool(callName, callDesc, {
    tool: z.string().describe(`Tool name from ${listName}`),
    params: z.record(z.any()).optional().describe("Tool parameters as object"),
  }, async ({ tool, params }) => {
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
  });
}

export function registerPrometheusTools(server: McpServer) {
  registerToolPair(server,
    "prometheus_list", "List all available Prometheus monitoring tools",
    "prometheus_call", "Query Prometheus metrics and monitoring data. Use prometheus_list to see available tools.",
    promTools
  );
}

export function registerUptimeKumaTools(server: McpServer) {
  registerToolPair(server,
    "uptime_list", "List all available Uptime Kuma monitoring tools",
    "uptime_call", "Monitor service uptime and availability. Use uptime_list to see available tools.",
    kumaTools
  );
}
