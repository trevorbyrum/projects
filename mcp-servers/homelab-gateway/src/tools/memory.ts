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
    // Collection doesn't exist, create it
    await qdrantFetch(`/collections/${COLLECTION_NAME}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: {
          size: VECTOR_SIZE,
          distance: "Cosine",
        },
      }),
    });
  }
}

export function registerMemoryTools(server: McpServer) {
  // Store memory
  server.tool(
    "memory_store",
    "Store a thought or note with automatic embedding generation",
    {
      content: z.string().describe("The content to store"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      category: z.string().optional().describe("Category name"),
      metadata: z.record(z.any()).optional().describe("Additional metadata"),
    },
    async ({ content, tags, category, metadata }) => {
      await ensureCollection();

      const embedding = await getEmbedding(content);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await qdrantFetch(`/collections/${COLLECTION_NAME}/points`, {
        method: "PUT",
        body: JSON.stringify({
          points: [
            {
              id,
              vector: embedding,
              payload: {
                content,
                tags: tags || [],
                category: category || "general",
                created_at: now,
                updated_at: now,
                ...metadata,
              },
            },
          ],
        }),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "stored", id, content_preview: content.substring(0, 100) }, null, 2),
          },
        ],
      };
    }
  );

  // Search memories
  server.tool(
    "memory_search",
    "Search for memories using semantic similarity",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(5).describe("Maximum results to return"),
      category: z.string().optional().describe("Filter by category"),
      tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
    },
    async ({ query, limit, category, tags }) => {
      await ensureCollection();

      const embedding = await getEmbedding(query);

      const filter: any = { must: [] };
      if (category) {
        filter.must.push({ key: "category", match: { value: category } });
      }
      if (tags && tags.length > 0) {
        filter.must.push({
          should: tags.map((tag) => ({ key: "tags", match: { value: tag } })),
        });
      }

      const body: any = {
        vector: embedding,
        limit,
        with_payload: true,
      };
      if (filter.must.length > 0) {
        body.filter = filter;
      }

      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/search`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const memories = result.result.map((r: any) => ({
        id: r.id,
        score: r.score,
        ...r.payload,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify({ query, results: memories }, null, 2) }],
      };
    }
  );

  // List memories (paginated)
  server.tool(
    "memory_list",
    "List stored memories with pagination",
    {
      limit: z.number().optional().default(10).describe("Number of memories to return"),
      offset: z.number().optional().default(0).describe("Offset for pagination"),
      category: z.string().optional().describe("Filter by category"),
    },
    async ({ limit, offset, category }) => {
      await ensureCollection();

      const body: any = {
        limit,
        offset,
        with_payload: true,
      };

      if (category) {
        body.filter = {
          must: [{ key: "category", match: { value: category } }],
        };
      }

      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/scroll`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const memories = result.result.points.map((p: any) => ({
        id: p.id,
        ...p.payload,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ memories, next_offset: result.result.next_page_offset }, null, 2),
          },
        ],
      };
    }
  );

  // Get specific memory
  server.tool(
    "memory_get",
    "Retrieve a specific memory by ID",
    {
      memory_id: z.string().describe("The memory ID"),
    },
    async ({ memory_id }) => {
      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/${memory_id}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: result.result.id, ...result.result.payload }, null, 2),
          },
        ],
      };
    }
  );

  // Update memory
  server.tool(
    "memory_update",
    "Update an existing memory's content or metadata",
    {
      memory_id: z.string().describe("The memory ID to update"),
      content: z.string().optional().describe("New content (will regenerate embedding)"),
      tags: z.array(z.string()).optional().describe("New tags"),
      category: z.string().optional().describe("New category"),
      metadata: z.record(z.any()).optional().describe("Additional metadata to merge"),
    },
    async ({ memory_id, content, tags, category, metadata }) => {
      // Get existing
      const existing = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/${memory_id}`);
      const payload = { ...existing.result.payload, updated_at: new Date().toISOString() };

      if (tags) payload.tags = tags;
      if (category) payload.category = category;
      if (metadata) Object.assign(payload, metadata);

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

      return {
        content: [{ type: "text", text: JSON.stringify({ status: "updated", memory_id }, null, 2) }],
      };
    }
  );

  // Delete memory
  server.tool(
    "memory_delete",
    "Delete a memory by ID",
    {
      memory_id: z.string().describe("The memory ID to delete"),
    },
    async ({ memory_id }) => {
      await qdrantFetch(`/collections/${COLLECTION_NAME}/points/delete`, {
        method: "POST",
        body: JSON.stringify({ points: [memory_id] }),
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ status: "deleted", memory_id }, null, 2) }],
      };
    }
  );

  // Memory stats
  server.tool(
    "memory_stats",
    "Get statistics about stored memories",
    {
      category: z.string().optional().describe("Filter stats by category"),
    },
    async ({ category }) => {
      await ensureCollection();

      const info = await qdrantFetch(`/collections/${COLLECTION_NAME}`);

      let count = info.result.points_count;

      if (category) {
        const filtered = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/count`, {
          method: "POST",
          body: JSON.stringify({
            filter: { must: [{ key: "category", match: { value: category } }] },
          }),
        });
        count = filtered.result.count;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total_memories: info.result.points_count,
                filtered_count: category ? count : undefined,
                collection: COLLECTION_NAME,
                vector_size: VECTOR_SIZE,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
