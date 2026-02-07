import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerGatewayTools(server: McpServer) {
  // Gateway status - basic health check
  server.tool(
    "gateway_status",
    "Check the health status of the gateway",
    {},
    async () => {
      const result = {
        status: "online",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
