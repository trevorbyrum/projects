import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Redis as IORedis } from "ioredis";

const REDIS_HOST = process.env.REDIS_HOST || "Redis";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379");
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

function getClient(db = 0): InstanceType<typeof IORedis> {
  return new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    db,
    lazyConnect: true,
    connectTimeout: 5000,
  });
}

async function withClient<T>(db: number, fn: (client: InstanceType<typeof IORedis>) => Promise<T>): Promise<T> {
  const client = getClient(db);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ── Server Info ────────────────────────────────────────────

  info: {
    description: "Get Redis server info. Sections: server, clients, memory, stats, replication, cpu, keyspace, or 'all'",
    params: { section: "(optional) Info section, default 'all'" },
    handler: async (p) => {
      return withClient(0, async (client) => {
        const raw = await client.info(p.section || "all");
        // Parse into object
        const result: Record<string, string> = {};
        for (const line of raw.split("\r\n")) {
          if (line.startsWith("#") || !line.includes(":")) continue;
          const [key, val] = line.split(":");
          result[key] = val;
        }
        return result;
      });
    },
  },

  keyspace: {
    description: "Show which databases have keys and how many (quick overview of Redis usage)",
    params: {},
    handler: async () => {
      return withClient(0, async (client) => {
        const raw = await client.info("keyspace");
        const dbs: Record<string, any> = {};
        for (const line of raw.split("\r\n")) {
          if (!line.startsWith("db")) continue;
          const [dbName, stats] = line.split(":");
          const parsed: Record<string, string> = {};
          for (const kv of stats.split(",")) {
            const [k, v] = kv.split("=");
            parsed[k] = v;
          }
          dbs[dbName] = parsed;
        }
        return dbs;
      });
    },
  },

  memory: {
    description: "Get Redis memory usage stats (used_memory, peak, fragmentation ratio, etc.)",
    params: {},
    handler: async () => {
      return withClient(0, async (client) => {
        const raw = await client.info("memory");
        const result: Record<string, string> = {};
        for (const line of raw.split("\r\n")) {
          if (line.startsWith("#") || !line.includes(":")) continue;
          const [key, val] = line.split(":");
          if (key.startsWith("used_memory") || key.includes("fragmentation") || key.includes("peak") || key.includes("rss")) {
            result[key] = val;
          }
        }
        return result;
      });
    },
  },

  dbsize: {
    description: "Get total key count in a specific database",
    params: { db: "(optional) Database number, default 0" },
    handler: async (p) => {
      const db = parseInt(p.db ?? "0");
      return withClient(db, async (client) => {
        const size = await client.dbsize();
        return { db, keys: size };
      });
    },
  },

  // ── Key Operations ─────────────────────────────────────────

  scan_keys: {
    description: "Scan keys matching a pattern (non-blocking, safe for production). Returns up to 100 keys.",
    params: {
      pattern: "(optional) Glob pattern, default '*'",
      db: "(optional) Database number, default 0",
      count: "(optional) Max keys to return, default 100",
    },
    handler: async (p) => {
      const db = parseInt(p.db ?? "0");
      const pattern = p.pattern || "*";
      const maxCount = Math.min(parseInt(p.count ?? "100"), 500);
      return withClient(db, async (client) => {
        const keys: string[] = [];
        let cursor = "0";
        do {
          const [next, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
          cursor = next;
          keys.push(...batch);
        } while (cursor !== "0" && keys.length < maxCount);
        return { db, pattern, keys: keys.slice(0, maxCount), total_returned: Math.min(keys.length, maxCount) };
      });
    },
  },

  get_key: {
    description: "Get the value of a key. Handles strings, lists, sets, hashes, and sorted sets automatically.",
    params: {
      key: "Key name",
      db: "(optional) Database number, default 0",
    },
    handler: async (p) => {
      const db = parseInt(p.db ?? "0");
      return withClient(db, async (client) => {
        const type = await client.type(p.key);
        const ttl = await client.ttl(p.key);
        let value: any;
        switch (type) {
          case "string": value = await client.get(p.key); break;
          case "list": value = await client.lrange(p.key, 0, 99); break;
          case "set": value = await client.smembers(p.key); break;
          case "zset": value = await client.zrange(p.key, 0, 99, "WITHSCORES"); break;
          case "hash": value = await client.hgetall(p.key); break;
          case "none": return { key: p.key, exists: false };
          default: value = `(unsupported type: ${type})`;
        }
        return { key: p.key, type, ttl: ttl === -1 ? "no expiry" : `${ttl}s`, value };
      });
    },
  },

  set_key: {
    description: "Set a string key value. Optionally set TTL in seconds.",
    params: {
      key: "Key name",
      value: "String value",
      db: "(optional) Database number, default 0",
      ttl: "(optional) TTL in seconds",
    },
    handler: async (p) => {
      const db = parseInt(p.db ?? "0");
      return withClient(db, async (client) => {
        if (p.ttl) {
          await client.setex(p.key, parseInt(p.ttl), p.value);
        } else {
          await client.set(p.key, p.value);
        }
        return { ok: true, key: p.key, db };
      });
    },
  },

  delete_key: {
    description: "Delete one or more keys",
    params: {
      keys: "Key name or comma-separated key names",
      db: "(optional) Database number, default 0",
    },
    handler: async (p) => {
      const db = parseInt(p.db ?? "0");
      const keyList = typeof p.keys === "string" ? p.keys.split(",").map((k: string) => k.trim()) : p.keys;
      return withClient(db, async (client) => {
        const deleted = await client.del(...keyList);
        return { deleted, keys: keyList, db };
      });
    },
  },

  key_type: {
    description: "Get the type and TTL of a key",
    params: {
      key: "Key name",
      db: "(optional) Database number, default 0",
    },
    handler: async (p) => {
      const db = parseInt(p.db ?? "0");
      return withClient(db, async (client) => {
        const [type, ttl, encoding] = await Promise.all([
          client.type(p.key),
          client.ttl(p.key),
          client.object("ENCODING", p.key).catch(() => "unknown"),
        ]);
        return { key: p.key, type, encoding, ttl: ttl === -1 ? "no expiry" : `${ttl}s`, db };
      });
    },
  },

  // ── Pub/Sub ────────────────────────────────────────────────

  list_channels: {
    description: "List active pub/sub channels matching a pattern",
    params: { pattern: "(optional) Channel pattern, default '*'" },
    handler: async (p) => {
      return withClient(0, async (client) => {
        const channels = await client.pubsub("CHANNELS", p.pattern || "*");
        return { channels };
      });
    },
  },

  // ── Slow Log ───────────────────────────────────────────────

  slowlog: {
    description: "Get recent slow queries (useful for debugging performance)",
    params: { count: "(optional) Number of entries, default 10" },
    handler: async (p) => {
      return withClient(0, async (client) => {
        const entries = await client.slowlog("GET", parseInt(p.count ?? "10"));
        return entries;
      });
    },
  },
};

export function registerRedisTools(server: McpServer) {
  server.tool(
    "redis_list",
    "List all available Redis tools. Redis is the shared cache/message broker used by Dify, plugin daemon, and other services. " +
    "Tools cover: server info (info, keyspace, memory, dbsize), key operations (scan, get, set, delete, type), " +
    "pub/sub channel listing, and slow query log. Databases: db0 (general), db1 (Dify), db2 (Dify plugin daemon).",
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
    "redis_call",
    "Execute a Redis tool. Use redis_list to see available tools. " +
    "Manages the shared Redis instance: key inspection, CRUD, server stats, and diagnostics.",
    {
      tool: z.string().describe("Tool name from redis_list"),
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
