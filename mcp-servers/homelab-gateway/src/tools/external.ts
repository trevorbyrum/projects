import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { readFileSync } from "fs";

interface ExternalServer {
  url: string;
  description: string;
  enabled: boolean;
  auth?: { type: string; token: string } | null;
  transport?: "sse" | "http";
}

interface ExternalConfig {
  servers: Record<string, ExternalServer>;
}

// Cache for MCP clients
const clients: Map<string, Client> = new Map();
const toolCache: Map<string, any[]> = new Map();

function loadConfig(): ExternalConfig {
  try {
    const configPath = process.env.EXTERNAL_MCP_CONFIG || "/app/external-mcp.json";
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.log("No external MCP config found, skipping external servers");
    return { servers: {} };
  }
}

async function getClient(name: string, server: ExternalServer): Promise<Client> {
  if (clients.has(name)) {
    return clients.get(name)!;
  }

  const client = new Client({
    name: `homelab-gateway-${name}`,
    version: "1.0.0",
  });

  const headers: Record<string, string> = {};
  if (server.auth?.type === "bearer" && server.auth.token) {
    headers["Authorization"] = `Bearer ${server.auth.token}`;
  }

  const url = new URL(server.url);
  const transport = server.transport === "sse"
    ? new SSEClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });

  await client.connect(transport);
  clients.set(name, client);

  return client;
}

async function getTools(name: string, server: ExternalServer): Promise<any[]> {
  if (toolCache.has(name)) {
    return toolCache.get(name)!;
  }

  try {
    const client = await getClient(name, server);
    const result = await client.listTools();
    const tools = result.tools || [];
    toolCache.set(name, tools);
    return tools;
  } catch (err: any) {
    console.error(`Failed to get tools from ${name}:`, err.message);
    return [];
  }
}

async function callTool(name: string, server: ExternalServer, toolName: string, args: any): Promise<any> {
  const client = await getClient(name, server);
  const result = await client.callTool({ name: toolName, arguments: args });
  return result;
}

export function registerExternalTools(mcpServer: McpServer) {
  const config = loadConfig();

  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) {
      console.log(`External MCP '${name}' is disabled, skipping`);
      continue;
    }

    console.log(`Registering external MCP: ${name} -> ${server.url}`);

    // Register {name}_list tool
    mcpServer.tool(
      `${name}_list`,
      `List available tools from external MCP: ${server.description}`,
      {},
      async () => {
        try {
          const tools = await getTools(name, server);
          const toolList = tools.map((t: any) => ({
            tool: t.name,
            description: t.description,
            params: t.inputSchema?.properties || {},
          }));
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                server: name,
                description: server.description,
                url: server.url,
                tools: toolList,
              }, null, 2)
            }]
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
            isError: true,
          };
        }
      }
    );

    // Register {name}_call tool
    mcpServer.tool(
      `${name}_call`,
      `Execute a tool from external MCP: ${server.description}. Use ${name}_list to see available tools.`,
      {
        tool: z.string().describe(`Tool name from ${name}_list`),
        params: z.record(z.any()).optional().describe("Tool parameters as object"),
      },
      async ({ tool, params }) => {
        try {
          const result = await callTool(name, server, tool, params || {});

          // Pass through the content from the external MCP
          if (result.content) {
            return { content: result.content };
          }

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
            isError: true,
          };
        }
      }
    );
  }
}
