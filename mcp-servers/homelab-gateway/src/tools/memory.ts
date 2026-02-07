import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEmbedding } from "../utils/embeddings.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://Qdrant:6333";
const COLLECTION_NAME = "memories";
const VECTOR_SIZE = 384; // all-MiniLM-L6-v2

async function qdrantFetch(endpoint: string, options: RequestInit = {}) {
  const url = `${QDRANT_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Qdrant API error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function ensureCollection() {
  try {
    await qdrantFetch(`/collections/${COLLECTION_NAME}`);
  } catch {
    await qdrantFetch(`/collections/${COLLECTION_NAME}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: { size: VECTOR_SIZE, distance: "Cosine" },
      }),
    });
  }
}

// Tool definitions
const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  store: {
    description: "Store a thought or note with automatic embedding generation",
    params: { content: "The content to store", tags: "Optional comma-separated tags", category: "Optional category name" },
    handler: async ({ content, tags, category }) => {
      await ensureCollection();
      const embedding = await getEmbedding(content);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const tagArray = tags ? tags.split(",").map((t: string) => t.trim()) : [];

      await qdrantFetch(`/collections/${COLLECTION_NAME}/points`, {
        method: "PUT",
        body: JSON.stringify({
          points: [{
            id,
            vector: embedding,
            payload: { content, tags: tagArray, category: category || "general", created_at: now, updated_at: now },
          }],
        }),
      });
      return { status: "stored", id, content_preview: content.substring(0, 100) };
    },
  },
  search: {
    description: "Search for memories using semantic similarity",
    params: { query: "Search query", limit: "Max results (default 5)", category: "Optional category filter" },
    handler: async ({ query, limit = 5, category }) => {
      await ensureCollection();
      const embedding = await getEmbedding(query);
      const filter: any = { must: [] };
      if (category) filter.must.push({ key: "category", match: { value: category } });

      const body: any = { vector: embedding, limit: parseInt(limit), with_payload: true };
      if (filter.must.length > 0) body.filter = filter;

      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/search`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { query, results: result.result.map((r: any) => ({ id: r.id, score: r.score, ...r.payload })) };
    },
  },
  list: {
    description: "List stored memories with pagination",
    params: { limit: "Number to return (default 10)", offset: "Offset for pagination", category: "Optional category filter" },
    handler: async ({ limit = 10, offset = 0, category }) => {
      await ensureCollection();
      const body: any = { limit: parseInt(limit), offset: parseInt(offset), with_payload: true };
      if (category) body.filter = { must: [{ key: "category", match: { value: category } }] };

      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/scroll`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { memories: result.result.points.map((p: any) => ({ id: p.id, ...p.payload })), next_offset: result.result.next_page_offset };
    },
  },
  get: {
    description: "Retrieve a specific memory by ID",
    params: { memory_id: "The memory ID" },
    handler: async ({ memory_id }) => {
      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/${memory_id}`);
      return { id: result.result.id, ...result.result.payload };
    },
  },
  update: {
    description: "Update an existing memory's content or metadata",
    params: { memory_id: "Memory ID to update", content: "New content (optional)", tags: "New comma-separated tags (optional)", category: "New category (optional)" },
    handler: async ({ memory_id, content, tags, category }) => {
      const existing = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/${memory_id}`);
      const payload = { ...existing.result.payload, updated_at: new Date().toISOString() };

      if (tags) payload.tags = tags.split(",").map((t: string) => t.trim());
      if (category) payload.category = category;

      let vector = undefined;
      if (content) {
        payload.content = content;
        vector = await getEmbedding(content);
      }

      const point: any = { id: memory_id, payload };
      if (vector) point.vector = vector;

      await qdrantFetch(`/collections/${COLLECTION_NAME}/points`, {
        method: "PUT",
        body: JSON.stringify({ points: [point] }),
      });
      return { status: "updated", memory_id };
    },
  },
  delete: {
    description: "Delete a memory by ID",
    params: { memory_id: "The memory ID to delete" },
    handler: async ({ memory_id }) => {
      await qdrantFetch(`/collections/${COLLECTION_NAME}/points/delete`, {
        method: "POST",
        body: JSON.stringify({ points: [memory_id] }),
      });
      return { status: "deleted", memory_id };
    },
  },
  stats: {
    description: "Get statistics about stored memories",
    params: { category: "Optional category filter" },
    handler: async ({ category }) => {
      await ensureCollection();
      const info = await qdrantFetch(`/collections/${COLLECTION_NAME}`);
      let count = info.result.points_count;

      if (category) {
        const filtered = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/count`, {
          method: "POST",
          body: JSON.stringify({ filter: { must: [{ key: "category", match: { value: category } }] } }),
        });
        count = filtered.result.count;
      }
      return { total_memories: info.result.points_count, filtered_count: category ? count : undefined, collection: COLLECTION_NAME, vector_size: VECTOR_SIZE };
    },
  },
};

export function registerMemoryTools(server: McpServer) {
  server.tool(
    "memory_list",
    "List all available memory/Qdrant tools and their parameters",
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
    "memory_call",
    "Execute a memory tool. Use memory_list to see available tools.",
    {
      tool: z.string().describe("Tool name from memory_list"),
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
