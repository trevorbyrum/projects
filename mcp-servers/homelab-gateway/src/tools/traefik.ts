import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Traefik API — internal Docker network URL (dashboard API on :8080)
const TRAEFIK_API_URL = process.env.TRAEFIK_API_URL || "http://traefik:8080";

async function traefikFetch(path: string): Promise<any> {
  const res = await fetch(`${TRAEFIK_API_URL}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Traefik API ${res.status}: ${body}`);
  }
  return res.json();
}

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ── Overview ───────────────────────────────────────────────

  get_overview: {
    description: "Get Traefik dashboard overview: router/service/middleware counts, active providers, feature flags",
    params: {},
    handler: async () => traefikFetch("/api/overview"),
  },

  get_version: {
    description: "Get Traefik version info",
    params: {},
    handler: async () => traefikFetch("/api/version"),
  },

  // ── Routers ────────────────────────────────────────────────

  list_routers: {
    description: "List all HTTP routers with their rules, entrypoints, service bindings, and status",
    params: {},
    handler: async () => traefikFetch("/api/http/routers"),
  },

  get_router: {
    description: "Get detailed info for a specific HTTP router",
    params: { name: "Router name (e.g. 'dify-api@docker')" },
    handler: async (p) => traefikFetch(`/api/http/routers/${encodeURIComponent(p.name)}`),
  },

  // ── Services ───────────────────────────────────────────────

  list_services: {
    description: "List all HTTP services with their load balancer URLs and health status",
    params: {},
    handler: async () => traefikFetch("/api/http/services"),
  },

  get_service: {
    description: "Get detailed info for a specific HTTP service",
    params: { name: "Service name (e.g. 'dify-api@docker')" },
    handler: async (p) => traefikFetch(`/api/http/services/${encodeURIComponent(p.name)}`),
  },

  // ── Middlewares ─────────────────────────────────────────────

  list_middlewares: {
    description: "List all HTTP middlewares (auth, rate limiting, headers, etc.)",
    params: {},
    handler: async () => traefikFetch("/api/http/middlewares"),
  },

  get_middleware: {
    description: "Get detailed info for a specific middleware",
    params: { name: "Middleware name" },
    handler: async (p) => traefikFetch(`/api/http/middlewares/${encodeURIComponent(p.name)}`),
  },

  // ── Entrypoints ────────────────────────────────────────────

  list_entrypoints: {
    description: "List all entrypoints (ports Traefik listens on: http/80, https/443, etc.)",
    params: {},
    handler: async () => traefikFetch("/api/entrypoints"),
  },

  // ── TCP (if any) ───────────────────────────────────────────

  list_tcp_routers: {
    description: "List TCP routers (non-HTTP traffic routing)",
    params: {},
    handler: async () => traefikFetch("/api/tcp/routers"),
  },

  list_tcp_services: {
    description: "List TCP services",
    params: {},
    handler: async () => traefikFetch("/api/tcp/services"),
  },

  // ── Diagnostics ────────────────────────────────────────────

  find_route: {
    description: "Find which router handles a given hostname (searches all routers for a Host match)",
    params: { hostname: "Hostname to search for (e.g. 'your-domain.com')" },
    handler: async (p) => {
      const routers = await traefikFetch("/api/http/routers");
      const matches = routers.filter((r: any) =>
        r.rule && r.rule.toLowerCase().includes(p.hostname.toLowerCase())
      );
      if (matches.length === 0) {
        return { hostname: p.hostname, matches: [], message: "No routers match this hostname" };
      }
      return { hostname: p.hostname, matches };
    },
  },

  check_conflicts: {
    description: "Check for routing conflicts: duplicate rules, overlapping paths, priority issues",
    params: {},
    handler: async () => {
      const routers = await traefikFetch("/api/http/routers");
      const ruleMap: Record<string, any[]> = {};
      for (const r of routers) {
        const key = r.rule || "no-rule";
        if (!ruleMap[key]) ruleMap[key] = [];
        ruleMap[key].push({ name: r.name, priority: r.priority, status: r.status, entryPoints: r.entryPoints });
      }
      const conflicts = Object.entries(ruleMap)
        .filter(([, v]) => v.length > 1)
        .map(([rule, routers]) => ({ rule, routers }));

      const errors = routers.filter((r: any) => r.status === "disabled" || r.status === "warning");

      return {
        total_routers: routers.length,
        duplicate_rules: conflicts,
        errored_routers: errors,
        healthy: conflicts.length === 0 && errors.length === 0,
      };
    },
  },
};

export function registerTraefikTools(server: McpServer) {
  server.tool(
    "traefik_list",
    "List all available Traefik reverse proxy tools. Traefik manages HTTP routing for all services. " +
    "Tools cover: overview/version, router listing/inspection, service listing/inspection, " +
    "middleware listing, entrypoints, TCP routers/services, and diagnostics (find_route, check_conflicts). " +
    "All read-only — no mutations. Use find_route to debug which router handles a hostname, " +
    "and check_conflicts to detect routing issues.",
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
    "traefik_call",
    "Execute a Traefik tool. Use traefik_list to see available tools. " +
    "Read-only inspection of the Traefik reverse proxy: routers, services, middlewares, entrypoints, and routing diagnostics.",
    {
      tool: z.string().describe("Tool name from traefik_list"),
      params: z.record(z.any()).optional().describe("Tool parameters as object"),
    },
    async ({ tool, params }) => {
      const toolDef = tools[tool];
      if (!toolDef) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
      }
      try {
        const result = await toolDef.handler(params || {});
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}

