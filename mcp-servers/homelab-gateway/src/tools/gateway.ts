import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const N8N_API_URL = process.env.N8N_API_URL || "";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const NEO4J_URL = process.env.NEO4J_URL || "bolt://localhost:7687";

async function checkService(name: string, url: string): Promise<{ status: string; latency?: number }> {
  if (!url) {
    return { status: "not_configured" };
  }
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    // Adjust endpoint based on service
    let checkUrl = url;
    if (name === "qdrant") {
      checkUrl = url.replace(/\/$/, "") + "/";
    } else if (name === "neo4j") {
      // Neo4j bolt doesn't have HTTP health check, use HTTP port
      checkUrl = url.replace("bolt://", "http://").replace(":7687", ":7474");
    }

    const response = await fetch(checkUrl, {
      signal: controller.signal,
      method: "GET",
    });
    clearTimeout(timeout);

    const latency = Date.now() - start;
    return { status: response.ok ? "healthy" : "unhealthy", latency };
  } catch (error) {
    return { status: "unreachable" };
  }
}

export function registerGatewayTools(server: McpServer) {
  // Gateway status - check all services
  server.tool(
    "gateway_status",
    "Check the health status of the gateway and all connected services",
    {},
    async () => {
      const [n8n, qdrant, neo4j] = await Promise.all([
        checkService("n8n", N8N_API_URL),
        checkService("qdrant", QDRANT_URL),
        checkService("neo4j", NEO4J_URL),
      ]);

      const result = {
        gateway: {
          status: "online",
          version: "1.0.0",
          timestamp: new Date().toISOString(),
        },
        services: {
          n8n: { configured: !!N8N_API_URL, ...n8n },
          qdrant: { configured: !!QDRANT_URL, ...qdrant },
          neo4j: { configured: !!NEO4J_URL, ...neo4j },
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Gateway config - get environment config (read-only for security)
  server.tool(
    "gateway_config",
    "Get gateway configuration (shows which services are configured, not URLs)",
    {},
    async () => {
      const config = {
        services: {
          n8n: { configured: !!process.env.N8N_API_URL && !!process.env.N8N_API_KEY },
          qdrant: { configured: !!process.env.QDRANT_URL },
          neo4j: { configured: !!process.env.NEO4J_URL && !!process.env.NEO4J_PASSWORD },
        },
        environment: process.env.NODE_ENV || "development",
      };

      return {
        content: [{ type: "text", text: JSON.stringify(config, null, 2) }],
      };
    }
  );
}
