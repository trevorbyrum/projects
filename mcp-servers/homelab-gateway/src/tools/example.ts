import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Example tool registration file.
 * 
 * Copy this file and modify it to create your own tools.
 * Then import and register in src/index.ts
 */

export function registerExampleTools(server: McpServer) {
  // Example: Simple tool with no parameters
  server.tool(
    "example_hello",
    "A simple hello world tool",
    {},
    async () => {
      return {
        content: [{ type: "text", text: JSON.stringify({ message: "Hello from MCP!" }, null, 2) }],
      };
    }
  );

  // Example: Tool with required and optional parameters
  server.tool(
    "example_greet",
    "Greet someone by name",
    {
      name: z.string().describe("The name to greet"),
      enthusiasm: z.number().optional().default(1).describe("Number of exclamation marks"),
    },
    async ({ name, enthusiasm }) => {
      const exclamation = "!".repeat(enthusiasm);
      return {
        content: [{ type: "text", text: JSON.stringify({ greeting: `Hello, ${name}${exclamation}` }, null, 2) }],
      };
    }
  );

  // Example: Tool that calls an external API
  server.tool(
    "example_api_call",
    "Example of calling an external API (replace with your own)",
    {
      endpoint: z.string().describe("API endpoint to call"),
    },
    async ({ endpoint }) => {
      // Get API URL from environment variable - never hardcode!
      const apiUrl = process.env.MY_API_URL;
      if (!apiUrl) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "MY_API_URL not configured" }, null, 2) }],
        };
      }

      try {
        const response = await fetch(`${apiUrl}${endpoint}`);
        const data = await response.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(error) }, null, 2) }],
        };
      }
    }
  );
}
