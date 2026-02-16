import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pgQuery as query } from "../utils/postgres.js";

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  query: {
    description: "Execute a SELECT query against PostgreSQL",
    params: { sql: "SQL SELECT query to execute", params: "JSON array of query parameters for $1, $2, etc. (optional)" },
    handler: async ({ sql, params: queryParams }) => {
      const trimmed = sql.trim().toLowerCase();
      if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
        return { error: "Only SELECT queries allowed. Use execute for mutations." };
      }
      const parsedParams = queryParams ? (typeof queryParams === "string" ? JSON.parse(queryParams) : queryParams) : [];
      const result = await query(sql, parsedParams);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  },
  execute: {
    description: "Execute INSERT, UPDATE, or DELETE query",
    params: { sql: "SQL mutation query", params: "JSON array of query parameters (optional)" },
    handler: async ({ sql, params: queryParams }) => {
      const parsedParams = queryParams ? (typeof queryParams === "string" ? JSON.parse(queryParams) : queryParams) : [];
      const result = await query(sql, parsedParams);
      return { rowCount: result.rowCount, command: result.command };
    },
  },
  list_tables: {
    description: "List all tables in the database",
    params: { schema: "Schema name (default: public)" },
    handler: async ({ schema = "public" }) => {
      const result = await query(
        `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
        [schema]
      );
      return { tables: result.rows };
    },
  },
  describe_table: {
    description: "Get column information for a table",
    params: { table: "Table name", schema: "Schema name (default: public)" },
    handler: async ({ table, schema = "public" }) => {
      const result = await query(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table]
      );
      return { table, columns: result.rows };
    },
  },
  list_indexes: {
    description: "List indexes on a table",
    params: { table: "Table name" },
    handler: async ({ table }) => {
      const result = await query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, [table]);
      return { table, indexes: result.rows };
    },
  },
};

export function registerPostgresTools(server: McpServer) {
  server.tool(
    "pg_list",
    "List all available PostgreSQL database tools and their parameters",
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
    "pg_call",
    "Execute a PostgreSQL tool. Use pg_list to see available tools.",
    {
      tool: z.string().describe("Tool name from pg_list"),
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
