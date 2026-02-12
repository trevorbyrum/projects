import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";
import neo4j, { Driver, Session } from "neo4j-driver";
import { mmPost } from "./mm-notify.js";

const { Pool } = pg;

// --- Config (reuses existing env vars) ---

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const NEO4J_URL = process.env.NEO4J_URL || "bolt://Neo4j:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";
const DIFY_API_URL = process.env.DIFY_API_URL || "http://dify-api:5001";
const DIFY_EMAIL = process.env.DIFY_EMAIL || "";
const DIFY_PASSWORD = process.env.DIFY_PASSWORD || "";

const HF_API_BASE = "https://huggingface.co/api";
const DEFAULT_EXTRACT_MODEL = "anthropic/claude-sonnet-4-5";
const DEFAULT_OPTIMIZE_MODEL = "anthropic/claude-sonnet-4-5";
const DEFAULT_EVAL_MODEL = "google/gemini-2.0-flash-001";

// --- Logging ---

function log(level: "info" | "warn" | "error", op: string, msg: string, meta?: Record<string, any>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [agentforge] [${op}]`;
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  if (level === "error") console.error(`${prefix} ${msg}${metaStr}`);
  else if (level === "warn") console.warn(`${prefix} ${msg}${metaStr}`);
  else console.log(`${prefix} ${msg}${metaStr}`);
}

async function ntfyNotify(message: string, title?: string, _priority?: number, tags?: string[]): Promise<void> {
  const emoji = tags?.length ? `:${tags[0]}: ` : "";
  const titleStr = title ? `**${emoji}${title}**\n` : "";
  await mmPost("dev-logs", `${titleStr}${message}`);
}

// --- PostgreSQL ---

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
      throw new Error("PostgreSQL not configured");
    }
    pool = new Pool({ host: POSTGRES_HOST, port: POSTGRES_PORT, user: POSTGRES_USER, password: POSTGRES_PASSWORD, database: POSTGRES_DB });
  }
  return pool;
}

async function pgQuery(sql: string, params: any[] = []): Promise<any> {
  const client = await getPool().connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

// --- Neo4j ---

let neo4jDriver: Driver | null = null;

function getNeo4jDriver(): Driver {
  if (!neo4jDriver) {
    neo4jDriver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  }
  return neo4jDriver;
}

async function runCypher(cypher: string, params: Record<string, any> = {}): Promise<any[]> {
  const session: Session = getNeo4jDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((record) => {
      const obj: any = {};
      record.keys.forEach((key) => {
        const value = record.get(key);
        if (neo4j.isInt(value)) obj[key] = value.toNumber();
        else if (value && typeof value === "object" && value.properties) obj[key] = { ...value.properties, _labels: value.labels };
        else obj[key] = value;
      });
      return obj;
    });
  } finally { await session.close(); }
}

// --- OpenRouter LLM ---

async function llmCall(model: string, messages: Array<{ role: string; content: string }>, maxTokens = 4000): Promise<string> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch(`${OPENROUTER_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://mcp.homelab.local",
      "X-Title": "AgentForge",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// --- HuggingFace API ---

async function hfSearch(type: "models" | "datasets", query: string, limit = 10, filters?: Record<string, string>): Promise<any[]> {
  const params = new URLSearchParams({ search: query, limit: String(limit), sort: "downloads", direction: "-1" });
  if (filters) {
    for (const [k, v] of Object.entries(filters)) params.set(k, v);
  }
  const res = await fetch(`${HF_API_BASE}/${type}?${params}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HuggingFace API error (${res.status}): ${err}`);
  }
  return res.json();
}

async function hfGetModel(modelId: string): Promise<any> {
  const res = await fetch(`${HF_API_BASE}/models/${modelId}`);
  if (!res.ok) throw new Error(`HF model not found: ${modelId}`);
  return res.json();
}

async function hfGetDataset(datasetId: string): Promise<any> {
  const res = await fetch(`${HF_API_BASE}/datasets/${datasetId}`);
  if (!res.ok) throw new Error(`HF dataset not found: ${datasetId}`);
  return res.json();
}

// --- Dify Console API (shared auth with dify.ts) ---

let cachedAccessToken = "";
let cachedCsrfToken = "";
let tokenExpiresAt = 0;

async function difyLogin(): Promise<void> {
  if (!DIFY_EMAIL || !DIFY_PASSWORD) throw new Error("DIFY_EMAIL and DIFY_PASSWORD must be set");
  const b64Password = Buffer.from(DIFY_PASSWORD).toString("base64");
  const res = await fetch(`${DIFY_API_URL}/console/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DIFY_EMAIL, password: b64Password, remember_me: true }),
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`Dify login failed (${res.status})`);
  const cookies = res.headers.getSetCookie?.() || [];
  for (const cookie of cookies) {
    const match = cookie.match(/^([^=]+)=([^;]+)/);
    if (!match) continue;
    const [, name, value] = match;
    if (name.includes("access_token")) cachedAccessToken = value;
    if (name.includes("csrf_token")) cachedCsrfToken = value;
  }
  if (!cachedAccessToken) throw new Error("Login succeeded but no access_token in cookies");
  tokenExpiresAt = Date.now() + 50 * 60 * 1000;
}

async function difyConsole(endpoint: string, options: RequestInit = {}): Promise<any> {
  if (!cachedAccessToken || Date.now() >= tokenExpiresAt) await difyLogin();
  const url = `${DIFY_API_URL}/console/api${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cachedAccessToken}`,
      "X-CSRF-Token": cachedCsrfToken,
      Cookie: `__Host-access_token=${cachedAccessToken}; __Host-csrf_token=${cachedCsrfToken}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dify Console error (${res.status}): ${err}`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

// --- Schema bootstrap ---

async function ensureSchema(): Promise<void> {
  const checkSql = `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'forge_experiments')`;
  const result = await pgQuery(checkSql);
  if (result.rows[0].exists) return;

  log("info", "schema", "Creating AgentForge tables...");

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS forge_experiments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'created',
      config JSONB DEFAULT '{}',
      results JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS forge_discoveries (
      id SERIAL PRIMARY KEY,
      experiment_id INTEGER REFERENCES forge_experiments(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      name TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      raw_text TEXT,
      processed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_forge_discoveries_experiment ON forge_discoveries(experiment_id)`);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS forge_triples (
      id SERIAL PRIMARY KEY,
      experiment_id INTEGER REFERENCES forge_experiments(id) ON DELETE CASCADE,
      discovery_id INTEGER,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      imported_to_neo4j BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_forge_triples_experiment ON forge_triples(experiment_id)`);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS forge_prompt_experiments (
      id SERIAL PRIMARY KEY,
      experiment_id INTEGER REFERENCES forge_experiments(id) ON DELETE CASCADE,
      prompt_name TEXT NOT NULL,
      base_prompt TEXT NOT NULL,
      evaluation_criteria JSONB DEFAULT '{}',
      test_cases JSONB DEFAULT '[]',
      status TEXT DEFAULT 'created',
      winner_variant_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS forge_prompt_variants (
      id SERIAL PRIMARY KEY,
      prompt_experiment_id INTEGER REFERENCES forge_prompt_experiments(id) ON DELETE CASCADE,
      variant_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      generation_method TEXT DEFAULT 'llm',
      scores JSONB DEFAULT '{}',
      avg_score REAL,
      evaluated BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_forge_variants_experiment ON forge_prompt_variants(prompt_experiment_id)`);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS forge_resource_evaluations (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      reusable_prompts JSONB DEFAULT '[]',
      new_tools JSONB DEFAULT '[]',
      lightrag_score INTEGER DEFAULT 0,
      lightrag_details JSONB DEFAULT '{}',
      lightrag_recommended BOOLEAN DEFAULT FALSE,
      prompts_to_create INTEGER DEFAULT 0,
      prompt_details JSONB DEFAULT '[]',
      estimated_cost REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      user_response TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  log("info", "schema", "AgentForge tables created successfully");
}

let schemaReady = false;
async function ready(): Promise<void> {
  if (!schemaReady) {
    await ensureSchema();
    schemaReady = true;
  }
}

// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ══════════════════════════════════════════════════════════════
  // Pipeline Management
  // ══════════════════════════════════════════════════════════════

  create_experiment: {
    description: "Create a new AgentForge experiment. An experiment tracks the full pipeline: discovery → KG → optimization → scaffolding.",
    params: {
      name: "Experiment name (e.g. 'budget-tracking-agent')",
      domain: "Domain/task description (e.g. 'personal finance budget tracking')",
      description: "(optional) Detailed description of the target agent",
      project_slug: "(optional) Link to an existing pipeline project by slug",
      config: "(optional) Config object: {extract_model, optimize_model, eval_model, max_variants, hf_search_limit}",
    },
    handler: async (p) => {
      await ready();
      let projectId: number | null = null;
      if (p.project_slug) {
        const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.project_slug]);
        if (proj.rowCount > 0) projectId = proj.rows[0].id;
      }
      const config = p.config || {};
      const result = await pgQuery(
        `INSERT INTO forge_experiments (project_id, name, domain, description, config)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [projectId, p.name, p.domain, p.description || null, JSON.stringify(config)]
      );
      log("info", "create_experiment", `Created experiment: ${p.name}`, { id: result.rows[0].id });
      return result.rows[0];
    },
  },

  get_experiment: {
    description: "Get full experiment details including discovery/triple/prompt counts.",
    params: { id: "Experiment ID" },
    handler: async (p) => {
      await ready();
      const exp = await pgQuery(`SELECT * FROM forge_experiments WHERE id = $1`, [p.id]);
      if (exp.rowCount === 0) throw new Error(`Experiment ${p.id} not found`);

      const [discoveries, triples, prompts] = await Promise.all([
        pgQuery(`SELECT source_type, COUNT(*) as count, COUNT(*) FILTER (WHERE processed) as processed FROM forge_discoveries WHERE experiment_id = $1 GROUP BY source_type`, [p.id]),
        pgQuery(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE imported_to_neo4j) as imported FROM forge_triples WHERE experiment_id = $1`, [p.id]),
        pgQuery(`SELECT id, prompt_name, status, winner_variant_id FROM forge_prompt_experiments WHERE experiment_id = $1`, [p.id]),
      ]);

      return {
        ...exp.rows[0],
        discovery_summary: discoveries.rows,
        triple_summary: triples.rows[0],
        prompt_experiments: prompts.rows,
      };
    },
  },

  list_experiments: {
    description: "List all AgentForge experiments.",
    params: {
      status: "(optional) Filter by status: created|researching|building_kg|optimizing|scaffolding|complete|failed",
      limit: "(optional) Max results, default 20",
    },
    handler: async (p) => {
      await ready();
      let sql = `SELECT e.*, (SELECT COUNT(*) FROM forge_discoveries d WHERE d.experiment_id = e.id) as discovery_count,
        (SELECT COUNT(*) FROM forge_triples t WHERE t.experiment_id = e.id) as triple_count
        FROM forge_experiments e WHERE 1=1`;
      const params: any[] = [];
      let idx = 1;
      if (p.status) { sql += ` AND e.status = $${idx++}`; params.push(p.status); }
      sql += ` ORDER BY e.created_at DESC LIMIT $${idx++}`;
      params.push(p.limit || 20);
      const result = await pgQuery(sql, params);
      return { experiments: result.rows, count: result.rowCount };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // Stage 1: Research & Discovery
  // ══════════════════════════════════════════════════════════════

  discover_models: {
    description: "Search HuggingFace Hub for models relevant to the experiment domain. Stores results as discoveries.",
    params: {
      experiment_id: "Experiment ID",
      query: "(optional) Custom search query. Defaults to experiment domain.",
      task: "(optional) HF task filter (e.g. 'text-generation', 'text-classification')",
      limit: "(optional) Max results, default 10",
    },
    handler: async (p) => {
      await ready();
      const exp = await pgQuery(`SELECT * FROM forge_experiments WHERE id = $1`, [p.experiment_id]);
      if (exp.rowCount === 0) throw new Error(`Experiment ${p.experiment_id} not found`);

      const query = p.query || exp.rows[0].domain;
      const filters: Record<string, string> = {};
      if (p.task) filters.pipeline_tag = p.task;
      const limit = p.limit || 10;

      log("info", "discover_models", `Searching HF models: "${query}"`, { task: p.task, limit });
      const models = await hfSearch("models", query, limit, filters);

      const inserted = [];
      for (const model of models) {
        const metadata = {
          modelId: model.modelId || model.id,
          pipeline_tag: model.pipeline_tag,
          tags: model.tags,
          downloads: model.downloads,
          likes: model.likes,
          library_name: model.library_name,
          cardData: model.cardData,
        };
        const result = await pgQuery(
          `INSERT INTO forge_discoveries (experiment_id, source_type, source_id, name, metadata)
           VALUES ($1, 'hf_model', $2, $3, $4) RETURNING id`,
          [p.experiment_id, model.modelId || model.id, model.modelId || model.id, JSON.stringify(metadata)]
        );
        inserted.push({ id: result.rows[0].id, modelId: model.modelId || model.id, downloads: model.downloads });
      }

      await pgQuery(`UPDATE forge_experiments SET status = 'researching', updated_at = NOW() WHERE id = $1 AND status = 'created'`, [p.experiment_id]);
      log("info", "discover_models", `Found ${inserted.length} models`, { experiment_id: p.experiment_id });
      return { query, models_found: inserted.length, discoveries: inserted };
    },
  },

  discover_datasets: {
    description: "Search HuggingFace Hub for datasets relevant to the experiment domain. Stores results as discoveries.",
    params: {
      experiment_id: "Experiment ID",
      query: "(optional) Custom search query. Defaults to experiment domain.",
      limit: "(optional) Max results, default 10",
    },
    handler: async (p) => {
      await ready();
      const exp = await pgQuery(`SELECT * FROM forge_experiments WHERE id = $1`, [p.experiment_id]);
      if (exp.rowCount === 0) throw new Error(`Experiment ${p.experiment_id} not found`);

      const query = p.query || exp.rows[0].domain;
      const limit = p.limit || 10;

      log("info", "discover_datasets", `Searching HF datasets: "${query}"`, { limit });
      const datasets = await hfSearch("datasets", query, limit);

      const inserted = [];
      for (const ds of datasets) {
        const metadata = {
          datasetId: ds.id,
          tags: ds.tags,
          downloads: ds.downloads,
          likes: ds.likes,
          cardData: ds.cardData,
          description: ds.description,
        };
        const result = await pgQuery(
          `INSERT INTO forge_discoveries (experiment_id, source_type, source_id, name, metadata)
           VALUES ($1, 'hf_dataset', $2, $3, $4) RETURNING id`,
          [p.experiment_id, ds.id, ds.id, JSON.stringify(metadata)]
        );
        inserted.push({ id: result.rows[0].id, datasetId: ds.id, downloads: ds.downloads });
      }

      await pgQuery(`UPDATE forge_experiments SET status = 'researching', updated_at = NOW() WHERE id = $1 AND status = 'created'`, [p.experiment_id]);
      log("info", "discover_datasets", `Found ${inserted.length} datasets`, { experiment_id: p.experiment_id });
      return { query, datasets_found: inserted.length, discoveries: inserted };
    },
  },

  add_source: {
    description: "Manually add a discovery source (web page, paper, etc.) with its text content for KG extraction.",
    params: {
      experiment_id: "Experiment ID",
      source_type: "Source type: web_page|paper|hf_model|hf_dataset|hf_space",
      source_id: "Unique identifier (URL, DOI, or HF model/dataset ID)",
      name: "Human-readable name",
      raw_text: "(optional) Raw text content for triple extraction",
      metadata: "(optional) Additional metadata as JSON object",
    },
    handler: async (p) => {
      await ready();
      const result = await pgQuery(
        `INSERT INTO forge_discoveries (experiment_id, source_type, source_id, name, raw_text, metadata)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [p.experiment_id, p.source_type, p.source_id, p.name, p.raw_text || null, JSON.stringify(p.metadata || {})]
      );
      return result.rows[0];
    },
  },

  list_discoveries: {
    description: "List discovered sources for an experiment.",
    params: {
      experiment_id: "Experiment ID",
      source_type: "(optional) Filter by type: hf_model|hf_dataset|hf_space|web_page|paper",
      processed: "(optional) Filter by processed status: true|false",
    },
    handler: async (p) => {
      await ready();
      let sql = `SELECT id, source_type, source_id, name, processed, created_at,
        jsonb_build_object('downloads', metadata->>'downloads', 'likes', metadata->>'likes', 'pipeline_tag', metadata->>'pipeline_tag') as summary
        FROM forge_discoveries WHERE experiment_id = $1`;
      const params: any[] = [p.experiment_id];
      let idx = 2;
      if (p.source_type) { sql += ` AND source_type = $${idx++}`; params.push(p.source_type); }
      if (p.processed !== undefined) { sql += ` AND processed = $${idx++}`; params.push(p.processed === "true" || p.processed === true); }
      sql += ` ORDER BY created_at`;
      const result = await pgQuery(sql, params);
      return { discoveries: result.rows, count: result.rowCount };
    },
  },

  fetch_model_details: {
    description: "Fetch full details + README from a HuggingFace model and store as raw_text on the discovery for triple extraction.",
    params: {
      discovery_id: "Discovery ID (must be source_type = hf_model)",
    },
    handler: async (p) => {
      await ready();
      const disc = await pgQuery(`SELECT * FROM forge_discoveries WHERE id = $1`, [p.discovery_id]);
      if (disc.rowCount === 0) throw new Error(`Discovery ${p.discovery_id} not found`);
      const d = disc.rows[0];
      if (d.source_type !== "hf_model") throw new Error("Discovery must be hf_model type");

      const modelInfo = await hfGetModel(d.source_id);
      // Fetch README
      let readme = "";
      try {
        const readmeRes = await fetch(`https://huggingface.co/${d.source_id}/raw/main/README.md`);
        if (readmeRes.ok) readme = await readmeRes.text();
      } catch { /* README may not exist */ }

      const fullText = [
        `Model: ${modelInfo.modelId || modelInfo.id}`,
        `Pipeline: ${modelInfo.pipeline_tag || "unknown"}`,
        `Library: ${modelInfo.library_name || "unknown"}`,
        `Tags: ${(modelInfo.tags || []).join(", ")}`,
        `Downloads: ${modelInfo.downloads}`,
        modelInfo.cardData ? `Card Data: ${JSON.stringify(modelInfo.cardData)}` : "",
        readme ? `\n--- README ---\n${readme.slice(0, 8000)}` : "",
      ].filter(Boolean).join("\n");

      await pgQuery(
        `UPDATE forge_discoveries SET raw_text = $1, metadata = $2, updated_at = NOW() WHERE id = $3`,
        [fullText, JSON.stringify(modelInfo), p.discovery_id]
      );

      return { discovery_id: p.discovery_id, model: modelInfo.modelId || modelInfo.id, text_length: fullText.length };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // Stage 2: KG Construction
  // ══════════════════════════════════════════════════════════════

  extract_triples: {
    description: "Extract entity-relation-entity triples from a discovery's raw_text using LLM. Stores triples in PG for review before Neo4j import.",
    params: {
      experiment_id: "Experiment ID",
      discovery_id: "(optional) Specific discovery to process. If omitted, processes all unprocessed discoveries.",
      model: `(optional) LLM model for extraction. Default: ${DEFAULT_EXTRACT_MODEL}`,
    },
    handler: async (p) => {
      await ready();
      const model = p.model || DEFAULT_EXTRACT_MODEL;

      let discoveries;
      if (p.discovery_id) {
        discoveries = await pgQuery(
          `SELECT * FROM forge_discoveries WHERE id = $1 AND experiment_id = $2 AND raw_text IS NOT NULL`,
          [p.discovery_id, p.experiment_id]
        );
      } else {
        discoveries = await pgQuery(
          `SELECT * FROM forge_discoveries WHERE experiment_id = $1 AND processed = FALSE AND raw_text IS NOT NULL`,
          [p.experiment_id]
        );
      }

      if (discoveries.rowCount === 0) return { message: "No unprocessed discoveries with raw_text found", extracted: 0 };

      let totalTriples = 0;
      const results: any[] = [];

      for (const disc of discoveries.rows) {
        const text = disc.raw_text.slice(0, 6000); // limit context
        const prompt = `Extract structured knowledge triples from the following text. Each triple should be: (subject, predicate, object).

Rules:
- Subjects and objects are entities (models, datasets, concepts, techniques, organizations, people)
- Predicates are relationships (uses, is_type_of, trained_on, achieves, outperforms, developed_by, related_to, requires, supports, part_of)
- Include a confidence score (0.0-1.0) for each triple
- Output as JSON array: [{"subject": "...", "predicate": "...", "object": "...", "confidence": 0.9}]
- Extract 5-20 meaningful triples, focus on factual relationships
- Use consistent entity names (e.g. "GPT-4" not "gpt4" or "GPT 4")

Text:
${text}

Output ONLY the JSON array, no other text.`;

        try {
          const response = await llmCall(model, [{ role: "user", content: prompt }], 3000);
          // Parse JSON from response (handle markdown code blocks)
          const jsonStr = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
          const triples = JSON.parse(jsonStr);

          if (!Array.isArray(triples)) throw new Error("Expected JSON array");

          for (const triple of triples) {
            if (!triple.subject || !triple.predicate || !triple.object) continue;
            await pgQuery(
              `INSERT INTO forge_triples (experiment_id, discovery_id, subject, predicate, object, confidence)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [p.experiment_id, disc.id, triple.subject, triple.predicate, triple.object, triple.confidence || 0.8]
            );
            totalTriples++;
          }

          await pgQuery(`UPDATE forge_discoveries SET processed = TRUE WHERE id = $1`, [disc.id]);
          results.push({ discovery_id: disc.id, name: disc.name, triples_extracted: triples.length });
        } catch (err: any) {
          log("error", "extract_triples", `Failed for discovery ${disc.id}: ${err.message}`);
          results.push({ discovery_id: disc.id, name: disc.name, error: err.message });
        }
      }

      await pgQuery(`UPDATE forge_experiments SET status = 'building_kg', updated_at = NOW() WHERE id = $1`, [p.experiment_id]);
      log("info", "extract_triples", `Extracted ${totalTriples} triples from ${discoveries.rowCount} sources`, { experiment_id: p.experiment_id });
      return { total_triples: totalTriples, sources_processed: results.length, details: results };
    },
  },

  list_triples: {
    description: "List extracted triples for an experiment, with optional filtering.",
    params: {
      experiment_id: "Experiment ID",
      min_confidence: "(optional) Minimum confidence threshold, default 0.0",
      imported: "(optional) Filter by Neo4j import status: true|false",
      limit: "(optional) Max results, default 100",
    },
    handler: async (p) => {
      await ready();
      let sql = `SELECT t.*, d.name as source_name FROM forge_triples t
        LEFT JOIN forge_discoveries d ON d.id = t.discovery_id
        WHERE t.experiment_id = $1`;
      const params: any[] = [p.experiment_id];
      let idx = 2;
      if (p.min_confidence) { sql += ` AND t.confidence >= $${idx++}`; params.push(parseFloat(p.min_confidence)); }
      if (p.imported !== undefined) { sql += ` AND t.imported_to_neo4j = $${idx++}`; params.push(p.imported === "true" || p.imported === true); }
      sql += ` ORDER BY t.confidence DESC LIMIT $${idx++}`;
      params.push(p.limit || 100);
      const result = await pgQuery(sql, params);
      return { triples: result.rows, count: result.rowCount };
    },
  },

  import_kg: {
    description: "Import extracted triples into Neo4j knowledge graph. Creates nodes with domain-specific labels and relationships. Only imports triples above the confidence threshold.",
    params: {
      experiment_id: "Experiment ID",
      min_confidence: "(optional) Minimum confidence to import, default 0.7",
      domain_label: "(optional) Neo4j label prefix for domain nodes, default 'Forge'",
      dry_run: "(optional) Set to true to preview without importing",
    },
    handler: async (p) => {
      await ready();
      const minConfidence = parseFloat(p.min_confidence || "0.7");
      const label = p.domain_label || "Forge";

      const triples = await pgQuery(
        `SELECT * FROM forge_triples WHERE experiment_id = $1 AND confidence >= $2 AND imported_to_neo4j = FALSE ORDER BY confidence DESC`,
        [p.experiment_id, minConfidence]
      );

      if (triples.rowCount === 0) return { message: "No triples to import", count: 0 };

      if (p.dry_run) {
        return {
          dry_run: true,
          triples_to_import: triples.rowCount,
          sample: triples.rows.slice(0, 10).map((t: any) => `(${t.subject}) -[${t.predicate}]-> (${t.object}) [${t.confidence}]`),
        };
      }

      // Collect unique entities
      const entities = new Set<string>();
      for (const t of triples.rows) {
        entities.add(t.subject);
        entities.add(t.object);
      }

      // Create/merge nodes
      const now = new Date().toISOString();
      for (const entity of entities) {
        await runCypher(
          `MERGE (n:${label} {name: $name})
           ON CREATE SET n.created_at = $now, n.recorded_at = $now, n.observations = [], n.source = 'agentforge'
           ON MATCH SET n.recorded_at = $now`,
          { name: entity, now }
        );
      }

      // Create relationships
      let imported = 0;
      for (const t of triples.rows) {
        const relType = t.predicate.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
        try {
          await runCypher(
            `MATCH (a:${label} {name: $subject}), (b:${label} {name: $object})
             MERGE (a)-[r:${relType}]->(b)
             ON CREATE SET r.confidence = $confidence, r.created_at = $now, r.recorded_at = $now, r.source = 'agentforge'`,
            { subject: t.subject, object: t.object, confidence: t.confidence, now }
          );
          await pgQuery(`UPDATE forge_triples SET imported_to_neo4j = TRUE WHERE id = $1`, [t.id]);
          imported++;
        } catch (err: any) {
          log("warn", "import_kg", `Failed to import triple ${t.id}: ${err.message}`);
        }
      }

      await pgQuery(`UPDATE forge_experiments SET updated_at = NOW() WHERE id = $1`, [p.experiment_id]);
      log("info", "import_kg", `Imported ${imported}/${triples.rowCount} triples to Neo4j`, { experiment_id: p.experiment_id, label });
      return {
        entities_created: entities.size,
        triples_imported: imported,
        triples_total: triples.rowCount,
        label,
      };
    },
  },

  query_domain_kg: {
    description: "Query the domain-specific knowledge graph built by an experiment. Returns entities, relationships, and paths.",
    params: {
      experiment_id: "Experiment ID (used to determine the label prefix)",
      entity: "(optional) Find a specific entity and its neighbors",
      cypher: "(optional) Raw Cypher query (advanced)",
      domain_label: "(optional) Label prefix, default 'Forge'",
    },
    handler: async (p) => {
      await ready();
      const label = p.domain_label || "Forge";

      if (p.cypher) {
        const result = await runCypher(p.cypher);
        return { results: result, count: result.length };
      }

      if (p.entity) {
        const result = await runCypher(
          `MATCH (n:${label} {name: $name})-[r]-(m:${label})
           RETURN n, type(r) as rel_type, r.confidence as confidence, m`,
          { name: p.entity }
        );
        return { entity: p.entity, neighbors: result, count: result.length };
      }

      // Default: return graph summary
      const [nodeCount, relCount, topEntities] = await Promise.all([
        runCypher(`MATCH (n:${label}) RETURN count(n) as count`),
        runCypher(`MATCH (:${label})-[r]->(:${label}) RETURN count(r) as count`),
        runCypher(`MATCH (n:${label})-[r]-() RETURN n.name as entity, count(r) as connections ORDER BY connections DESC LIMIT 10`),
      ]);

      return {
        label,
        nodes: nodeCount[0]?.count || 0,
        relationships: relCount[0]?.count || 0,
        top_entities: topEntities,
      };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // Stage 3: Prompt Optimization
  // ══════════════════════════════════════════════════════════════

  create_prompt_experiment: {
    description: "Create a prompt optimization experiment. Define the base prompt, evaluation criteria, and test cases for A/B testing.",
    params: {
      experiment_id: "Parent AgentForge experiment ID",
      prompt_name: "Name for this prompt (e.g. 'system_prompt', 'extraction_prompt')",
      base_prompt: "The initial prompt to optimize",
      evaluation_criteria: "Object describing how to score variants: {criteria: [{name, weight, description}], scoring: 'llm_judge'|'exact_match'|'contains'}",
      test_cases: "Array of test inputs: [{input, expected_output?, context?}]",
    },
    handler: async (p) => {
      await ready();
      const result = await pgQuery(
        `INSERT INTO forge_prompt_experiments (experiment_id, prompt_name, base_prompt, evaluation_criteria, test_cases)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          p.experiment_id, p.prompt_name, p.base_prompt,
          JSON.stringify(p.evaluation_criteria || {}),
          JSON.stringify(p.test_cases || []),
        ]
      );
      // Insert the base prompt as variant 0
      await pgQuery(
        `INSERT INTO forge_prompt_variants (prompt_experiment_id, variant_number, prompt_text, generation_method)
         VALUES ($1, 0, $2, 'original')`,
        [result.rows[0].id, p.base_prompt]
      );
      return result.rows[0];
    },
  },

  generate_variants: {
    description: "Generate prompt variants for a prompt experiment using LLM. Creates N alternative prompts optimized for the evaluation criteria.",
    params: {
      prompt_experiment_id: "Prompt experiment ID",
      count: "(optional) Number of variants to generate, default 3",
      model: `(optional) LLM model for generation. Default: ${DEFAULT_OPTIMIZE_MODEL}`,
      strategy: "(optional) Generation strategy: 'diverse'|'refined'|'simplified'. Default: 'diverse'",
    },
    handler: async (p) => {
      await ready();
      const model = p.model || DEFAULT_OPTIMIZE_MODEL;
      const count = p.count || 3;
      const strategy = p.strategy || "diverse";

      const pexp = await pgQuery(`SELECT * FROM forge_prompt_experiments WHERE id = $1`, [p.prompt_experiment_id]);
      if (pexp.rowCount === 0) throw new Error(`Prompt experiment ${p.prompt_experiment_id} not found`);
      const pe = pexp.rows[0];

      const criteria = typeof pe.evaluation_criteria === "string" ? JSON.parse(pe.evaluation_criteria) : pe.evaluation_criteria;
      const testCases = typeof pe.test_cases === "string" ? JSON.parse(pe.test_cases) : pe.test_cases;

      // Get existing variants to inform generation
      const existingVariants = await pgQuery(
        `SELECT variant_number, prompt_text, avg_score FROM forge_prompt_variants WHERE prompt_experiment_id = $1 ORDER BY variant_number`,
        [p.prompt_experiment_id]
      );

      const strategyInstructions: Record<string, string> = {
        diverse: "Generate diverse alternatives that take different approaches to the same task. Vary structure, tone, level of detail, and prompting techniques (chain-of-thought, few-shot, role-based, etc.).",
        refined: "Generate refined versions that improve on the original while maintaining its core approach. Focus on clarity, specificity, and addressing potential failure modes.",
        simplified: "Generate simplified versions that are more concise and focused. Remove unnecessary complexity while maintaining effectiveness.",
      };

      const prompt = `You are an expert prompt engineer. Generate ${count} alternative versions of the following prompt.

ORIGINAL PROMPT:
${pe.base_prompt}

EVALUATION CRITERIA:
${JSON.stringify(criteria, null, 2)}

SAMPLE TEST CASES:
${JSON.stringify(testCases.slice(0, 3), null, 2)}

${existingVariants.rowCount > 1 ? `EXISTING VARIANTS AND SCORES:\n${existingVariants.rows.map((v: any) => `Variant ${v.variant_number} (score: ${v.avg_score ?? 'not evaluated'}): ${v.prompt_text.slice(0, 200)}...`).join("\n\n")}` : ""}

STRATEGY: ${strategyInstructions[strategy] || strategyInstructions.diverse}

Generate exactly ${count} prompt variants. Output as JSON array:
[{"prompt_text": "...", "rationale": "brief explanation of changes"}]

Output ONLY the JSON array.`;

      log("info", "generate_variants", `Generating ${count} variants with strategy: ${strategy}`, { prompt_experiment_id: p.prompt_experiment_id });
      const response = await llmCall(model, [{ role: "user", content: prompt }], 8000);
      const jsonStr = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const variants = JSON.parse(jsonStr);

      if (!Array.isArray(variants)) throw new Error("Expected JSON array of variants");

      // Get next variant number
      const lastVariant = await pgQuery(
        `SELECT MAX(variant_number) as max_num FROM forge_prompt_variants WHERE prompt_experiment_id = $1`,
        [p.prompt_experiment_id]
      );
      let nextNum = (lastVariant.rows[0].max_num || 0) + 1;

      const inserted = [];
      for (const v of variants) {
        if (!v.prompt_text) continue;
        const result = await pgQuery(
          `INSERT INTO forge_prompt_variants (prompt_experiment_id, variant_number, prompt_text, generation_method)
           VALUES ($1, $2, $3, $4) RETURNING id, variant_number`,
          [p.prompt_experiment_id, nextNum, v.prompt_text, `llm_${strategy}`]
        );
        inserted.push({ ...result.rows[0], rationale: v.rationale });
        nextNum++;
      }

      await pgQuery(`UPDATE forge_prompt_experiments SET status = 'generating', updated_at = NOW() WHERE id = $1`, [p.prompt_experiment_id]);
      return { variants_generated: inserted.length, variants: inserted };
    },
  },

  evaluate_variants: {
    description: "Evaluate prompt variants against test cases using an LLM judge. Scores each variant and identifies the winner.",
    params: {
      prompt_experiment_id: "Prompt experiment ID",
      model: `(optional) LLM model for evaluation judging. Default: ${DEFAULT_EVAL_MODEL}`,
      execution_model: "(optional) Model to execute prompts with for testing. Default: same as judge model.",
    },
    handler: async (p) => {
      await ready();
      const judgeModel = p.model || DEFAULT_EVAL_MODEL;
      const execModel = p.execution_model || judgeModel;

      const pexp = await pgQuery(`SELECT * FROM forge_prompt_experiments WHERE id = $1`, [p.prompt_experiment_id]);
      if (pexp.rowCount === 0) throw new Error(`Prompt experiment ${p.prompt_experiment_id} not found`);
      const pe = pexp.rows[0];

      const criteria = typeof pe.evaluation_criteria === "string" ? JSON.parse(pe.evaluation_criteria) : pe.evaluation_criteria;
      const testCases = typeof pe.test_cases === "string" ? JSON.parse(pe.test_cases) : pe.test_cases;

      if (!testCases.length) throw new Error("No test cases defined. Add test_cases to the prompt experiment.");

      const variants = await pgQuery(
        `SELECT * FROM forge_prompt_variants WHERE prompt_experiment_id = $1 AND evaluated = FALSE ORDER BY variant_number`,
        [p.prompt_experiment_id]
      );

      if (variants.rowCount === 0) return { message: "All variants already evaluated" };

      await pgQuery(`UPDATE forge_prompt_experiments SET status = 'evaluating', updated_at = NOW() WHERE id = $1`, [p.prompt_experiment_id]);
      log("info", "evaluate_variants", `Evaluating ${variants.rowCount} variants against ${testCases.length} test cases`);

      const results: any[] = [];

      for (const variant of variants.rows) {
        const scores: Record<string, number> = {};
        let totalScore = 0;
        let scoredTests = 0;

        for (let i = 0; i < testCases.length; i++) {
          const tc = testCases[i];
          try {
            // Execute the prompt with the test input
            const execResponse = await llmCall(execModel, [
              { role: "system", content: variant.prompt_text },
              { role: "user", content: tc.input },
            ], 2000);

            // Judge the output
            const judgePrompt = `Score the following LLM output on a scale of 1-10 for each criterion.

PROMPT USED:
${variant.prompt_text.slice(0, 500)}

INPUT: ${tc.input}
OUTPUT: ${execResponse.slice(0, 1000)}
${tc.expected_output ? `EXPECTED: ${tc.expected_output}` : ""}

CRITERIA:
${JSON.stringify(criteria.criteria || [{ name: "quality", weight: 1, description: "Overall quality and relevance" }], null, 2)}

Score each criterion and provide an overall score. Output as JSON:
{"scores": {"criterion_name": score_number}, "overall": number, "notes": "brief notes"}

Output ONLY the JSON.`;

            const judgeResponse = await llmCall(judgeModel, [{ role: "user", content: judgePrompt }], 500);
            const judgeJson = JSON.parse(judgeResponse.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

            const testScore = judgeJson.overall || 5;
            scores[`test_${i}`] = testScore;
            totalScore += testScore;
            scoredTests++;
          } catch (err: any) {
            log("warn", "evaluate_variants", `Failed to evaluate variant ${variant.variant_number} on test ${i}: ${err.message}`);
            scores[`test_${i}_error`] = err.message;
          }
        }

        const avgScore = scoredTests > 0 ? totalScore / scoredTests : 0;
        await pgQuery(
          `UPDATE forge_prompt_variants SET scores = $1, avg_score = $2, evaluated = TRUE WHERE id = $3`,
          [JSON.stringify(scores), avgScore, variant.id]
        );
        results.push({ variant_id: variant.id, variant_number: variant.variant_number, avg_score: avgScore, scores });
      }

      // Determine winner
      const allVariants = await pgQuery(
        `SELECT id, variant_number, avg_score FROM forge_prompt_variants WHERE prompt_experiment_id = $1 AND evaluated = TRUE ORDER BY avg_score DESC`,
        [p.prompt_experiment_id]
      );
      const winner = allVariants.rows[0];
      if (winner) {
        await pgQuery(`UPDATE forge_prompt_experiments SET winner_variant_id = $1, status = 'complete', updated_at = NOW() WHERE id = $2`,
          [winner.id, p.prompt_experiment_id]);
      }

      const experimentId = pe.experiment_id;
      await pgQuery(`UPDATE forge_experiments SET status = 'optimizing', updated_at = NOW() WHERE id = $1`, [experimentId]);

      log("info", "evaluate_variants", `Evaluation complete. Winner: variant ${winner?.variant_number} (score: ${winner?.avg_score})`, { prompt_experiment_id: p.prompt_experiment_id });
      return {
        variants_evaluated: results.length,
        results: results.sort((a, b) => b.avg_score - a.avg_score),
        winner: winner ? { variant_id: winner.id, variant_number: winner.variant_number, avg_score: winner.avg_score } : null,
      };
    },
  },

  get_optimization_results: {
    description: "Get prompt optimization results for an experiment, including all variants with scores.",
    params: { prompt_experiment_id: "Prompt experiment ID" },
    handler: async (p) => {
      await ready();
      const pexp = await pgQuery(`SELECT * FROM forge_prompt_experiments WHERE id = $1`, [p.prompt_experiment_id]);
      if (pexp.rowCount === 0) throw new Error(`Prompt experiment ${p.prompt_experiment_id} not found`);

      const variants = await pgQuery(
        `SELECT * FROM forge_prompt_variants WHERE prompt_experiment_id = $1 ORDER BY avg_score DESC NULLS LAST`,
        [p.prompt_experiment_id]
      );

      return {
        experiment: pexp.rows[0],
        variants: variants.rows,
        winner: pexp.rows[0].winner_variant_id
          ? variants.rows.find((v: any) => v.id === pexp.rows[0].winner_variant_id)
          : null,
      };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // Stage 4: Scaffold & Deploy
  // ══════════════════════════════════════════════════════════════

  scaffold_agent: {
    description: "Generate a complete Dify workflow app configuration from the experiment's optimized prompts and KG context. Produces a blueprint-compatible spec.",
    params: {
      experiment_id: "Experiment ID",
      app_name: "Name for the Dify app",
      app_mode: "(optional) Dify app mode: 'workflow'|'chat'|'agent-chat'. Default: 'workflow'",
      model: `(optional) LLM model for scaffold generation. Default: ${DEFAULT_OPTIMIZE_MODEL}`,
    },
    handler: async (p) => {
      await ready();
      const exp = await pgQuery(`SELECT * FROM forge_experiments WHERE id = $1`, [p.experiment_id]);
      if (exp.rowCount === 0) throw new Error(`Experiment ${p.experiment_id} not found`);

      // Gather winning prompts
      const prompts = await pgQuery(
        `SELECT pe.prompt_name, pv.prompt_text, pv.avg_score
         FROM forge_prompt_experiments pe
         JOIN forge_prompt_variants pv ON pv.id = pe.winner_variant_id
         WHERE pe.experiment_id = $1`,
        [p.experiment_id]
      );

      // Gather KG summary
      const tripleSummary = await pgQuery(
        `SELECT subject, predicate, object, confidence FROM forge_triples
         WHERE experiment_id = $1 AND confidence >= 0.7
         ORDER BY confidence DESC LIMIT 50`,
        [p.experiment_id]
      );

      // Gather discovery metadata
      const discoverySummary = await pgQuery(
        `SELECT source_type, name, metadata->>'pipeline_tag' as task, metadata->>'downloads' as downloads
         FROM forge_discoveries WHERE experiment_id = $1 ORDER BY created_at LIMIT 20`,
        [p.experiment_id]
      );

      const model = p.model || DEFAULT_OPTIMIZE_MODEL;
      const appMode = p.app_mode || "workflow";

      const scaffoldPrompt = `You are a Dify AI platform expert. Generate a complete Dify ${appMode} app configuration.

AGENT DOMAIN: ${exp.rows[0].domain}
AGENT DESCRIPTION: ${exp.rows[0].description || "N/A"}

OPTIMIZED PROMPTS:
${prompts.rows.map((p: any) => `- ${p.prompt_name} (score: ${p.avg_score}): ${p.prompt_text.slice(0, 500)}`).join("\n")}

DOMAIN KNOWLEDGE (top triples):
${tripleSummary.rows.map((t: any) => `(${t.subject}) -[${t.predicate}]-> (${t.object})`).join("\n")}

RELEVANT MODELS/DATASETS:
${discoverySummary.rows.map((d: any) => `- ${d.name} (${d.source_type}, task: ${d.task || "N/A"})`).join("\n")}

Generate a JSON object with:
{
  "app_config": {
    "name": "${p.app_name}",
    "mode": "${appMode}",
    "description": "...",
    "icon": "emoji character",
    "system_prompt": "the optimized system prompt",
    "model": "model ID to use (prefer openrouter models)",
    "tools": ["list of recommended tool names"],
    "knowledge_base_docs": ["list of documents to add to KB"],
    "workflow_nodes": ${appMode === "workflow" ? '"array of workflow node definitions"' : "null"}
  },
  "blueprint": {
    "name": "blueprint-name",
    "description": "...",
    "components": {
      "dify_app": { "mode": "${appMode}", "model": "...", "system_prompt": "..." },
      "knowledge_base": { "name": "...", "documents": [] }
    },
    "guardrails": {
      "max_daily_actions": 100,
      "auto_disable_after": "30 days inactive"
    }
  }
}

Output ONLY the JSON object.`;

      log("info", "scaffold_agent", `Scaffolding agent: ${p.app_name}`, { experiment_id: p.experiment_id, mode: appMode });
      const response = await llmCall(model, [{ role: "user", content: scaffoldPrompt }], 6000);
      const jsonStr = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const scaffold = JSON.parse(jsonStr);

      // Store in experiment results
      await pgQuery(
        `UPDATE forge_experiments SET results = results || $1, status = 'scaffolding', updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ scaffold }), p.experiment_id]
      );

      log("info", "scaffold_agent", `Scaffold generated for ${p.app_name}`, { experiment_id: p.experiment_id });
      return scaffold;
    },
  },

  deploy_agent: {
    description: "Deploy a scaffolded agent to Dify. Creates the app, configures it with optimized prompts, and optionally creates a knowledge base. Requires confirm=true.",
    params: {
      experiment_id: "Experiment ID (must have scaffold in results)",
      confirm: "Must be true to actually deploy. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true to deploy. Use scaffold_agent first to review the config." };
      }
      await ready();
      const exp = await pgQuery(`SELECT * FROM forge_experiments WHERE id = $1`, [p.experiment_id]);
      if (exp.rowCount === 0) throw new Error(`Experiment ${p.experiment_id} not found`);

      const results = typeof exp.rows[0].results === "string" ? JSON.parse(exp.rows[0].results) : exp.rows[0].results;
      if (!results?.scaffold?.app_config) throw new Error("No scaffold found. Run scaffold_agent first.");

      const appConfig = results.scaffold.app_config;

      // Create Dify app
      log("info", "deploy_agent", `Creating Dify app: ${appConfig.name}`);
      const app = await difyConsole("/apps", {
        method: "POST",
        body: JSON.stringify({
          name: appConfig.name,
          mode: appConfig.mode || "workflow",
          description: appConfig.description || "",
          icon_type: "emoji",
          icon: appConfig.icon || "🤖",
          icon_background: "#FFEAD5",
        }),
      });

      const appId = app.id;

      // Create knowledge base if specified
      let datasetId: string | null = null;
      if (results.scaffold.blueprint?.components?.knowledge_base) {
        const kb = results.scaffold.blueprint.components.knowledge_base;
        const dataset = await difyConsole("/datasets", {
          method: "POST",
          body: JSON.stringify({ name: kb.name || `${appConfig.name}-kb`, description: `Knowledge base for ${appConfig.name}` }),
        });
        datasetId = dataset.id;

        // Upload KG triples as a document
        const triples = await pgQuery(
          `SELECT subject, predicate, object FROM forge_triples WHERE experiment_id = $1 AND confidence >= 0.7`,
          [p.experiment_id]
        );
        if (triples.rowCount > 0) {
          const kgDoc = triples.rows.map((t: any) => `${t.subject} ${t.predicate} ${t.object}`).join("\n");
          await difyConsole(`/datasets/${datasetId}/document/create-by-text`, {
            method: "POST",
            body: JSON.stringify({
              name: "domain-knowledge-graph.txt",
              text: kgDoc,
              indexing_technique: "high_quality",
              process_rule: { mode: "automatic" },
            }),
          });
        }
      }

      // Store deployment info
      await pgQuery(
        `UPDATE forge_experiments SET results = results || $1, status = 'complete', updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ deployment: { app_id: appId, dataset_id: datasetId, deployed_at: new Date().toISOString() } }), p.experiment_id]
      );

      await ntfyNotify(
        `AgentForge deployed: ${appConfig.name} (app: ${appId})`,
        "Agent Deployed",
        3,
        ["robot_face"]
      );

      log("info", "deploy_agent", `Deployed: ${appConfig.name}`, { app_id: appId, dataset_id: datasetId });
      return {
        app_id: appId,
        app_name: appConfig.name,
        dataset_id: datasetId,
        mode: appConfig.mode,
        message: `Agent '${appConfig.name}' deployed to Dify. App ID: ${appId}`,
      };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // PM Decision Framework
  // ══════════════════════════════════════════════════════════════

  evaluate_resources: {
    description: "Run the 5-step PM resource evaluation for a project: (1) prompt inventory, (2) tool discovery, (3) LightRAG scoring, (4) prompt creation needs, (5) HitL approval notification. Returns evaluation with recommendations.",
    params: {
      project_slug: "Pipeline project slug to evaluate",
    },
    handler: async (p) => {
      await ready();
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.project_slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.project_slug}' not found`);
      const project = proj.rows[0];

      log("info", "evaluate_resources", `Starting resource evaluation for: ${project.name}`);

      // Step 1: Prompt Inventory — check existing Dify apps
      let reusablePrompts: any[] = [];
      try {
        const apps = await difyConsole("/apps?page=1&limit=100");
        if (apps.data) {
          reusablePrompts = apps.data
            .filter((a: any) => a.name?.toLowerCase().includes(project.name.toLowerCase()) ||
              a.description?.toLowerCase().includes(project.name.toLowerCase()) ||
              (project.tags || []).some((t: string) => a.name?.toLowerCase().includes(t.toLowerCase())))
            .map((a: any) => ({ id: a.id, name: a.name, mode: a.mode, description: a.description }));
        }
      } catch (err: any) {
        log("warn", "evaluate_resources", `Dify search failed: ${err.message}`);
      }

      // Step 2: Tool Discovery — use LLM to identify useful tools
      let newTools: any[] = [];
      try {
        const toolPrompt = `Given this project description, identify 3-5 free or self-hostable tools that would benefit development. Focus on: MCP servers, APIs, specialized models, data sources.

Project: ${project.name}
Description: ${project.description || "N/A"}
Tags: ${(project.tags || []).join(", ")}

Output as JSON array: [{"name": "tool name", "type": "mcp_server|api|model|data_source", "url": "homepage URL", "justification": "why it's useful"}]
Output ONLY the JSON array.`;

        const toolResponse = await llmCall(DEFAULT_EVAL_MODEL, [{ role: "user", content: toolPrompt }], 1500);
        const toolJson = toolResponse.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        newTools = JSON.parse(toolJson);
      } catch (err: any) {
        log("warn", "evaluate_resources", `Tool discovery failed: ${err.message}`);
      }

      // Step 3: LightRAG Scoring (4-point checklist)
      const sourceTypes = new Set<string>();
      if (project.description) {
        // Heuristic: count distinct information domains mentioned
        const domains = ["api", "database", "model", "paper", "documentation", "regulation", "standard", "protocol"];
        for (const d of domains) {
          if (project.description.toLowerCase().includes(d)) sourceTypes.add(d);
        }
      }
      // Also check research findings if available
      const research = await pgQuery(
        `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
        [project.id]
      );
      const workflowCount = research.rowCount;

      const lightragChecklist = {
        source_types: sourceTypes.size >= 3,
        multi_workflow: workflowCount >= 2,
        entity_relationships: project.description?.toLowerCase().includes("relat") ||
          project.description?.toLowerCase().includes("connect") ||
          project.description?.toLowerCase().includes("depend") || false,
        reuse_potential: (project.tags || []).length >= 2, // more tags = more cross-project potential
      };
      const lightragScore = Object.values(lightragChecklist).filter(Boolean).length;
      const lightragRecommended = lightragScore >= 3;

      // Step 4: Prompt Creation Needs
      const gapCount = Math.max(0, 3 - reusablePrompts.length); // rough estimate
      const estimatedCost = gapCount * 0.50 + (lightragRecommended ? 2.0 : 0); // rough cost estimate

      // Store evaluation
      const evalResult = await pgQuery(
        `INSERT INTO forge_resource_evaluations
         (project_id, reusable_prompts, new_tools, lightrag_score, lightrag_details, lightrag_recommended,
          prompts_to_create, estimated_cost, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'awaiting_approval')
         RETURNING *`,
        [
          project.id,
          JSON.stringify(reusablePrompts),
          JSON.stringify(newTools),
          lightragScore,
          JSON.stringify(lightragChecklist),
          lightragRecommended,
          gapCount,
          estimatedCost,
        ]
      );

      // Step 5: HitL Notification
      const notification = [
        `📋 Project: ${project.name}`,
        `✅ Reusable prompts: ${reusablePrompts.length} (${reusablePrompts.map((p: any) => p.name).join(", ") || "none"})`,
        `🆕 New tools: ${newTools.length} (${newTools.map((t: any) => t.name).join(", ") || "none"})`,
        `🕸️ LightRAG: ${lightragRecommended ? "YES" : "No"} (score: ${lightragScore}/4)`,
        `📝 Prompts to create: ${gapCount}`,
        `💰 Est. cost: $${estimatedCost.toFixed(2)}`,
        "",
        "⏳ Awaiting approval...",
      ].join("\n");

      await ntfyNotify(notification, "Resource Evaluation", 4, ["clipboard"]);

      log("info", "evaluate_resources", `Evaluation complete for ${project.name}`, {
        reusable: reusablePrompts.length,
        new_tools: newTools.length,
        lightrag_score: lightragScore,
      });

      return {
        evaluation_id: evalResult.rows[0].id,
        project: project.name,
        reusable_prompts: reusablePrompts,
        new_tools: newTools,
        lightrag: {
          score: lightragScore,
          recommended: lightragRecommended,
          checklist: lightragChecklist,
        },
        prompts_to_create: gapCount,
        estimated_cost: estimatedCost,
        status: "awaiting_approval",
      };
    },
  },

  approve_evaluation: {
    description: "Approve, modify, or skip a PM resource evaluation.",
    params: {
      evaluation_id: "Resource evaluation ID",
      decision: "Decision: approve|modify|skip",
      notes: "(optional) Notes or modifications",
    },
    handler: async (p) => {
      await ready();
      const status = p.decision === "approve" ? "approved" : p.decision === "modify" ? "modified" : "skipped";
      const result = await pgQuery(
        `UPDATE forge_resource_evaluations SET status = $1, user_response = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
        [status, p.notes || null, p.evaluation_id]
      );
      if (result.rowCount === 0) throw new Error(`Evaluation ${p.evaluation_id} not found`);

      await ntfyNotify(
        `Resource evaluation ${status}: ${p.notes || "no notes"}`,
        "Evaluation Decision",
        3,
        [status === "approved" ? "white_check_mark" : status === "modified" ? "pencil" : "fast_forward"]
      );

      return result.rows[0];
    },
  },

  get_evaluation: {
    description: "Get a PM resource evaluation by ID or by project slug.",
    params: {
      evaluation_id: "(optional) Evaluation ID",
      project_slug: "(optional) Get latest evaluation for a project",
    },
    handler: async (p) => {
      await ready();
      if (p.evaluation_id) {
        const result = await pgQuery(`SELECT * FROM forge_resource_evaluations WHERE id = $1`, [p.evaluation_id]);
        if (result.rowCount === 0) throw new Error(`Evaluation ${p.evaluation_id} not found`);
        return result.rows[0];
      }
      if (p.project_slug) {
        const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.project_slug]);
        if (proj.rowCount === 0) throw new Error(`Project '${p.project_slug}' not found`);
        const result = await pgQuery(
          `SELECT * FROM forge_resource_evaluations WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [proj.rows[0].id]
        );
        if (result.rowCount === 0) return { message: "No evaluations found for this project" };
        return result.rows[0];
      }
      throw new Error("Provide evaluation_id or project_slug");
    },
  },

  // ══════════════════════════════════════════════════════════════
  // Full Pipeline
  // ══════════════════════════════════════════════════════════════

  run_pipeline: {
    description: "Run the full AgentForge pipeline: discovery → extraction → KG import → prompt optimization → scaffold. Runs stages sequentially. Use for automated end-to-end agent creation.",
    params: {
      experiment_id: "Experiment ID",
      app_name: "Name for the final Dify app",
      base_prompt: "Initial system prompt to optimize",
      test_cases: "Array of test cases: [{input, expected_output?}]",
      auto_deploy: "(optional) Set to true to automatically deploy after scaffolding. Default: false",
    },
    handler: async (p) => {
      await ready();
      const exp = await pgQuery(`SELECT * FROM forge_experiments WHERE id = $1`, [p.experiment_id]);
      if (exp.rowCount === 0) throw new Error(`Experiment ${p.experiment_id} not found`);

      const stageResults: Record<string, any> = {};

      await ntfyNotify(`AgentForge pipeline started: ${exp.rows[0].name}`, "Pipeline Started", 3, ["gear"]);

      try {
        // Stage 1: Discovery (datasets only — models available via discover_models for manual use)
        log("info", "run_pipeline", "Stage 1: Dataset Discovery");
        const datasetDiscovery = await tools.discover_datasets.handler({ experiment_id: p.experiment_id });
        stageResults.discovery = { datasets: datasetDiscovery.datasets_found };

        // Stage 2: KG Construction
        log("info", "run_pipeline", "Stage 2: KG Construction");
        const extraction = await tools.extract_triples.handler({ experiment_id: p.experiment_id });
        stageResults.extraction = { triples: extraction.total_triples };

        const kgImport = await tools.import_kg.handler({ experiment_id: p.experiment_id });
        stageResults.kg_import = kgImport;

        // Stage 3: Prompt Optimization
        log("info", "run_pipeline", "Stage 3: Prompt Optimization");
        const promptExp = await tools.create_prompt_experiment.handler({
          experiment_id: p.experiment_id,
          prompt_name: "system_prompt",
          base_prompt: p.base_prompt,
          evaluation_criteria: {
            criteria: [
              { name: "relevance", weight: 3, description: "Output is relevant to the domain" },
              { name: "accuracy", weight: 3, description: "Information is factually correct" },
              { name: "completeness", weight: 2, description: "Response addresses the full query" },
              { name: "clarity", weight: 2, description: "Response is clear and well-structured" },
            ],
            scoring: "llm_judge",
          },
          test_cases: p.test_cases,
        });

        const variants = await tools.generate_variants.handler({ prompt_experiment_id: promptExp.id, count: 3, strategy: "diverse" });
        stageResults.variants = { generated: variants.variants_generated };

        const evaluation = await tools.evaluate_variants.handler({ prompt_experiment_id: promptExp.id });
        stageResults.evaluation = { winner: evaluation.winner };

        // Stage 4: Scaffold
        log("info", "run_pipeline", "Stage 4: Scaffolding");
        const scaffold = await tools.scaffold_agent.handler({
          experiment_id: p.experiment_id,
          app_name: p.app_name,
        });
        stageResults.scaffold = { app_name: p.app_name, has_blueprint: !!scaffold.blueprint };

        // Optional: Deploy
        if (p.auto_deploy) {
          log("info", "run_pipeline", "Auto-deploying...");
          const deployment = await tools.deploy_agent.handler({ experiment_id: p.experiment_id, confirm: true });
          stageResults.deployment = deployment;
        }

        await pgQuery(
          `UPDATE forge_experiments SET status = 'complete', results = results || $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify({ pipeline_results: stageResults }), p.experiment_id]
        );

        await ntfyNotify(
          `AgentForge pipeline complete: ${exp.rows[0].name}\n${JSON.stringify(stageResults, null, 2)}`,
          "Pipeline Complete",
          4,
          ["white_check_mark"]
        );

        return { status: "complete", stages: stageResults };

      } catch (err: any) {
        await pgQuery(
          `UPDATE forge_experiments SET status = 'failed', results = results || $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify({ error: err.message, completed_stages: stageResults }), p.experiment_id]
        );

        await ntfyNotify(
          `AgentForge pipeline FAILED: ${exp.rows[0].name}\nError: ${err.message}`,
          "Pipeline Failed",
          5,
          ["rotating_light"]
        );

        log("error", "run_pipeline", `Pipeline failed: ${err.message}`, { experiment_id: p.experiment_id });
        throw err;
      }
    },
  },
};

// --- Registration ---

export function registerAgentforgeTools(server: McpServer) {
  server.tool(
    "agentforge_list",
    "List all available AgentForge tools. AgentForge automates the end-to-end process of creating AI agents: " +
    "researching domains via HuggingFace Hub, building knowledge graphs, optimizing prompts via A/B testing, " +
    "and scaffolding complete Dify workflow apps. Tools cover: pipeline management (create/get/list experiments, run_pipeline), " +
    "discovery (HF model/dataset search, add sources, fetch details), KG construction (extract triples, import to Neo4j, query), " +
    "prompt optimization (create experiments, generate/evaluate variants, get results), " +
    "scaffold & deploy (generate configs, deploy to Dify), and PM framework (evaluate resources, approve/skip).",
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
    "agentforge_call",
    "Execute an AgentForge tool. Use agentforge_list to see available tools. " +
    "AgentForge automates agent creation through a 4-stage pipeline: " +
    "(1) Research & Discovery — search HuggingFace for models/datasets, scrape sources. " +
    "(2) KG Construction — extract entity-relation triples, import to Neo4j. " +
    "(3) Prompt Optimization — generate variants, A/B test with LLM judge, select winner. " +
    "(4) Scaffold & Deploy — generate Dify app config, deploy with optimized prompts + knowledge base.",
    {
      tool: z.string().describe("Tool name from agentforge_list"),
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
        log("error", "call", `Tool ${tool} failed: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}

