import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEmbedding } from "../utils/embeddings.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://Qdrant:6333";
const COLLECTION_NAME = "dev-preferences";
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
  pref_store: {
    description: "Store a development preference with semantic embedding. Embedding is generated from concatenation of domain + topic + context + preference.",
    params: {
      domain: "Domain area (e.g. 'ui', 'backend', 'architecture', 'tooling', 'workflow')",
      topic: "Specific topic (e.g. 'color-palette', 'state-management', 'navigation')",
      context: "When/where this preference applies",
      preference: "The actual preference statement",
      anti_pattern: "(optional) What to avoid — the opposite of this preference",
      examples: "(optional) JSON object with 'good' and 'bad' arrays of example strings",
      confidence: "(optional) Confidence level: high|medium|low, default high",
      source: "(optional) Where this preference came from (e.g. 'user-stated', 'inferred', 'research')",
      tags: "(optional) Comma-separated tags for filtering",
    },
    handler: async (p) => {
      await ensureCollection();

      // Build embedding from key semantic fields
      const embeddingText = [p.domain, p.topic, p.context, p.preference].filter(Boolean).join(" ");
      const embedding = await getEmbedding(embeddingText);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const tagArray = p.tags ? p.tags.split(",").map((t: string) => t.trim()) : [];
      const examples = p.examples ? (typeof p.examples === "string" ? JSON.parse(p.examples) : p.examples) : null;

      await qdrantFetch(`/collections/${COLLECTION_NAME}/points`, {
        method: "PUT",
        body: JSON.stringify({
          points: [{
            id,
            vector: embedding,
            payload: {
              domain: p.domain,
              topic: p.topic,
              context: p.context,
              preference: p.preference,
              anti_pattern: p.anti_pattern || null,
              examples,
              confidence: p.confidence || "high",
              source: p.source || "user-stated",
              tags: tagArray,
              created_at: now,
              updated_at: now,
            },
          }],
        }),
      });
      return { status: "stored", id, domain: p.domain, topic: p.topic, preview: p.preference.substring(0, 100) };
    },
  },

  pref_search: {
    description: "Search preferences by semantic similarity. Use this to find relevant design/dev preferences for a project context.",
    params: {
      query: "Search query (e.g. 'dark mode mobile navigation app')",
      limit: "(optional) Max results, default 5",
      domain: "(optional) Filter by domain (ui, backend, architecture, tooling, workflow)",
    },
    handler: async (p) => {
      await ensureCollection();
      const embedding = await getEmbedding(p.query);
      const filter: any = { must: [] };
      if (p.domain) filter.must.push({ key: "domain", match: { value: p.domain } });

      const body: any = { vector: embedding, limit: parseInt(p.limit || "5"), with_payload: true };
      if (filter.must.length > 0) body.filter = filter;

      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/search`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        query: p.query,
        results: result.result.map((r: any) => ({
          id: r.id,
          score: r.score,
          ...r.payload,
        })),
      };
    },
  },

  pref_list: {
    description: "List all stored preferences with optional domain filter.",
    params: {
      limit: "(optional) Max results, default 20",
      offset: "(optional) Pagination offset",
      domain: "(optional) Filter by domain",
    },
    handler: async (p) => {
      await ensureCollection();
      const body: any = { limit: parseInt(p.limit || "20"), offset: parseInt(p.offset || "0"), with_payload: true };
      if (p.domain) body.filter = { must: [{ key: "domain", match: { value: p.domain } }] };

      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/scroll`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        preferences: result.result.points.map((pt: any) => ({ id: pt.id, ...pt.payload })),
        next_offset: result.result.next_page_offset,
      };
    },
  },

  pref_update: {
    description: "Update an existing preference by ID. Re-embeds if semantic fields change.",
    params: {
      id: "Preference ID to update",
      domain: "(optional) New domain",
      topic: "(optional) New topic",
      context: "(optional) New context",
      preference: "(optional) New preference text",
      anti_pattern: "(optional) New anti-pattern",
      examples: "(optional) New examples JSON object",
      confidence: "(optional) New confidence level",
      tags: "(optional) New comma-separated tags",
    },
    handler: async (p) => {
      const existing = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/${p.id}`);
      const payload = { ...existing.result.payload, updated_at: new Date().toISOString() };

      const semanticFields = ["domain", "topic", "context", "preference"];
      let needsReembed = false;

      for (const field of semanticFields) {
        if (p[field] !== undefined) {
          payload[field] = p[field];
          needsReembed = true;
        }
      }
      if (p.anti_pattern !== undefined) payload.anti_pattern = p.anti_pattern;
      if (p.examples !== undefined) payload.examples = typeof p.examples === "string" ? JSON.parse(p.examples) : p.examples;
      if (p.confidence !== undefined) payload.confidence = p.confidence;
      if (p.tags !== undefined) payload.tags = p.tags.split(",").map((t: string) => t.trim());

      if (needsReembed) {
        const embeddingText = [payload.domain, payload.topic, payload.context, payload.preference].filter(Boolean).join(" ");
        const vector = await getEmbedding(embeddingText);
        await qdrantFetch(`/collections/${COLLECTION_NAME}/points`, {
          method: "PUT",
          body: JSON.stringify({ points: [{ id: p.id, vector, payload }] }),
        });
      } else {
        await qdrantFetch(`/collections/${COLLECTION_NAME}/points/payload`, {
          method: "POST",
          body: JSON.stringify({ payload, points: [p.id] }),
        });
      }
      return { status: "updated", id: p.id };
    },
  },

  pref_delete: {
    description: "Delete a preference by ID.",
    params: { id: "Preference ID to delete" },
    handler: async (p) => {
      await qdrantFetch(`/collections/${COLLECTION_NAME}/points/delete`, {
        method: "POST",
        body: JSON.stringify({ points: [p.id] }),
      });
      return { status: "deleted", id: p.id };
    },
  },

  pref_export: {
    description: "Export all preferences as a structured JSON document, grouped by domain.",
    params: {},
    handler: async () => {
      await ensureCollection();
      const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/scroll`, {
        method: "POST",
        body: JSON.stringify({ limit: 100, with_payload: true }),
      });

      const grouped: Record<string, any[]> = {};
      for (const pt of result.result.points) {
        const domain = pt.payload.domain || "uncategorized";
        if (!grouped[domain]) grouped[domain] = [];
        grouped[domain].push({ id: pt.id, ...pt.payload });
      }

      return { total: result.result.points.length, by_domain: grouped };
    },
  },
};

// Exported for direct use by other modules (no MCP overhead)
export async function storePreference(pref: {
  domain: string; topic: string; context: string; preference: string;
  anti_pattern?: string; confidence?: string; source?: string; tags?: string[];
}): Promise<{ id: string }> {
  await ensureCollection();
  const embeddingText = [pref.domain, pref.topic, pref.context, pref.preference].filter(Boolean).join(" ");
  const embedding = await getEmbedding(embeddingText);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await qdrantFetch(`/collections/${COLLECTION_NAME}/points`, {
    method: "PUT",
    body: JSON.stringify({
      points: [{
        id, vector: embedding,
        payload: {
          domain: pref.domain, topic: pref.topic, context: pref.context,
          preference: pref.preference, anti_pattern: pref.anti_pattern || null,
          examples: null, confidence: pref.confidence || "high",
          source: pref.source || "persona-digest", tags: pref.tags || [],
          created_at: now, updated_at: now,
        },
      }],
    }),
  });
  return { id };
}

export async function searchPreferences(query: string, limit: number = 5, domain?: string): Promise<any[]> {
  await ensureCollection();
  const embedding = await getEmbedding(query);
  const filter: any = { must: [] };
  if (domain) filter.must.push({ key: "domain", match: { value: domain } });

  const body: any = { vector: embedding, limit, with_payload: true };
  if (filter.must.length > 0) body.filter = filter;

  const result = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/search`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result.result.map((r: any) => ({
    id: r.id,
    score: r.score,
    ...r.payload,
  }));
}

const PREF_CALL_DESCRIPTION = `Manage development preferences — persistent design and engineering opinions that inform AI-generated research and architecture decisions.

Store preferences for: UI/UX patterns, color and typography choices, framework/library selections, architecture patterns, accessibility requirements, performance targets, code style, workflow preferences.

Each preference has: domain (ui/backend/architecture/tooling/workflow), topic, context (when it applies), preference (the actual opinion), anti_pattern (what to avoid), examples (good/bad), confidence (high/medium/low), source, tags.

Preferences are embedded semantically and retrieved via similarity search during research pipelines. The research pipeline automatically queries preferences relevant to each section and injects them as context for the LLM.`;

export function registerPreferenceTools(server: McpServer) {
  server.tool(
    "pref_list_tools",
    "List all available preference management tools and their parameters",
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
    "pref_call",
    PREF_CALL_DESCRIPTION,
    {
      tool: z.string().describe("Tool name from pref_list_tools"),
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
