import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEmbeddingWithModel, getEmbeddingDimensions, getEmbeddingCacheStats, generateSparseVector, extractUniqueTokens } from "../utils/embeddings.js";
import { mmPost, mmPipelineUpdate, mmAlert, mmPostWithId, mmUpdatePost } from "./mm-notify.js";
import { qdrantFetch, qdrantScroll, isHybridCollection } from "../utils/qdrant.js";
import { pgQuery } from "../utils/postgres.js";
import { neo4jQuery } from "../utils/neo4j.js";
import { openrouterChat, OPENROUTER_API_KEY, getCostTracker, resetPassCost, resetAllCost } from "../utils/llm.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";


// Prevent unhandled promise rejections from crashing the process
process.on("unhandledRejection", (reason: any) => {
  console.error("[rag-generator] Unhandled rejection:", reason?.message || reason);
});
// ── Persistent File Logger (buffered async) ─────────────────────────
const LOG_DIR = process.env.KB_LOG_DIR || "/app/logs";
const LOG_RETENTION_DAYS = 7;
let _logRotated = false;
let _logBuffer: string[] = [];
let _logFlushTimer: ReturnType<typeof setTimeout> | null = null;
const LOG_FLUSH_INTERVAL = 500; // ms

function _flushLogBuffer() {
  if (_logBuffer.length === 0) return;
  const lines = _logBuffer;
  _logBuffer = [];
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const dateStr = new Date().toISOString().split("T")[0];
    const logFile = path.join(LOG_DIR, `kb-${dateStr}.log`);
    fs.appendFileSync(logFile, lines.join(""));
  } catch { /* file logging failed, non-fatal */ }
}

function kbLog(level: "INFO" | "WARN" | "ERROR", channel: string, message: string) {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timestamp = now.toISOString();
  const line = `[${timestamp}] [${level}] [${channel}] ${message}\n`;

  // Console passthrough (for Docker logs while they last)
  if (level === "ERROR") console.error(`[${channel}] ${message}`);
  else if (level === "WARN") console.warn(`[${channel}] ${message}`);
  else console.log(`[${channel}] ${message}`);

  // Rotate old files once per process lifecycle
  if (!_logRotated) {
    _logRotated = true;
    try {
      if (fs.existsSync(LOG_DIR)) {
        const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith("kb-") && f.endsWith(".log"));
        const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
        for (const file of files) {
          const filePath = path.join(LOG_DIR, file);
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch { /* rotation failed, non-fatal */ }
  }

  // Buffer writes and flush periodically (reduces I/O contention under load)
  _logBuffer.push(line);
  if (!_logFlushTimer) {
    _logFlushTimer = setTimeout(() => {
      _logFlushTimer = null;
      _flushLogBuffer();
    }, LOG_FLUSH_INTERVAL);
  }
  // Flush immediately for errors
  if (level === "ERROR") {
    if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
    _flushLogBuffer();
  }
}

// Flush on process exit
process.on("exit", _flushLogBuffer);


// ── API Concurrency Limiter ───────────────────────────────────────────
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly maxConcurrent: number, private readonly name: string) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => { this.active++; resolve(); });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }

  get stats() { return { name: this.name, active: this.active, queued: this.queue.length, max: this.maxConcurrent }; }
}

// Per-API concurrency limits
const SEM_FIRECRAWL    = new Semaphore(2, "firecrawl");
const SEM_S2           = new Semaphore(1, "semantic-scholar");
const SEM_OPENALEX     = new Semaphore(3, "openalex");
const SEM_CORE         = new Semaphore(2, "core");
const SEM_EVAL         = new Semaphore(5, "gemini-eval");
const SEM_GITHUB       = new Semaphore(3, "github");
const SEM_RERANKER     = new Semaphore(2, "reranker");
const SEM_ARXIV        = new Semaphore(2, "arxiv");
const SEM_PUBMED       = new Semaphore(3, "pubmed");
const SEM_EDGAR        = new Semaphore(2, "edgar");
const SEM_GOVINFO      = new Semaphore(2, "govinfo");
const SEM_FRED         = new Semaphore(2, "fred");
const SEM_GUARDIAN     = new Semaphore(3, "guardian");
const SEM_NEWSAPI      = new Semaphore(1, "newsapi");
const SEM_WIKIDATA     = new Semaphore(3, "wikidata");
const SEM_CLINTRIALS   = new Semaphore(2, "clinicaltrials");
const SEM_INGEST       = new Semaphore(parseInt(process.env.KB_INGEST_CONCURRENCY || "4"), "ingest-pipeline");

// ── RAG Job Queue ────────────────────────────────────────────────────
const QUEUE_POLL_INTERVAL = parseInt(process.env.KB_QUEUE_POLL_MS || "10000"); // 10s
const QUEUE_MAX_CONCURRENT = parseInt(process.env.KB_QUEUE_MAX_CONCURRENT || "3");
let _queueRunning = 0;

interface QueueJob {
  id: string;
  job_type: string;
  collection_name: string;
  topic: string;
  params: Record<string, any>;
  priority: number;
  status: string;
  triggered_by: string;
}

async function enqueueJob(
  job_type: string,
  collection_name: string,
  topic: string,
  params: Record<string, any>,
  priority: number = 5,
  triggered_by: string = "manual"
): Promise<{ id: string; position: number }> {
  const result = await pgQuery(
    `INSERT INTO kb_job_queue (job_type, collection_name, topic, params, priority, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [job_type, collection_name, topic, JSON.stringify(params), priority, triggered_by]
  );
  const id = result.rows[0].id;

  // Count position in queue
  const pos = await pgQuery(
    `SELECT COUNT(*) as cnt FROM kb_job_queue WHERE status = 'pending' AND (priority < $1 OR (priority = $1 AND created_at < (SELECT created_at FROM kb_job_queue WHERE id = $2)))`,
    [priority, id]
  );
  const position = parseInt(pos.rows[0].cnt) + 1;

  kbLog("INFO", "queue", `Enqueued job ${id.slice(0,8)} (${job_type}) for ${collection_name} — priority ${priority}, position ${position}`);
  // Only notify for user-triggered jobs to reduce spam
  if (triggered_by === "manual") {
    await mmPipelineUpdate(collection_name, `Job queued: **${job_type}** (priority ${priority}, position #${position})`, "inbox_tray");
  }
  return { id, position };
}

async function dequeueNext(): Promise<QueueJob | null> {
  const result = await pgQuery(
    `UPDATE kb_job_queue SET status = 'running', started_at = NOW()
     WHERE id = (
       SELECT id FROM kb_job_queue
       WHERE status = 'pending'
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    job_type: row.job_type,
    collection_name: row.collection_name,
    topic: row.topic,
    params: typeof row.params === "string" ? JSON.parse(row.params) : row.params,
    priority: row.priority,
    status: "running",
    triggered_by: row.triggered_by,
  };
}

async function completeJob(id: string, result: any, apiCalls?: Record<string, number>, costUsd?: number) {
  await pgQuery(
    `UPDATE kb_job_queue SET status = 'completed', completed_at = NOW(), result = $2, api_calls = $3, estimated_cost_usd = $4 WHERE id = $1`,
    [id, JSON.stringify(result), JSON.stringify(apiCalls || {}), costUsd || 0]
  );
  // Check for suspiciously fast completions
  try {
    const jobRow = await pgQuery("SELECT started_at, completed_at FROM kb_job_queue WHERE id = $1", [id]);
    if (jobRow.rows.length > 0 && jobRow.rows[0].started_at && jobRow.rows[0].completed_at) {
      const durationMs = new Date(jobRow.rows[0].completed_at).getTime() - new Date(jobRow.rows[0].started_at).getTime();
      const durationSec = durationMs / 1000;
      if (durationSec < 5) {
        kbLog("WARN", "queue", `Job ${id.slice(0,8)} completed suspiciously fast (${durationSec.toFixed(1)}s) — may not have done real work`);
      } else {
        kbLog("INFO", "queue", `Job ${id.slice(0,8)} completed (${durationSec.toFixed(1)}s)`);
      }
    }
  } catch {
    kbLog("INFO", "queue", `Job ${id.slice(0,8)} completed`);
  }
}

async function failJob(id: string, error: string) {
  await pgQuery(
    `UPDATE kb_job_queue SET status = 'failed', completed_at = NOW(), error = $2 WHERE id = $1`,
    [id, error]
  );
  kbLog("ERROR", "queue", `Job ${id.slice(0,8)} failed: ${error}`);
}

async function executeQueueJob(job: QueueJob): Promise<void> {
  kbLog("INFO", "queue", `Executing job ${job.id.slice(0,8)}: ${job.job_type} for ${job.collection_name}`);
  const handler = tools[job.job_type];
  if (!handler) {
    await failJob(job.id, `Unknown job type: ${job.job_type}`);
    return;
  }

  try {
    // Merge default params — add _queue_managed so handlers run synchronously
    const params = {
      collection_name: job.collection_name,
      topic: job.topic,
      ...job.params,
      _queue_managed: true,
    };

    const result = await handler.handler(params);
    await completeJob(job.id, result);
    // Job-level completion is already notified by the handler itself; skip double notification
    kbLog("INFO", "queue", `Queue job completed: ${job.job_type} for ${job.collection_name}`);
  } catch (err: any) {
    await failJob(job.id, err.message);
    await mmAlert("rag-generator", "queue-worker", err.message, { job_id: job.id, job_type: job.job_type });
  }
}

// Background queue worker — dequeues up to available slots per tick, non-blocking execution
function startQueueWorker() {
  setInterval(async () => {
    const slotsAvailable = QUEUE_MAX_CONCURRENT - _queueRunning;
    if (slotsAvailable <= 0) return;

    for (let i = 0; i < slotsAvailable; i++) {
      try {
        const job = await dequeueNext();
        if (!job) break; // no more pending jobs
        _queueRunning++;
        // Fire and forget — do NOT await, so we can fill remaining slots
        executeQueueJob(job)
          .finally(() => { _queueRunning--; })
          .catch((err: any) => kbLog("ERROR", "queue", `Worker execution error: ${err.message}`));
      } catch (err: any) {
        kbLog("ERROR", "queue", `Dequeue error: ${err.message}`);
        break;
      }
    }
  }, QUEUE_POLL_INTERVAL);
  kbLog("INFO", "queue", `Queue worker started (poll: ${QUEUE_POLL_INTERVAL}ms, max concurrent: ${QUEUE_MAX_CONCURRENT})`);
}

// Start worker on module load (delayed to let PG connection initialize)
// Only start in worker or all mode — gateway-only skips the pipeline worker
const _ROLE = process.env.ROLE || "all";
if (_ROLE === "worker" || _ROLE === "all") {
  setTimeout(() => {
    try { startQueueWorker(); }
    catch (err: any) { kbLog("ERROR", "queue", `Failed to start worker: ${err.message}`); }
  }, 5000);
} else {
  kbLog("INFO", "queue", `Queue worker skipped (ROLE=${_ROLE})`);
}

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const EVAL_MODEL = process.env.KB_EVAL_MODEL || "google/gemini-2.0-flash-001";
const RESEARCH_MODEL = process.env.KB_RESEARCH_MODEL || "perplexity/sonar-pro";
const EMBEDDING_MODEL = process.env.KB_EMBEDDING_MODEL || "nomic";
const VECTOR_SIZE = getEmbeddingDimensions(EMBEDDING_MODEL);
const CHUNK_SIZE = 256;  // tokens (approx 4 chars/token)
const CHUNK_OVERLAP = 40;
const EMBED_BATCH_SIZE = parseInt(process.env.KB_EMBED_BATCH_SIZE || "16"); // parallel embedding batch size

// API keys for research databases
const CORE_API_KEY = process.env.CORE_API_KEY || "";
const SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const PUBMED_API_KEY = process.env.PUBMED_API_KEY || "";
const GOVINFO_API_KEY = process.env.GOVINFO_API_KEY || "";
const FRED_API_KEY = process.env.FRED_API_KEY || "";
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY || "";
const NEWSAPI_API_KEY = process.env.NEWSAPI_API_KEY || "";
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";


// ── Deduplication Helpers ────────────────────────────────────────────

/** SHA-256 hash of cleaned text content */
function computeContentHash(text: string): string {
  return crypto.createHash("sha256").update(text.trim()).digest("hex");
}

/** Check if a URL already exists in a Qdrant collection (payload filter) */
async function checkUrlExists(collection_name: string, url: string): Promise<boolean> {
  try {
    const result = await qdrantFetch(`/collections/${collection_name}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({
        filter: { must: [{ key: "url", match: { value: url } }] },
        limit: 1,
        with_payload: false,
      }),
    });
    return (result.result?.points?.length || 0) > 0;
  } catch { return false; }
}

/** Check if a content hash already exists in a Qdrant collection */
async function checkContentHashExists(collection_name: string, hash: string): Promise<boolean> {
  try {
    const result = await qdrantFetch(`/collections/${collection_name}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({
        filter: { must: [{ key: "content_hash", match: { value: hash } }] },
        limit: 1,
        with_payload: false,
      }),
    });
    return (result.result?.points?.length || 0) > 0;
  } catch { return false; }
}

/** Check for near-duplicate chunks via embedding similarity > threshold.
 *  Returns the IDs of matching chunks if any are found. */
async function checkSemanticDuplicates(
  collection_name: string,
  embedding: number[],
  threshold: number = 0.95,
): Promise<{ isDuplicate: boolean; matchScore?: number; matchId?: string }> {
  try {
    // Support both hybrid (named vectors) and legacy (unnamed) collections
    const hybrid = await isHybridCollection(collection_name);
    const vectorParam = hybrid ? { name: "dense", vector: embedding } : embedding;
    const result = await qdrantFetch(`/collections/${collection_name}/points/search`, {
      method: "POST",
      body: JSON.stringify({
        vector: vectorParam,
        limit: 1,
        with_payload: false,
        score_threshold: threshold,
      }),
    });
    const hits = result.result || [];
    if (hits.length > 0) {
      return { isDuplicate: true, matchScore: hits[0].score, matchId: hits[0].id };
    }
    return { isDuplicate: false };
  } catch (err: any) {
    kbLog("WARN", "dedup", `Semantic duplicate check failed: ${err.message}`);
    return { isDuplicate: false };
  }
}


/** Write chunk provenance records to PostgreSQL — batched multi-row INSERT */
async function writeProvenance(
  collection: string,
  chunkIds: string[],
  sourceUrl: string,
  contentHash: string,
  qualityScore: number,
  authorityScore: number,
  nrr: number | null,
  semanticBucket: string | null,
): Promise<void> {
  if (chunkIds.length === 0) return;
  try {
    // Shared params: $1=collection, $2=sourceUrl, $3=contentHash, $4=qualityScore, $5=authorityScore, $6=nrr, $7=semanticBucket
    const sharedParams: any[] = [collection, sourceUrl, contentHash, qualityScore, authorityScore, nrr, semanticBucket];
    const BATCH_SIZE = 50; // PG param limit safety
    for (let i = 0; i < chunkIds.length; i += BATCH_SIZE) {
      const batch = chunkIds.slice(i, i + BATCH_SIZE);
      const valueClauses: string[] = [];
      const params = [...sharedParams];
      for (const chunkId of batch) {
        params.push(chunkId);
        valueClauses.push(`($1, $${params.length}::uuid, $2, $3, $4, $5, $6, $7)`);
      }
      await pgQuery(
        `INSERT INTO rag_chunks (collection, chunk_id, source_url, content_hash, quality_score, authority_score, nrr, semantic_bucket)
         VALUES ${valueClauses.join(", ")}
         ON CONFLICT (collection, chunk_id) DO UPDATE SET
           source_url = EXCLUDED.source_url,
           content_hash = EXCLUDED.content_hash,
           quality_score = EXCLUDED.quality_score,
           authority_score = EXCLUDED.authority_score,
           nrr = EXCLUDED.nrr,
           semantic_bucket = EXCLUDED.semantic_bucket`,
        params
      );
    }
  } catch (err: any) {
    kbLog("WARN", "provenance", `Failed to write provenance for ${sourceUrl}: ${err.message}`);
  }
}


// ── Types ────────────────────────────────────────────────────────────

interface ChunkMetadata {
  url?: string;
  title?: string;
  doc_type?: string;
  style_category?: string;
  key_topics?: string[];
  platform?: string;
  authority_score?: number;
  source?: string;
  ai_quality_score?: number;
  ai_reasoning?: string;
}

interface QualityAssessment {
  relevance_score: number;
  quality_score: number;
  authority_score: number;
  actionability_score: number;
  is_junk: boolean;
  overall_score: number;
  reasoning: string;
  recommendation: "INGEST" | "REJECT";
  doc_type?: string;
  style_category?: string;
  key_topics?: string[];
}

interface ResearchPlan {
  categories: Array<{
    name: string;
    description: string;
    urls: string[];
  }>;
  total_urls: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractJson(raw: string): any {
  if (!raw || raw.trim().length === 0) throw new Error("Empty AI response - model may have exhausted tokens on reasoning");
  let s = raw.trim();
  const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  } else if (s.startsWith("```")) {
    // Unclosed fence (truncated response) - strip opening fence line
    s = s.replace(/^```(?:json)?\s*\n?/, "").trim();
  }
  s = s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!s.startsWith("{") && !s.startsWith("[")) {
    const jsonMatch = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) s = jsonMatch[1];
  }
  return JSON.parse(s);
}

/** Strip cookie/consent boilerplate from scraped markdown.
 *  Strategy: if the first 2000 chars contain cookie/consent keywords but also
 *  have a real heading (# Title) further in, skip to that heading. This handles
 *  sites like NN/g that prepend thousands of chars of cookie preference UI. */
function stripCookieBoilerplate(markdown: string): string {
  const first2k = markdown.substring(0, 2000).toLowerCase();
  const hasCookieJunk = first2k.includes("cookie") || first2k.includes("consent") || first2k.includes("gdpr") || first2k.includes("privacy preferences");
  if (!hasCookieJunk) return markdown;

  // Find the first real markdown heading (H1-H3 with 10+ chars of title text)
  const headingMatch = markdown.match(/^#{1,3}\s+.{10,}/m);
  if (headingMatch && headingMatch.index && headingMatch.index > 500) {
    // There's a real heading past the cookie junk — skip to it
    kbLog("INFO", "scrape", `Stripped ${headingMatch.index} chars of cookie/consent boilerplate`);
    return markdown.substring(headingMatch.index).trim();
  }

  // Fallback: try to find content after common end-of-cookie-banner markers
  const markers = ["accept all", "reject all", "accept cookies", "cookie settings"];
  let furthestMarker = -1;
  for (const marker of markers) {
    const idx = markdown.toLowerCase().lastIndexOf(marker);
    if (idx > furthestMarker && idx < 10000) furthestMarker = idx;
  }
  if (furthestMarker > 0) {
    // Skip past the marker line
    const nextNewline = markdown.indexOf("\n", furthestMarker);
    if (nextNewline > 0) {
      kbLog("INFO", "scrape", `Stripped ${nextNewline} chars via cookie marker fallback`);
      return markdown.substring(nextNewline).trim();
    }
  }

  return markdown;
}

// ── Knowledge Graph Population ───────────────────────────────────────
// Auto-populates Neo4j with KB nodes and edges on every ingest.
// Node types: KBCollection, KBSource, KBTopic, KBCategory, KBAuthority, KBDomain
// Edge types: CONTAINS, TAGGED_WITH, CATEGORIZED_AS, PUBLISHED_BY, CO_OCCURS_WITH

const AUTHORITY_MAP: Record<string, string> = {
  "nngroup.com": "Nielsen Norman Group",
  "www.nngroup.com": "Nielsen Norman Group",
  "developer.mozilla.org": "MDN Web Docs",
  "web.dev": "Google web.dev",
  "www.w3.org": "W3C",
  "w3.org": "W3C",
  "css-tricks.com": "CSS-Tricks",
  "smashingmagazine.com": "Smashing Magazine",
  "www.smashingmagazine.com": "Smashing Magazine",
  "alistapart.com": "A List Apart",
  "www.alistapart.com": "A List Apart",
  "m3.material.io": "Material Design",
  "material.io": "Material Design",
  "ant.design": "Ant Design",
  "chakra-ui.com": "Chakra UI",
  "tailwindcss.com": "Tailwind CSS",
  "a11yproject.com": "A11Y Project",
  "webaim.org": "WebAIM",
  "www.deque.com": "Deque Systems",
  "joshwcomeau.com": "Josh W Comeau",
  "ishadeed.com": "Ahmad Shadeed",
  "moderncss.dev": "Modern CSS",
  "every-layout.dev": "Every Layout",
  "lawsofux.com": "Laws of UX",
  "design-system.service.gov.uk": "GOV.UK Design System",
  "primer.style": "GitHub Primer",
  "github.com": "GitHub",
  "api.semanticscholar.org": "Semantic Scholar",
  "www.semanticscholar.org": "Semantic Scholar",
};

function extractAuthority(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    return AUTHORITY_MAP[hostname] || AUTHORITY_MAP[hostname.replace(/^www\./, "")] || null;
  } catch { return null; }
}

async function populateKBGraph(
  collectionName: string,
  sourceUrl: string,
  sourceTitle: string,
  docType: string,
  styleCategory: string,
  keyTopics: string[],
  qualityScore: number,
  chunkCount: number,
): Promise<void> {
  try {
    // Step 1: Create collection + source + CONTAINS in a single query
    await neo4jQuery(
      `MERGE (c:KBCollection {name: $collection})
       ON CREATE SET c.created_at = datetime()
       SET c.updated_at = datetime()
       MERGE (s:KBSource {url: $url})
       ON CREATE SET s.title = $title, s.doc_type = $docType, s.quality_score = $quality,
                     s.chunk_count = $chunks, s.ingested_at = datetime()
       ON MATCH SET s.quality_score = $quality, s.chunk_count = $chunks
       MERGE (c)-[:CONTAINS]->(s)`,
      { collection: collectionName, url: sourceUrl, title: sourceTitle, docType, quality: qualityScore, chunks: chunkCount }
    );

    // Step 2: Run independent operations in parallel
    const parallelOps: Promise<any>[] = [];

    // CATEGORIZED_AS: Source -> Category
    if (styleCategory) {
      parallelOps.push(neo4jQuery(
        `MERGE (cat:KBCategory {name: $name})
         WITH cat
         MATCH (s:KBSource {url: $url})
         MERGE (s)-[:CATEGORIZED_AS]->(cat)`,
        { name: styleCategory, url: sourceUrl }
      ));
    }

    // TAGGED_WITH + CO_OCCURS_WITH: Use UNWIND for all topics in a single query
    if (keyTopics && keyTopics.length > 0) {
      const normalizedTopics = keyTopics.map(t => t.toLowerCase().trim()).filter(t => t.length > 1);
      if (normalizedTopics.length > 0) {
        parallelOps.push(neo4jQuery(
          `UNWIND $topics AS topicName
           MERGE (t:KBTopic {name: topicName})
           WITH t
           MATCH (s:KBSource {url: $url})
           MERGE (s)-[:TAGGED_WITH]->(t)`,
          { topics: normalizedTopics, url: sourceUrl }
        ));

        // CO_OCCURS_WITH: Build pairs and UNWIND
        if (normalizedTopics.length >= 2) {
          const pairs: Array<{ t1: string; t2: string }> = [];
          for (let i = 0; i < normalizedTopics.length; i++) {
            for (let j = i + 1; j < normalizedTopics.length; j++) {
              pairs.push({ t1: normalizedTopics[i], t2: normalizedTopics[j] });
            }
          }
          parallelOps.push(neo4jQuery(
            `UNWIND $pairs AS pair
             MATCH (t1:KBTopic {name: pair.t1}), (t2:KBTopic {name: pair.t2})
             MERGE (t1)-[r:CO_OCCURS_WITH]-(t2)
             ON CREATE SET r.count = 1
             ON MATCH SET r.count = r.count + 1`,
            { pairs }
          ));
        }
      }
    }

    // PUBLISHED_BY: Source -> Authority
    const authority = extractAuthority(sourceUrl);
    if (authority) {
      parallelOps.push(neo4jQuery(
        `MERGE (a:KBAuthority {name: $name})
         WITH a
         MATCH (s:KBSource {url: $url})
         MERGE (s)-[:PUBLISHED_BY]->(a)`,
        { name: authority, url: sourceUrl }
      ));
    }

    await Promise.all(parallelOps);
  } catch (err: any) {
    // Graph population failure is non-fatal — log and continue
    kbLog("WARN", "graph", `Failed to populate KB graph for ${sourceUrl}: ${err.message}`);
  }
}

// ── Firecrawl with cookie bypass ─────────────────────────────────────

const COOKIE_ACTIONS = [
  { type: "click", selector: "#onetrust-accept-btn-handler", optional: true },
  { type: "click", selector: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", optional: true },
  { type: "click", selector: "button[id*='accept']", optional: true },
  { type: "click", selector: "button[id*='agree']", optional: true },
  { type: "click", selector: ".cookie-consent-accept", optional: true },
  { type: "click", selector: "[data-testid='cookie-accept']", optional: true },
  { type: "click", selector: "button.accept-cookies", optional: true },
  { type: "click", selector: "#gdpr-accept", optional: true },
  { type: "wait", milliseconds: 1500 },
];

async function firecrawlScrape(url: string): Promise<{ markdown: string; metadata: any }> {
  if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not configured");
  return SEM_FIRECRAWL.run(async () => {

  async function doScrape(withActions: boolean) {
    const body: any = {
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 3000,
      timeout: 30000,
    };
    if (withActions) body.actions = COOKIE_ACTIONS;
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (response.ok) {
        const data = await response.json();
        return { markdown: data.data?.markdown || "", metadata: data.data?.metadata || {} };
      }
      lastError = await response.text();
      // Retry on 429 (rate limit) or 5xx (server error) with exponential backoff
      if (response.status === 429 || response.status >= 500) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        kbLog("WARN", "scrape", `Firecrawl ${response.status} on ${url}, retry ${attempt + 1}/3 in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(lastError); // Non-retryable error
    }
    throw new Error(`Firecrawl failed after 3 retries: ${lastError}`);
  }

  try {
    const result = await doScrape(false);
    // Strip cookie boilerplate that got scraped as content
    result.markdown = stripCookieBoilerplate(result.markdown);

    const lower = result.markdown.toLowerCase();
    const isCookieWall = result.markdown.length < 500 && (
      lower.includes("cookie") || lower.includes("consent") || lower.includes("gdpr") || lower.includes("privacy preferences")
    );
    if (isCookieWall) {
      kbLog("INFO", "firecrawl", "Cookie wall detected after stripping, retrying with actions...");
      try {
        const retry = await doScrape(true);
        retry.markdown = stripCookieBoilerplate(retry.markdown);
        return retry;
      } catch {
        return result;
      }
    }
    return result;
  } catch (err: any) {
    throw new Error(`Firecrawl error: ${err.message}`);
  }
  }); // SEM_FIRECRAWL
}

// ── AI Research (Sonar) ──────────────────────────────────────────────

async function researchTopic(topic: string, targetSources: number = 80): Promise<ResearchPlan> {
  const prompt = `You are a knowledge base architect building a comprehensive RAG for an AI coding assistant.

TOPIC: "${topic}"

Research and provide a structured plan with categorized, scrapable URLs.

REQUIREMENTS:
- Target ${targetSources}+ total URLs across all categories
- Only include URLs that are publicly accessible (no paywalls, no login required)
- Prioritize: official documentation, authoritative references, well-known technical blogs, academic resources, and industry-standard guides relevant to the topic
- Each category should have 5-12 URLs
- URLs must be specific article/page URLs (not homepages or search results)
- Cover BOTH theory (principles, guidelines, research) AND practice (code examples, implementation patterns, tutorials)
- Generate 10-15 categories that comprehensively cover the topic domain
- Think broadly: include foundational theory, practical techniques, tools/frameworks, case studies, and adjacent fields that enrich understanding

Respond ONLY with valid JSON (no markdown fences, no explanation):
{
  "categories": [
    {
      "name": "Category Name",
      "description": "What this category covers",
      "urls": ["https://example.com/specific-article", ...]
    }
  ],
  "total_urls": <number>
}`;

  kbLog("INFO", "research", "Calling openrouterChat with RESEARCH_MODEL...");
  const raw = await openrouterChat(RESEARCH_MODEL, [{ role: "user", content: prompt }], 8000, 0.4, 180000);
  kbLog("INFO", "research", `Got raw response (${raw.length} chars), parsing JSON...`);
  const plan: ResearchPlan = extractJson(raw);
  kbLog("INFO", "research", `Parsed plan: ${plan.categories?.length} categories`);

  const seen = new Set<string>();
  for (const cat of plan.categories) {
    cat.urls = cat.urls.filter(u => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  }
  plan.total_urls = plan.categories.reduce((sum, c) => sum + c.urls.length, 0);
  return plan;
}

// ── AI Quality Eval + Auto-Tagging ───────────────────────────────────

async function evaluateAndTag(content: string, url: string, topic: string, category?: string): Promise<QualityAssessment> {
  if (!OPENROUTER_API_KEY) {
    return {
      relevance_score: 8, quality_score: 8, authority_score: 7, actionability_score: 7,
      is_junk: false, overall_score: 7.5,
      reasoning: "No AI evaluation (OPENROUTER_API_KEY not configured)",
      recommendation: "INGEST", doc_type: "reference", style_category: category || "general", key_topics: []
    };
  }

  const excerpt = content.substring(0, 2000);
  const prompt = `You are a strict RAG content quality evaluator for a knowledge base on: ${topic}
${category ? `Research category: "${category}"` : ""}

EVALUATE this scraped web content. Be strict - only high-quality, actionable content should pass.

REJECT if:
- Cookie banners, login walls, error pages, navigation-only content
- Generic marketing copy with no technical substance
- Content shorter than 200 words of actual substance
- Duplicate/boilerplate content (privacy policies, terms of service)
- Content not relevant to: ${topic}

ACCEPT if:
- Contains specific, actionable guidance, principles, or techniques relevant to: ${topic}
- Includes practical examples, code patterns, or implementation details
- Provides well-structured documentation, specifications, or reference material
- Offers research-backed insights or established best practices

URL: ${url}
Content (first 2000 chars):
${excerpt}

Respond ONLY with valid JSON (no markdown fences):
{
  "relevance_score": <0-10>,
  "quality_score": <0-10>,
  "authority_score": <0-10>,
  "actionability_score": <0-10>,
  "is_junk": <true if spam/ads/cookie banners/broken/login walls>,
  "overall_score": <weighted average, weight actionability and quality highest>,
  "reasoning": "<1-2 sentence explanation>",
  "recommendation": "INGEST" or "REJECT",
  "doc_type": "<one of: guideline, tutorial, reference, case-study, specification, opinion, code-example>",
  "style_category": "<short lowercase hyphenated category label for content focus area, generate appropriate categories for the topic domain>",
  "semantic_bucket": "<one of: procedural, reference, conceptual, troubleshooting, research-finding, opinion, tutorial>",
  "key_topics": ["topic1", "topic2", "topic3"]
}`;

  try {
    const assessment: QualityAssessment = await SEM_EVAL.run(async () => {
      const raw = await openrouterChat(EVAL_MODEL, [{ role: "user", content: prompt }], 600, 0.3);
      const result: QualityAssessment = extractJson(raw);
      return result;
    });
    // Trust the LLM's recommendation but validate: if is_junk, always reject
    if (assessment.is_junk) assessment.recommendation = "REJECT";
    return assessment;
  } catch (error: any) {
    kbLog("ERROR", "eval", `AI eval failed: ${error.message}`);
    return {
      relevance_score: 0, quality_score: 0, authority_score: 0, actionability_score: 0,
      is_junk: false, overall_score: 0,
      reasoning: `AI eval failed: ${error.message}. Rejecting - re-ingest manually if needed.`,
      recommendation: "REJECT", doc_type: "reference", style_category: category || "general", key_topics: []
    };
  }
}

// ── Markdown-Aware Chunking with Context Injection ───────────────────

function markdownChunk(
  content: string,
  sourceTitle: string = "",
  targetTokens: number = CHUNK_SIZE,
  overlapTokens: number = CHUNK_OVERLAP
): string[] {
  const sections: Array<{ header: string; content: string }> = [];
  const headerRegex = /^(#{1,4}\s+.+)$/gm;
  let lastIndex = 0;
  let lastHeader = "";
  let match: RegExpExecArray | null;

  while ((match = headerRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      sections.push({ header: lastHeader, content: content.slice(lastIndex, match.index).trim() });
    }
    lastHeader = match[1];
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    sections.push({ header: lastHeader, content: content.slice(lastIndex).trim() });
  }
  if (sections.length === 0 && content.trim()) {
    sections.push({ header: "", content: content.trim() });
  }

  const chunks: string[] = [];
  const charsPerToken = 4;
  const targetChars = targetTokens * charsPerToken;
  const overlapChars = overlapTokens * charsPerToken;

  for (const section of sections) {
    if (!section.content) continue;
    const contextPrefix = sourceTitle
      ? `[Source: ${sourceTitle}]${section.header ? ` [Section: ${section.header.replace(/^#+\s*/, "")}]` : ""}\n\n`
      : (section.header ? section.header + "\n\n" : "");
    const paragraphs = section.content.split(/\n\n+/).filter(p => p.trim().length > 0);
    let current = contextPrefix;

    for (const para of paragraphs) {
      if (current.length + para.length > targetChars && current.length > contextPrefix.length) {
        chunks.push(current.trim());
        const overlapText = current.slice(-overlapChars);
        current = contextPrefix + overlapText + "\n\n" + para;
      } else {
        current += (current.length > contextPrefix.length ? "\n\n" : "") + para;
      }
    }
    if (current.trim().length > contextPrefix.length || (current.trim().length > 0 && !contextPrefix)) {
      chunks.push(current.trim());
    }
  }

  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push(content.trim());
  }

  return chunks;
}

// ── AI Reranker ──────────────────────────────────────────────────────

async function rerankResults(
  query: string,
  results: Array<{ score: number; text: string; metadata: any }>,
  topK: number = 5
): Promise<Array<{ score: number; rerank_score: number; text: string; metadata: any }>> {
  if (results.length <= topK || !OPENROUTER_API_KEY) return results.map(r => ({ ...r, rerank_score: r.score }));

  const snippets = results.map((r, i) => `[${i}] ${r.text.substring(0, 300)}`).join("\n\n");
  const prompt = `You are a search result reranker. Given a query and ${results.length} candidate passages, return the indices of the ${topK} MOST RELEVANT passages in order of relevance.

Query: "${query}"

Passages:
${snippets}

Respond ONLY with valid JSON (no markdown fences):
{"ranked_indices": [<index>, <index>, ...]}`;

  try {
    const raw = await SEM_RERANKER.run(() => openrouterChat(EVAL_MODEL, [{ role: "user", content: prompt }], 200, 0.1));
    const parsed = extractJson(raw);
    const indices: number[] = parsed.ranked_indices || [];
    const reranked = indices
      .filter(i => i >= 0 && i < results.length)
      .slice(0, topK)
      .map((idx, rank) => ({
        ...results[idx],
        rerank_score: 1 - (rank * 0.05),
      }));
    if (reranked.length < topK) {
      const used = new Set(indices);
      for (const r of results) {
        if (reranked.length >= topK) break;
        const idx = results.indexOf(r);
        if (!used.has(idx)) reranked.push({ ...r, rerank_score: r.score });
      }
    }
    return reranked;
  } catch (err: any) {
    kbLog("ERROR", "reranker", `Failed, returning original order: ${err.message}`);
    return results.slice(0, topK).map(r => ({ ...r, rerank_score: r.score }));
  }
}

// ── Wikipedia Reference Harvester ────────────────────────────────────

const GOOD_DOMAINS = new Set([
  "developer.mozilla.org", "web.dev", "www.w3.org", "w3.org",
  "css-tricks.com", "smashingmagazine.com", "www.smashingmagazine.com",
  "alistapart.com", "www.alistapart.com", "nngroup.com", "www.nngroup.com",
  "m3.material.io", "m2.material.io", "material.io",
  "tailwindcss.com", "chakra-ui.com", "ant.design",
  "a11yproject.com", "www.a11yproject.com",
  "ishadeed.com", "every-layout.dev", "moderncss.dev",
  "primer.style", "designsystem.digital.gov",
  "inclusive-components.design", "webaim.org", "www.deque.com",
  "heydonworks.com", "lea.verou.me", "joshwcomeau.com",
  "lawsofux.com", "www.lawsofux.com",
  "design-system.service.gov.uk",
]);

function extractWikipediaRefs(markdown: string): string[] {
  const urls: string[] = [];
  const urlRegex = /https?:\/\/[^\s\)\]"'<>,]+/g;
  const refSectionMatch = markdown.match(/#{1,3}\s*(References|External links|Further reading|Sources)[\s\S]*$/i);
  const searchText = refSectionMatch ? refSectionMatch[0] : markdown;

  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRegex.exec(searchText)) !== null) {
    let url = urlMatch[0].replace(/[.)}\]]+$/, "");
    if (url.includes("wikipedia.org") || url.includes("wikimedia.org")) continue;
    if (url.includes("archive.org")) continue;
    if (url.includes("doi.org") || url.includes("isbn")) continue;
    urls.push(url);
  }
  return [...new Set(urls)];
}

function filterByDomain(urls: string[]): { good: string[]; unknown: string[] } {
  const good: string[] = [];
  const unknown: string[] = [];
  for (const url of urls) {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, "");
      if (GOOD_DOMAINS.has(domain) || GOOD_DOMAINS.has("www." + domain)) {
        good.push(url);
      } else {
        unknown.push(url);
      }
    } catch { /* invalid URL */ }
  }
  return { good, unknown };
}

// ── GitHub Discovery ─────────────────────────────────────────────────

const GITHUB_SEED_REPOS = [
  // Curated knowledge repos (README-based, rich markdown)
  { owner: "brunopulis", repo: "awesome-a11y", paths: [""], recurse: false },
  { owner: "tipoqueno", repo: "UI-Design", paths: [""], recurse: false },
  { owner: "bendc", repo: "frontend-guidelines", paths: [""], recurse: false },
  { owner: "phuocng", repo: "frontend-tips", paths: [""], recurse: false },
  // Design systems with documented patterns (content in subdirs)
  { owner: "alphagov", repo: "govuk-design-system", paths: ["src/patterns", "src/components", "src/styles"], recurse: true },
  { owner: "w3c", repo: "aria-practices", paths: ["content/patterns"], recurse: true },
  { owner: "w3c", repo: "wcag", paths: ["understanding", "techniques"], recurse: true },
  // Primer (GitHub's design system)
  { owner: "primer", repo: "design", paths: [""], recurse: false },
  // Carbon (IBM's design system)
  { owner: "carbon-design-system", repo: "carbon-website", paths: ["src/pages/guidelines", "src/pages/components"], recurse: true },
];

const GITHUB_SEARCH_TOPICS = [
  "design-system topic:design-system stars:>1000",
  "accessibility wcag guidelines stars:>200",
  "ux design principles best-practices stars:>200",
  "css best-practices frontend guidelines stars:>300",
  "ui-patterns component-library documentation stars:>500",
];

async function githubApiFetch(path: string): Promise<any> {
  return SEM_GITHUB.run(async () => {
  const headers: Record<string, string> = { "Accept": "application/vnd.github.v3+json", "User-Agent": "homelab-mcp-gateway" };
  if (GITHUB_TOKEN) headers["Authorization"] = `token ${GITHUB_TOKEN}`;
  const resp = await fetch(`https://api.github.com${path}`, { headers });
  if (!resp.ok) {
    if (resp.status === 403) {
      kbLog("WARN", "github", `Rate limited on ${path}`);
      return null;
    }
    throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
  }); // SEM_GITHUB
}

async function fetchRepoMarkdownFiles(owner: string, repo: string, paths: string[], recurse: boolean = false, maxDepth: number = 2): Promise<Array<{ path: string; content: string; url: string }>> {
  const files: Array<{ path: string; content: string; url: string }> = [];
  const MAX_FILES = 50; // Cap total files per repo

  async function listDir(dirPath: string, depth: number) {
    if (files.length >= MAX_FILES) return;
    const apiPath = dirPath ? `/repos/${owner}/${repo}/contents/${dirPath}` : `/repos/${owner}/${repo}/contents`;
    try {
      const contents = await githubApiFetch(apiPath);
      if (!contents || !Array.isArray(contents)) return;

      // Collect markdown files
      const mdFiles = contents.filter((f: any) =>
        f.type === "file" && /\.(md|mdx)$/i.test(f.name)
        && !f.name.toLowerCase().includes("changelog")
        && !f.name.toLowerCase().includes("license")
        && !f.name.toLowerCase().includes("contributing")
        && !f.name.toLowerCase().includes("code-of-conduct")
      );

      for (const file of mdFiles) {
        if (files.length >= MAX_FILES) break;
        try {
          const fileData = await githubApiFetch(`/repos/${owner}/${repo}/contents/${file.path}`);
          if (!fileData?.content) continue;
          const decoded = Buffer.from(fileData.content, "base64").toString("utf-8");
          if (decoded.length > 200) {
            files.push({
              path: `${owner}/${repo}/${file.path}`,
              content: decoded,
              url: `https://github.com/${owner}/${repo}/blob/main/${file.path}`,
            });
          }
        } catch (err: any) {
          kbLog("WARN", "github", `Failed to fetch ${file.path}: ${err.message}`);
        }
      }

      // Recurse into subdirectories
      if (recurse && depth < maxDepth) {
        const dirs = contents.filter((f: any) => f.type === "dir" && !f.name.startsWith(".") && !["node_modules", "dist", "build", "__tests__", "test", "tests", "vendor"].includes(f.name));
        for (const dir of dirs) {
          if (files.length >= MAX_FILES) break;
          await listDir(dir.path, depth + 1);
        }
      }
    } catch (err: any) {
      kbLog("WARN", "github", `Failed to list ${apiPath}: ${err.message}`);
    }
  }

  for (const subpath of paths) {
    await listDir(subpath, 0);
  }
  return files;
}

async function searchGithubRepos(query: string, maxRepos: number = 5): Promise<Array<{ owner: string; repo: string; description: string }>> {
  const data = await githubApiFetch(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${maxRepos}`);
  if (!data?.items) return [];
  return data.items.map((r: any) => ({
    owner: r.owner.login,
    repo: r.name,
    description: r.description || "",
  }));
}

// ── Research API Discovery (Semantic Scholar + OpenAlex + CORE) ──────

async function searchSemanticScholar(query: string, limit: number = 20): Promise<Array<{ paperId: string; title: string; abstract: string; url: string; year: number; citationCount: number; tldr?: string }>> {
  return SEM_S2.run(async () => {
  const headers: Record<string, string> = {};
  if (SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = SEMANTIC_SCHOLAR_API_KEY;

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: "paperId,title,abstract,url,year,citationCount,tldr,isOpenAccess,openAccessPdf",
  });

  const resp = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { headers });
  if (!resp.ok) {
    if (resp.status === 429) {
      kbLog("WARN", "s2", "Rate limited, waiting 10s...");
      await new Promise(r => setTimeout(r, 10000));
      const retry = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { headers });
      if (!retry.ok) throw new Error(`Semantic Scholar ${retry.status}`);
      const data = await retry.json();
      return data.data || [];
    }
    throw new Error(`Semantic Scholar ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.data || [];
  }); // SEM_S2
}

async function searchOpenAlex(query: string, limit: number = 25): Promise<Array<{ title: string; abstract: string; doi: string; year: number; cited_by_count: number; open_access_url?: string }>> {
  return SEM_OPENALEX.run(async () => {
  const params = new URLSearchParams({
    search: query,
    // No concept filter - let the search query determine relevance
    per_page: String(limit),
    sort: "cited_by_count:desc",
  });

  const resp = await fetch(`https://api.openalex.org/works?${params}`, {
    headers: { "User-Agent": "homelab-mcp-gateway/1.0 (mailto:admin@example.com)" },
  });
  if (!resp.ok) throw new Error(`OpenAlex ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();

  return (data.results || []).map((w: any) => {
    // OpenAlex stores abstract as inverted index — reconstruct
    let abstract = "";
    if (w.abstract_inverted_index) {
      const entries: Array<[string, number[]]> = Object.entries(w.abstract_inverted_index);
      const words: Array<{ word: string; pos: number }> = [];
      for (const [word, positions] of entries) {
        for (const pos of positions as number[]) {
          words.push({ word, pos });
        }
      }
      words.sort((a, b) => a.pos - b.pos);
      abstract = words.map(w => w.word).join(" ");
    }
    return {
      title: w.display_name || w.title || "",
      abstract,
      doi: w.doi || "",
      year: w.publication_year || 0,
      cited_by_count: w.cited_by_count || 0,
      open_access_url: w.open_access?.oa_url || w.best_oa_location?.pdf_url || "",
    };
  });
  }); // SEM_OPENALEX
}

async function resolveUnpaywall(doi: string): Promise<string | null> {
  if (!doi) return null;
  const cleanDoi = doi.replace("https://doi.org/", "");
  try {
    const resp = await fetch(`https://api.unpaywall.org/v2/${cleanDoi}?email=admin@example.com`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.best_oa_location?.url_for_pdf || data.best_oa_location?.url || null;
  } catch { return null; }
}

async function searchCore(query: string, limit: number = 10): Promise<Array<{ title: string; abstract: string; fullText?: string; downloadUrl?: string }>> {
  if (!CORE_API_KEY) return [];
  return SEM_CORE.run(async () => {
  const resp = await fetch(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${limit}`, {
    headers: { "Authorization": `Bearer ${CORE_API_KEY}` },
  });
  if (!resp.ok) {
    kbLog("WARN", "core", `API error ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  return (data.results || []).map((w: any) => ({
    title: w.title || "",
    abstract: w.abstract || "",
    fullText: w.fullText || undefined,
    downloadUrl: w.downloadUrl || undefined,
  }));
  }); // SEM_CORE
}

// ── Core Ingest (shared by smart_ingest and build_knowledge_base) ────


/** Shared core ingest logic — handles eval, chunk, embed, dedup, upsert, provenance, KG */
async function ingestCore(
  content: string, title: string, url: string,
  collection_name: string, topic: string, threshold: number,
  category?: string, sourceApi: string = "direct",
  contentHash?: string,
): Promise<any> {
  if (!content || content.trim().length < 100) {
    return { status: "rejected", reason: "Content too short or empty", url };
  }

  // Normalize URL — handle empty/missing gracefully
  if (!url || url.trim().length === 0) {
    url = `direct://${crypto.randomUUID().slice(0, 8)}`;
    kbLog("WARN", "ingest", `No URL provided for "${title}", using generated: ${url}`);
  }

  const hash = contentHash || computeContentHash(content);

  // Content hash dedup
  if (await checkContentHashExists(collection_name, hash)) {
    kbLog("INFO", "dedup", `Content hash match, skipping: "${title || url}"`);
    return { status: "skipped", reason: "Duplicate content (hash match)", url, title, content_hash: hash };
  }

  // URL dedup (if URL provided)
  if (url && await checkUrlExists(collection_name, url)) {
    kbLog("INFO", "dedup", `URL already exists, skipping: ${url}`);
    return { status: "skipped", reason: "URL already in collection (dedup)", url };
  }

  const rawLength = content.length;
  kbLog("INFO", "ingest", `Evaluating: "${title || url}" (${content.length} chars)`);
  const quality = await evaluateAndTag(content, url, topic, category);

  if (quality.overall_score < threshold || quality.is_junk) {
    kbLog("INFO", "ingest", `Rejected (${quality.overall_score}/10): "${title || url}" — ${quality.reasoning}`);
    return { status: "rejected", reason: quality.reasoning, url, quality };
  }

  kbLog("INFO", "ingest", `Passed (${quality.overall_score}/10): "${title || url}" — chunking...`);
  const MAX_CHUNKS_PER_SOURCE = 50;
  let chunks = markdownChunk(content, title);
  if (chunks.length > MAX_CHUNKS_PER_SOURCE) {
    kbLog("WARN", "ingest", `Source "${title || url}" produced ${chunks.length} chunks, capping at ${MAX_CHUNKS_PER_SOURCE}`);
    chunks = chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
  }

  // NRR — strip context prefixes and deduct overlap to measure true content reduction
  const contextPrefixRe = /^\[Source: [^\]]*\](\s*\[Section: [^\]]*\])?\n\n/;
  const charsPerToken = 4;
  const overlapChars = CHUNK_OVERLAP * charsPerToken;
  const cleanLength = chunks.reduce((sum, ch, idx) => {
    const stripped = ch.replace(contextPrefixRe, "");
    const overlapDeduction = idx > 0 ? Math.min(overlapChars, stripped.length) : 0;
    return sum + Math.max(0, stripped.length - overlapDeduction);
  }, 0);
  const nrr = rawLength > 0 ? Math.max(0, Math.min(1, (rawLength - cleanLength) / rawLength)) : 0;
  if (nrr > 0.80) kbLog("WARN", "nrr", `High NRR ${nrr.toFixed(3)} for ${url} — cleaning may be too aggressive`);
  else if (nrr < 0.10) kbLog("WARN", "nrr", `Low NRR ${nrr.toFixed(3)} for ${url} — content may contain noise`);

  // Embed all chunks — batched parallel for CPU utilization
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(chunk => getEmbeddingWithModel(chunk, EMBEDDING_MODEL))
    );
    embeddings.push(...batchResults);
  }

  // Near-semantic dedup — parallel Qdrant searches
  let nearDupCount = 0;
  const keptIndices: number[] = [];
  const dupResults = await Promise.all(
    embeddings.map(emb => checkSemanticDuplicates(collection_name, emb, 0.95))
  );
  dupResults.forEach((dup, i) => {
    if (dup.isDuplicate) {
      nearDupCount++;
      kbLog("INFO", "dedup", `Near-duplicate chunk ${i + 1}/${chunks.length} (score ${dup.matchScore?.toFixed(3)}), skipping`);
    } else {
      keptIndices.push(i);
    }
  });

  if (keptIndices.length === 0) {
    kbLog("INFO", "dedup", `All ${chunks.length} chunks are near-duplicates: "${title || url}"`);
    return { status: "skipped", reason: "All chunks are semantic near-duplicates", url, title, near_duplicates: nearDupCount };
  }
  if (nearDupCount > 0) {
    kbLog("INFO", "dedup", `Filtered ${nearDupCount}/${chunks.length} near-dup chunks: "${title || url}"`);
  }

  const now = new Date().toISOString();
  const hybrid = await isHybridCollection(collection_name);

  // Sparse vectors for hybrid collections
  let sparseVectors: Array<{ indices: number[]; values: number[] }> = [];
  if (hybrid) {
    const { idfMap, totalDocs } = await loadIdfCache();
    sparseVectors = keptIndices.map(idx => generateSparseVector(chunks[idx], idfMap, totalDocs));
    const allTokens = keptIndices.flatMap(idx => extractUniqueTokens(chunks[idx]));
    updateIdfTerms(allTokens).catch((err: any) => kbLog("ERROR", "idf", `Failed to update IDF terms: ${err.message}`));
  }

  // Authority score — enrich with extracted signals
  let extractedCitations = 0;
  let extractedPublishedAt: string | undefined;

  // Extract year from content for published_at (matches "Published: 2024", "Date: January 2023", copyright years, etc.)
  const yearMatch = content.match(/(?:published|date|updated|posted|written|copyright|\u00a9)\s*:?\s*(?:\w+\s+)?(\d{4})/i)
    || content.match(/\b(20[12]\d)\b/); // fallback: any year 2010-2029
  if (yearMatch) {
    extractedPublishedAt = `${yearMatch[1]}-01-01`;
  }

  // For GitHub sources, use star counts as citation proxy
  if (sourceApi === "firecrawl" && url?.includes("github.com")) {
    const starMatch = content.match(/(\d[\d,]+)\s*stars?/i);
    if (starMatch) extractedCitations = parseInt(starMatch[1].replace(/,/g, "")) || 0;
  }

  const sourceMeta: SourceMetadata = {
    title, url, citations: extractedCitations,
    authority_signals: { quality: quality.overall_score },
    source_api: sourceApi,
    published_at: extractedPublishedAt,
  };
  const authorityScore = computeAuthorityScore(sourceMeta);

  const points = keptIndices.map((idx, i) => {
    const basePayload: any = {
      text: chunks[idx], chunk_index: idx, total_chunks: chunks.length,
      url, source_url: url, title,
      content_hash: hash,
      nrr: parseFloat(nrr.toFixed(3)),
      doc_type: quality.doc_type || "reference",
      style_category: quality.style_category || category || "general",
      semantic_bucket: (quality as any).semantic_bucket || null,
      key_topics: quality.key_topics || [],
      ai_quality_score: quality.overall_score,
      ai_reasoning: quality.reasoning,
      authority_score: authorityScore,
      ingested_at: now, recorded_at: now, embedding_model: EMBEDDING_MODEL,
    };

    if (hybrid) {
      return {
        id: crypto.randomUUID(),
        vector: {
          dense: embeddings[keptIndices[i]],
          sparse: { indices: sparseVectors[i].indices, values: sparseVectors[i].values },
        },
        payload: basePayload,
      };
    } else {
      return {
        id: crypto.randomUUID(),
        vector: embeddings[keptIndices[i]],
        payload: basePayload,
      };
    }
  });

  await qdrantFetch(`/collections/${collection_name}/points`, {
    method: "PUT",
    body: JSON.stringify({ points }),
  });

  updateCollectionStats(collection_name, 1, points.length)
    .then(() => advanceLifecycleState(collection_name).catch((err: any) => kbLog("WARN", "lifecycle", `Auto-advance failed: ${err.message}`)))
    .catch((err: any) => kbLog("WARN", "stats", `Stats update failed: ${err.message}`));
  const chunkIds = points.map(pt => pt.id);
  await writeProvenance(collection_name, chunkIds, url, hash, quality.overall_score, authorityScore, nrr, (quality as any).semantic_bucket || null);
  await populateKBGraph(collection_name, url, title, quality.doc_type || "reference", quality.style_category || "general", quality.key_topics || [], quality.overall_score, chunks.length);

  return {
    status: "ingested", url, collection_name,
    chunks_ingested: points.length, chunks_total: chunks.length,
    near_duplicates_filtered: nearDupCount,
    content_hash: hash,
    nrr: parseFloat(nrr.toFixed(3)),
    quality,
  };
}

async function ingestUrl(
  url: string, collection_name: string, topic: string,
  threshold: number, category?: string
): Promise<any> {
  // URL dedup first (before expensive scrape)
  if (await checkUrlExists(collection_name, url)) {
    kbLog("INFO", "dedup", `URL already exists, skipping: ${url}`);
    return { status: "skipped", reason: "URL already in collection (dedup)", url };
  }

  kbLog("INFO", "ingest", `Scraping: ${url}`);
  const { markdown, metadata: scrapedMeta } = await firecrawlScrape(url);
  const title = scrapedMeta?.title || "Untitled";
  const contentHash = markdown ? computeContentHash(markdown) : undefined;

  return ingestCore(markdown || "", title, url, collection_name, topic, threshold, category, "firecrawl", contentHash);
}

/** Ingest raw text content directly (no Firecrawl scrape needed) */
async function ingestContent(
  content: string, title: string, url: string,
  collection_name: string, topic: string, threshold: number, category?: string
): Promise<any> {
  return ingestCore(content, title, url, collection_name, topic, threshold, category, "direct");
}


// ── Query Rewriting (3-query strategy) ──────────────────────────────

/** Rewrite a query using domain vocabulary for better retrieval */
async function rewriteQueryTechnical(query: string, topic?: string): Promise<string> {
  try {
    const prompt = `Rewrite this search query using precise technical vocabulary to improve retrieval from a knowledge base${topic ? ` about "${topic}"` : ""}.

Original query: "${query}"

Requirements:
- Use specific technical terms, acronyms, and domain jargon
- Expand abbreviations and add synonyms
- Keep it as a search query (not a question or sentence)
- Return ONLY the rewritten query text, nothing else`;

    const result = await openrouterChat(EVAL_MODEL, [{ role: "user", content: prompt }], 200, 0.2, 15000);
    return result.trim().replace(/^["']|["']$/g, "");
  } catch (err: any) {
    kbLog("WARN", "rewrite", `Technical rewrite failed: ${err.message}`);
    return query; // fallback to original
  }
}

/** Generate a Hypothetical Document Embedding (HyDE) — a synthetic answer to embed */
async function generateHyDE(query: string, topic?: string): Promise<string> {
  try {
    const prompt = `Write a short, factual paragraph (100-150 words) that would be the ideal answer to this question, as if it appeared in a technical reference document${topic ? ` about "${topic}"` : ""}.

Question: "${query}"

Requirements:
- Write as if this text exists in a real document
- Include specific technical details, not generalities
- Use the vocabulary and style of technical documentation
- Return ONLY the paragraph text`;

    const result = await openrouterChat(EVAL_MODEL, [{ role: "user", content: prompt }], 300, 0.3, 15000);
    return result.trim();
  } catch (err: any) {
    kbLog("WARN", "hyde", `HyDE generation failed: ${err.message}`);
    return query; // fallback to original
  }
}

/** Execute parallel multi-query search and merge results */
async function multiQuerySearch(
  collection_name: string,
  queries: string[],
  fetchLimit: number,
  filter?: any,
  scoreThreshold: number = 0.3,
): Promise<Array<{ id: string; score: number; text: string; metadata: any }>> {
  const hybrid = await isHybridCollection(collection_name);

  // Check IDF availability for hybrid collections
  let idfEmpty = false;
  if (hybrid) {
    const { idfMap } = await loadIdfCache();
    if (idfMap.size === 0) {
      kbLog("WARN", "search", `IDF table is empty — hybrid sparse vectors will be meaningless, using dense-only fallback`);
      idfEmpty = true;
    }
  }

  const searchPromises = queries.map(async (q) => {
    const embedding = await getEmbeddingWithModel(q, EMBEDDING_MODEL);

    if (hybrid && !idfEmpty) {
      // Use hybrid search (dense + sparse with RRF)
      const { idfMap, totalDocs } = await loadIdfCache();
      const sparse = generateSparseVector(q, idfMap, totalDocs);
      return hybridSearch(collection_name, q, embedding, sparse, fetchLimit, filter, scoreThreshold);
    }

    // Dense-only path (non-hybrid or IDF empty fallback)
    const body: any = hybrid
      ? { vector: { name: "dense", vector: embedding }, limit: fetchLimit, with_payload: true, score_threshold: scoreThreshold }
      : { vector: embedding, limit: fetchLimit, with_payload: true, score_threshold: scoreThreshold };
    if (filter) body.filter = filter;
    const result = await qdrantFetch(`/collections/${collection_name}/points/search`, { method: "POST", body: JSON.stringify(body) });
    return (result.result || []).map((r: any) => ({
      id: r.id,
      score: r.score,
      text: r.payload?.text || "",
      metadata: {
        url: r.payload?.url, title: r.payload?.title, doc_type: r.payload?.doc_type,
        style_category: r.payload?.style_category, key_topics: r.payload?.key_topics,
        ai_quality_score: r.payload?.ai_quality_score, semantic_bucket: r.payload?.semantic_bucket,
      }
    }));
  });

  const allResults = await Promise.allSettled(searchPromises);
  const merged = new Map<string, { id: string; score: number; text: string; metadata: any; queryHits: number }>();

  for (const result of allResults) {
    if (result.status !== "fulfilled") continue;
    for (const hit of result.value) {
      const existing = merged.get(hit.id);
      if (!existing || hit.score > existing.score) {
        merged.set(hit.id, { ...hit, queryHits: (existing?.queryHits || 0) + 1 });
      } else {
        existing.queryHits++;
      }
    }
  }

  // If hybrid returned 0 results, try dense-only fallback
  if (merged.size === 0 && hybrid && !idfEmpty) {
    kbLog("WARN", "search", `Hybrid search returned 0 results, falling back to dense-only`);
    const fallbackEmbedding = await getEmbeddingWithModel(queries[0], EMBEDDING_MODEL);
    const fallbackBody: any = { vector: { name: "dense", vector: fallbackEmbedding }, limit: fetchLimit, with_payload: true, score_threshold: 0.2 };
    if (filter) fallbackBody.filter = filter;
    const fallbackResult = await qdrantFetch(`/collections/${collection_name}/points/search`, { method: "POST", body: JSON.stringify(fallbackBody) });
    for (const r of (fallbackResult.result || [])) {
      merged.set(String(r.id), {
        id: String(r.id), score: r.score, text: r.payload?.text || "",
        metadata: { url: r.payload?.url, title: r.payload?.title, doc_type: r.payload?.doc_type,
          style_category: r.payload?.style_category, key_topics: r.payload?.key_topics,
          ai_quality_score: r.payload?.ai_quality_score, semantic_bucket: r.payload?.semantic_bucket },
        queryHits: 1,
      });
    }
  }

  // Sort by: multi-query hits first (boosted), then by score
  return Array.from(merged.values())
    .sort((a, b) => {
      if (a.queryHits !== b.queryHits) return b.queryHits - a.queryHits;
      return b.score - a.score;
    });
}

// ── Maximal Marginal Relevance (MMR) ────────────────────────────────

/** Cosine similarity between two vectors */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

/** Apply MMR to select diverse, relevant results.
 *  lambda=1.0 = pure relevance, lambda=0.0 = pure diversity */
async function applyMMR(
  queryEmbedding: number[],
  candidates: Array<{ score: number; rerank_score: number; text: string; metadata: any }>,
  topK: number,
  lambda: number = 0.7,
): Promise<Array<{ score: number; rerank_score: number; mmr_score: number; text: string; metadata: any }>> {
  if (candidates.length <= topK) {
    return candidates.map(c => ({ ...c, mmr_score: c.rerank_score }));
  }

  // Embed all candidates — batched parallel
  const candidateEmbeddings: number[][] = [];
  for (let i = 0; i < candidates.length; i += EMBED_BATCH_SIZE) {
    const batch = candidates.slice(i, i + EMBED_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(cand => getEmbeddingWithModel(cand.text.substring(0, 500), EMBEDDING_MODEL))
    );
    candidateEmbeddings.push(...batchResults);
  }

  const selected: number[] = [];
  const remaining = new Set(candidates.map((_, i) => i));
  const result: Array<{ score: number; rerank_score: number; mmr_score: number; text: string; metadata: any }> = [];

  for (let step = 0; step < topK && remaining.size > 0; step++) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (const idx of remaining) {
      // Relevance to query
      const relevance = cosineSim(queryEmbedding, candidateEmbeddings[idx]);

      // Max similarity to already-selected documents
      let maxSimToSelected = 0;
      for (const selIdx of selected) {
        const sim = cosineSim(candidateEmbeddings[idx], candidateEmbeddings[selIdx]);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(bestIdx);
      remaining.delete(bestIdx);
      result.push({ ...candidates[bestIdx], mmr_score: bestMMR });
    }
  }

  return result;
}


// ── Phase 3+4: Source Connector Interface ─────────────────────────────

interface ConnectorSearchOpts {
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly?: boolean;
  minCitations?: number;
}

interface SourceResult {
  id: string;
  title: string;
  content: string;
  url: string;
  metadata: SourceMetadata;
}

interface SourceContent {
  text: string;
  title: string;
  url: string;
  metadata: SourceMetadata;
}

interface SourceMetadata {
  title: string;
  url: string;
  doi?: string;
  arxiv_id?: string;
  pmid?: string;
  s2_corpus_id?: string;
  citations?: number;
  authority_signals: Record<string, number>;
  license?: string;
  published_at?: string;
  source_api: string;
}

interface SourceConnector {
  name: string;
  category: string;
  rateLimit: { requests: number; windowMs: number };
  search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]>;
  fetch(id: string): Promise<SourceContent | null>;
  extractMetadata(raw: any): SourceMetadata;
}

// ── IDF Cache for Sparse Vectors ─────────────────────────────────────

let _idfCache: Map<string, number> | null = null;
let _idfTotalDocs = 1000;
let _idfLastLoad = 0;
let _idfLoadingPromise: Promise<{ idfMap: Map<string, number>; totalDocs: number }> | null = null;
const IDF_CACHE_TTL = 300_000; // 5 minutes

async function loadIdfCache(): Promise<{ idfMap: Map<string, number>; totalDocs: number }> {
  const now = Date.now();
  if (_idfCache && now - _idfLastLoad < IDF_CACHE_TTL) {
    return { idfMap: _idfCache, totalDocs: _idfTotalDocs };
  }
  // In-flight guard prevents thundering herd on cache reload
  if (_idfLoadingPromise) return _idfLoadingPromise;
  _idfLoadingPromise = _loadIdfCacheImpl();
  try { return await _idfLoadingPromise; }
  finally { _idfLoadingPromise = null; }
}

async function _loadIdfCacheImpl(): Promise<{ idfMap: Map<string, number>; totalDocs: number }> {
  try {
    const result = await pgQuery("SELECT term, doc_count FROM rag_idf_terms ORDER BY doc_count DESC LIMIT 50000");
    _idfCache = new Map();
    for (const row of result.rows) {
      _idfCache.set(row.term, parseInt(row.doc_count));
    }
    const statsResult = await pgQuery("SELECT SUM(total_docs) as total FROM rag_collection_stats");
    _idfTotalDocs = parseInt(statsResult.rows[0]?.total || "1000") || 1000;
    _idfLastLoad = Date.now();
    return { idfMap: _idfCache, totalDocs: _idfTotalDocs };
  } catch {
    return { idfMap: new Map(), totalDocs: 1000 };
  }
}

/** Update IDF table with tokens from newly ingested content */
async function updateIdfTerms(tokens: string[]): Promise<void> {
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return;
  try {
    // Batch upsert in chunks of 100
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const values = batch.map((_, j) => `($${j + 1}, 1, NOW())`).join(", ");
      await pgQuery(
        `INSERT INTO rag_idf_terms (term, doc_count, last_updated) VALUES ${values}
         ON CONFLICT (term) DO UPDATE SET doc_count = rag_idf_terms.doc_count + 1, last_updated = NOW()`,
        batch
      );
    }
    _idfCache = null; // Invalidate cache
  } catch (err: any) {
    kbLog("WARN", "idf", `Failed to update IDF terms: ${err.message}`);
  }
}

/** Update collection stats after ingest */
async function updateCollectionStats(collection: string, newDocs: number, newChunks: number): Promise<void> {
  try {
    await pgQuery(
      `INSERT INTO rag_collection_stats (collection, total_docs, total_chunks, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (collection) DO UPDATE SET
         total_docs = rag_collection_stats.total_docs + $2,
         total_chunks = rag_collection_stats.total_chunks + $3,
         updated_at = NOW()`,
      [collection, newDocs, newChunks]
    );
  } catch (err: any) {
    kbLog("WARN", "stats", `Failed to update collection stats: ${err.message}`);
  }
}

// ── Authority Scoring ────────────────────────────────────────────────

const DOMAIN_REPUTATION: Record<string, number> = {
  // Tier 3 (score 3)
  "nature.com": 3, "science.org": 3, "arxiv.org": 3, "pnas.org": 3,
  "acm.org": 3, "ieee.org": 3, "springer.com": 3, "wiley.com": 3,
  "nih.gov": 3, "ncbi.nlm.nih.gov": 3, "pubmed.ncbi.nlm.nih.gov": 3,
  "clinicaltrials.gov": 3, "govinfo.gov": 3, "sec.gov": 3,
  "federalreserve.gov": 3, "congress.gov": 3,
  "w3.org": 3, "developer.mozilla.org": 3,
  // Tier 2 (score 2)
  "github.com": 2, "stackoverflow.com": 2, "medium.com": 2,
  "web.dev": 2, "smashingmagazine.com": 2, "nngroup.com": 2,
  "css-tricks.com": 2, "alistapart.com": 2, "a11yproject.com": 2,
  "fredslouisdlg.com": 2, "api.semanticscholar.org": 2,
  "huggingface.co": 2, "openai.com": 2, "anthropic.com": 2,
  "m3.material.io": 2, "ant.design": 2, "chakra-ui.com": 2,
  "tailwindcss.com": 2, "ishadeed.com": 2, "joshwcomeau.com": 2,
  "theguardian.com": 2, "reuters.com": 2, "bbc.com": 2,
  // Tier 1 (score 1)
  "dev.to": 1, "hashnode.com": 1, "freecodecamp.org": 1,
  "moderncss.dev": 1, "every-layout.dev": 1,
  "lawsofux.com": 1, "webaim.org": 1, "deque.com": 1,
};

function computeAuthorityScore(metadata: SourceMetadata): number {
  let score = 0;

  // Domain reputation (0-3)
  if (metadata.url) {
    try {
      const hostname = new URL(metadata.url).hostname.replace(/^www\./, "");
      // Check exact match, then parent domain
      score += DOMAIN_REPUTATION[hostname]
        ?? DOMAIN_REPUTATION[hostname.split(".").slice(-2).join(".")]
        ?? (hostname.endsWith(".gov") || hostname.endsWith(".edu") ? 3 : 0.5);
    } catch { score += 0.5; }
  }

  // Citation signal (0-3): log-scaled
  if (metadata.citations && metadata.citations > 0) {
    score += Math.min(3, Math.log10(metadata.citations + 1));
  }

  // Recency (0-2): full score < 1 year, linear decay to 0 at 5 years
  if (metadata.published_at) {
    try {
      const ageYears = (Date.now() - new Date(metadata.published_at).getTime()) / (365.25 * 86400_000);
      if (ageYears < 1) score += 2;
      else if (ageYears < 5) score += 2 * (1 - (ageYears - 1) / 4);
    } catch { /* unparseable date */ }
  }

  // Source tier (0-2)
  const SOURCE_TIERS: Record<string, number> = {
    "semantic-scholar": 2, "openalex": 2, "pubmed": 2, "core": 1.5,
    "arxiv": 2, "govinfo": 2, "edgar": 2, "fred": 2,
    "caselaw": 1.5, "courtlistener": 1.5, "clinicaltrials": 2,
    "github": 1, "huggingface": 1.5, "guardian": 1.5,
    "newsapi": 1, "wikidata": 1.5, "wikipedia": 1,
    "web": 0.5, "firecrawl": 0.5,
  };
  score += SOURCE_TIERS[metadata.source_api] ?? 0.5;

  return Math.min(10, Math.round(score * 100) / 100);
}

// ── Hybrid Collection Management ────────────────────────────────────

async function createHybridCollection(name: string, denseSize: number = VECTOR_SIZE): Promise<void> {
  await qdrantFetch(`/collections/${name}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: {
        dense: { size: denseSize, distance: "Cosine" },
      },
      sparse_vectors: {
        sparse: {},
      },
    }),
  });
  kbLog("INFO", "hybrid", `Created hybrid collection: ${name} (dense: ${denseSize}d + sparse)`);
}

// ── Hybrid Search with RRF Fusion ────────────────────────────────────

async function hybridSearch(
  collection: string,
  queryText: string,
  queryEmbedding: number[],
  sparseVector: { indices: number[]; values: number[] },
  limit: number = 20,
  filter?: any,
  scoreThreshold: number = 0.3,
): Promise<Array<{ id: string; score: number; text: string; metadata: any }>> {
  const RRF_K = 60;

  // Dense search
  const denseBody: any = {
    vector: { name: "dense", vector: queryEmbedding },
    limit,
    with_payload: true,
    score_threshold: scoreThreshold,
  };
  if (filter) denseBody.filter = filter;

  // Sparse search
  const sparseBody: any = {
    vector: { name: "sparse", vector: { indices: sparseVector.indices, values: sparseVector.values } },
    limit,
    with_payload: true,
  };
  if (filter) sparseBody.filter = filter;

  const [denseResult, sparseResult] = await Promise.all([
    qdrantFetch(`/collections/${collection}/points/search`, { method: "POST", body: JSON.stringify(denseBody) }).catch(() => ({ result: [] })),
    qdrantFetch(`/collections/${collection}/points/search`, { method: "POST", body: JSON.stringify(sparseBody) }).catch(() => ({ result: [] })),
  ]);

  const denseHits = denseResult.result || [];
  const sparseHits = sparseResult.result || [];

  // RRF fusion: score(doc) = sum(1/(k + rank_i))
  const rrfScores = new Map<string, { score: number; payload: any }>();

  for (let i = 0; i < denseHits.length; i++) {
    const id = String(denseHits[i].id);
    const existing = rrfScores.get(id);
    const rrfContrib = 1 / (RRF_K + i);
    rrfScores.set(id, {
      score: (existing?.score || 0) + rrfContrib,
      payload: existing?.payload || denseHits[i].payload,
    });
  }

  for (let i = 0; i < sparseHits.length; i++) {
    const id = String(sparseHits[i].id);
    const existing = rrfScores.get(id);
    const rrfContrib = 1 / (RRF_K + i);
    rrfScores.set(id, {
      score: (existing?.score || 0) + rrfContrib,
      payload: existing?.payload || sparseHits[i].payload,
    });
  }

  return Array.from(rrfScores.entries())
    .map(([id, data]) => ({
      id,
      score: data.score,
      text: data.payload?.text || "",
      metadata: {
        url: data.payload?.url,
        title: data.payload?.title,
        doc_type: data.payload?.doc_type,
        style_category: data.payload?.style_category,
        key_topics: data.payload?.key_topics,
        ai_quality_score: data.payload?.ai_quality_score,
        semantic_bucket: data.payload?.semantic_bucket,
        doi: data.payload?.doi,
        arxiv_id: data.payload?.arxiv_id,
        pmid: data.payload?.pmid,
      },
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Golden Set Generation ───────────────────────────────────────────

async function generateGoldenSet(collection: string, count: number = 100): Promise<{ generated: number; valid: number; discarded: number }> {
  kbLog("INFO", "golden", `Generating golden set for ${collection} (target: ${count} triplets)`);

  // Sample chunks stratified by semantic_bucket and quality
  const allPoints = await qdrantScroll(collection, undefined, 100, true, false);
  if (allPoints.length === 0) throw new Error(`Collection ${collection} is empty`);

  // Stratify by semantic_bucket
  const buckets = new Map<string, any[]>();
  for (const pt of allPoints) {
    const bucket = pt.payload?.semantic_bucket || "general";
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(pt);
  }

  // Sample proportionally from each bucket
  const sampled: any[] = [];
  const totalPoints = allPoints.length;
  for (const [bucket, points] of buckets) {
    const proportion = points.length / totalPoints;
    const sampleSize = Math.max(1, Math.round(count * proportion));
    // Sort by quality descending, take a mix from top/mid/low
    const sorted = points.sort((a: any, b: any) => (b.payload?.ai_quality_score || 0) - (a.payload?.ai_quality_score || 0));
    const step = Math.max(1, Math.floor(sorted.length / sampleSize));
    for (let i = 0; i < sorted.length && sampled.length < count; i += step) {
      sampled.push(sorted[i]);
    }
  }

  let generated = 0, valid = 0, discarded = 0;

  // Generate queries for each sampled chunk in batches
  const BATCH_SIZE = 10;
  for (let i = 0; i < sampled.length; i += BATCH_SIZE) {
    const batch = sampled.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (pt: any) => {
      const text = pt.payload?.text || "";
      const title = pt.payload?.title || "";
      if (text.length < 50) return null;

      try {
        const prompt = `Given this text from a knowledge base, generate a natural-language search query that this text should answer. Also rate the difficulty.

Text: "${text.substring(0, 800)}"
Source: ${title}

Respond with JSON only:
{"query": "<search query>", "difficulty": "<easy|medium|hard>", "expected_answer": "<1-2 sentence answer summary>"}`;

        const raw = await SEM_EVAL.run(() => openrouterChat(EVAL_MODEL, [{ role: "user", content: prompt }], 300, 0.4));
        const parsed = extractJson(raw);
        if (!parsed.query || parsed.query.length < 10) return null;

        // Validate: search for the query and check if source chunk appears in top-10
        const embedding = await getEmbeddingWithModel(parsed.query, EMBEDDING_MODEL);

        // Use appropriate search based on collection type
        const isHybrid = await isHybridCollection(collection);
        let searchBody: any;
        if (isHybrid) {
          searchBody = { vector: { name: "dense", vector: embedding }, limit: 10, with_payload: false };
        } else {
          searchBody = { vector: embedding, limit: 10, with_payload: false };
        }
        const searchResult = await qdrantFetch(`/collections/${collection}/points/search`, {
          method: "POST", body: JSON.stringify(searchBody),
        });

        const topIds = (searchResult.result || []).map((r: any) => String(r.id));
        const isRetrievable = topIds.includes(String(pt.id));

        if (!isRetrievable) {
          discarded++;
          return null;
        }

        // Store in PG
        await pgQuery(
          `INSERT INTO rag_golden_sets (collection, query, expected_chunk_ids, expected_answer, difficulty, semantic_bucket)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [collection, parsed.query, [pt.id], parsed.expected_answer || "", parsed.difficulty || "medium", pt.payload?.semantic_bucket || "general"]
        );

        generated++;
        valid++;
        return parsed;
      } catch (err: any) {
        discarded++;
        return null;
      }
    });

    await Promise.allSettled(batchPromises);
    kbLog("INFO", "golden", `Progress: ${generated} generated, ${discarded} discarded (batch ${Math.floor(i / BATCH_SIZE) + 1})`);
  }

  kbLog("INFO", "golden", `Golden set complete for ${collection}: ${generated} generated, ${valid} valid, ${discarded} discarded`);
  return { generated, valid, discarded };
}

// ── Retrieval Evaluation Harness ─────────────────────────────────────

interface EvalConfig {
  hybrid: boolean;
  reranking: boolean;
  mmr: boolean;
  multi_query: boolean;
}

async function runEvalHarness(
  collection: string,
  config: EvalConfig = { hybrid: true, reranking: true, mmr: true, multi_query: true },
): Promise<{
  recall_5: number; recall_10: number; recall_20: number;
  mrr: number; ndcg_10: number; precision_5: number;
  golden_set_size: number;
}> {
  // Load golden set
  const goldenResult = await pgQuery(
    "SELECT * FROM rag_golden_sets WHERE collection = $1 AND is_valid = true",
    [collection]
  );
  const goldenSet = goldenResult.rows;
  if (goldenSet.length === 0) throw new Error(`No golden set found for ${collection}. Run generate_golden_set first.`);

  kbLog("INFO", "eval", `Running eval on ${collection}: ${goldenSet.length} queries, config: ${JSON.stringify(config)}`);

  let sumRecall5 = 0, sumRecall10 = 0, sumRecall20 = 0;
  let sumRR = 0; // reciprocal rank
  let sumNDCG10 = 0;
  let sumPrecision5 = 0;

  const isHybrid = config.hybrid && await isHybridCollection(collection);

  // Process golden set in parallel batches
  const EVAL_BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < goldenSet.length; batchStart += EVAL_BATCH_SIZE) {
    const batch = goldenSet.slice(batchStart, batchStart + EVAL_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (gs: any) => {
      const expectedIds = new Set((gs.expected_chunk_ids || []).map(String));
      const queryText = gs.query;

      let results: Array<{ id: string; score: number; text: string; metadata: any }>;

      if (config.multi_query) {
        const [technicalRewrite, hydeAnswer] = await Promise.all([
          rewriteQueryTechnical(queryText),
          generateHyDE(queryText),
        ]);
        const queries = [queryText, technicalRewrite, hydeAnswer].filter((q: string, i: number, arr: string[]) => arr.indexOf(q) === i);

        if (isHybrid) {
          const queryResults = await Promise.all(queries.map(async (q: string) => {
            const emb = await getEmbeddingWithModel(q, EMBEDDING_MODEL);
            const { idfMap, totalDocs } = await loadIdfCache();
            const sparse = generateSparseVector(q, idfMap, totalDocs);
            return hybridSearch(collection, q, emb, sparse, 20);
          }));
          const merged = new Map<string, { id: string; score: number; text: string; metadata: any; queryHits: number }>();
          for (const hits of queryResults) {
            for (const hit of hits) {
              const existing = merged.get(hit.id);
              if (!existing || hit.score > existing.score) {
                merged.set(hit.id, { ...hit, queryHits: (existing?.queryHits || 0) + 1 });
              } else if (existing) { existing.queryHits++; }
            }
          }
          results = Array.from(merged.values()).sort((a, b) => b.queryHits !== a.queryHits ? b.queryHits - a.queryHits : b.score - a.score);
        } else {
          results = await multiQuerySearch(collection, queries, 20);
        }
      } else {
        const embedding = await getEmbeddingWithModel(queryText, EMBEDDING_MODEL);
        if (isHybrid) {
          const { idfMap, totalDocs } = await loadIdfCache();
          const sparse = generateSparseVector(queryText, idfMap, totalDocs);
          results = await hybridSearch(collection, queryText, embedding, sparse, 20);
        } else {
          const searchResult = await qdrantFetch(`/collections/${collection}/points/search`, {
            method: "POST", body: JSON.stringify({ vector: embedding, limit: 20, with_payload: true }),
          });
          results = (searchResult.result || []).map((r: any) => ({
            id: String(r.id), score: r.score, text: r.payload?.text || "", metadata: {},
          }));
        }
      }

      const retrievedIds = results.map(r => String(r.id));
      const recall = (k: number) => {
        const topK = new Set(retrievedIds.slice(0, k));
        let found = 0;
        for (const eid of expectedIds) { if (topK.has(eid as string)) found++; }
        return expectedIds.size > 0 ? found / expectedIds.size : 0;
      };
      let rr = 0;
      for (let i = 0; i < retrievedIds.length; i++) {
        if (expectedIds.has(retrievedIds[i])) { rr = 1 / (i + 1); break; }
      }
      let dcg = 0;
      for (let i = 0; i < Math.min(10, retrievedIds.length); i++) {
        dcg += (expectedIds.has(retrievedIds[i]) ? 1 : 0) / Math.log2(i + 2);
      }
      let idcg = 0;
      for (let i = 0; i < Math.min(10, expectedIds.size); i++) {
        idcg += 1 / Math.log2(i + 2);
      }
      let precHits = 0;
      for (let i = 0; i < Math.min(5, retrievedIds.length); i++) {
        if (expectedIds.has(retrievedIds[i])) precHits++;
      }
      return { recall5: recall(5), recall10: recall(10), recall20: recall(20), rr, ndcg10: idcg > 0 ? dcg / idcg : 0, precision5: precHits / 5 };
    }));

    for (const m of batchResults) {
      sumRecall5 += m.recall5;
      sumRecall10 += m.recall10;
      sumRecall20 += m.recall20;
      sumRR += m.rr;
      sumNDCG10 += m.ndcg10;
      sumPrecision5 += m.precision5;
    }
  }

  const n = goldenSet.length;
  const metrics = {
    recall_5: sumRecall5 / n,
    recall_10: sumRecall10 / n,
    recall_20: sumRecall20 / n,
    mrr: sumRR / n,
    ndcg_10: sumNDCG10 / n,
    precision_5: sumPrecision5 / n,
    golden_set_size: n,
  };

  // Store results
  await pgQuery(
    `INSERT INTO rag_eval_runs (collection, config, recall_5, recall_10, recall_20, mrr, ndcg_10, precision_5, golden_set_size, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [collection, JSON.stringify(config), metrics.recall_5, metrics.recall_10, metrics.recall_20, metrics.mrr, metrics.ndcg_10, metrics.precision_5, n, `Automated eval run`]
  );

  // Check for regression
  try {
    const prevResult = await pgQuery(
      "SELECT * FROM rag_eval_runs WHERE collection = $1 ORDER BY run_at DESC LIMIT 1 OFFSET 1",
      [collection]
    );
    if (prevResult.rows.length > 0) {
      const prev = prevResult.rows[0];
      const recallDelta = metrics.recall_10 - parseFloat(prev.recall_10);
      if (recallDelta < -0.05) {
        await mmAlert("rag-generator", "eval", `Recall@10 regression detected: ${(recallDelta * 100).toFixed(1)}% (${parseFloat(prev.recall_10).toFixed(3)} -> ${metrics.recall_10.toFixed(3)})`, { collection });
      }
    }
  } catch { /* no previous run */ }

  kbLog("INFO", "eval", `Eval complete for ${collection}: Recall@10=${metrics.recall_10.toFixed(3)} MRR=${metrics.mrr.toFixed(3)} NDCG@10=${metrics.ndcg_10.toFixed(3)}`);
  await mmPipelineUpdate(collection, `Eval results: Recall@10=${metrics.recall_10.toFixed(3)} | MRR=${metrics.mrr.toFixed(3)} | NDCG@10=${metrics.ndcg_10.toFixed(3)} | P@5=${metrics.precision_5.toFixed(3)}`, "bar_chart");

  return metrics;
}

// ── Source Connector Registry ────────────────────────────────────────

const connectorRegistry = new Map<string, SourceConnector>();

async function trackConnectorCall(name: string, success: boolean, resultCount: number, latencyMs: number): Promise<void> {
  try {
    if (success) {
      await pgQuery(
        `INSERT INTO rag_connector_health (connector, status, last_success, total_calls, total_results, avg_latency_ms, updated_at)
         VALUES ($1, 'active', NOW(), 1, $2, $3, NOW())
         ON CONFLICT (connector) DO UPDATE SET
           status = 'active', last_success = NOW(), consecutive_failures = 0,
           total_calls = rag_connector_health.total_calls + 1,
           total_results = rag_connector_health.total_results + $2,
           avg_latency_ms = (COALESCE(rag_connector_health.avg_latency_ms, 0) * 0.8 + $3 * 0.2)::INTEGER,
           updated_at = NOW()`,
        [name, resultCount, latencyMs]
      );
    } else {
      await pgQuery(
        `INSERT INTO rag_connector_health (connector, status, last_failure, consecutive_failures, total_calls, updated_at)
         VALUES ($1, CASE WHEN 1 >= 5 THEN 'disabled' ELSE 'active' END, NOW(), 1, 1, NOW())
         ON CONFLICT (connector) DO UPDATE SET
           last_failure = NOW(),
           consecutive_failures = rag_connector_health.consecutive_failures + 1,
           status = CASE WHEN rag_connector_health.consecutive_failures + 1 >= 5 THEN 'disabled' ELSE rag_connector_health.status END,
           total_calls = rag_connector_health.total_calls + 1,
           updated_at = NOW()`,
        [name]
      );
    }
  } catch { /* health tracking failure is non-fatal */ }
}

async function isConnectorHealthy(name: string): Promise<boolean> {
  try {
    const result = await pgQuery("SELECT status, last_failure FROM rag_connector_health WHERE connector = $1", [name]);
    if (result.rows.length === 0) return true; // Unknown = healthy
    const row = result.rows[0];
    if (row.status === "disabled") {
      // Auto-re-enable after 1 hour cooldown
      if (row.last_failure && (Date.now() - new Date(row.last_failure).getTime()) > 3600_000) {
        await pgQuery("UPDATE rag_connector_health SET status = 'active', consecutive_failures = 0 WHERE connector = $1", [name]);
        return true;
      }
      return false;
    }
    return true;
  } catch { return true; }
}

// ── Connector: Semantic Scholar ──────────────────────────────────────

const s2Connector: SourceConnector = {
  name: "semantic-scholar",
  category: "academic",
  rateLimit: { requests: 1, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_S2.run(async () => {
      const headers: Record<string, string> = {};
      if (SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = SEMANTIC_SCHOLAR_API_KEY;
      const limit = opts?.limit || 20;
      const params = new URLSearchParams({
        query, limit: String(limit),
        fields: "paperId,title,abstract,url,year,citationCount,tldr,isOpenAccess,openAccessPdf,externalIds",
      });
      if (opts?.yearFrom) params.set("year", `${opts.yearFrom}-${opts.yearTo || ""}`);
      const resp = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { headers });
      if (!resp.ok) {
        if (resp.status === 429) { await new Promise(r => setTimeout(r, 10000)); }
        throw new Error(`S2 ${resp.status}`);
      }
      const data = await resp.json();
      return (data.data || []).filter((p: any) => p.abstract && p.abstract.length > 50).map((p: any) => ({
        id: p.paperId,
        title: p.title,
        content: `# ${p.title}\n\n**Year**: ${p.year} | **Citations**: ${p.citationCount}\n\n## Abstract\n\n${p.abstract}${p.tldr?.text ? `\n\n## TL;DR\n\n${p.tldr.text}` : ""}`,
        url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
        metadata: s2Connector.extractMetadata(p),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> {
    return SEM_S2.run(async () => {
      const headers: Record<string, string> = {};
      if (SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = SEMANTIC_SCHOLAR_API_KEY;
      const resp = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${id}?fields=paperId,title,abstract,url,year,citationCount,tldr,externalIds`, { headers });
      if (!resp.ok) return null;
      const p = await resp.json();
      if (!p.abstract) return null;
      return {
        text: `# ${p.title}\n\n**Year**: ${p.year} | **Citations**: ${p.citationCount}\n\n## Abstract\n\n${p.abstract}${p.tldr?.text ? `\n\n## TL;DR\n\n${p.tldr.text}` : ""}`,
        title: p.title, url: p.url || "",
        metadata: s2Connector.extractMetadata(p),
      };
    });
  },
  extractMetadata(raw: any): SourceMetadata {
    return {
      title: raw.title || "", url: raw.url || "",
      doi: raw.externalIds?.DOI, arxiv_id: raw.externalIds?.ArXiv,
      s2_corpus_id: raw.paperId,
      citations: raw.citationCount || 0,
      authority_signals: { citation_count: raw.citationCount || 0, is_open_access: raw.isOpenAccess ? 1 : 0 },
      published_at: raw.year ? `${raw.year}-01-01` : undefined,
      source_api: "semantic-scholar",
    };
  },
};
connectorRegistry.set("semantic-scholar", s2Connector);

// ── Connector: OpenAlex ──────────────────────────────────────────────

const openAlexConnector: SourceConnector = {
  name: "openalex",
  category: "academic",
  rateLimit: { requests: 10, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_OPENALEX.run(async () => {
      const limit = opts?.limit || 25;
      const params = new URLSearchParams({ search: query, per_page: String(limit), sort: "cited_by_count:desc" });
      if (opts?.openAccessOnly) params.set("filter", "is_oa:true");
      if (opts?.yearFrom) params.append("filter", `from_publication_date:${opts.yearFrom}-01-01`);
      const resp = await fetch(`https://api.openalex.org/works?${params}`, {
        headers: { "User-Agent": "homelab-mcp-gateway/1.0 (mailto:admin@example.com)" },
      });
      if (!resp.ok) throw new Error(`OpenAlex ${resp.status}`);
      const data = await resp.json();
      return (data.results || []).map((w: any) => {
        let abstract = "";
        if (w.abstract_inverted_index) {
          const words: Array<{ word: string; pos: number }> = [];
          for (const [word, positions] of Object.entries(w.abstract_inverted_index)) {
            for (const pos of positions as number[]) words.push({ word, pos });
          }
          words.sort((a, b) => a.pos - b.pos);
          abstract = words.map(w => w.word).join(" ");
        }
        if (!abstract || abstract.length < 50) return null;
        return {
          id: w.id || w.doi || "",
          title: w.display_name || w.title || "",
          content: `# ${w.display_name || w.title}\n\n**Year**: ${w.publication_year} | **Citations**: ${w.cited_by_count}\n\n## Abstract\n\n${abstract}`,
          url: w.doi || w.id || "",
          metadata: openAlexConnector.extractMetadata(w),
        };
      }).filter(Boolean) as SourceResult[];
    });
  },
  async fetch(id: string): Promise<SourceContent | null> {
    try {
      const resp = await fetch(`https://api.openalex.org/works/${id}`, {
        headers: { "User-Agent": "homelab-mcp-gateway/1.0 (mailto:admin@example.com)" },
      });
      if (!resp.ok) return null;
      const w = await resp.json();
      return { text: w.display_name || "", title: w.display_name || "", url: w.doi || "", metadata: openAlexConnector.extractMetadata(w) };
    } catch { return null; }
  },
  extractMetadata(raw: any): SourceMetadata {
    return {
      title: raw.display_name || raw.title || "", url: raw.doi || "",
      doi: raw.doi?.replace("https://doi.org/", ""),
      citations: raw.cited_by_count || 0,
      authority_signals: { citation_count: raw.cited_by_count || 0 },
      published_at: raw.publication_date || (raw.publication_year ? `${raw.publication_year}-01-01` : undefined),
      source_api: "openalex",
      license: raw.best_oa_location?.license || undefined,
    };
  },
};
connectorRegistry.set("openalex", openAlexConnector);

// ── Connector: CORE ──────────────────────────────────────────────────

const coreConnector: SourceConnector = {
  name: "core",
  category: "academic",
  rateLimit: { requests: 2, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    if (!CORE_API_KEY) return [];
    return SEM_CORE.run(async () => {
      const limit = opts?.limit || 10;
      const resp = await fetch(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${CORE_API_KEY}` },
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.results || []).filter((w: any) => (w.abstract || w.fullText || "").length > 100).map((w: any) => ({
        id: String(w.id || ""),
        title: w.title || "",
        content: w.fullText || `# ${w.title}\n\n## Abstract\n\n${w.abstract}`,
        url: w.downloadUrl || w.sourceFulltextUrls?.[0] || "",
        metadata: coreConnector.extractMetadata(w),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return {
      title: raw.title || "", url: raw.downloadUrl || "",
      doi: raw.doi, citations: raw.citationCount || 0,
      authority_signals: { has_fulltext: raw.fullText ? 1 : 0 },
      published_at: raw.publishedDate || undefined,
      source_api: "core",
    };
  },
};
connectorRegistry.set("core", coreConnector);

// ── Connector: GitHub ────────────────────────────────────────────────

const githubConnector: SourceConnector = {
  name: "github",
  category: "code",
  rateLimit: { requests: 5000, windowMs: 3600_000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    const limit = opts?.limit || 5;
    const data = await githubApiFetch(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${limit}`);
    if (!data?.items) return [];
    return data.items.map((r: any) => ({
      id: `${r.owner.login}/${r.name}`,
      title: `${r.owner.login}/${r.name}`,
      content: r.description || "",
      url: r.html_url,
      metadata: githubConnector.extractMetadata(r),
    }));
  },
  async fetch(id: string): Promise<SourceContent | null> {
    const [owner, repo] = id.split("/");
    if (!owner || !repo) return null;
    const files = await fetchRepoMarkdownFiles(owner, repo, [""]);
    if (files.length === 0) return null;
    return { text: files[0].content, title: `${owner}/${repo}`, url: files[0].url, metadata: githubConnector.extractMetadata({ owner: { login: owner }, name: repo, stargazers_count: 0 }) };
  },
  extractMetadata(raw: any): SourceMetadata {
    return {
      title: `${raw.owner?.login || ""}/${raw.name || ""}`, url: raw.html_url || "",
      citations: raw.stargazers_count || 0,
      authority_signals: { stars: raw.stargazers_count || 0, forks: raw.forks_count || 0 },
      source_api: "github",
      license: raw.license?.spdx_id || undefined,
    };
  },
};
connectorRegistry.set("github", githubConnector);

// ── Connector: arXiv ─────────────────────────────────────────────────

const arxivConnector: SourceConnector = {
  name: "arxiv",
  category: "academic",
  rateLimit: { requests: 1, windowMs: 3000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_ARXIV.run(async () => {
      const limit = opts?.limit || 10;
      const params = new URLSearchParams({ search_query: `all:${query}`, start: "0", max_results: String(limit), sortBy: "relevance" });
      const resp = await fetch(`http://export.arxiv.org/api/query?${params}`);
      if (!resp.ok) throw new Error(`arXiv ${resp.status}`);
      const xml = await resp.text();
      // Simple XML parsing for arXiv Atom feed
      const entries: SourceResult[] = [];
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let match;
      while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];
        const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, " ") || "";
        const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, " ") || "";
        const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || "";
        const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || "";
        const arxivId = id.replace("http://arxiv.org/abs/", "").replace(/v\d+$/, "");
        if (!summary || summary.length < 50) continue;
        entries.push({
          id: arxivId,
          title,
          content: `# ${title}\n\n**arXiv ID**: ${arxivId} | **Published**: ${published.split("T")[0]}\n\n## Abstract\n\n${summary}`,
          url: id,
          metadata: { title, url: id, arxiv_id: arxivId, citations: 0, authority_signals: {}, published_at: published.split("T")[0], source_api: "arxiv" },
        });
      }
      return entries;
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.title || "", url: raw.url || "", arxiv_id: raw.arxiv_id, citations: 0, authority_signals: {}, source_api: "arxiv" };
  },
};
connectorRegistry.set("arxiv", arxivConnector);

// ── Connector: PubMed ────────────────────────────────────────────────

const pubmedConnector: SourceConnector = {
  name: "pubmed",
  category: "healthcare",
  rateLimit: { requests: 3, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_PUBMED.run(async () => {
      const limit = opts?.limit || 10;
      const apiKey = PUBMED_API_KEY ? `&api_key=${PUBMED_API_KEY}` : "";
      // E-search
      const searchResp = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json${apiKey}`);
      if (!searchResp.ok) return [];
      const searchData = await searchResp.json();
      const ids = searchData.esearchresult?.idlist || [];
      if (ids.length === 0) return [];
      // E-fetch
      const fetchResp = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml${apiKey}`);
      if (!fetchResp.ok) return [];
      const xml = await fetchResp.text();
      const results: SourceResult[] = [];
      const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
      let m;
      while ((m = articleRegex.exec(xml)) !== null) {
        const art = m[1];
        const title = art.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1]?.replace(/<[^>]*>/g, "").trim() || "";
        const abstractParts: string[] = [];
        const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
        let absMatch;
        while ((absMatch = absRegex.exec(art)) !== null) { abstractParts.push(absMatch[1].replace(/<[^>]*>/g, "").trim()); }
        const abstract = abstractParts.join("\n\n");
        const pmid = art.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1] || "";
        const year = art.match(/<Year>(\d{4})<\/Year>/)?.[1] || "";
        if (!abstract || abstract.length < 50) continue;
        results.push({
          id: pmid, title,
          content: `# ${title}\n\n**PMID**: ${pmid} | **Year**: ${year}\n\n## Abstract\n\n${abstract}`,
          url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
          metadata: { title, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, pmid, citations: 0, authority_signals: {}, published_at: year ? `${year}-01-01` : undefined, source_api: "pubmed" },
        });
      }
      return results;
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.title || "", url: raw.url || "", pmid: raw.pmid, citations: 0, authority_signals: {}, source_api: "pubmed" };
  },
};
connectorRegistry.set("pubmed", pubmedConnector);

// ── Connector: SEC EDGAR ─────────────────────────────────────────────

const edgarConnector: SourceConnector = {
  name: "edgar",
  category: "financial",
  rateLimit: { requests: 10, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_EDGAR.run(async () => {
      const limit = opts?.limit || 10;
      const resp = await fetch(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&dateRange=custom&startdt=2020-01-01&forms=10-K,10-Q,8-K&hits.hits.total.value=${limit}`, {
        headers: { "User-Agent": "homelab-mcp-gateway admin@example.com" },
      });
      if (!resp.ok) {
        // Fallback to full-text search
        const resp2 = await fetch(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=10-K,10-Q`, {
          headers: { "User-Agent": "homelab-mcp-gateway admin@example.com" },
        });
        if (!resp2.ok) return [];
        const data2 = await resp2.json();
        return (data2.hits?.hits || []).slice(0, limit).map((h: any) => ({
          id: h._id || "", title: h._source?.file_description || query,
          content: `# SEC Filing: ${h._source?.file_description || ""}\n\n${h._source?.file_description || ""}`,
          url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(query)}&type=10-K`,
          metadata: edgarConnector.extractMetadata(h._source || {}),
        }));
      }
      const data = await resp.json();
      return (data.hits?.hits || []).slice(0, limit).map((h: any) => ({
        id: h._id || "", title: h._source?.file_description || query,
        content: h._source?.file_description || "",
        url: `https://www.sec.gov/Archives/edgar/data/${h._source?.entity_id || ""}`,
        metadata: edgarConnector.extractMetadata(h._source || {}),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.file_description || raw.display_names?.[0] || "", url: "", citations: 0, authority_signals: { form_type: raw.form_type || "" }, source_api: "edgar" };
  },
};
connectorRegistry.set("edgar", edgarConnector);

// ── Connector: GovInfo ───────────────────────────────────────────────

const govInfoConnector: SourceConnector = {
  name: "govinfo",
  category: "government",
  rateLimit: { requests: 2, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_GOVINFO.run(async () => {
      const limit = opts?.limit || 10;
      const apiKey = GOVINFO_API_KEY ? `&api_key=${GOVINFO_API_KEY}` : "";
      const resp = await fetch(`https://api.govinfo.gov/search?query=${encodeURIComponent(query)}&pageSize=${limit}&offsetMark=*${apiKey}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.results || []).map((r: any) => ({
        id: r.packageId || "", title: r.title || "",
        content: `# ${r.title}\n\n${r.description || r.title}`,
        url: r.packageLink || r.detailsLink || "",
        metadata: govInfoConnector.extractMetadata(r),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.title || "", url: raw.packageLink || "", citations: 0, authority_signals: { collection: raw.collectionCode || "" }, published_at: raw.dateIssued, source_api: "govinfo" };
  },
};
connectorRegistry.set("govinfo", govInfoConnector);

// ── Connector: FRED ──────────────────────────────────────────────────

const fredConnector: SourceConnector = {
  name: "fred",
  category: "financial",
  rateLimit: { requests: 2, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    if (!FRED_API_KEY) return [];
    return SEM_FRED.run(async () => {
      const limit = opts?.limit || 10;
      const resp = await fetch(`https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(query)}&limit=${limit}&api_key=${FRED_API_KEY}&file_type=json`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.seriess || []).map((s: any) => ({
        id: s.id, title: s.title,
        content: `# ${s.title}\n\n**Series ID**: ${s.id}\n**Frequency**: ${s.frequency}\n**Units**: ${s.units}\n**Seasonal Adjustment**: ${s.seasonal_adjustment}\n\n${s.notes || ""}`,
        url: `https://fred.stlouisfed.org/series/${s.id}`,
        metadata: fredConnector.extractMetadata(s),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.title || "", url: `https://fred.stlouisfed.org/series/${raw.id}`, citations: raw.popularity || 0, authority_signals: { popularity: raw.popularity || 0 }, source_api: "fred" };
  },
};
connectorRegistry.set("fred", fredConnector);

// ── Connector: Caselaw Access Project ────────────────────────────────

const caselawConnector: SourceConnector = {
  name: "caselaw",
  category: "legal",
  rateLimit: { requests: 2, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    const limit = opts?.limit || 10;
    const resp = await fetch(`https://api.case.law/v1/cases/?search=${encodeURIComponent(query)}&page_size=${limit}&full_case=true`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map((c: any) => ({
      id: String(c.id), title: c.name_abbreviation || c.name || "",
      content: `# ${c.name_abbreviation || c.name}\n\n**Court**: ${c.court?.name || ""}\n**Date**: ${c.decision_date}\n\n${c.casebody?.data?.opinions?.[0]?.text?.substring(0, 3000) || ""}`,
      url: c.frontend_url || c.url || "",
      metadata: caselawConnector.extractMetadata(c),
    }));
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.name_abbreviation || "", url: raw.frontend_url || "", citations: raw.citations?.length || 0, authority_signals: { court: raw.court?.name || "" }, published_at: raw.decision_date, source_api: "caselaw" };
  },
};
connectorRegistry.set("caselaw", caselawConnector);

// ── Connector: CourtListener ─────────────────────────────────────────

const courtListenerConnector: SourceConnector = {
  name: "courtlistener",
  category: "legal",
  rateLimit: { requests: 2, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    const limit = opts?.limit || 10;
    const resp = await fetch(`https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(query)}&type=o&page_size=${limit}`, {
      headers: { "Accept": "application/json" },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map((r: any) => ({
      id: String(r.id || r.cluster_id || ""), title: r.caseName || "",
      content: `# ${r.caseName}\n\n**Court**: ${r.court || ""}\n**Date**: ${r.dateFiled || ""}\n\n${(r.snippet || "").replace(/<[^>]*>/g, "")}`,
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : "",
      metadata: courtListenerConnector.extractMetadata(r),
    }));
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.caseName || "", url: raw.absolute_url || "", citations: raw.citeCount || 0, authority_signals: { cite_count: raw.citeCount || 0 }, published_at: raw.dateFiled, source_api: "courtlistener" };
  },
};
connectorRegistry.set("courtlistener", courtListenerConnector);

// ── Connector: Wikidata ──────────────────────────────────────────────

const wikidataConnector: SourceConnector = {
  name: "wikidata",
  category: "knowledge",
  rateLimit: { requests: 3, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_WIKIDATA.run(async () => {
      const limit = opts?.limit || 10;
      const resp = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&limit=${limit}&format=json`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.search || []).map((e: any) => ({
        id: e.id, title: e.label || "",
        content: `# ${e.label}\n\n${e.description || ""}`,
        url: e.concepturi || `https://www.wikidata.org/wiki/${e.id}`,
        metadata: wikidataConnector.extractMetadata(e),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.label || "", url: raw.concepturi || "", citations: 0, authority_signals: {}, source_api: "wikidata" };
  },
};
connectorRegistry.set("wikidata", wikidataConnector);

// ── Connector: Hugging Face ──────────────────────────────────────────

const huggingfaceConnector: SourceConnector = {
  name: "huggingface",
  category: "code",
  rateLimit: { requests: 5, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    const limit = opts?.limit || 10;
    const resp = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${limit}&sort=downloads&direction=-1`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map((m: any) => ({
      id: m.modelId || m.id, title: m.modelId || "",
      content: `# ${m.modelId}\n\n**Downloads**: ${m.downloads || 0} | **Likes**: ${m.likes || 0}\n**Tags**: ${(m.tags || []).join(", ")}\n**Pipeline**: ${m.pipeline_tag || "N/A"}`,
      url: `https://huggingface.co/${m.modelId}`,
      metadata: huggingfaceConnector.extractMetadata(m),
    }));
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.modelId || "", url: `https://huggingface.co/${raw.modelId}`, citations: raw.downloads || 0, authority_signals: { downloads: raw.downloads || 0, likes: raw.likes || 0 }, source_api: "huggingface", license: raw.license || undefined };
  },
};
connectorRegistry.set("huggingface", huggingfaceConnector);

// ── Connector: The Guardian ──────────────────────────────────────────

const guardianConnector: SourceConnector = {
  name: "guardian",
  category: "news",
  rateLimit: { requests: 12, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    if (!GUARDIAN_API_KEY) return [];
    return SEM_GUARDIAN.run(async () => {
      const limit = opts?.limit || 10;
      const resp = await fetch(`https://content.guardianapis.com/search?q=${encodeURIComponent(query)}&page-size=${limit}&show-fields=bodyText,headline&api-key=${GUARDIAN_API_KEY}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.response?.results || []).map((r: any) => ({
        id: r.id, title: r.fields?.headline || r.webTitle || "",
        content: `# ${r.fields?.headline || r.webTitle}\n\n${(r.fields?.bodyText || "").substring(0, 3000)}`,
        url: r.webUrl || "",
        metadata: guardianConnector.extractMetadata(r),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.webTitle || "", url: raw.webUrl || "", citations: 0, authority_signals: { section: raw.sectionName || "" }, published_at: raw.webPublicationDate, source_api: "guardian" };
  },
};
connectorRegistry.set("guardian", guardianConnector);

// ── Connector: NewsAPI ───────────────────────────────────────────────

const newsapiConnector: SourceConnector = {
  name: "newsapi",
  category: "news",
  rateLimit: { requests: 1, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    if (!NEWSAPI_API_KEY) return [];
    return SEM_NEWSAPI.run(async () => {
      const limit = opts?.limit || 10;
      const resp = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&pageSize=${limit}&sortBy=relevancy&apiKey=${NEWSAPI_API_KEY}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.articles || []).map((a: any) => ({
        id: a.url, title: a.title || "",
        content: `# ${a.title}\n\n**Source**: ${a.source?.name || ""}\n**Published**: ${a.publishedAt || ""}\n\n${a.description || ""}\n\n${a.content || ""}`,
        url: a.url || "",
        metadata: newsapiConnector.extractMetadata(a),
      }));
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.title || "", url: raw.url || "", citations: 0, authority_signals: { source: raw.source?.name || "" }, published_at: raw.publishedAt, source_api: "newsapi" };
  },
};
connectorRegistry.set("newsapi", newsapiConnector);

// ── Connector: ClinicalTrials.gov ────────────────────────────────────

const clinicalTrialsConnector: SourceConnector = {
  name: "clinicaltrials",
  category: "healthcare",
  rateLimit: { requests: 2, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    return SEM_CLINTRIALS.run(async () => {
      const limit = opts?.limit || 10;
      const resp = await fetch(`https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(query)}&pageSize=${limit}&format=json`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.studies || []).map((s: any) => {
        const proto = s.protocolSection || {};
        const id = proto.identificationModule?.nctId || "";
        const title = proto.identificationModule?.briefTitle || "";
        const summary = proto.descriptionModule?.briefSummary || "";
        return {
          id, title,
          content: `# ${title}\n\n**NCT ID**: ${id}\n**Status**: ${proto.statusModule?.overallStatus || ""}\n\n## Summary\n\n${summary}`,
          url: `https://clinicaltrials.gov/study/${id}`,
          metadata: clinicalTrialsConnector.extractMetadata(s),
        };
      });
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    const proto = raw.protocolSection || {};
    return { title: proto.identificationModule?.briefTitle || "", url: `https://clinicaltrials.gov/study/${proto.identificationModule?.nctId || ""}`, citations: 0, authority_signals: {}, source_api: "clinicaltrials" };
  },
};
connectorRegistry.set("clinicaltrials", clinicalTrialsConnector);

// ── Connector: Alpha Vantage ─────────────────────────────────────────

const alphaVantageConnector: SourceConnector = {
  name: "alphavantage",
  category: "financial",
  rateLimit: { requests: 5, windowMs: 60_000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    if (!ALPHA_VANTAGE_API_KEY) return [];
    const resp = await fetch(`https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${ALPHA_VANTAGE_API_KEY}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.bestMatches || []).map((m: any) => ({
      id: m["1. symbol"], title: `${m["2. name"]} (${m["1. symbol"]})`,
      content: `# ${m["2. name"]} (${m["1. symbol"]})\n\n**Type**: ${m["3. type"]}\n**Region**: ${m["4. region"]}\n**Currency**: ${m["8. currency"]}`,
      url: `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${m["1. symbol"]}`,
      metadata: alphaVantageConnector.extractMetadata(m),
    }));
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw["2. name"] || "", url: "", citations: 0, authority_signals: {}, source_api: "alphavantage" };
  },
};
connectorRegistry.set("alphavantage", alphaVantageConnector);

// ── Connector: Socrata / data.gov ────────────────────────────────────

const socrataConnector: SourceConnector = {
  name: "socrata",
  category: "government",
  rateLimit: { requests: 5, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    const limit = opts?.limit || 10;
    const resp = await fetch(`https://api.us.socrata.com/api/catalog/v1?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map((r: any) => {
      const res = r.resource || {};
      return {
        id: res.id || "", title: res.name || "",
        content: `# ${res.name}\n\n**Domain**: ${r.metadata?.domain || ""}\n**Updated**: ${res.updatedAt || ""}\n\n${res.description || ""}`,
        url: r.link || res.link || "",
        metadata: socrataConnector.extractMetadata(r),
      };
    });
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    const res = raw.resource || {};
    return { title: res.name || "", url: raw.link || "", citations: res.page_views?.page_views_total || 0, authority_signals: { domain: raw.metadata?.domain || "" }, source_api: "socrata" };
  },
};
connectorRegistry.set("socrata", socrataConnector);

// ── Connector: Wikipedia ─────────────────────────────────────────────

const wikipediaConnector: SourceConnector = {
  name: "wikipedia",
  category: "knowledge",
  rateLimit: { requests: 5, windowMs: 1000 },
  async search(query: string, opts?: ConnectorSearchOpts): Promise<SourceResult[]> {
    const limit = opts?.limit || 10;
    const resp = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.query?.search || []).map((r: any) => ({
      id: String(r.pageid), title: r.title || "",
      content: `# ${r.title}\n\n${(r.snippet || "").replace(/<[^>]*>/g, "")}`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
      metadata: wikipediaConnector.extractMetadata(r),
    }));
  },
  async fetch(id: string): Promise<SourceContent | null> { return null; },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.title || "", url: `https://en.wikipedia.org/wiki/${encodeURIComponent((raw.title || "").replace(/ /g, "_"))}`, citations: 0, authority_signals: {}, source_api: "wikipedia" };
  },
};
connectorRegistry.set("wikipedia", wikipediaConnector);

// ── Connector: Unpaywall ─────────────────────────────────────────────

const unpaywallConnector: SourceConnector = {
  name: "unpaywall",
  category: "academic",
  rateLimit: { requests: 5, windowMs: 1000 },
  async search(query: string): Promise<SourceResult[]> { return []; /* DOI-based only */ },
  async fetch(id: string): Promise<SourceContent | null> {
    // id = DOI
    const cleanDoi = id.replace("https://doi.org/", "");
    try {
      const resp = await fetch(`https://api.unpaywall.org/v2/${cleanDoi}?email=admin@example.com`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const url = data.best_oa_location?.url_for_pdf || data.best_oa_location?.url || null;
      if (!url) return null;
      return { text: data.title || "", title: data.title || "", url, metadata: unpaywallConnector.extractMetadata(data) };
    } catch { return null; }
  },
  extractMetadata(raw: any): SourceMetadata {
    return { title: raw.title || "", url: raw.best_oa_location?.url || "", doi: raw.doi, citations: raw.cited_by_count || 0, authority_signals: {}, source_api: "unpaywall", license: raw.best_oa_location?.license || undefined };
  },
};
connectorRegistry.set("unpaywall", unpaywallConnector);

// ── Query Router (Agent Gate) ────────────────────────────────────────

async function routeQuery(query: string): Promise<{ route: "single" | "multi" | "no_rag"; collections: string[]; confidence: number; reasoning: string }> {
  try {
    const statsResult = await pgQuery("SELECT collection, description, total_chunks, lifecycle_state FROM rag_collection_stats WHERE lifecycle_state NOT IN ('retiring')");
    if (statsResult.rows.length === 0) return { route: "no_rag", collections: [], confidence: 1.0, reasoning: "No collections available" };
    if (statsResult.rows.length === 1) return { route: "single", collections: [statsResult.rows[0].collection], confidence: 1.0, reasoning: "Only one collection" };

    const collectionInfo = statsResult.rows.map((r: any) => `- ${r.collection}: ${r.description || "no description"} (${r.total_chunks} chunks, ${r.lifecycle_state})`).join("\n");

    const prompt = `Route this search query to the appropriate knowledge base collection(s).

Query: "${query}"

Available collections:
${collectionInfo}

Respond with JSON only:
{"route": "single"|"multi"|"no_rag", "collections": ["name1"], "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

    const raw = await openrouterChat(EVAL_MODEL, [{ role: "user", content: prompt }], 200, 0.2, 10000);
    const result = extractJson(raw);
    // Validate collection names
    const validCollections = new Set(statsResult.rows.map((r: any) => r.collection));
    result.collections = (result.collections || []).filter((c: string) => validCollections.has(c));
    if (result.collections.length === 0) {
      // Fan out to all production collections
      result.collections = statsResult.rows.filter((r: any) => r.lifecycle_state === "production").map((r: any) => r.collection);
      result.route = result.collections.length > 1 ? "multi" : "single";
      result.confidence = 0.5;
    }
    return result;
  } catch (err: any) {
    kbLog("WARN", "router", `Query routing failed: ${err.message}`);
    return { route: "no_rag", collections: [], confidence: 0, reasoning: `Routing error: ${err.message}` };
  }
}

// ── Collection Lifecycle Management ──────────────────────────────────

async function advanceLifecycleState(collection: string): Promise<string | null> {
  try {
    const result = await pgQuery("SELECT * FROM rag_collection_stats WHERE collection = $1", [collection]);
    if (result.rows.length === 0) return null;
    const stats = result.rows[0];
    const currentState = stats.lifecycle_state;
    let newState: string | null = null;

    if (currentState === "bootstrapping" && stats.total_chunks >= 100) {
      newState = "curating";
    } else if (currentState === "curating" && stats.total_chunks >= 5000) {
      // Check average quality
      try {
        const info = await qdrantFetch(`/collections/${collection}`);
        if (info.result?.points_count >= 5000) newState = "production";
      } catch { /* collection might not exist */ }
    } else if (currentState === "production") {
      const daysSinceUpdate = (Date.now() - new Date(stats.updated_at).getTime()) / 86400_000;
      if (daysSinceUpdate > 30) newState = "maintaining";
    } else if (currentState === "maintaining") {
      const daysSinceUpdate = (Date.now() - new Date(stats.updated_at).getTime()) / 86400_000;
      // Check query volume
      const queryResult = await pgQuery("SELECT COUNT(*) as cnt FROM rag_query_log WHERE collection = $1 AND queried_at > NOW() - INTERVAL '30 days'", [collection]);
      const recentQueries = parseInt(queryResult.rows[0]?.cnt || "0");
      if (daysSinceUpdate > 90 && recentQueries === 0) newState = "retiring";
    }

    if (newState) {
      await pgQuery("UPDATE rag_collection_stats SET lifecycle_state = $2, updated_at = NOW() WHERE collection = $1", [collection, newState]);
      kbLog("INFO", "lifecycle", `Collection ${collection}: ${currentState} -> ${newState}`);
      return newState;
    }
    return currentState;
  } catch { return null; }
}

// ── Source Freshness ─────────────────────────────────────────────────

async function findStaleSources(collection: string, maxAgeDays: number = 90): Promise<Array<{ url: string; last_crawled: string; age_days: number }>> {
  try {
    const result = await pgQuery(
      `SELECT DISTINCT source_url, COALESCE(last_crawled_at, ingested_at) as last_check
       FROM rag_chunks WHERE collection = $1 AND source_url IS NOT NULL
       ORDER BY last_check ASC`,
      [collection]
    );

    const stale: Array<{ url: string; last_crawled: string; age_days: number }> = [];
    const cutoff = Date.now() - maxAgeDays * 86400_000;

    for (const row of result.rows) {
      const lastCheck = new Date(row.last_check).getTime();
      if (lastCheck < cutoff) {
        stale.push({
          url: row.source_url,
          last_crawled: row.last_check,
          age_days: Math.round((Date.now() - lastCheck) / 86400_000),
        });
      }
    }

    return stale;
  } catch { return []; }
}

// ── Drift Detection ─────────────────────────────────────────────────

async function detectDrift(collection: string, windowDays: number = 30): Promise<{
  drift_detected: boolean;
  avg_top_score: number;
  score_trend: string;
  query_count: number;
  recommendation: string;
}> {
  try {
    const result = await pgQuery(
      `SELECT AVG(top_score) as avg_score, COUNT(*) as cnt,
              AVG(CASE WHEN queried_at > NOW() - INTERVAL '7 days' THEN top_score END) as recent_avg,
              AVG(CASE WHEN queried_at < NOW() - INTERVAL '7 days' THEN top_score END) as older_avg
       FROM rag_query_log WHERE collection = $1 AND queried_at > NOW() - INTERVAL '1 day' * $2`,
      [collection, windowDays]
    );

    const row = result.rows[0];
    const avgScore = parseFloat(row.avg_score || "0");
    const recentAvg = parseFloat(row.recent_avg || "0");
    const olderAvg = parseFloat(row.older_avg || "0");
    const count = parseInt(row.cnt || "0");

    let trend = "stable";
    let driftDetected = false;
    let recommendation = "No action needed";

    if (count < 10) {
      recommendation = "Insufficient query data for drift detection";
    } else if (recentAvg > 0 && olderAvg > 0) {
      const delta = recentAvg - olderAvg;
      if (delta < -0.1) {
        trend = "declining";
        driftDetected = true;
        recommendation = "Query relevance declining — consider adding new content or reviewing coverage gaps";
      } else if (delta > 0.05) {
        trend = "improving";
      }
    }

    if (avgScore < 0.5 && count >= 10) {
      driftDetected = true;
      recommendation = "Average relevance scores are low — collection may not cover common queries";
    }

    return { drift_detected: driftDetected, avg_top_score: avgScore, score_trend: trend, query_count: count, recommendation };
  } catch { return { drift_detected: false, avg_top_score: 0, score_trend: "unknown", query_count: 0, recommendation: "Error computing drift" }; }
}

/** Log a query for drift detection */
async function logQuery(collection: string, query: string, topScore: number, resultCount: number): Promise<void> {
  try {
    await pgQuery(
      "INSERT INTO rag_query_log (collection, query, top_score, result_count) VALUES ($1, $2, $3, $4)",
      [collection, query, topScore, resultCount]
    );
  } catch { /* non-fatal */ }
}



// ── Tool Definitions ─────────────────────────────────────────────────



// ── Tally tracker for live Mattermost scoreboard ──────────────────
interface ChannelTally {
  ingested: number;
  rejected: number;
  errors: number;
  qualitySum: number;
  qualityCount: number;
}

interface PipelineTally {
  postId: string | null;
  collection: string;
  topic: string;
  pass: number;
  maxPass: number;
  channels: { web: ChannelTally; github: ChannelTally; scholar: ChannelTally };
  startTime: number;
  passCosts: number[];   // cost per completed pass
  passVectors: number[]; // vectors added per completed pass
}

function newChannelTally(): ChannelTally {
  return { ingested: 0, rejected: 0, errors: 0, qualitySum: 0, qualityCount: 0 };
}

function createTally(collection: string, topic: string, maxPass: number): PipelineTally {
  resetAllCost();
  return {
    postId: null,
    collection,
    topic,
    pass: 1,
    maxPass,
    channels: { web: newChannelTally(), github: newChannelTally(), scholar: newChannelTally() },
    startTime: Date.now(),
    passCosts: [],
    passVectors: [],
  };
}

function tallyRecord(tally: PipelineTally, channel: "web" | "github" | "scholar", accepted: boolean, quality?: number, isError?: boolean) {
  const ch = tally.channels[channel];
  if (isError) { ch.errors++; return; }
  if (accepted) ch.ingested++;
  else ch.rejected++;
  if (quality !== undefined && quality > 0) { ch.qualitySum += quality; ch.qualityCount++; }
}

function formatTally(tally: PipelineTally, status?: string): string {
  const { web, github, scholar } = tally.channels;
  const total = {
    ingested: web.ingested + github.ingested + scholar.ingested,
    rejected: web.rejected + github.rejected + scholar.rejected,
    errors: web.errors + github.errors + scholar.errors,
  };
  const totalQSum = web.qualitySum + github.qualitySum + scholar.qualitySum;
  const totalQCount = web.qualityCount + github.qualityCount + scholar.qualityCount;
  const totalAvgQ = totalQCount > 0 ? totalQSum / totalQCount : 0;
  const totalEvaluated = total.ingested + total.rejected;
  const efficiency = totalEvaluated > 0 ? ((total.ingested / totalEvaluated) * 100).toFixed(1) : "—";

  const avgQ = (ch: ChannelTally) => ch.qualityCount > 0 ? (ch.qualitySum / ch.qualityCount).toFixed(1) : "—";
  const eff = (ch: ChannelTally) => {
    const ev = ch.ingested + ch.rejected;
    return ev > 0 ? ((ch.ingested / ev) * 100).toFixed(0) + "%" : "—";
  };
  const elapsed = Math.round((Date.now() - tally.startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  // Cost & efficiency curve
  const cost = getCostTracker();
  const passCostStr = `$${cost.passCost.toFixed(4)}`;
  const totalCostStr = `$${cost.totalCost.toFixed(4)}`;

  // Build per-pass cost/vector curve for diminishing returns analysis
  let curveLines: string[] = [];
  for (let i = 0; i < tally.passCosts.length; i++) {
    const pc = tally.passCosts[i];
    const pv = tally.passVectors[i] || 0;
    const cpv = pv > 0 ? `$${(pc / pv).toFixed(6)}` : "—";
    curveLines.push(`P${i + 1}: ${pv} vec @ $${pc.toFixed(4)} (${cpv}/vec)`);
  }
  // Add current in-progress pass if we have active cost
  if (cost.passCost > 0 && tally.passCosts.length < tally.pass) {
    const currentVecs = (web.ingested + github.ingested + scholar.ingested) - tally.passVectors.reduce((a, b) => a + b, 0);
    const currentCpv = currentVecs > 0 ? `$${(cost.passCost / currentVecs).toFixed(6)}` : "—";
    curveLines.push(`P${tally.pass}: ${currentVecs} vec @ ${passCostStr} (${currentCpv}/vec) *active*`);
  }
  const curveLine = curveLines.length > 0 ? curveLines.join("\n") : "";
  const costLine = curveLine
    ? `**Cost:** ${totalCostStr} total\n\`\`\`\n${curveLine}\n\`\`\``
    : `**Cost:** ${passCostStr} this pass | ${totalCostStr} total`;

  const statusLine = status ? `\n**Status:** ${status}` : "";

  return `:bar_chart: **${tally.collection}** — Pass ${tally.pass}/${tally.maxPass} (${mins}m ${secs}s)${statusLine}

| Channel | Ingested | Rejected | Errors | Efficiency | Avg Quality |
|:--------|:--------:|:--------:|:------:|:----------:|:-----------:|
| Web | ${web.ingested} | ${web.rejected} | ${web.errors} | ${eff(web)} | ${avgQ(web)} |
| GitHub | ${github.ingested} | ${github.rejected} | ${github.errors} | ${eff(github)} | ${avgQ(github)} |
| Scholar | ${scholar.ingested} | ${scholar.rejected} | ${scholar.errors} | ${eff(scholar)} | ${avgQ(scholar)} |
| **Total** | **${total.ingested}** | **${total.rejected}** | **${total.errors}** | **${efficiency}%** | **${totalAvgQ.toFixed(1)}** |

${costLine}`;
}

async function tallyUpdate(tally: PipelineTally, status?: string): Promise<void> {
  const msg = formatTally(tally, status);
  if (!tally.postId) {
    const post = await mmPostWithId("dev-logs", msg);
    if (post?.id) tally.postId = post.id;
  } else {
    await mmUpdatePost(tally.postId, msg);
  }
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (params: any) => Promise<any> }> = {

  build_knowledge_base: {
    description: "Full autonomous pipeline: research topic with Sonar Pro, scrape with Firecrawl, evaluate quality, chunk with context injection, embed with nomic-embed-text-v1.5, store in Qdrant. Optionally runs GitHub and Research API discovery in parallel. Fire and forget.",
    params: {
      topic: "Research topic",
      collection_name: "Qdrant collection name (REQUIRED)",
      seed_urls: "Optional JSON array of URLs to ingest directly (bypasses Sonar discovery for these)",
      target_sources: "Approximate target URL count (default 80)",
      quality_threshold: "Minimum quality score 0-10 (default 6.5)",
      wipe_existing: "Delete collection first (default false)",
      include_github: "Also run GitHub discovery in parallel (default true)",
      include_research: "Also run academic research discovery in parallel (default true)",
    },
    handler: async ({ topic, collection_name, seed_urls, target_sources = 80, quality_threshold = 6.5, wipe_existing = "false", include_github = "true", include_research = "true", _queue_managed = false }) => {
      if (!collection_name || !topic) return { status: "error", error: "collection_name and topic are required" };
      const parsedSeedUrls: string[] = seed_urls ? (typeof seed_urls === "string" ? JSON.parse(seed_urls) : seed_urls) : [];
      const threshold = parseFloat(quality_threshold);
      const targetCount = parseInt(target_sources);
      const wipe = wipe_existing === "true" || wipe_existing === true;
      const doGithub = include_github === "true" || include_github === true;
      const doResearch = include_research === "true" || include_research === true;
      const jobId = crypto.randomUUID().slice(0, 8);

      const pipelineWork = async () => {
        try {
          const channels = ["Sonar web research"];
          if (doGithub) channels.push("GitHub repo mining");
          if (doResearch) channels.push("Academic research APIs");
          await mmPipelineUpdate(collection_name, `Knowledge base build initiated (job: ${jobId})\n**Topic**: ${topic}\n**Channels**: ${channels.join(", ")}\n**Embedding**: nomic-embed-text-v1.5 (${VECTOR_SIZE}d)`, "rocket");

          if (wipe) {
            try {
              await qdrantFetch(`/collections/${collection_name}`, { method: "DELETE" });
              kbLog("INFO", "build", `Wiped collection: ${collection_name}`);
            } catch { /* collection may not exist */ }
          }

          // Ensure collection exists (always create as hybrid for dense + sparse support)
          try {
            const info = await qdrantFetch(`/collections/${collection_name}`);
            const vectorConfig = info.result?.config?.params?.vectors;
            const existingSize = vectorConfig?.dense?.size || vectorConfig?.size;
            if (existingSize && existingSize !== VECTOR_SIZE) {
              await qdrantFetch(`/collections/${collection_name}`, { method: "DELETE" });
              throw new Error("recreate");
            }
          } catch {
            await createHybridCollection(collection_name, VECTOR_SIZE);
            kbLog("INFO", "build", `Created hybrid collection: ${collection_name} (${VECTOR_SIZE}d + sparse)`);
          }

          // Launch parallel discovery channels
          const channelPromises: Promise<void>[] = [];

          // Channel 0: Seed URLs (if provided) — direct ingest, no discovery
          if (parsedSeedUrls.length > 0) {
            channelPromises.push((async () => {
              kbLog("INFO", "build", `[Seed] Ingesting ${parsedSeedUrls.length} seed URLs...`);
              let ingested = 0, rejected = 0, errors = 0;
              for (const seedUrl of parsedSeedUrls) {
                try {
                  const result = await ingestUrl(seedUrl, collection_name, topic, threshold);
                  if (result.status === "ingested") ingested++;
                  else rejected++;
                } catch { errors++; }
              }
              await mmPipelineUpdate(collection_name, `[Seed] Complete: ${ingested} ingested | ${rejected} rejected | ${errors} errors (from ${parsedSeedUrls.length} URLs)`, "white_check_mark");
            })());
          }

          // Channel 1: Sonar web research (always)
          channelPromises.push((async () => {
            kbLog("INFO", "build", `[Web] Researching topic: ${topic}`);
            let plan: ResearchPlan;
            try {
              plan = await researchTopic(topic, targetCount);
            } catch (error: any) {
              await mmAlert("rag-generator", "sonar-research", error.message, { topic });
              return;
            }

            const categoryList = plan.categories.map(c => `- **${c.name}** (${c.urls.length})`).join("\n");
            kbLog("INFO", "build", `[Web] ${plan.categories.length} categories, ${plan.total_urls} URLs`);

            let ingested = 0, rejected = 0, errors = 0;
            const ingestPromises = plan.categories.flatMap((cat: any) =>
              cat.urls.map((url: string) => SEM_INGEST.run(async () => {
                try {
                  const result = await ingestUrl(url, collection_name, topic, threshold, cat.name);
                  if (result.status === "ingested") ingested++;
                  else rejected++;
                } catch { errors++; }
              }))
            );
            await Promise.allSettled(ingestPromises);
            await mmPipelineUpdate(collection_name, `[Web] Complete: ${ingested} ingested | ${rejected} rejected | ${errors} errors`, "white_check_mark");
          })());

          // Channel 2: GitHub repo mining
          if (doGithub) {
            channelPromises.push((async () => {
              kbLog("INFO", "build", `[GitHub] Mining seed repos + searching topics...`);
              let ingested = 0, rejected = 0, errors = 0;

              // Seed repos (only for design_knowledge collection)
              if (collection_name === "design_knowledge") {
                for (const seed of GITHUB_SEED_REPOS) {
                  try {
                    const files = await fetchRepoMarkdownFiles(seed.owner, seed.repo, seed.paths, seed.recurse || false);
                    kbLog("INFO", "github", `${seed.owner}/${seed.repo}: ${files.length} markdown files`);
                    const seedFilePromises = files.map((file: any) => SEM_INGEST.run(async () => {
                      try {
                        const result = await ingestContent(file.content, `${seed.owner}/${seed.repo} - ${file.path.split("/").pop()}`, file.url, collection_name, topic, threshold);
                        if (result.status === "ingested") ingested++;
                        else rejected++;
                      } catch { errors++; }
                    }));
                    await Promise.allSettled(seedFilePromises);
                  } catch (err: any) {
                    kbLog("ERROR", "github", `Error on ${seed.owner}/${seed.repo}: ${err.message}`);
                    errors++;
                  }
                }
              }

              // Generate topic-appropriate GitHub search queries
              let githubSearchQueries: string[] = [];
              if (collection_name === "design_knowledge") {
                githubSearchQueries = GITHUB_SEARCH_TOPICS;
              } else {
                try {
                  const gPrompt = `Generate 5 GitHub repository search queries for: "${topic}"
Return ONLY a JSON array. Each query should find repos with good documentation/guides.
Include star filters. Example: ["topic keywords stars:>500", ...]`;
                  const gRaw = await openrouterChat(EVAL_MODEL, [{ role: "user", content: gPrompt }], 500, 0.3);
                  githubSearchQueries = extractJson(gRaw);
                  kbLog("INFO", "github", `Generated ${githubSearchQueries.length} topic-specific search queries`);
                } catch {
                  githubSearchQueries = [`${topic} stars:>200`];
                }
              }

              // Topic search
              for (const searchQuery of githubSearchQueries) {
                try {
                  const repos = await searchGithubRepos(searchQuery, 3);
                  for (const repo of repos) {
                    try {
                      const files = await fetchRepoMarkdownFiles(repo.owner, repo.repo, [""]);
                      const topicFilePromises = files.slice(0, 10).map((file: any) => SEM_INGEST.run(async () => {
                        try {
                          const result = await ingestContent(file.content, `${repo.owner}/${repo.repo}`, file.url, collection_name, topic, threshold);
                          if (result.status === "ingested") ingested++;
                          else rejected++;
                        } catch { errors++; }
                      }));
                      await Promise.allSettled(topicFilePromises);
                    } catch { errors++; }
                  }
                } catch { errors++; }
              }

              await mmPipelineUpdate(collection_name, `[GitHub] Complete: ${ingested} ingested | ${rejected} rejected | ${errors} errors`, "white_check_mark");
            })());
          }

          // Channel 3: Academic research APIs
          if (doResearch) {
            channelPromises.push((async () => {
              kbLog("INFO", "build", `[Scholar] Searching Semantic Scholar + OpenAlex + CORE...`);

              // Generate topic-appropriate research queries using eval model
              let searchQueries: string[] = [];
              try {
                const qPrompt = `Generate 10 academic search queries for building a knowledge base on: "${topic}"
Return ONLY a JSON array of query strings. Each query should target a different subtopic or aspect.
Example: ["query 1", "query 2", ...]`;
                const qRaw = await openrouterChat(EVAL_MODEL, [{ role: "user", content: qPrompt }], 1000, 0.3);
                searchQueries = extractJson(qRaw);
                kbLog("INFO", "research", `Generated ${searchQueries.length} topic-specific research queries`);
              } catch (err: any) {
                kbLog("WARN", "research", `Failed to generate queries, using topic as fallback: ${err.message}`);
                searchQueries = [topic];
              }

              let ingested = 0, rejected = 0, errors = 0;
              const seenTitles = new Set<string>();

              for (const q of searchQueries) {
                // Semantic Scholar
                try {
                  const papers = await searchSemanticScholar(q, 10);
                  for (const paper of papers) {
                    if (!paper.abstract || paper.abstract.length < 100) continue;
                    if (seenTitles.has(paper.title.toLowerCase())) continue;
                    seenTitles.add(paper.title.toLowerCase());

                    const content = `# ${paper.title}\n\n**Year**: ${paper.year} | **Citations**: ${paper.citationCount}\n\n## Abstract\n\n${paper.abstract}${paper.tldr ? `\n\n## TL;DR\n\n${paper.tldr}` : ""}`;
                    try {
                      const result = await ingestContent(content, paper.title, paper.url || `https://api.semanticscholar.org/paper/${paper.paperId}`, collection_name, topic, threshold, "research");
                      if (result.status === "ingested") ingested++;
                      else rejected++;
                    } catch { errors++; }
                  }
                  // Rate limit respect
                  await new Promise(r => setTimeout(r, 1200));
                } catch (err: any) {
                  kbLog("WARN", "s2", `Search failed for "${q}": ${err.message}`);
                }

                // OpenAlex
                try {
                  const works = await searchOpenAlex(q, 10);
                  for (const work of works) {
                    if (!work.abstract || work.abstract.length < 100) continue;
                    if (seenTitles.has(work.title.toLowerCase())) continue;
                    seenTitles.add(work.title.toLowerCase());

                    // Try to get full text via Unpaywall if DOI available
                    let fullText = "";
                    if (work.open_access_url) {
                      try {
                        const { markdown } = await firecrawlScrape(work.open_access_url);
                        if (markdown && markdown.length > 500) fullText = markdown;
                      } catch { /* scrape failed, use abstract only */ }
                    }

                    const content = fullText || `# ${work.title}\n\n**Year**: ${work.year} | **Citations**: ${work.cited_by_count}\n\n## Abstract\n\n${work.abstract}`;
                    try {
                      const result = await ingestContent(content, work.title, work.doi || work.open_access_url || "", collection_name, topic, threshold, "research");
                      if (result.status === "ingested") ingested++;
                      else rejected++;
                    } catch { errors++; }
                  }
                } catch (err: any) {
                  kbLog("WARN", "openalex", `Search failed for "${q}": ${err.message}`);
                }
              }

              // CORE full-text (if key available)
              if (CORE_API_KEY) {
                for (const q of searchQueries.slice(0, 5)) {
                  try {
                    const works = await searchCore(q, 5);
                    for (const work of works) {
                      if (seenTitles.has(work.title.toLowerCase())) continue;
                      seenTitles.add(work.title.toLowerCase());
                      const content = work.fullText || `# ${work.title}\n\n## Abstract\n\n${work.abstract}`;
                      if (content.length < 200) continue;
                      try {
                        const result = await ingestContent(content, work.title, work.downloadUrl || "", collection_name, topic, threshold, "research");
                        if (result.status === "ingested") ingested++;
                        else rejected++;
                      } catch { errors++; }
                    }
                    await new Promise(r => setTimeout(r, 200));
                  } catch (err: any) {
                    kbLog("WARN", "core", `Search failed for "${q}": ${err.message}`);
                  }
                }
              }

              await mmPipelineUpdate(collection_name, `[Scholar] Complete: ${ingested} ingested | ${rejected} rejected | ${errors} errors\n**Papers evaluated**: ${seenTitles.size}`, "white_check_mark");
            })());
          }

          // Wait for all channels
          await Promise.allSettled(channelPromises);

          // Final validation
          let validation: any = {};
          try {
            const info = await qdrantFetch(`/collections/${collection_name}`);
            validation = { total_vectors: info.result.points_count };
          } catch (e: any) { validation = { error: e.message }; }

          await mmPipelineUpdate(collection_name, `:checkered_flag: **Build Complete**\n**Total vectors**: ${validation.total_vectors || "?"}\n**Channels**: ${channels.join(", ")}`, "tada");

        } catch (err: any) {
          kbLog("ERROR", "build", `FATAL: ${err.message}\n${err.stack}`);
          try { await mmAlert("rag-generator", "build_knowledge_base", err.message, { topic, collection_name, jobId }); } catch (e) { kbLog("ERROR", "build", `Failed to send alert: ${e}`); }
        }
      };

      if (_queue_managed) {
        await pipelineWork();
        return { status: "completed", job_id: jobId, collection_name, topic };
      }
      pipelineWork();
      return { status: "started", job_id: jobId, collection_name, topic, embedding_model: EMBEDDING_MODEL, vector_size: VECTOR_SIZE, chunk_size: CHUNK_SIZE, message: "Build running in background. Progress posted to Mattermost." };
    },
  },

  discover_from_github: {
    description: "Search GitHub repos for knowledge on any topic (markdown docs, guides, READMEs). Uses curated design seed repos only for design_knowledge collection. Auto-generates search queries for other topics. Fire and forget.",
    params: {
      collection_name: "Target Qdrant collection (REQUIRED)",
      topic: "Topic for quality evaluation (REQUIRED)",
      quality_threshold: "Minimum quality score (default 6.5)",
      extra_repos: "Optional JSON array of {owner, repo, paths[]} to add beyond seed list",
      extra_search_queries: "Optional JSON array of additional GitHub search queries",
    },
    handler: async ({ collection_name, topic, quality_threshold = 6.5, extra_repos, extra_search_queries, _queue_managed = false }) => {
      if (!collection_name || !topic) return { status: "error", error: "collection_name and topic are required" };
      const threshold = parseFloat(quality_threshold);
      const jobId = crypto.randomUUID().slice(0, 8);

      // Only use UX seed repos for design_knowledge collection
      const repos: Array<{ owner: string; repo: string; paths: string[]; recurse?: boolean }> = [];
      if (collection_name === "design_knowledge") {
        repos.push(...GITHUB_SEED_REPOS);
      }
      if (extra_repos) {
        const extras = typeof extra_repos === "string" ? JSON.parse(extra_repos) : extra_repos;
        repos.push(...extras);
      }

      // Generate topic-appropriate search queries
      let queries: string[] = [];
      if (collection_name === "design_knowledge") {
        queries = [...GITHUB_SEARCH_TOPICS];
      } else {
        try {
          const gPrompt = `Generate 5 GitHub repository search queries for: "${topic}"
Return ONLY a JSON array. Each query should find repos with good documentation/guides.
Include star filters. Example: ["topic keywords stars:>500", ...]`;
          const gRaw = await openrouterChat(EVAL_MODEL, [{ role: "user", content: gPrompt }], 500, 0.3);
          queries = extractJson(gRaw);
          kbLog("INFO", "github", `Generated ${queries.length} topic-specific search queries`);
        } catch {
          queries = [`${topic} stars:>200`];
        }
      }
      if (extra_search_queries) {
        const extras = typeof extra_search_queries === "string" ? JSON.parse(extra_search_queries) : extra_search_queries;
        queries.push(...extras);
      }

      const pipelineWork = async () => {
        try {
          await mmPipelineUpdate(collection_name, `GitHub discovery started (job: ${jobId})\n**Seed repos**: ${repos.length}\n**Search queries**: ${queries.length}`, "octocat");
          let ingested = 0, rejected = 0, errors = 0;

          for (const seed of repos) {
            try {
              const files = await fetchRepoMarkdownFiles(seed.owner, seed.repo, seed.paths, seed.recurse || false);
              const filePromises = files.map((file: any) => SEM_INGEST.run(async () => {
                try {
                  const result = await ingestContent(file.content, `${seed.owner}/${seed.repo} - ${file.path.split("/").pop()}`, file.url, collection_name, topic, threshold);
                  if (result.status === "ingested") ingested++;
                  else rejected++;
                } catch { errors++; }
              }));
              await Promise.allSettled(filePromises);
            } catch (err: any) {
              errors++;
              kbLog("ERROR", "github", `${seed.owner}/${seed.repo}: ${err.message}`);
            }
          }

          for (const q of queries) {
            try {
              const found = await searchGithubRepos(q, 3);
              for (const repo of found) {
                const files = await fetchRepoMarkdownFiles(repo.owner, repo.repo, [""]);
                const searchFilePromises = files.slice(0, 10).map((file: any) => SEM_INGEST.run(async () => {
                  try {
                    const result = await ingestContent(file.content, `${repo.owner}/${repo.repo}`, file.url, collection_name, topic, threshold);
                    if (result.status === "ingested") ingested++;
                    else rejected++;
                  } catch { errors++; }
                }));
                await Promise.allSettled(searchFilePromises);
              }
            } catch { errors++; }
          }

          await mmPipelineUpdate(collection_name, `:checkered_flag: **GitHub Discovery Complete** (job: ${jobId})\n${ingested} ingested | ${rejected} rejected | ${errors} errors`, "tada");
        } catch (err: any) {
          kbLog("ERROR", "github", `FATAL: ${err.message}`);
          try { await mmAlert("rag-generator", "discover_from_github", err.message, { jobId }); } catch (e) {}
        }
      };

      if (_queue_managed) {
        await pipelineWork();
        return { status: "completed" };
      }
      pipelineWork();
      return { status: "started", job_id: jobId, seed_repos: repos.length, search_queries: queries.length, message: "GitHub discovery running in background. Progress posted to Mattermost." };
    },
  },

  discover_from_research: {
    description: "Search academic databases (Semantic Scholar, OpenAlex, CORE) for research papers on any topic. Ingests abstracts, TLDRs, and full text where available. Auto-generates search queries from topic if not provided. Fire and forget.",
    params: {
      collection_name: "Target Qdrant collection (REQUIRED)",
      topic: "Topic for quality evaluation (REQUIRED)",
      quality_threshold: "Minimum quality score (default 6.5)",
      search_queries: "Optional JSON array of custom search queries (default: auto-generated from topic via LLM)",
      papers_per_query: "Max papers per query per source (default 10)",
    },
    handler: async ({ collection_name, topic, quality_threshold = 6.5, search_queries, papers_per_query = 10, _queue_managed = false }) => {
      if (!collection_name || !topic) return { status: "error", error: "collection_name and topic are required" };
      const threshold = parseFloat(quality_threshold);
      const perQuery = parseInt(papers_per_query);
      const jobId = crypto.randomUUID().slice(0, 8);

      let queries: string[];
      if (search_queries) {
        queries = typeof search_queries === "string" ? JSON.parse(search_queries) : search_queries;
      } else {
        // Generate topic-appropriate research queries via LLM
        try {
          const qPrompt = `Generate 15 academic search queries for building a knowledge base on: "${topic}"
Return ONLY a JSON array of query strings. Each query should target a different subtopic or aspect.
Use specific technical terminology. Example: ["query 1", "query 2", ...]`;
          const qRaw = await openrouterChat(EVAL_MODEL, [{ role: "user", content: qPrompt }], 1000, 0.3);
          queries = extractJson(qRaw);
          kbLog("INFO", "research", `Generated ${queries.length} topic-specific research queries for "${topic}"`);
        } catch (err: any) {
          kbLog("WARN", "research", `Failed to generate queries, using topic as fallback: ${err.message}`);
          queries = [topic, `${topic} survey`, `${topic} best practices`, `${topic} evaluation`, `${topic} techniques`];
        }
      }

      const pipelineWork = async () => {
        try {
          const sources = ["Semantic Scholar", "OpenAlex"];
          if (CORE_API_KEY) sources.push("CORE");
          await mmPipelineUpdate(collection_name, `Academic research discovery started (job: ${jobId})\n**Sources**: ${sources.join(", ")}\n**Queries**: ${queries.length}\n**Per query**: ${perQuery}`, "books");

          let ingested = 0, rejected = 0, errors = 0;
          const seenTitles = new Set<string>();

          for (const q of queries) {
            kbLog("INFO", "research", `Query ${queries.indexOf(q) + 1}/${queries.length}: "${q}"`);
            // Semantic Scholar
            try {
              const papers = await searchSemanticScholar(q, perQuery);
              kbLog("INFO", "s2", `"${q}": ${papers.length} papers returned`);
              for (const paper of papers) {
                if (!paper.abstract || paper.abstract.length < 100) continue;
                if (seenTitles.has(paper.title.toLowerCase())) continue;
                seenTitles.add(paper.title.toLowerCase());
                const content = `# ${paper.title}\n\n**Year**: ${paper.year} | **Citations**: ${paper.citationCount}\n\n## Abstract\n\n${paper.abstract}${paper.tldr ? `\n\n## TL;DR\n\n${paper.tldr}` : ""}`;
                try {
                  const result = await ingestContent(content, paper.title, paper.url || "", collection_name, topic, threshold, "research");
                  if (result.status === "ingested") ingested++;
                  else rejected++;
                } catch { errors++; }
              }
              await new Promise(r => setTimeout(r, 1200));
            } catch (err: any) {
              kbLog("WARN", "s2", `"${q}": ${err.message}`);
            }

            // OpenAlex
            try {
              const works = await searchOpenAlex(q, perQuery);
              kbLog("INFO", "openalex", `"${q}": ${works.length} works returned`);
              for (const work of works) {
                if (!work.abstract || work.abstract.length < 100) continue;
                if (seenTitles.has(work.title.toLowerCase())) continue;
                seenTitles.add(work.title.toLowerCase());
                const content = `# ${work.title}\n\n**Year**: ${work.year} | **Citations**: ${work.cited_by_count}\n\n## Abstract\n\n${work.abstract}`;
                try {
                  const result = await ingestContent(content, work.title, work.doi || "", collection_name, topic, threshold, "research");
                  if (result.status === "ingested") ingested++;
                  else rejected++;
                } catch { errors++; }
              }
            } catch (err: any) {
              kbLog("WARN", "openalex", `"${q}": ${err.message}`);
            }

            // CORE
            if (CORE_API_KEY) {
              try {
                const works = await searchCore(q, 5);
                kbLog("INFO", "core", `"${q}": ${works.length} works returned`);
                for (const work of works) {
                  if (seenTitles.has(work.title.toLowerCase())) continue;
                  seenTitles.add(work.title.toLowerCase());
                  const content = work.fullText || `# ${work.title}\n\n## Abstract\n\n${work.abstract}`;
                  if (content.length < 200) continue;
                  try {
                    const result = await ingestContent(content, work.title, work.downloadUrl || "", collection_name, topic, threshold, "research");
                    if (result.status === "ingested") ingested++;
                    else rejected++;
                  } catch { errors++; }
                }
                await new Promise(r => setTimeout(r, 200));
              } catch (err: any) {
                kbLog("WARN", "core", `"${q}": ${err.message}`);
              }
            }
          }

          await mmPipelineUpdate(collection_name, `:checkered_flag: **Research Discovery Complete** (job: ${jobId})\n**Papers evaluated**: ${seenTitles.size}\n${ingested} ingested | ${rejected} rejected | ${errors} errors`, "tada");
        } catch (err: any) {
          kbLog("ERROR", "research", `FATAL: ${err.message}`);
          try { await mmAlert("rag-generator", "discover_from_research", err.message, { jobId }); } catch (e) {}
        }
      };

      if (_queue_managed) {
        await pipelineWork();
        return { status: "completed" };
      }
      pipelineWork();
      return { status: "started", job_id: jobId, queries: queries.length, message: "Research discovery running in background. Progress posted to Mattermost." };
    },
  },

  discover_from_wikipedia: {
    description: "Mine Wikipedia articles for high-quality reference URLs, then ingest the good ones. Fire and forget.",
    params: {
      wikipedia_urls: "JSON array of Wikipedia article URLs to mine for references",
      collection_name: "Target Qdrant collection",
      topic: "Topic for quality evaluation",
      quality_threshold: "Minimum quality score (default 6.5)",
      ingest_unknown_domains: "Also try unknown-domain URLs (default false)"
    },
    handler: async ({ wikipedia_urls, collection_name, topic, quality_threshold = 6.5, ingest_unknown_domains = "false", _queue_managed = false }) => {
      const wikiUrls: string[] = typeof wikipedia_urls === "string" ? JSON.parse(wikipedia_urls) : wikipedia_urls;
      const threshold = parseFloat(quality_threshold);
      const tryUnknown = ingest_unknown_domains === "true" || ingest_unknown_domains === true;
      const jobId = crypto.randomUUID().slice(0, 8);

      const pipelineWork = async () => {
        try {
          await mmPipelineUpdate(collection_name, `Wikipedia reference mining started (job: ${jobId})\nMining ${wikiUrls.length} Wikipedia articles...`, "mag");
          const allGoodUrls: string[] = [];
          const allUnknownUrls: string[] = [];

          for (const wikiUrl of wikiUrls) {
            try {
              const { markdown } = await firecrawlScrape(wikiUrl);
              const refs = extractWikipediaRefs(markdown);
              const { good, unknown } = filterByDomain(refs);
              allGoodUrls.push(...good);
              if (tryUnknown) allUnknownUrls.push(...unknown);
              // (tally handles notification)
            } catch (err: any) {
              kbLog("ERROR", "wiki", `${wikiUrl}: ${err.message}`);
            }
          }

          const uniqueGood = [...new Set(allGoodUrls)];
          const uniqueUnknown = [...new Set(allUnknownUrls)];
          const urlsToIngest = [...uniqueGood, ...uniqueUnknown];

          await mmPipelineUpdate(collection_name, `Mining complete: ${uniqueGood.length} good + ${uniqueUnknown.length} unknown = ${urlsToIngest.length} to ingest`, "clipboard");

          let ingested = 0, rejected = 0, errors = 0;
          const wikiIngestPromises = urlsToIngest.map((url: string) => SEM_INGEST.run(async () => {
            try {
              const result = await ingestUrl(url, collection_name, topic, threshold);
              if (result.status === "ingested") ingested++;
              else rejected++;
            } catch { errors++; }
          }));
          await Promise.allSettled(wikiIngestPromises);

          await mmPipelineUpdate(collection_name, `:checkered_flag: **Wikipedia Mining Complete** (job: ${jobId})\n**Articles**: ${wikiUrls.length} | **URLs tried**: ${urlsToIngest.length}\n${ingested} ingested | ${rejected} rejected | ${errors} errors`, "tada");
        } catch (err: any) {
          kbLog("ERROR", "wiki", `FATAL: ${err.message}`);
          try { await mmAlert("rag-generator", "discover_from_wikipedia", err.message, { jobId }); } catch (e) {}
        }
      };

      if (_queue_managed) {
        await pipelineWork();
        return { status: "completed" };
      }
      pipelineWork();
      return { status: "started", job_id: jobId, wikipedia_articles: wikiUrls.length, message: "Wikipedia mining running in background." };
    },
  },

  smart_ingest: {
    description: "Scrape a single URL via Firecrawl, evaluate quality + auto-tag with AI, embed with nomic-embed-text-v1.5, ingest to Qdrant if high quality.",
    params: {
      url: "URL to scrape",
      collection_name: "Target Qdrant collection",
      topic: "Topic for quality evaluation",
      quality_threshold: "Minimum quality score (0-10, default 6.5)",
      category: "Optional category hint"
    },
    handler: async ({ url, collection_name, topic, quality_threshold = 6.5, category }) => {
      try {
        return await ingestUrl(url, collection_name, topic, parseFloat(quality_threshold), category);
      } catch (error: any) {
        await mmAlert("rag-generator", "smart_ingest", error.message, { url });
        return { status: "error", url, error: error.message };
      }
    },
  },

  batch_smart_ingest: {
    description: "Scrape and ingest multiple URLs. Fire and forget.",
    params: {
      urls: "JSON array of URLs",
      collection_name: "Target Qdrant collection",
      topic: "Topic for quality evaluation",
      quality_threshold: "Minimum quality score (default 6.5)",
      category: "Optional category for all URLs"
    },
    handler: async ({ urls, collection_name, topic, quality_threshold = 6.5, category, _queue_managed = false }) => {
      const urlArray: string[] = typeof urls === "string" ? JSON.parse(urls) : urls;
      const jobId = crypto.randomUUID().slice(0, 8);

      const pipelineWork = async () => {
        try {
          await mmPipelineUpdate(collection_name, `Batch ingestion started (job: ${jobId}): ${urlArray.length} URLs`, "rocket");
          let ingested = 0, rejected = 0, errors = 0;
          const batchIngestPromises = urlArray.map((url: string) => SEM_INGEST.run(async () => {
            try {
              const r = await ingestUrl(url, collection_name, topic, parseFloat(quality_threshold), category);
              if (r.status === "ingested") ingested++;
              else rejected++;
            } catch { errors++; }
          }));
          await Promise.allSettled(batchIngestPromises);
          await mmPipelineUpdate(collection_name, `:checkered_flag: Batch complete (job: ${jobId})\n${ingested} ingested | ${rejected} rejected | ${errors} errors`, "bar_chart");
        } catch (err: any) {
          kbLog("ERROR", "batch", `FATAL: ${err.message}`);
          try { await mmAlert("rag-generator", "batch_smart_ingest", err.message, { jobId }); } catch (e) {}
        }
      };

      if (_queue_managed) {
        await pipelineWork();
        return { status: "completed" };
      }
      pipelineWork();
      return { status: "started", job_id: jobId, urls_queued: urlArray.length, message: "Batch running in background." };
    },
  },

  create_collection: {
    description: "Create a new Qdrant collection (supports hybrid with dense + sparse vectors)",
    params: { collection_name: "Name", vector_size: "Size (default from embedding model)", distance: "Cosine/Euclid/Dot", hybrid: "Enable hybrid search with sparse vectors (default false)" },
    handler: async ({ collection_name, vector_size, distance = "Cosine", hybrid = "false" }) => {
      const size = vector_size ? parseInt(vector_size) : VECTOR_SIZE;
      const isHybrid = hybrid === "true" || hybrid === true;
      try {
        await qdrantFetch(`/collections/${collection_name}`);
        return { status: "exists", collection_name };
      } catch {
        if (isHybrid) {
          await createHybridCollection(collection_name, size);
        } else {
          await qdrantFetch(`/collections/${collection_name}`, {
            method: "PUT",
            body: JSON.stringify({ vectors: { size, distance } }),
          });
        }
        // Initialize collection stats
        await pgQuery(
          `INSERT INTO rag_collection_stats (collection, lifecycle_state) VALUES ($1, 'bootstrapping') ON CONFLICT DO NOTHING`,
          [collection_name]
        ).catch(() => {});
        return { status: "created", collection_name, vector_size: size, distance, hybrid: isHybrid };
      }
    },
  },

  query_knowledge: {
    description: "Advanced RAG query: multi-query rewriting (original + technical + HyDE), AI reranking, MMR diversity. Fetches from 3 parallel search paths, deduplicates, reranks, then applies MMR for balanced results.",
    params: {
      collection_name: "Collection to query",
      query: "Search query",
      limit: "Max results (default 5)",
      filter: "Optional JSON filter",
      rerank: "Enable AI reranking (default true)",
      multi_query: "Enable 3-query strategy: original + technical rewrite + HyDE (default true)",
      mmr: "Enable MMR diversity filtering (default true)",
      mmr_lambda: "MMR lambda: 1.0=pure relevance, 0.0=pure diversity (default 0.7)",
      auto_route: "Auto-route query across collections when no collection specified (default false)",
    },
    handler: async ({ collection_name, query, limit = 5, filter, rerank = "true", multi_query = "true", mmr = "true", mmr_lambda = "0.7" }) => {
      const finalLimit = parseInt(limit);
      const doRerank = rerank === "true" || rerank === true;
      const doMultiQuery = multi_query === "true" || multi_query === true;
      const doMMR = mmr === "true" || mmr === true;
      const lambda = parseFloat(mmr_lambda) || 0.7;
      const fetchLimit = doRerank ? Math.max(20, finalLimit * 4) : finalLimit;

      // Build filter object if provided
      let filterObj: any = undefined;
      if (filter) {
        const parsed = typeof filter === "string" ? JSON.parse(filter) : filter;
        filterObj = { must: Object.entries(parsed).map(([key, value]) => ({ key, match: { value } })) };
      }

      let candidates: Array<{ id?: string; score: number; text: string; metadata: any }>;

      if (doMultiQuery) {
        // ── 3-query strategy: original + technical rewrite + HyDE ──
        const [technicalRewrite, hydeAnswer] = await Promise.all([
          rewriteQueryTechnical(query),
          generateHyDE(query),
        ]);
        const queries = [query, technicalRewrite, hydeAnswer].filter((q, i, arr) =>
          arr.indexOf(q) === i // deduplicate if rewrite/HyDE fell back to original
        );
        kbLog("INFO", "query", `Multi-query: ${queries.length} variants for "${query.slice(0, 60)}"`);

        candidates = await multiQuerySearch(collection_name, queries, fetchLimit, filterObj);
      } else {
        // Single-query path (backward compat) — supports hybrid collections
        const embedding = await getEmbeddingWithModel(query, EMBEDDING_MODEL);
        const isHybrid = await isHybridCollection(collection_name);
        let body: any;
        if (isHybrid) {
          // Use named vector for hybrid collections
          body = { vector: { name: "dense", vector: embedding }, limit: fetchLimit, with_payload: true, score_threshold: 0.3 };
        } else {
          body = { vector: embedding, limit: fetchLimit, with_payload: true, score_threshold: 0.3 };
        }
        if (filterObj) body.filter = filterObj;
        const result = await qdrantFetch(`/collections/${collection_name}/points/search`, { method: "POST", body: JSON.stringify(body) });
        candidates = (result.result || []).map((r: any) => ({
          id: r.id,
          score: r.score,
          text: r.payload?.text || "",
          metadata: {
            url: r.payload?.url, title: r.payload?.title, doc_type: r.payload?.doc_type,
            style_category: r.payload?.style_category, key_topics: r.payload?.key_topics,
            ai_quality_score: r.payload?.ai_quality_score, semantic_bucket: r.payload?.semantic_bucket,
          }
        }));
      }

      // ── AI Reranking ──
      let reranked: Array<{ score: number; rerank_score: number; text: string; metadata: any }>;
      if (doRerank && candidates.length > finalLimit) {
        reranked = await rerankResults(query, candidates, Math.min(candidates.length, finalLimit * 3));
      } else {
        reranked = candidates.slice(0, finalLimit * 3).map((c: any) => ({ ...c, rerank_score: c.score }));
      }

      // ── MMR diversity filtering ──
      let finalResults: Array<{ score: number; rerank_score: number; mmr_score?: number; text: string; metadata: any }>;
      if (doMMR && reranked.length > finalLimit) {
        const queryEmbedding = await getEmbeddingWithModel(query, EMBEDDING_MODEL);
        finalResults = await applyMMR(queryEmbedding, reranked, finalLimit, lambda);
      } else {
        finalResults = reranked.slice(0, finalLimit).map(r => ({ ...r, mmr_score: r.rerank_score }));
      }

      // Log query for drift detection
      const topScore = finalResults.length > 0 ? finalResults[0].score : 0;
      logQuery(collection_name, query, topScore, finalResults.length).catch(() => {});

      return {
        query, collection: collection_name,
        strategy: { reranked: doRerank, multi_query: doMultiQuery, mmr: doMMR, mmr_lambda: lambda },
        results: finalResults.map((r: any) => ({
          score: r.score,
          rerank_score: r.rerank_score,
          mmr_score: r.mmr_score,
          text: r.text.substring(0, 500),
          metadata: r.metadata
        }))
      };
    },
  },

  validate_collection: {
    description: "Get statistics, coverage analysis, and quality metrics",
    params: { collection_name: "Collection to validate" },
    handler: async ({ collection_name }) => {
      try {
        const info = await qdrantFetch(`/collections/${collection_name}`);
        // Stream-process in batches to avoid loading all points into memory
        const sources: Record<string, number> = {};
        const types: Record<string, number> = {};
        const cats: Record<string, number> = {};
        let qSum = 0, qCount = 0;
        let offset: string | null = null;
        do {
          const body: any = { limit: 100, with_payload: true };
          if (offset) body.offset = offset;
          const batch = await qdrantFetch(`/collections/${collection_name}/points/scroll`, {
            method: "POST", body: JSON.stringify(body),
          });
          for (const pt of batch.result.points) {
            const src = pt.payload.url || "unknown";
            sources[src] = (sources[src] || 0) + 1;
            if (pt.payload.doc_type) types[pt.payload.doc_type] = (types[pt.payload.doc_type] || 0) + 1;
            if (pt.payload.style_category) cats[pt.payload.style_category] = (cats[pt.payload.style_category] || 0) + 1;
            if (pt.payload.ai_quality_score) { qSum += pt.payload.ai_quality_score; qCount++; }
          }
          offset = batch.result.next_page_offset || null;
        } while (offset);

        return {
          collection: collection_name, total_vectors: info.result.points_count,
          status: info.result.status, indexed: info.result.status === "green",
          embedding_model: EMBEDDING_MODEL, vector_size: VECTOR_SIZE,
          avg_quality: qCount > 0 ? (qSum / qCount).toFixed(2) : null,
          unique_sources: Object.keys(sources).length,
          doc_types: types, style_categories: cats,
          top_sources: Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 20),
        };
      } catch (error: any) {
        return { collection: collection_name, error: error.message, exists: false };
      }
    },
  },

  queue_job: {
    description: "Add a knowledge builder job to the persistent queue. Jobs execute in priority order with concurrency limits.",
    params: {
      job_type: "Tool name to execute: build_knowledge_base, discover_from_research, discover_from_github, discover_from_wikipedia, batch_smart_ingest, balance_knowledge_base",
      collection_name: "Target Qdrant collection (REQUIRED)",
      topic: "Research topic",
      params: "JSON object of additional parameters for the tool",
      priority: "1-10, lower = higher priority (default: 5). User-triggered: 3, automated: 7, balance: 5",
      triggered_by: "Who triggered: manual, automation, curator, balance (default: manual)",
    },
    handler: async ({ job_type, collection_name, topic, params: extraParams, priority = 5, triggered_by = "manual" }) => {
      if (!job_type || !collection_name || !topic) return { status: "error", error: "job_type, collection_name, and topic are required" };
      const parsedParams = extraParams ? (typeof extraParams === "string" ? JSON.parse(extraParams) : extraParams) : {};
      const result = await enqueueJob(job_type, collection_name, topic, parsedParams, parseInt(priority), triggered_by);
      return { status: "queued", ...result, job_type, collection_name, priority: parseInt(priority) };
    },
  },

  list_queue: {
    description: "List jobs in the knowledge builder queue. Shows pending, running, and recent completed/failed jobs.",
    params: {
      status: "Filter by status: pending, running, completed, failed, all (default: all)",
      limit: "Max jobs to return (default: 20)",
      collection_name: "Filter by collection (optional)",
    },
    handler: async ({ status = "all", limit = 20, collection_name }) => {
      let sql = "SELECT id, job_type, collection_name, topic, priority, status, triggered_by, created_at, started_at, completed_at, error, estimated_cost_usd FROM kb_job_queue";
      const conditions: string[] = [];
      const params: any[] = [];
      if (status !== "all") { conditions.push(`status = $${params.length + 1}`); params.push(status); }
      if (collection_name) { conditions.push(`collection_name = $${params.length + 1}`); params.push(collection_name); }
      if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
      sql += " ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, priority ASC, created_at DESC";
      sql += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(limit));
      const result = await pgQuery(sql, params);
      const summary = await pgQuery("SELECT status, COUNT(*) as count FROM kb_job_queue GROUP BY status");
      return {
        jobs: result.rows.map((r: any) => ({ ...r, id: r.id.slice(0, 8) + "..." })),
        summary: Object.fromEntries(summary.rows.map((r: any) => [r.status, parseInt(r.count)])),
        worker: { running: _queueRunning, max_concurrent: QUEUE_MAX_CONCURRENT },
      };
    },
  },

  cancel_job: {
    description: "Cancel a pending job in the queue.",
    params: { job_id: "Job UUID (or prefix)" },
    handler: async ({ job_id }) => {
      const result = await pgQuery(
        "UPDATE kb_job_queue SET status = 'cancelled', completed_at = NOW() WHERE id::text LIKE $1 AND status = 'pending' RETURNING id",
        [job_id + "%"]
      );
      if (result.rows.length === 0) return { error: "No pending job found matching that ID" };
      return { status: "cancelled", id: result.rows[0].id };
    },
  },

  queue_stats: {
    description: "Queue statistics: job counts, cost tracking, API usage across all jobs.",
    params: { days: "Look back N days (default: 7)" },
    handler: async ({ days = 7 }) => {
      const d = parseInt(days);
      const stats = await pgQuery(`
        SELECT
          status,
          COUNT(*) as count,
          SUM(estimated_cost_usd) as total_cost,
          AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_sec
        FROM kb_job_queue
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY status
      `, [d]);

      const byType = await pgQuery(`
        SELECT job_type, COUNT(*) as count, SUM(estimated_cost_usd) as cost
        FROM kb_job_queue
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY job_type ORDER BY count DESC
      `, [d]);

      const byCollection = await pgQuery(`
        SELECT collection_name, COUNT(*) as count, SUM(estimated_cost_usd) as cost
        FROM kb_job_queue
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY collection_name ORDER BY count DESC
      `, [d]);

      return {
        period_days: d,
        by_status: stats.rows,
        by_type: byType.rows,
        by_collection: byCollection.rows,
        worker: { running: _queueRunning, max_concurrent: QUEUE_MAX_CONCURRENT, poll_interval_ms: QUEUE_POLL_INTERVAL },
      };
    },
  },


  curate_collection: {
    description: "RAG curator agent. Analyzes a collection for gaps, generates targeted discovery queries, and dispatches to selected channels. Runs build_knowledge_base first if collection is empty. Uses a reasoning model for lateral thinking. Supports selective channels: web, github, research, or all.",
    params: {
      collection_name: "Target Qdrant collection name",
      topic: "Domain description for the collection",
      channels: "Comma-separated channels: web,github,research,all (default: all)",
      max_iterations: "Max curator passes (default: 2)",
      quality_threshold: "Minimum quality score (default: 6.5)",
      reference_collection: "Optional collection for meta-guidance (e.g. rag_best_practices)",
    },
    handler: async ({ collection_name, topic, channels = "all", max_iterations = 2, quality_threshold = 6.5, reference_collection, _queue_managed = false }: any) => {
      const maxIter = Math.min(parseInt(max_iterations) || 2, 5);
      const threshold = parseFloat(quality_threshold);
      const channelList = (channels as string).split(",").map((c: string) => c.trim());
      const doWeb = channelList.includes("web") || channelList.includes("all");
      const doGithub = channelList.includes("github") || channelList.includes("all");
      const doResearch = channelList.includes("research") || channelList.includes("all");
      const jobId = crypto.randomUUID().slice(0, 8);
      const CURATOR_MODEL = process.env.KB_CURATOR_MODEL || "anthropic/claude-sonnet-4.5";

      const pipelineWork = async () => {
        try {
          const tally = createTally(collection_name, topic, maxIter);
          await tallyUpdate(tally, "Starting...");
          kbLog("INFO", "curator", `Starting curation of "${collection_name}" (job: ${jobId})`);
          await mmPipelineUpdate(collection_name, `Curator started for **${collection_name}** (job: ${jobId}) — ${maxIter} passes max`, "brain");

          // Ensure collection exists (hybrid for dense + sparse)
          try {
            await qdrantFetch(`/collections/${collection_name}`);
          } catch {
            await createHybridCollection(collection_name, VECTOR_SIZE);
            kbLog("INFO", "curator", `Created hybrid collection: ${collection_name}`);
          }

          // Check if collection is empty — run initial build first
          let initialStats: any = {};
          try { initialStats = await tools.validate_collection.handler({ collection_name }); } catch {}
          if (!initialStats.total_vectors || initialStats.total_vectors === 0) {
            kbLog("INFO", "curator", `Collection is empty — running initial build_knowledge_base pass first`);
            await mmPipelineUpdate(collection_name, `Collection empty — running initial discovery pass before curation...`, "rocket");
            await tools.build_knowledge_base.handler({
              topic,
              collection_name,
              target_sources: 80,
              quality_threshold: threshold,
              include_github: doGithub ? "true" : "false",
              include_research: doResearch ? "true" : "false",
              _queue_managed: true,
            });
            kbLog("INFO", "curator", `Initial build pass complete — starting curation analysis`);
          }

          const previousPasses: any[] = [];

          for (let pass = 1; pass <= maxIter; pass++) {
            kbLog("INFO", "curator", `Pass ${pass}/${maxIter} starting...`);
            resetPassCost();
            tally.pass = pass;
            await tallyUpdate(tally, "Analyzing...");

            // Get current stats
            let stats: any = { total_vectors: 0, unique_sources: 0, avg_quality: "0", style_categories: {}, doc_types: {}, top_sources: [] };
            try {
              stats = await tools.validate_collection.handler({ collection_name });
            } catch { /* empty collection */ }

            // Build reference context
            let refContext = "";
            if (reference_collection) {
              try {
                const refs = await tools.query_knowledge.handler({
                  collection_name: reference_collection,
                  query: "how to build balanced high quality RAG collection coverage gaps chunking strategies",
                  top_k: 5,
                });
                if (refs.results) {
                  refContext = "\n\nREFERENCE — RAG BEST PRACTICES:\n" + refs.results.map((r: any) => r.text).join("\n---\n");
                }
              } catch { /* ref collection may not exist */ }
            }

            // Build analysis prompt
            const catEntries = Object.entries(stats.style_categories || {});
            const catDist = catEntries
              .map(([k, v]: [string, any]) => `  ${k}: ${v} vectors (${stats.total_vectors > 0 ? ((v / stats.total_vectors) * 100).toFixed(1) : 0}%)`)
              .join("\n");
            const docEntries = Object.entries(stats.doc_types || {});
            const docDist = docEntries
              .map(([k, v]: [string, any]) => `  ${k}: ${v} vectors`)
              .join("\n");
            const topSrcLines = (stats.top_sources || []).slice(0, 10)
              .map((s: any) => `  ${s[0]}: ${s[1]} chunks`)
              .join("\n");

            const statsBlock = stats.total_vectors > 0
              ? `\nCURRENT STATS:\n- Total vectors: ${stats.total_vectors}\n- Unique sources: ${stats.unique_sources}\n- Average quality: ${stats.avg_quality}/10\n\nCATEGORY DISTRIBUTION:\n${catDist || "  (none)"}\n\nDOC TYPE DISTRIBUTION:\n${docDist || "  (none)"}\n\nTOP SOURCES:\n${topSrcLines || "  (none)"}\n`
              : "EMPTY COLLECTION — this is a bootstrap run. Generate a comprehensive initial plan.";

            const prevBlock = previousPasses.length > 0
              ? "\nPREVIOUS CURATOR PASSES:\n" + previousPasses.map((p: any, i: number) => `Pass ${i + 1}: Score ${p.readiness_score}/10 — ${(p.assessment || "").slice(0, 200)}`).join("\n")
              : "";

            const analysisPrompt = `You are an expert RAG collection curator. Analyze this knowledge base and create a targeted discovery plan.

COLLECTION: "${collection_name}"
TOPIC DOMAIN: "${topic}"
${statsBlock}${prevBlock}${refContext}

CHANNELS AVAILABLE: ${channelList.join(", ")}

INSTRUCTIONS:
1. Assess the collection's readiness (1-10 scale). Consider both depth AND breadth.
2. Identify GAPS — what important categories/subtopics are missing or thin?
3. Think LATERALLY — what adjacent fields would enrich this collection? (e.g., for UI/UX: color theory, cognitive psychology, Gestalt principles. For security: game theory, social engineering, cryptography history.)
4. Think META — include self-referential knowledge where applicable. If this collection is about a process (like RAG itself, or design, or engineering), it should contain knowledge about how to scope, size, evaluate, and optimize ITSELF. For example, a RAG about RAG best practices must include:
   - How to determine optimal collection size for a given domain
   - When and how to include cross-domain subtopics
   - Collection completeness metrics and coverage heuristics
   - Diminishing returns analysis and cost/quality tradeoffs
   - Embedding model selection and evaluation criteria
   - Retrieval quality benchmarking methodologies
5. Think about EFFICIENCY — maximize unique, high-value vectors per query:
   - Prefer queries targeting specific techniques, frameworks, or research over broad overviews
   - Avoid re-discovering content already well-represented (check category distribution)
   - Target underrepresented categories and doc types for balance
   - For research queries, prefer specific paper titles or author names when available
6. Generate targeted search queries for EACH available channel:
   - web_queries: 10-20 queries for web research (finds article URLs via Sonar Pro)
   - github_queries: 5-10 GitHub repo search queries (format: "topic keywords stars:>N")
   - github_repos: specific repos to mine [{owner, repo, paths, recurse}]
   - research_queries: 10-20 academic search queries for Semantic Scholar/OpenAlex/CORE
7. Only include queries for channels that are available.
8. Suggest 8-16 category labels appropriate for this topic domain.
9. Decide if another pass is needed. Be aggressive — if the collection is below 10,000 vectors, another pass is almost always warranted. Target 25,000+ for foundational/meta collections.

Respond ONLY with valid JSON:
{
  "assessment": "<narrative assessment>",
  "readiness_score": <1-10>,
  "gaps": [{"category": "<name>", "severity": "<critical|moderate|minor>", "description": "<why>", "target_vectors": <N>}],
  "lateral_suggestions": [{"topic": "<name>", "rationale": "<why>", "channel": "<web|github|research>"}],
  "discovery_plan": {
    "web_queries": ["<query>", ...],
    "github_queries": ["<query>", ...],
    "github_repos": [{"owner": "<owner>", "repo": "<repo>", "paths": ["<path>"], "recurse": <bool>}],
    "research_queries": ["<query>", ...]
  },
  "suggested_categories": ["<cat1>", "<cat2>", ...],
  "another_pass_recommended": <true|false>,
  "pass_focus": "<what next pass should focus on>"
}`;

            kbLog("INFO", "curator", `Calling ${CURATOR_MODEL} for analysis...`);
            let plan: any;
            try {
              const raw = await openrouterChat(CURATOR_MODEL, [{ role: "user", content: analysisPrompt }], 4000, 0.5, 120000);
              plan = extractJson(raw);
              kbLog("INFO", "curator", `Analysis: score ${plan.readiness_score}/10, ${plan.gaps?.length || 0} gaps, web:${plan.discovery_plan?.web_queries?.length || 0} gh:${plan.discovery_plan?.github_queries?.length || 0} rs:${plan.discovery_plan?.research_queries?.length || 0}`);
            } catch (err: any) {
              kbLog("ERROR", "curator", `Analysis failed: ${err.message}`);
              await mmAlert("rag-generator", "curator", `Analysis failed: ${err.message}`, { collection_name, pass });
              break;
            }

            previousPasses.push(plan);

            // Post analysis to Mattermost
            const gapSummary = (plan.gaps || []).map((g: any) => `- **${g.category}** (${g.severity}): ${g.description}`).join("\n");
            const lateralSummary = (plan.lateral_suggestions || []).map((l: any) => `- **${l.topic}**: ${l.rationale}`).join("\n");
            await tallyUpdate(tally, `Pass ${pass} — score ${plan.readiness_score}/10, ${plan.gaps?.length || 0} gaps. Discovering...`);

            // Execute discovery plan
            const channelPromises: Promise<void>[] = [];

            // Web channel
            if (doWeb && plan.discovery_plan?.web_queries?.length > 0) {
              channelPromises.push((async () => {
                kbLog("INFO", "curator", `Web channel: ${plan.discovery_plan.web_queries.length} queries`);
                let webIngested = 0, webRejected = 0;
                for (const query of plan.discovery_plan.web_queries) {
                  try {
                    const searchPrompt = `Find 5-8 high-quality, publicly accessible web articles about: "${query}"\nContext: Building a "${topic}" knowledge base.\nReturn ONLY a JSON array of URLs: ["https://...", ...]\nRequirements: specific pages only (not homepages), no paywalls, authoritative sources.`;
                    const raw = await openrouterChat(RESEARCH_MODEL, [{ role: "user", content: searchPrompt }], 2000, 0.3, 60000);
                    let urls: string[];
                    try { urls = extractJson(raw); } catch { continue; }
                    kbLog("INFO", "curator", `Web "${query}": ${urls.length} URLs`);
                    const webUrlPromises = urls.map((url: string) => SEM_INGEST.run(async () => {
                      try {
                        const result = await ingestUrl(url, collection_name, topic, threshold);
                        if (result.status === "ingested") webIngested++;
                        else webRejected++;
                      } catch { webRejected++; }
                    }));
                    await Promise.allSettled(webUrlPromises);
                  } catch (err: any) {
                    kbLog("WARN", "curator", `Web query failed "${query}": ${err.message}`);
                  }
                }
                kbLog("INFO", "curator", `Web channel done: ${webIngested} ingested, ${webRejected} rejected`);
                tally.channels.web.ingested += webIngested;
                tally.channels.web.rejected += webRejected;
                await tallyUpdate(tally);
              })());
            }

            // GitHub channel
            if (doGithub && (plan.discovery_plan?.github_repos?.length > 0 || plan.discovery_plan?.github_queries?.length > 0)) {
              channelPromises.push((async () => {
                let ghIngested = 0, ghRejected = 0, ghErrors = 0;

                // Mine specific repos
                for (const repo of (plan.discovery_plan?.github_repos || [])) {
                  try {
                    const files = await fetchRepoMarkdownFiles(repo.owner, repo.repo, repo.paths || [""], repo.recurse || false);
                    kbLog("INFO", "curator", `GitHub ${repo.owner}/${repo.repo}: ${files.length} files`);
                    const curateFilePromises = files.map((file: any) => SEM_INGEST.run(async () => {
                      try {
                        const result = await ingestContent(file.content, `${repo.owner}/${repo.repo} - ${file.path.split("/").pop()}`, file.url, collection_name, topic, threshold);
                        if (result.status === "ingested") ghIngested++;
                        else ghRejected++;
                      } catch { ghErrors++; }
                    }));
                    await Promise.allSettled(curateFilePromises);
                  } catch (err: any) {
                    kbLog("WARN", "curator", `GitHub repo error ${repo.owner}/${repo.repo}: ${err.message}`);
                    ghErrors++;
                  }
                }

                // Search queries
                for (const query of (plan.discovery_plan?.github_queries || [])) {
                  try {
                    const repos = await searchGithubRepos(query, 3);
                    for (const repo of repos) {
                      try {
                        const files = await fetchRepoMarkdownFiles(repo.owner, repo.repo, [""]);
                        const curateSearchPromises = files.slice(0, 10).map((file: any) => SEM_INGEST.run(async () => {
                          try {
                            const result = await ingestContent(file.content, `${repo.owner}/${repo.repo}`, file.url, collection_name, topic, threshold);
                            if (result.status === "ingested") ghIngested++;
                            else ghRejected++;
                          } catch { ghErrors++; }
                        }));
                        await Promise.allSettled(curateSearchPromises);
                      } catch { ghErrors++; }
                    }
                  } catch { ghErrors++; }
                }

                kbLog("INFO", "curator", `GitHub channel done: ${ghIngested} ingested, ${ghRejected} rejected, ${ghErrors} errors`);
                tally.channels.github.ingested += ghIngested;
                tally.channels.github.rejected += ghRejected;
                tally.channels.github.errors += ghErrors;
                await tallyUpdate(tally);
              })());
            }

            // Research channel
            if (doResearch && plan.discovery_plan?.research_queries?.length > 0) {
              channelPromises.push((async () => {
                let rsIngested = 0, rsRejected = 0;
                const seenTitles = new Set<string>();

                for (let qi = 0; qi < plan.discovery_plan.research_queries.length; qi++) {
                  const q = plan.discovery_plan.research_queries[qi];
                  kbLog("INFO", "curator", `Research ${qi + 1}/${plan.discovery_plan.research_queries.length}: "${q}"`);

                  // Semantic Scholar
                  try {
                    const papers = await searchSemanticScholar(q, 10);
                    kbLog("INFO", "curator", `S2 "${q}": ${papers.length} papers`);
                    for (const paper of papers) {
                      if (!paper.abstract || paper.abstract.length < 100) continue;
                      if (seenTitles.has(paper.title.toLowerCase())) continue;
                      seenTitles.add(paper.title.toLowerCase());
                      const pContent = `# ${paper.title}\n\n**Year**: ${paper.year} | **Citations**: ${paper.citationCount}\n\n## Abstract\n\n${paper.abstract}${paper.tldr ? `\n\n## TL;DR\n\n${paper.tldr}` : ""}`;
                      try {
                        const result = await ingestContent(pContent, paper.title, paper.url || `https://api.semanticscholar.org/paper/${paper.paperId}`, collection_name, topic, threshold, "research");
                        if (result.status === "ingested") rsIngested++;
                        else rsRejected++;
                      } catch { rsRejected++; }
                    }
                    await new Promise(r => setTimeout(r, 1200));
                  } catch (err: any) {
                    kbLog("WARN", "curator", `S2 failed "${q}": ${err.message}`);
                  }

                  // OpenAlex
                  try {
                    const works = await searchOpenAlex(q, 10);
                    kbLog("INFO", "curator", `OpenAlex "${q}": ${works.length} works`);
                    for (const work of works) {
                      if (!work.abstract || work.abstract.length < 100) continue;
                      if (seenTitles.has(work.title.toLowerCase())) continue;
                      seenTitles.add(work.title.toLowerCase());
                      const wContent = `# ${work.title}\n\n**Year**: ${work.year} | **Citations**: ${work.cited_by_count}\n\n## Abstract\n\n${work.abstract}`;
                      try {
                        const result = await ingestContent(wContent, work.title, work.doi || work.open_access_url || "", collection_name, topic, threshold, "research");
                        if (result.status === "ingested") rsIngested++;
                        else rsRejected++;
                      } catch { rsRejected++; }
                    }
                  } catch (err: any) {
                    kbLog("WARN", "curator", `OpenAlex failed "${q}": ${err.message}`);
                  }

                  // CORE
                  if (CORE_API_KEY) {
                    try {
                      const coreWorks = await searchCore(q, 5);
                      kbLog("INFO", "curator", `CORE "${q}": ${coreWorks.length} works`);
                      for (const work of coreWorks) {
                        if (seenTitles.has(work.title.toLowerCase())) continue;
                        seenTitles.add(work.title.toLowerCase());
                        const cContent = work.fullText || `# ${work.title}\n\n## Abstract\n\n${work.abstract}`;
                        if (cContent.length < 200) continue;
                        try {
                          const result = await ingestContent(cContent, work.title, work.downloadUrl || "", collection_name, topic, threshold, "research");
                          if (result.status === "ingested") rsIngested++;
                          else rsRejected++;
                        } catch { rsRejected++; }
                      }
                      await new Promise(r => setTimeout(r, 200));
                    } catch (err: any) {
                      kbLog("WARN", "curator", `CORE failed "${q}": ${err.message}`);
                    }
                  }
                }

                kbLog("INFO", "curator", `Research channel done: ${rsIngested} ingested, ${rsRejected} rejected (from ${seenTitles.size} unique papers)`);
                tally.channels.scholar.ingested += rsIngested;
                tally.channels.scholar.rejected += rsRejected;
                await tallyUpdate(tally);
              })());
            }

            // Wait for all channels
            await Promise.allSettled(channelPromises);

            // Post-pass summary
            let postStats: any = {};
            try { postStats = await tools.validate_collection.handler({ collection_name }); } catch {}
            const deltaVectors = (postStats.total_vectors || 0) - (stats.total_vectors || 0);
            tally.passVectors.push(deltaVectors);
            tally.passCosts.push(getCostTracker().passCost);
            await tallyUpdate(tally, `Pass ${pass} complete — ${deltaVectors > 0 ? "+" + deltaVectors + " vectors" : "no new vectors"}`);

            kbLog("INFO", "curator", `Pass ${pass} done: +${deltaVectors} vectors, total ${postStats.total_vectors || "?"}`);

            // Diminishing returns auto-stop (any condition triggers early termination)
            if (pass > 1 && deltaVectors >= 0) {
              const passCost = tally.passCosts[tally.passCosts.length - 1] || 0;
              const costPerVec = deltaVectors > 0 ? passCost / deltaVectors : Infinity;
              const totalVecs = tally.passVectors.reduce((a, b) => a + b, 0);
              const totalCost = tally.passCosts.reduce((a, b) => a + b, 0);
              const avgCostPerVec = totalVecs > 0 ? totalCost / totalVecs : 0;
              const firstPassVecs = tally.passVectors[0] || 1;

              // Hard floor: fewer than 50 new vectors
              if (deltaVectors < 50) {
                kbLog("INFO", "curator", `Diminishing returns: hard floor — only ${deltaVectors} new vectors (< 50 threshold). Stopping.`);
                await tallyUpdate(tally, `Stopped early — diminishing returns (${deltaVectors} vectors < 50 floor)`);
                break;
              }
              // Cost spike: $/vec > 5x running average
              if (avgCostPerVec > 0 && costPerVec > avgCostPerVec * 5) {
                kbLog("INFO", "curator", `Diminishing returns: cost spike — $${costPerVec.toFixed(6)}/vec vs $${avgCostPerVec.toFixed(6)}/vec avg (5x threshold). Stopping.`);
                await tallyUpdate(tally, `Stopped early — cost spike ($${costPerVec.toFixed(6)}/vec > 5x avg)`);
                break;
              }
              // Yield decay: < 10% of first pass yield
              if (deltaVectors < firstPassVecs * 0.10) {
                kbLog("INFO", "curator", `Diminishing returns: yield decay — ${deltaVectors} vectors < 10% of P1 (${firstPassVecs}). Stopping.`);
                await tallyUpdate(tally, `Stopped early — yield decay (${deltaVectors} < 10% of P1's ${firstPassVecs})`);
                break;
              }
              kbLog("INFO", "curator", `Diminishing returns check passed: ${deltaVectors} vec, $${costPerVec.toFixed(6)}/vec, ${((deltaVectors/firstPassVecs)*100).toFixed(0)}% of P1`);
            }

            // Check if another pass is recommended
            if (!plan.another_pass_recommended || pass >= maxIter) {
              kbLog("INFO", "curator", `Curation complete after ${pass} pass(es)`);
              break;
            }
            kbLog("INFO", "curator", `Another pass recommended: ${plan.pass_focus}`);
            await tallyUpdate(tally, `Looping to pass ${pass + 1}...`);
          }

          // Final report + verdict
          let finalStats: any = {};
          try { finalStats = await tools.validate_collection.handler({ collection_name }); } catch {}

          // Generate verdict label
          let verdict = { label: "good-to-go" as string, note: "" };
          try {
            const passHistory = previousPasses.map((p: any, i: number) =>
              `Pass ${i + 1}: readiness_score=${p.readiness_score}/10, gaps=${p.gaps?.length || 0}, assessment: ${(p.assessment || "").slice(0, 300)}`
            ).join("\n");

            const verdictPrompt = `You are a RAG collection quality auditor. Based on the curation history below, assign a final verdict.

COLLECTION: "${collection_name}"
TOPIC: "${topic}"
FINAL STATS: ${finalStats.total_vectors || 0} vectors, ${finalStats.unique_sources || 0} sources, avg quality ${finalStats.avg_quality || "N/A"}/10
PASSES COMPLETED: ${previousPasses.length}/${maxIter}
COST/VECTOR CURVE: ${tally.passVectors.map((v, i) => `P${i+1}: ${v} vec @ $${tally.passCosts[i]?.toFixed(4) || "?"} ($${v > 0 ? (tally.passCosts[i] / v).toFixed(6) : "?"}/vec)`).join(" → ")}

CURATION HISTORY:
${passHistory}

CATEGORY DISTRIBUTION:
${Object.entries(finalStats.style_categories || {}).map(([k, v]: [string, any]) => "  " + k + ": " + v).join("\n") || "  (none)"}

SIZE TARGETS:
- Minimum viable: 10,000 vectors for any production collection
- Foundational/meta collections: 25,000+ vectors
- Below 10K is automatically "needs-work" regardless of quality

Assign exactly ONE verdict label:
- "good-to-go": Collection has 10K+ vectors (25K+ for foundational topics), well-balanced coverage, good quality. Ready for production use.
- "warning": Collection is approaching targets but has notable gaps, imbalances, or is between 7K-10K vectors.
- "needs-work": Collection is below 10K vectors, has significant coverage gaps, quality issues, or is too thin for reliable use.

Respond ONLY with valid JSON:
{
  "label": "<good-to-go|warning|needs-work>",
  "note": "<If warning or needs-work: one paragraph explaining why and what specific areas need attention. If good-to-go: empty string>"
}`;

            const raw = await openrouterChat(CURATOR_MODEL, [{ role: "user", content: verdictPrompt }], 1000, 0.3, 60000);
            verdict = extractJson(raw);
            if (!["good-to-go", "warning", "needs-work"].includes(verdict.label)) verdict.label = "warning";
            kbLog("INFO", "curator", `Verdict: ${verdict.label}${verdict.note ? " — " + verdict.note.slice(0, 200) : ""}`);
          } catch (err: any) {
            kbLog("WARN", "curator", `Verdict generation failed: ${err.message}`);
            verdict = { label: "warning", note: "Verdict could not be generated automatically — manual review recommended." };
          }

          const verdictEmoji = verdict.label === "good-to-go" ? "white_check_mark" : verdict.label === "warning" ? "warning" : "x";
          const verdictNote = verdict.note ? `\n\n**Note:** ${verdict.note}` : "";
          await tallyUpdate(tally, `Complete — verdict: ${verdict.label}`);
          await mmPipelineUpdate(collection_name, `:checkered_flag: **Curator Complete** (job: ${jobId})\n**Verdict**: :${verdictEmoji}: \`${verdict.label}\`${verdictNote}\n\n**Final vectors**: ${finalStats.total_vectors || "?"}\n**Sources**: ${finalStats.unique_sources || "?"}\n**Avg quality**: ${finalStats.avg_quality || "?"}/10\n**Passes**: ${previousPasses.length}/${maxIter}`, "tada");
          kbLog("INFO", "curator", `Curation of "${collection_name}" complete: ${finalStats.total_vectors || "?"} vectors, verdict: ${verdict.label}`);

          // Auto-generate golden set after curation if collection has enough data
          if ((finalStats.total_vectors || 0) >= 500) {
            try {
              kbLog("INFO", "curator", `Auto-generating golden set for ${collection_name} (${finalStats.total_vectors} vectors)`);
              await generateGoldenSet(collection_name, 50);
              kbLog("INFO", "curator", `Golden set generated for ${collection_name}`);
            } catch (err: any) {
              kbLog("WARN", "curator", `Auto golden set generation failed: ${err.message}`);
            }
          }

        } catch (err: any) {
          kbLog("ERROR", "curator", `FATAL: ${err.message}\n${err.stack}`);
          try { await mmAlert("rag-generator", "curator", err.message, { collection_name, jobId }); } catch {}
        }
      };

      if (_queue_managed) {
        await pipelineWork();
        return { status: "completed", job_id: jobId, collection_name };
      }
      pipelineWork();
      return { status: "started", job_id: jobId, collection_name, topic, channels: channelList, max_iterations: maxIter, message: "Curator running in background. Progress posted to Mattermost." };
    },
  },


  view_logs: {
    description: "View persistent knowledge builder pipeline logs. Logs persist for 7 days across container restarts.",
    params: {
      date: "Date string YYYY-MM-DD (default: today)",
      tail: "Number of lines from end (default: 100)",
      level: "Filter by level: INFO, WARN, ERROR (default: all)",
      channel: "Filter by channel: build, ingest, github, s2, openalex, core, research, scrape, eval, wiki, batch (default: all)",
      search: "Search string to filter log lines (default: none)",
    },
    handler: async ({ date, tail = 100, level, channel, search }: any) => {
      const tailN = parseInt(tail) || 100;
      try {
        if (!fs.existsSync(LOG_DIR)) return { error: "Log directory not found. Is the volume mounted?", hint: "Deploy with: -v /opt/homelab-mcp-gateway/logs:/app/logs" };

        // List available log files
        const logFiles = fs.readdirSync(LOG_DIR)
          .filter((f: string) => f.startsWith("kb-") && f.endsWith(".log"))
          .sort()
          .reverse();

        if (logFiles.length === 0) return { error: "No log files found yet", log_dir: LOG_DIR };

        // Pick the right file
        const dateStr = date || new Date().toISOString().split("T")[0];
        const targetFile = `kb-${dateStr}.log`;
        const filePath = path.join(LOG_DIR, targetFile);

        if (!fs.existsSync(filePath)) {
          return {
            error: `No log file for ${dateStr}`,
            available_dates: logFiles.map((f: string) => f.replace("kb-", "").replace(".log", "")),
          };
        }

        const allLines = fs.readFileSync(filePath, "utf-8").split("\n").filter((l: string) => l.trim());

        // Summary stats from full file (computed before filtering)
        const stats = {
          total_lines: allLines.length,
          errors: allLines.filter((l: string) => l.includes("[ERROR]")).length,
          warnings: allLines.filter((l: string) => l.includes("[WARN]")).length,
          info: allLines.filter((l: string) => l.includes("[INFO]")).length,
        };

        // Apply filters
        let lines = allLines;
        if (level) lines = lines.filter((l: string) => l.includes(`[${level.toUpperCase()}]`));
        if (channel) lines = lines.filter((l: string) => l.includes(`[${channel}]`));
        if (search) lines = lines.filter((l: string) => l.toLowerCase().includes(search.toLowerCase()));

        const total = lines.length;
        lines = lines.slice(-tailN);

        return {
          date: dateStr,
          file: targetFile,
          file_size_kb: Math.round(fs.statSync(filePath).size / 1024),
          stats,
          showing: `last ${lines.length} of ${total} matching lines`,
          available_dates: logFiles.map((f: string) => f.replace("kb-", "").replace(".log", "")),
          lines: lines.join("\n"),
        };
      } catch (err: any) {
        return { error: err.message };
      }
    },
  },


  generate_golden_set: {
    description: "Generate a synthetic evaluation dataset from existing collection content. Samples chunks, generates natural-language queries via AI, validates retrieval. Used as ground truth for benchmarking.",
    params: {
      collection_name: "Collection to generate golden set for",
      count: "Number of triplets to generate (default: 100)",
    },
    handler: async ({ collection_name, count = 100, _queue_managed = false }) => {
      const targetCount = parseInt(count);
      const jobId = crypto.randomUUID().slice(0, 8);

      const pipelineWork = async () => {
        try {
          await mmPipelineUpdate(collection_name, `Golden set generation started (job: ${jobId}) — target ${targetCount} triplets`, "test_tube");
          const result = await generateGoldenSet(collection_name, targetCount);
          await mmPipelineUpdate(collection_name, `:checkered_flag: Golden set complete (job: ${jobId})\n**Generated**: ${result.generated} | **Valid**: ${result.valid} | **Discarded**: ${result.discarded}`, "white_check_mark");
          return { status: "completed", ...result };
        } catch (err: any) {
          kbLog("ERROR", "golden", `FATAL: ${err.message}`);
          await mmAlert("rag-generator", "generate_golden_set", err.message, { collection_name, jobId });
          return { status: "error", error: err.message };
        }
      };

      if (_queue_managed) { return await pipelineWork(); }
      pipelineWork();
      return { status: "started", job_id: jobId, collection_name, target_count: targetCount, message: "Golden set generation running in background." };
    },
  },

  run_eval: {
    description: "Execute retrieval quality benchmarks using golden sets. Computes Recall@K, MRR, NDCG@10, Precision@5. Compares against previous runs and alerts on regression.",
    params: {
      collection_name: "Collection to evaluate",
      hybrid: "Use hybrid search (default: auto-detect)",
      reranking: "Enable AI reranking (default: true)",
      mmr: "Enable MMR diversity (default: true)",
      multi_query: "Enable 3-query strategy (default: true)",
    },
    handler: async ({ collection_name, hybrid, reranking = "true", mmr = "true", multi_query = "true", _queue_managed = false }) => {
      const config: EvalConfig = {
        hybrid: hybrid !== undefined ? (hybrid === "true" || hybrid === true) : await isHybridCollection(collection_name),
        reranking: reranking === "true" || reranking === true,
        mmr: mmr === "true" || mmr === true,
        multi_query: multi_query === "true" || multi_query === true,
      };
      const jobId = crypto.randomUUID().slice(0, 8);

      const pipelineWork = async () => {
        try {
          await mmPipelineUpdate(collection_name, `Eval harness started (job: ${jobId})\nConfig: ${JSON.stringify(config)}`, "bar_chart");
          const metrics = await runEvalHarness(collection_name, config);
          return { status: "completed", collection_name, config, metrics };
        } catch (err: any) {
          kbLog("ERROR", "eval", `FATAL: ${err.message}`);
          await mmAlert("rag-generator", "run_eval", err.message, { collection_name, jobId });
          return { status: "error", error: err.message };
        }
      };

      if (_queue_managed) { return await pipelineWork(); }
      pipelineWork();
      return { status: "started", job_id: jobId, collection_name, config, message: "Eval running in background." };
    },
  },

  migrate_collection: {
    description: "Migrate a dense-only collection to hybrid (dense + sparse vectors). Reads all points, generates sparse vectors, creates new hybrid collection, swaps.",
    params: {
      collection_name: "Collection to migrate",
      batch_size: "Points per batch (default: 100)",
    },
    handler: async ({ collection_name, batch_size = 100, _queue_managed = false }) => {
      const batchSz = parseInt(batch_size);
      const jobId = crypto.randomUUID().slice(0, 8);

      const pipelineWork = async () => {
        try {
          // Check if already hybrid
          if (await isHybridCollection(collection_name)) {
            return { status: "skipped", reason: "Collection is already hybrid" };
          }

          await mmPipelineUpdate(collection_name, `Migration to hybrid started (job: ${jobId})`, "arrows_counterclockwise");

          // Read all points from old collection
          kbLog("INFO", "migrate", `Reading all points from ${collection_name}...`);
          const allPoints = await qdrantScroll(collection_name, undefined, batchSz, true, true);
          kbLog("INFO", "migrate", `Read ${allPoints.length} points`);

          if (allPoints.length === 0) {
            return { status: "skipped", reason: "Collection is empty" };
          }

          // Create new hybrid collection
          const v2Name = `${collection_name}_v2`;
          await createHybridCollection(v2Name, VECTOR_SIZE);

          // Load IDF cache for sparse generation
          const { idfMap, totalDocs } = await loadIdfCache();

          // Migrate in batches
          let migrated = 0;
          for (let i = 0; i < allPoints.length; i += batchSz) {
            const batch = allPoints.slice(i, i + batchSz);
            const newPoints = batch.map((pt: any) => {
              const text = pt.payload?.text || "";
              const sparse = generateSparseVector(text, idfMap, totalDocs);
              const denseVector = Array.isArray(pt.vector) ? pt.vector : (pt.vector?.dense || pt.vector || []);
              return {
                id: pt.id,
                vector: {
                  dense: denseVector,
                  sparse: { indices: sparse.indices, values: sparse.values },
                },
                payload: pt.payload,
              };
            });

            await qdrantFetch(`/collections/${v2Name}/points`, {
              method: "PUT",
              body: JSON.stringify({ points: newPoints }),
            });
            migrated += newPoints.length;
            if (i % (batchSz * 5) === 0) {
              kbLog("INFO", "migrate", `Progress: ${migrated}/${allPoints.length}`);
            }
          }

          // Update IDF terms from all texts
          const allTokens = allPoints.flatMap((pt: any) => extractUniqueTokens(pt.payload?.text || ""));
          await updateIdfTerms(allTokens);

          // Swap: delete old, rename by creating alias or just update stats
          await qdrantFetch(`/collections/${collection_name}`, { method: "DELETE" });
          // Qdrant doesn't support rename, so we create a new collection with the original name and alias
          // Actually, let's just use the v2 name and update references
          // Update all related PG tables to point to new collection name
          const tablesToUpdate = [
            "rag_collection_stats",
            "rag_chunks",
            "rag_golden_sets",
            "rag_query_log",
            "rag_eval_runs",
            "rag_idf_terms",  // IDF terms reference collection indirectly via collection_stats
          ];
          for (const table of tablesToUpdate) {
            try {
              await pgQuery(`UPDATE ${table} SET collection = $2 WHERE collection = $1`, [collection_name, v2Name]);
            } catch { /* table may not exist or have no matching rows */ }
          }

          await mmPipelineUpdate(v2Name, `:checkered_flag: Migration complete (job: ${jobId})\n**Migrated**: ${migrated} points\n**New collection**: ${v2Name} (hybrid: dense + sparse)`, "white_check_mark");
          kbLog("INFO", "migrate", `Migration complete: ${collection_name} -> ${v2Name} (${migrated} points)`);

          return { status: "completed", old_collection: collection_name, new_collection: v2Name, migrated_points: migrated };
        } catch (err: any) {
          kbLog("ERROR", "migrate", `FATAL: ${err.message}`);
          await mmAlert("rag-generator", "migrate_collection", err.message, { collection_name, jobId });
          return { status: "error", error: err.message };
        }
      };

      if (_queue_managed) { return await pipelineWork(); }
      pipelineWork();
      return { status: "started", job_id: jobId, collection_name, message: "Migration running in background." };
    },
  },

  discover_from_source: {
    description: "Generic connector-based discovery. Searches a specific source connector, evaluates, and ingests results. Supports 22 data sources.",
    params: {
      connector: "Connector name (e.g. semantic-scholar, openalex, arxiv, pubmed, edgar, github, etc.)",
      query: "Search query",
      collection_name: "Target Qdrant collection",
      topic: "Topic for quality evaluation",
      quality_threshold: "Minimum quality score (default 6.5)",
      limit: "Max results per query (default 10)",
    },
    handler: async ({ connector: connName, query, collection_name, topic, quality_threshold = 6.5, limit = 10, _queue_managed = false }) => {
      const threshold = parseFloat(quality_threshold);
      const maxResults = parseInt(limit);
      const jobId = crypto.randomUUID().slice(0, 8);
      const conn = connectorRegistry.get(connName);
      if (!conn) {
        return { status: "error", error: `Unknown connector: ${connName}`, available: Array.from(connectorRegistry.keys()) };
      }

      const pipelineWork = async () => {
        const startTime = Date.now();
        try {
          if (!await isConnectorHealthy(connName)) {
            return { status: "error", error: `Connector ${connName} is disabled due to consecutive failures. Will auto-re-enable in 1 hour.` };
          }

          await mmPipelineUpdate(collection_name, `Source discovery: **${connName}** (job: ${jobId})\nQuery: "${query}"`, "mag");

          const results = await conn.search(query, { limit: maxResults });
          const latency = Date.now() - startTime;
          await trackConnectorCall(connName, true, results.length, latency);

          let ingested = 0, rejected = 0, errors = 0;
          const seenTitles = new Set<string>();

          for (const result of results) {
            if (seenTitles.has(result.title.toLowerCase())) continue;
            seenTitles.add(result.title.toLowerCase());

            if (result.content.length < 100) continue;

            try {
              const r = await ingestContent(result.content, result.title, result.url, collection_name, topic, threshold, conn.category);
              if (r.status === "ingested") ingested++;
              else rejected++;
            } catch { errors++; }
          }

          await mmPipelineUpdate(collection_name, `Source ${connName} complete (job: ${jobId})\n${ingested} ingested | ${rejected} rejected | ${errors} errors (from ${results.length} results)`, "white_check_mark");
          return { status: "completed", connector: connName, results_found: results.length, ingested, rejected, errors };
        } catch (err: any) {
          const latency = Date.now() - startTime;
          await trackConnectorCall(connName, false, 0, latency);
          kbLog("ERROR", connName, `Discovery failed: ${err.message}`);
          return { status: "error", connector: connName, error: err.message };
        }
      };

      if (_queue_managed) { return await pipelineWork(); }
      pipelineWork();
      return { status: "started", job_id: jobId, connector: connName, query, collection_name, message: `${connName} discovery running in background.` };
    },
  },

  list_connectors: {
    description: "List all available source connectors with their health status, categories, and rate limits.",
    params: {},
    handler: async () => {
      const connectors: any[] = [];
      for (const [name, conn] of connectorRegistry) {
        let health: any = { status: "unknown" };
        try {
          const result = await pgQuery("SELECT * FROM rag_connector_health WHERE connector = $1", [name]);
          if (result.rows.length > 0) health = result.rows[0];
        } catch { /* no health data yet */ }

        connectors.push({
          name: conn.name,
          category: conn.category,
          rate_limit: conn.rateLimit,
          health_status: health.status || "unknown",
          total_calls: health.total_calls || 0,
          total_results: health.total_results || 0,
          avg_latency_ms: health.avg_latency_ms || null,
          last_success: health.last_success || null,
          consecutive_failures: health.consecutive_failures || 0,
        });
      }
      return { total: connectors.length, connectors };
    },
  },

  collection_health: {
    description: "Comprehensive health report: lifecycle state, drift detection, freshness, query volume, eval trends.",
    params: {
      collection_name: "Collection to check",
      stale_days: "Days threshold for staleness (default: 90)",
      drift_window: "Days for drift detection window (default: 30)",
    },
    handler: async ({ collection_name, stale_days = 90, drift_window = 30 }) => {
      const staleDays = parseInt(stale_days);
      const driftDays = parseInt(drift_window);

      // Collection stats
      let stats: any = {};
      try {
        const result = await pgQuery("SELECT * FROM rag_collection_stats WHERE collection = $1", [collection_name]);
        if (result.rows.length > 0) stats = result.rows[0];
      } catch {}

      // Advance lifecycle if needed
      const lifecycle = await advanceLifecycleState(collection_name);

      // Vector count from Qdrant
      let vectorCount = 0;
      try {
        const info = await qdrantFetch(`/collections/${collection_name}`);
        vectorCount = info.result?.points_count || 0;
      } catch {}

      // Is hybrid?
      const hybrid = await isHybridCollection(collection_name);

      // Staleness
      const stale = await findStaleSources(collection_name, staleDays);

      // Drift detection
      const drift = await detectDrift(collection_name, driftDays);

      // Latest eval
      let latestEval: any = null;
      try {
        const evalResult = await pgQuery("SELECT * FROM rag_eval_runs WHERE collection = $1 ORDER BY run_at DESC LIMIT 1", [collection_name]);
        if (evalResult.rows.length > 0) latestEval = evalResult.rows[0];
      } catch {}

      // Query volume
      let queryVolume = { total_30d: 0, total_7d: 0 };
      try {
        const qResult = await pgQuery(
          `SELECT
            COUNT(*) FILTER (WHERE queried_at > NOW() - INTERVAL '30 days') as total_30d,
            COUNT(*) FILTER (WHERE queried_at > NOW() - INTERVAL '7 days') as total_7d
          FROM rag_query_log WHERE collection = $1`,
          [collection_name]
        );
        if (qResult.rows.length > 0) {
          queryVolume = { total_30d: parseInt(qResult.rows[0].total_30d), total_7d: parseInt(qResult.rows[0].total_7d) };
        }
      } catch {}

      return {
        collection: collection_name,
        lifecycle_state: lifecycle || stats.lifecycle_state || "unknown",
        is_hybrid: hybrid,
        vectors: vectorCount,
        total_docs: stats.total_docs || 0,
        total_chunks: stats.total_chunks || 0,
        description: stats.description || null,
        stale_sources: { count: stale.length, oldest: stale[0] || null, threshold_days: staleDays },
        drift: drift,
        latest_eval: latestEval ? {
          recall_10: latestEval.recall_10,
          mrr: latestEval.mrr,
          ndcg_10: latestEval.ndcg_10,
          run_at: latestEval.run_at,
        } : null,
        query_volume: queryVolume,
      };
    },
  },

  refresh_stale_sources: {
    description: "Find and re-crawl sources that haven't been checked in N days. Checks if URLs are still alive, re-ingests if content changed.",
    params: {
      collection_name: "Collection to refresh",
      max_age_days: "Days threshold (default: 90)",
      max_urls: "Max URLs to re-crawl (default: 50)",
      topic: "Topic for quality evaluation",
      quality_threshold: "Minimum quality score (default 6.5)",
    },
    handler: async ({ collection_name, max_age_days = 90, max_urls = 50, topic, quality_threshold = 6.5, _queue_managed = false }) => {
      const maxAge = parseInt(max_age_days);
      const maxUrls = parseInt(max_urls);
      const threshold = parseFloat(quality_threshold);
      const jobId = crypto.randomUUID().slice(0, 8);

      const pipelineWork = async () => {
        try {
          const stale = await findStaleSources(collection_name, maxAge);
          if (stale.length === 0) {
            return { status: "completed", message: "No stale sources found", checked: 0 };
          }

          const urlsToCheck = stale.slice(0, maxUrls);
          await mmPipelineUpdate(collection_name, `Refreshing ${urlsToCheck.length} stale sources (job: ${jobId})`, "arrows_counterclockwise");

          let refreshed = 0, unchanged = 0, dead = 0, errors = 0;

          const refreshPromises = urlsToCheck.map((source: any) => SEM_INGEST.run(async () => {
            try {
              // HEAD check
              const headResp = await fetch(source.url, { method: "HEAD", redirect: "follow" });
              if (!headResp.ok) {
                dead++;
                kbLog("INFO", "refresh", `Dead URL (${headResp.status}): ${source.url}`);
                return;
              }

              // Re-scrape and compare hash
              const { markdown } = await firecrawlScrape(source.url);
              const newHash = computeContentHash(markdown);

              // Check if content changed
              const existingResult = await pgQuery(
                "SELECT content_hash FROM rag_chunks WHERE collection = $1 AND source_url = $2 LIMIT 1",
                [collection_name, source.url]
              );
              const oldHash = existingResult.rows[0]?.content_hash;

              if (oldHash === newHash) {
                // Same content — just update last_crawled_at
                await pgQuery(
                  "UPDATE rag_chunks SET last_crawled_at = NOW() WHERE collection = $1 AND source_url = $2",
                  [collection_name, source.url]
                );
                unchanged++;
              } else {
                // Content changed — delete old chunks and re-ingest
                await pgQuery(
                  "DELETE FROM rag_chunks WHERE collection = $1 AND source_url = $2",
                  [collection_name, source.url]
                );
                // Delete old vectors by URL filter
                await qdrantFetch(`/collections/${collection_name}/points/delete`, {
                  method: "POST",
                  body: JSON.stringify({ filter: { must: [{ key: "url", match: { value: source.url } }] } }),
                });
                // Re-ingest
                await ingestUrl(source.url, collection_name, topic || "", threshold);
                refreshed++;
              }
            } catch (err: any) {
              errors++;
              kbLog("WARN", "refresh", `Error checking ${source.url}: ${err.message}`);
            }
          }));
          await Promise.allSettled(refreshPromises);

          await mmPipelineUpdate(collection_name, `Refresh complete (job: ${jobId})\n**Refreshed**: ${refreshed} | **Unchanged**: ${unchanged} | **Dead**: ${dead} | **Errors**: ${errors}`, "white_check_mark");
          return { status: "completed", total_stale: stale.length, checked: urlsToCheck.length, refreshed, unchanged, dead, errors };
        } catch (err: any) {
          kbLog("ERROR", "refresh", `FATAL: ${err.message}`);
          return { status: "error", error: err.message };
        }
      };

      if (_queue_managed) { return await pipelineWork(); }
      pipelineWork();
      return { status: "started", job_id: jobId, collection_name, message: "Refresh running in background." };
    },
  },



  retry_jobs: {
    description: "Re-enqueue failed jobs and suspicious completions (duration < 5s). Creates new pending jobs with original parameters.",
    params: {
      collection_name: "Filter by collection (optional)",
      status_filter: "Filter: failed, suspicious, both (default: both)",
      limit: "Max jobs to retry (default: 20)",
    },
    handler: async ({ collection_name, status_filter = "both", limit = 20 }) => {
      const maxRetry = parseInt(limit);
      const conditions: string[] = [];
      const params: any[] = [];

      if (status_filter === "failed" || status_filter === "both") {
        conditions.push("status = 'failed'");
      }
      if (status_filter === "suspicious" || status_filter === "both") {
        conditions.push("(status = 'completed' AND EXTRACT(EPOCH FROM (completed_at - started_at)) < 5)");
      }

      let sql = `SELECT id, job_type, collection_name, topic, params FROM kb_job_queue WHERE (${conditions.join(" OR ")})`;
      if (collection_name) {
        params.push(collection_name);
        sql += ` AND collection_name = $${params.length}`;
      }
      params.push(maxRetry);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

      const result = await pgQuery(sql, params);
      const retried: Array<{ original_id: string; new_id: string; job_type: string; collection_name: string }> = [];

      for (const row of result.rows) {
        const parsedParams = typeof row.params === "string" ? JSON.parse(row.params) : (row.params || {});
        const newJob = await enqueueJob(row.job_type, row.collection_name, row.topic, parsedParams, 5, "retry");
        retried.push({ original_id: row.id.slice(0, 8), new_id: newJob.id.slice(0, 8), job_type: row.job_type, collection_name: row.collection_name });
      }

      kbLog("INFO", "queue", `Retried ${retried.length} jobs`);
      return { status: "completed", retried_count: retried.length, retried };
    },
  },

  requeue_empty_collections: {
    description: "Scan for collections tracked in PG/Neo4j but with 0 Qdrant points. Re-enqueues build_knowledge_base for each.",
    params: {},
    handler: async () => {
      // Get all collections from PG stats
      const statsResult = await pgQuery("SELECT collection, lifecycle_state FROM rag_collection_stats");
      const requeued: Array<{ collection: string; new_job_id: string }> = [];

      for (const row of statsResult.rows) {
        try {
          const info = await qdrantFetch(`/collections/${row.collection}`);
          const pointCount = info.result?.points_count || 0;
          if (pointCount === 0) {
            // Try to get topic from Neo4j or use collection name as fallback
            let topic = row.collection.replace(/_/g, " ");
            try {
              const neo4jResult = await neo4jQuery(
                "MATCH (c:KBCollection {name: $name})-[:CONTAINS]->(s:KBSource) RETURN s.title AS topic LIMIT 1",
                { name: row.collection }
              );
              if (neo4jResult.length > 0 && neo4jResult[0]?.topic) topic = neo4jResult[0].topic;
            } catch {}

            const newJob = await enqueueJob("build_knowledge_base", row.collection, topic, {}, 5, "requeue_empty");
            requeued.push({ collection: row.collection, new_job_id: newJob.id.slice(0, 8) });
          }
        } catch {
          // Collection might not exist in Qdrant yet — that's fine, enqueue build
          let topic = row.collection.replace(/_/g, " ");
          const newJob = await enqueueJob("build_knowledge_base", row.collection, topic, {}, 5, "requeue_empty");
          requeued.push({ collection: row.collection, new_job_id: newJob.id.slice(0, 8) });
        }
      }

      kbLog("INFO", "queue", `Requeued ${requeued.length} empty collections`);
      return { status: "completed", requeued_count: requeued.length, requeued };
    },
  },

  backfill_idf: {
    description: "Backfill the IDF terms table by scrolling all points in a collection and extracting tokens from their text. Use after migration or when IDF table is empty.",
    params: {
      collection_name: "Collection to scan for IDF terms",
      batch_size: "Points per scroll batch (default: 100)",
    },
    handler: async ({ collection_name, batch_size = 100 }) => {
      const batchSz = parseInt(batch_size);
      kbLog("INFO", "idf", `Starting IDF backfill from ${collection_name}...`);

      const allPoints = await qdrantScroll(collection_name, undefined, batchSz, true, false);
      kbLog("INFO", "idf", `Scrolled ${allPoints.length} points from ${collection_name}`);

      if (allPoints.length === 0) {
        return { status: "skipped", reason: "Collection is empty" };
      }

      let totalTokens = 0;
      for (let i = 0; i < allPoints.length; i += batchSz) {
        const batch = allPoints.slice(i, i + batchSz);
        const allTokens = batch.flatMap((pt: any) => extractUniqueTokens(pt.payload?.text || ""));
        totalTokens += allTokens.length;
        await updateIdfTerms(allTokens);
        if (i % (batchSz * 5) === 0 && i > 0) {
          kbLog("INFO", "idf", `IDF backfill progress: ${i}/${allPoints.length} points`);
        }
      }

      // Verify
      const countResult = await pgQuery("SELECT COUNT(*) as cnt FROM rag_idf_terms");
      const termCount = parseInt(countResult.rows[0]?.cnt || "0");

      kbLog("INFO", "idf", `IDF backfill complete: ${allPoints.length} points, ${totalTokens} tokens, ${termCount} terms in table`);
      return { status: "completed", collection_name, points_scanned: allPoints.length, tokens_processed: totalTokens, idf_terms_count: termCount };
    },
  },

  delete_collection: {
    description: "Delete a knowledge base collection",
    params: { collection_name: "Collection to delete" },
    handler: async ({ collection_name }) => {
      await qdrantFetch(`/collections/${collection_name}`, { method: "DELETE" });
      return { status: "deleted", collection_name };
    },
  },

  ingest_content: {
    description: "Ingest pre-scraped content directly (no Firecrawl, no AI eval)",
    params: { content: "Markdown/text", collection_name: "Collection", metadata: "JSON metadata object" },
    handler: async ({ content, collection_name, metadata = {} }) => {
      const meta: ChunkMetadata = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      const chunks = markdownChunk(content, meta.title || "");
      if (chunks.length === 0) return { status: "skipped", reason: "No content" };
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(chunk => getEmbeddingWithModel(chunk, EMBEDDING_MODEL))
        );
        embeddings.push(...batchResults);
      }
      const now = new Date().toISOString();
      const points = chunks.map((chunk, i) => ({
        id: crypto.randomUUID(), vector: embeddings[i],
        payload: { text: chunk, chunk_index: i, total_chunks: chunks.length, ...meta, ingested_at: now, recorded_at: now, embedding_model: EMBEDDING_MODEL }
      }));
      await qdrantFetch(`/collections/${collection_name}/points`, { method: "PUT", body: JSON.stringify({ points }) });
      return { status: "ingested", collection_name, chunks_ingested: chunks.length };
    },
  },
};

// ── Registration ─────────────────────────────────────────────────────

const DESCRIPTION = `Autonomous RAG generator — builds, maintains, and serves specialty knowledge collections.
Supports hybrid search (dense + sparse vectors with RRF fusion), 22 source connectors, automated quality evaluation, and collection lifecycle management.

**Build & Discover**: build_knowledge_base, discover_from_github, discover_from_research, discover_from_wikipedia, discover_from_source
**Ingest**: smart_ingest, batch_smart_ingest, ingest_content
**Query**: query_knowledge (multi-query rewriting + hybrid search + AI reranking + MMR diversity)
**Eval**: generate_golden_set, run_eval (Recall@K, MRR, NDCG, Precision)
**Connectors**: list_connectors (22 sources: academic, legal, financial, gov, code, health, news, knowledge)
**Lifecycle**: collection_health, refresh_stale_sources, migrate_collection
**Admin**: create_collection (hybrid support), delete_collection, validate_collection, view_logs, backfill_idf
**Queue**: queue_job, list_queue, cancel_job, queue_stats, curate_collection, retry_jobs, requeue_empty_collections

Pipeline: research/connector -> scrape/fetch -> AI quality eval -> authority scoring -> markdown chunking -> nomic-embed-text-v1.5 (768d) + TF-IDF sparse -> Qdrant (hybrid).
Logs persist to /app/logs/ for 7 days (mounted volume).`;

export function registerRagGeneratorTools(server: McpServer) {
  server.tool("rag_generator_list", "List knowledge builder tools", {}, async () => {
    const list = Object.entries(tools).map(([name, def]) => ({ tool: name, description: def.description, params: def.params }));
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  });

  server.tool("rag_generator_call", DESCRIPTION, {
    tool: z.string().describe("Tool name"),
    params: z.record(z.any()).optional().describe("Tool parameters"),
  }, async ({ tool, params }) => {
    const def = tools[tool];
    if (!def) return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
    try {
      const result = await def.handler(params || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
    }
  });

  // Backward compatibility aliases (one release cycle)
  server.tool("knowledge_builder_list", "[DEPRECATED] Use rag_generator_list", {}, async () => {
    const list = Object.entries(tools).map(([name, def]) => ({ tool: name, description: def.description, params: def.params }));
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  });

  server.tool("knowledge_builder_call", "[DEPRECATED] Use rag_generator_call", {
    tool: z.string().describe("Tool name"),
    params: z.record(z.any()).optional().describe("Tool parameters"),
  }, async ({ tool: t, params: p }) => {
    const def = tools[t];
    if (!def) return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${t}`, available: Object.keys(tools) }) }] };
    try {
      const result = await def.handler(p || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
    }
  });
}

