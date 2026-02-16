/**
 * Shared PostgreSQL connection pool for pgvector-18.
 * All pipeline modules import from here instead of creating their own pools.
 */
import pg from "pg";

const { Pool } = pg;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
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

export async function pgQuery(sql: string, params?: any[]): Promise<any> {
  return getPool().query(sql, params);
}
