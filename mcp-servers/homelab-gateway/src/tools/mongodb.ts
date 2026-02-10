import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MongoClient } from "mongodb";

const MONGODB_URL = process.env.MONGODB_URL || "mongodb://MongoDB:27017";

let cachedClient: MongoClient | null = null;

async function getClient(): Promise<MongoClient> {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URL, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });
    await cachedClient.connect();
  }
  return cachedClient;
}

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ── Database Operations ────────────────────────────────────

  list_databases: {
    description: "List all databases with their sizes",
    params: {},
    handler: async () => {
      const client = await getClient();
      const result = await client.db("admin").command({ listDatabases: 1 });
      return result.databases.map((db: any) => ({
        name: db.name,
        sizeOnDisk: db.sizeOnDisk,
        sizeMB: (db.sizeOnDisk / 1024 / 1024).toFixed(2),
        empty: db.empty,
      }));
    },
  },

  server_status: {
    description: "Get MongoDB server status (version, uptime, connections, memory, operations)",
    params: {},
    handler: async () => {
      const client = await getClient();
      const status = await client.db("admin").command({ serverStatus: 1 });
      return {
        version: status.version,
        uptime_hours: (status.uptime / 3600).toFixed(1),
        connections: status.connections,
        opcounters: status.opcounters,
        mem: status.mem,
        storageEngine: status.storageEngine?.name,
      };
    },
  },

  // ── Collection Operations ──────────────────────────────────

  list_collections: {
    description: "List all collections in a database with document counts and sizes",
    params: { database: "Database name" },
    handler: async (p) => {
      const client = await getClient();
      const db = client.db(p.database);
      const collections = await db.listCollections().toArray();
      const results = [];
      for (const col of collections) {
        const stats = await db.command({ collStats: col.name }).catch(() => null);
        results.push({
          name: col.name,
          type: col.type,
          documents: stats?.count ?? "unknown",
          size: stats?.size ? `${(stats.size / 1024).toFixed(1)}KB` : "unknown",
          indexes: stats?.nindexes ?? "unknown",
        });
      }
      return { database: p.database, collections: results };
    },
  },

  create_collection: {
    description: "Create a new collection in a database",
    params: {
      database: "Database name",
      collection: "Collection name",
    },
    handler: async (p) => {
      const client = await getClient();
      await client.db(p.database).createCollection(p.collection);
      return { ok: true, database: p.database, collection: p.collection };
    },
  },

  drop_collection: {
    description: "Drop (delete) a collection and all its documents. DESTRUCTIVE.",
    params: {
      database: "Database name",
      collection: "Collection name",
    },
    handler: async (p) => {
      const client = await getClient();
      const result = await client.db(p.database).dropCollection(p.collection);
      return { dropped: result, database: p.database, collection: p.collection };
    },
  },

  // ── Document Operations ────────────────────────────────────

  find_documents: {
    description: "Query documents in a collection. Returns up to 50 documents.",
    params: {
      database: "Database name",
      collection: "Collection name",
      filter: "(optional) MongoDB query filter as JSON object, default {}",
      projection: "(optional) Fields to include/exclude, e.g. {name: 1, _id: 0}",
      sort: "(optional) Sort order, e.g. {createdAt: -1}",
      limit: "(optional) Max documents, default 20 (max 50)",
    },
    handler: async (p) => {
      const client = await getClient();
      const filter = p.filter || {};
      const projection = p.projection || {};
      const sort = p.sort || {};
      const limit = Math.min(parseInt(p.limit ?? "20"), 50);

      const docs = await client.db(p.database)
        .collection(p.collection)
        .find(filter, { projection })
        .sort(sort)
        .limit(limit)
        .toArray();

      return { database: p.database, collection: p.collection, count: docs.length, documents: docs };
    },
  },

  count_documents: {
    description: "Count documents matching a filter",
    params: {
      database: "Database name",
      collection: "Collection name",
      filter: "(optional) MongoDB query filter as JSON object, default {}",
    },
    handler: async (p) => {
      const client = await getClient();
      const count = await client.db(p.database)
        .collection(p.collection)
        .countDocuments(p.filter || {});
      return { database: p.database, collection: p.collection, count };
    },
  },

  insert_document: {
    description: "Insert a single document into a collection",
    params: {
      database: "Database name",
      collection: "Collection name",
      document: "Document to insert as JSON object",
    },
    handler: async (p) => {
      const client = await getClient();
      const result = await client.db(p.database)
        .collection(p.collection)
        .insertOne(p.document);
      return { insertedId: result.insertedId, acknowledged: result.acknowledged };
    },
  },

  insert_many: {
    description: "Insert multiple documents into a collection",
    params: {
      database: "Database name",
      collection: "Collection name",
      documents: "Array of documents to insert",
    },
    handler: async (p) => {
      const client = await getClient();
      const result = await client.db(p.database)
        .collection(p.collection)
        .insertMany(p.documents);
      return { insertedCount: result.insertedCount, acknowledged: result.acknowledged };
    },
  },

  update_documents: {
    description: "Update documents matching a filter",
    params: {
      database: "Database name",
      collection: "Collection name",
      filter: "MongoDB query filter",
      update: "Update operations (e.g. {$set: {field: value}})",
      many: "(optional) Update all matches (true) or just first (false), default false",
    },
    handler: async (p) => {
      const client = await getClient();
      const col = client.db(p.database).collection(p.collection);
      const result = p.many
        ? await col.updateMany(p.filter, p.update)
        : await col.updateOne(p.filter, p.update);
      return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, acknowledged: result.acknowledged };
    },
  },

  delete_documents: {
    description: "Delete documents matching a filter",
    params: {
      database: "Database name",
      collection: "Collection name",
      filter: "MongoDB query filter (REQUIRED — empty {} deletes everything!)",
      many: "(optional) Delete all matches (true) or just first (false), default false",
    },
    handler: async (p) => {
      const client = await getClient();
      const col = client.db(p.database).collection(p.collection);
      const result = p.many
        ? await col.deleteMany(p.filter)
        : await col.deleteOne(p.filter);
      return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
    },
  },

  // ── Indexes ────────────────────────────────────────────────

  list_indexes: {
    description: "List all indexes on a collection",
    params: {
      database: "Database name",
      collection: "Collection name",
    },
    handler: async (p) => {
      const client = await getClient();
      const indexes = await client.db(p.database)
        .collection(p.collection)
        .indexes();
      return { database: p.database, collection: p.collection, indexes };
    },
  },

  create_index: {
    description: "Create an index on a collection",
    params: {
      database: "Database name",
      collection: "Collection name",
      keys: "Index keys (e.g. {email: 1} for ascending, {createdAt: -1} for descending)",
      options: "(optional) Index options (e.g. {unique: true, name: 'email_idx'})",
    },
    handler: async (p) => {
      const client = await getClient();
      const name = await client.db(p.database)
        .collection(p.collection)
        .createIndex(p.keys, p.options || {});
      return { indexName: name, database: p.database, collection: p.collection };
    },
  },

  // ── Aggregation ────────────────────────────────────────────

  aggregate: {
    description: "Run an aggregation pipeline on a collection",
    params: {
      database: "Database name",
      collection: "Collection name",
      pipeline: "Array of aggregation stages (e.g. [{$match: {}}, {$group: {_id: '$field', count: {$sum: 1}}}])",
    },
    handler: async (p) => {
      const client = await getClient();
      const results = await client.db(p.database)
        .collection(p.collection)
        .aggregate(p.pipeline)
        .toArray();
      return { count: results.length, results };
    },
  },
};

export function registerMongodbTools(server: McpServer) {
  server.tool(
    "mongodb_list",
    "List all available MongoDB tools. MongoDB hosts data for LibreChat and Compose-Craft. " +
    "Tools cover: database listing/status, collection management (list/create/drop), " +
    "document CRUD (find/insert/update/delete), indexes, and aggregation pipelines.",
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
    "mongodb_call",
    "Execute a MongoDB tool. Use mongodb_list to see available tools. " +
    "Manages MongoDB databases, collections, documents, indexes, and aggregation pipelines.",
    {
      tool: z.string().describe("Tool name from mongodb_list"),
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
