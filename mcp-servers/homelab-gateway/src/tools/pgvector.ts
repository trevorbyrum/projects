import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";
import pgvector from "pgvector/pg";

const { Pool } = pg;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";

let pool: pg.Pool | null = null;

async function getPool(): Promise<pg.Pool> {
  if (!pool) {
    if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
      throw new Error("PostgreSQL not configured");
    }
    pool = new Pool({
      host: POSTGRES_HOST,
      port: POSTGRES_PORT,
      user: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      database: POSTGRES_DB,
    });
    
    const client = await pool.connect();
    try {
      await pgvector.registerType(client);
    } finally {
      client.release();
    }
  }
  return pool;
}

async function query(sql: string, params: any[] = []): Promise<any> {
  const p = await getPool();
  const client = await p.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  create_table: {
    description: "Create a table with a vector column for embeddings",
    params: { table: "Table name", dimensions: "Vector dimensions (default 1536)", extra_columns: "Additional column definitions (optional)" },
    handler: async ({ table, dimensions = 1536, extra_columns }) => {
      await query("CREATE EXTENSION IF NOT EXISTS vector");
      let sql = `CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, embedding vector(${dimensions})`;
      if (extra_columns) sql += `, ${extra_columns}`;
      sql += ", created_at TIMESTAMP DEFAULT NOW())";
      await query(sql);
      return { status: "created", table, dimensions };
    },
  },
  create_index: {
    description: "Create an index on a vector column for faster similarity search",
    params: { table: "Table name", column: "Vector column (default: embedding)", method: "Index method: ivfflat or hnsw (default: hnsw)" },
    handler: async ({ table, column = "embedding", method = "hnsw" }) => {
      const indexName = `${table}_${column}_idx`;
      let sql: string;
      if (method === "ivfflat") {
        sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING ivfflat (${column} vector_cosine_ops) WITH (lists = 100)`;
      } else {
        sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING hnsw (${column} vector_cosine_ops) WITH (m = 16, ef_construction = 64)`;
      }
      await query(sql);
      return { status: "created", index: indexName, method };
    },
  },
  insert: {
    description: "Insert a vector embedding into a table",
    params: { table: "Table name", embedding: "JSON array of numbers (the vector)", data: "JSON object of additional column values (optional)" },
    handler: async ({ table, embedding, data }) => {
      const parsedEmbedding = typeof embedding === "string" ? JSON.parse(embedding) : embedding;
      const parsedData = data ? (typeof data === "string" ? JSON.parse(data) : data) : {};
      
      const columns = ["embedding"];
      const values = [pgvector.toSql(parsedEmbedding)];
      const placeholders = ["$1"];

      let i = 2;
      for (const [col, val] of Object.entries(parsedData)) {
        columns.push(col);
        values.push(val);
        placeholders.push(`$${i++}`);
      }

      const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id`;
      const result = await query(sql, values);
      return { status: "inserted", id: result.rows[0].id };
    },
  },
  search: {
    description: "Search for similar vectors using cosine similarity",
    params: { table: "Table name", embedding: "JSON array of numbers (query vector)", limit: "Number of results (default 10)", columns: "Comma-separated additional columns to return", where: "WHERE clause without 'WHERE' keyword (optional)" },
    handler: async ({ table, embedding, limit = 10, columns, where }) => {
      const parsedEmbedding = typeof embedding === "string" ? JSON.parse(embedding) : embedding;
      const selectCols = ["id", "1 - (embedding <=> $1) as similarity"];
      if (columns) selectCols.push(...columns.split(",").map((c: string) => c.trim()));

      let sql = `SELECT ${selectCols.join(", ")} FROM ${table}`;
      if (where) sql += ` WHERE ${where}`;
      sql += ` ORDER BY embedding <=> $1 LIMIT ${limit}`;

      const result = await query(sql, [pgvector.toSql(parsedEmbedding)]);
      return { results: result.rows };
    },
  },
  get: {
    description: "Get a vector and its data by ID",
    params: { table: "Table name", id: "Row ID" },
    handler: async ({ table, id }) => {
      const result = await query(`SELECT * FROM ${table} WHERE id = $1`, [parseInt(id)]);
      if (result.rows.length === 0) return { error: "Not found" };
      return result.rows[0];
    },
  },
  delete: {
    description: "Delete a vector by ID",
    params: { table: "Table name", id: "Row ID" },
    handler: async ({ table, id }) => {
      const result = await query(`DELETE FROM ${table} WHERE id = $1`, [parseInt(id)]);
      return { status: result.rowCount > 0 ? "deleted" : "not_found", id };
    },
  },
  count: {
    description: "Count vectors in a table",
    params: { table: "Table name", where: "WHERE clause without 'WHERE' keyword (optional)" },
    handler: async ({ table, where }) => {
      let sql = `SELECT COUNT(*) as count FROM ${table}`;
      if (where) sql += ` WHERE ${where}`;
      const result = await query(sql);
      return { table, count: parseInt(result.rows[0].count) };
    },
  },
};

export function registerPgvectorTools(server: McpServer) {
  server.tool(
    "vector_list",
    "List all available pgvector tools for vector/embedding operations",
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
    "vector_call",
    "Execute a pgvector tool. Use vector_list to see available tools.",
    {
      tool: z.string().describe("Tool name from vector_list"),
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
