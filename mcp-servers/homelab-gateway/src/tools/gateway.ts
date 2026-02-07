import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const N8N_API_URL = process.env.N8N_API_URL || "https://n8n.8-bit-byrum.com";
const QDRANT_URL = process.env.QDRANT_URL || "http://Qdrant:6333";
const NEO4J_URL = process.env.NEO4J_URL || "bolt://Neo4j:7687";

async function checkService(name: string, url: string): Promise<{ status: string; latency?: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let checkUrl = url;
    if (name === "qdrant") checkUrl = url.replace(/\/$/, "") + "/";
    else if (name === "neo4j") checkUrl = url.replace("bolt://", "http://").replace(":7687", ":7474");

    const response = await fetch(checkUrl, { signal: controller.signal, method: "GET" });
    clearTimeout(timeout);
    return { status: response.ok ? "healthy" : "unhealthy", latency: Date.now() - start };
  } catch {
    return { status: "unreachable" };
  }
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  status: {
    description: "Check the health status of the gateway and all connected services",
    params: {},
    handler: async () => {
      const [n8n, qdrant, neo4j] = await Promise.all([
        checkService("n8n", N8N_API_URL),
        checkService("qdrant", QDRANT_URL),
        checkService("neo4j", NEO4J_URL),
      ]);
      return {
        gateway: { status: "online", version: "2.0.0", timestamp: new Date().toISOString() },
        services: {
          n8n: { url: N8N_API_URL, ...n8n },
          qdrant: { url: QDRANT_URL, ...qdrant },
          neo4j: { url: NEO4J_URL, ...neo4j },
        },
      };
    },
  },
  config: {
    description: "Get gateway configuration (service URLs, not secrets)",
    params: {},
    handler: async () => ({
      services: {
        n8n: { url: N8N_API_URL, configured: !!process.env.N8N_API_KEY },
        qdrant: { url: QDRANT_URL },
        neo4j: { url: NEO4J_URL, user: process.env.NEO4J_USER || "neo4j" },
      },
      environment: process.env.NODE_ENV || "development",
    }),
  },
};

export function registerGatewayTools(server: McpServer) {
  server.tool(
    "gateway_list",
    "List all available gateway utility tools",
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
    "gateway_call",
    "Execute a gateway tool. Use gateway_list to see available tools.",
    {
      tool: z.string().describe("Tool name from gateway_list"),
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
