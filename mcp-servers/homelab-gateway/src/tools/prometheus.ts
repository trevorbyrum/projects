import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://Prometheus:9090";

async function promFetch(path: string): Promise<any> {
  const res = await fetch(`${PROMETHEUS_URL}${path}`);
  if (!res.ok) throw new Error(`Prometheus ${path}: ${res.status} - ${await res.text()}`);
  return res.json();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
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

export function registerPrometheusTools(server: McpServer) {
  server.tool(
    "prometheus_list",
    "List all available Prometheus monitoring tools",
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
    "prometheus_call",
    "Query Prometheus metrics and monitoring data. Use prometheus_list to see available tools.",
    {
      tool: z.string().describe("Tool name from prometheus_list"),
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
