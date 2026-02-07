import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
      throw new Error("PostgreSQL not configured - check POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB");
    }
    pool = new Pool({
      host: POSTGRES_HOST,
      port: POSTGRES_PORT,
      user: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      database: POSTGRES_DB,
    });
  }
  return pool;
}

async function query(sql: string, params: any[] = []): Promise<any> {
  const client = await getPool().connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

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
