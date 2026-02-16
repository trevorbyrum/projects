import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Model registry (kept in main thread for getEmbeddingDimensions)
const MODEL_REGISTRY: Record<string, { id: string; dimensions: number }> = {
  "minilm": { id: "Xenova/all-MiniLM-L6-v2", dimensions: 384 },
  "nomic": { id: "nomic-ai/nomic-embed-text-v1.5", dimensions: 768 },
};

// ── Worker Thread Pool ───────────────────────────────────────────────
// Dense embedding computation runs in a separate thread to avoid
// blocking the main event loop with CPU-bound ONNX inference.

let _worker: Worker | null = null;
let _requestId = 0;
const _pending = new Map<number, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!_worker) {
    const workerPath = path.join(__dirname, "embedding-worker.js");
    _worker = new Worker(workerPath);
    _worker.on("message", (msg: { id?: number; type?: string; embedding?: number[]; error?: string }) => {
      if (msg.type === "ready") return;
      if (msg.id === undefined) return;
      const p = _pending.get(msg.id);
      if (!p) return;
      _pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.embedding!);
    });
    _worker.on("error", (err) => {
      console.error("[embedding-worker] Worker error:", err.message);
      for (const [, p] of _pending) {
        p.reject(err);
      }
      _pending.clear();
      _worker = null;
    });
    _worker.on("exit", (code) => {
      if (code !== 0) console.error(`[embedding-worker] Exited with code ${code}`);
      _worker = null;
    });
    console.log("[embeddings] Worker thread started");
  }
  return _worker;
}

/** Compute a dense embedding via the worker thread */
async function computeEmbedding(text: string, modelKey: string): Promise<number[]> {
  const id = _requestId++;
  const worker = getWorker();
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    worker.postMessage({ id, text, modelKey });
  });
}

// ── LRU Embedding Cache ──────────────────────────────────────────────
// Key: SHA-256(modelKey + ":" + text), Value: number[]
// Cache stays in main thread — only cache misses go to the worker.

const CACHE_MAX_ENTRIES = parseInt(process.env.EMBEDDING_CACHE_MAX || "10000");

interface CacheEntry {
  embedding: number[];
  lastUsed: number;
}

const _cache = new Map<string, CacheEntry>();
let _cacheHits = 0;
let _cacheMisses = 0;

function cacheKey(text: string, modelKey: string): string {
  return crypto.createHash("sha256").update(`${modelKey}:${text}`).digest("hex");
}

function cacheGet(key: string): number[] | null {
  const entry = _cache.get(key);
  if (!entry) { _cacheMisses++; return null; }
  entry.lastUsed = Date.now();
  _cacheHits++;
  return entry.embedding;
}

function cachePut(key: string, embedding: number[]): void {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, v] of _cache) {
      if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
    }
    if (oldestKey) _cache.delete(oldestKey);
  }
  _cache.set(key, { embedding, lastUsed: Date.now() });
}

/** Get cache statistics */
export function getEmbeddingCacheStats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: string } {
  const total = _cacheHits + _cacheMisses;
  return {
    size: _cache.size,
    maxSize: CACHE_MAX_ENTRIES,
    hits: _cacheHits,
    misses: _cacheMisses,
    hitRate: total > 0 ? ((_cacheHits / total) * 100).toFixed(1) + "%" : "N/A",
  };
}

/** Get embedding dimensions for a model key */
export function getEmbeddingDimensions(modelKey: string = "minilm"): number {
  const entry = MODEL_REGISTRY[modelKey];
  if (!entry) throw new Error(`Unknown embedding model: ${modelKey}`);
  return entry.dimensions;
}

/** Default embedding (MiniLM 384d) — backward compatible */
export async function getEmbedding(text: string): Promise<number[]> {
  return getEmbeddingWithModel(text, "minilm");
}

/** Embedding with configurable model + LRU cache (dense work offloaded to worker thread) */
export async function getEmbeddingWithModel(text: string, modelKey: string = "minilm"): Promise<number[]> {
  const key = cacheKey(text, modelKey);
  const cached = cacheGet(key);
  if (cached) return cached;

  const embedding = await computeEmbedding(text, modelKey);

  cachePut(key, embedding);
  return embedding;
}

/** Batch embeddings — default model */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map((t) => getEmbedding(t)));
}

/** Batch embeddings — configurable model */
export async function getEmbeddingsWithModel(texts: string[], modelKey: string = "minilm"): Promise<number[][]> {
  return Promise.all(texts.map((t) => getEmbeddingWithModel(t, modelKey)));
}

// ── Sparse Vector Generation (BM25/TF-IDF) ──────────────────────────

/** FNV-1a hash — fast, low collision, maps tokens to sparse vector indices */
export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "and", "but", "or", "if", "while", "because", "until", "that", "this",
  "these", "those", "it", "its", "he", "she", "they", "we", "you", "i",
  "me", "him", "her", "us", "them", "my", "your", "his", "our", "their",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && t.length < 50 && !STOP_WORDS.has(t));
}

const SPARSE_BUCKETS = 100_000;

export function generateSparseVector(
  text: string,
  idfMap?: Map<string, number>,
  totalDocs: number = 1000,
): { indices: number[]; values: number[] } {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  const sparseMap = new Map<number, number>();
  for (const [term, count] of tf) {
    const termFreq = count / tokens.length;
    const docFreq = idfMap?.get(term) ?? 1;
    const idf = Math.log((totalDocs + 1) / (docFreq + 1)) + 1;
    const tfidf = termFreq * idf;

    const hashIdx = fnv1aHash(term) % SPARSE_BUCKETS;
    sparseMap.set(hashIdx, (sparseMap.get(hashIdx) || 0) + tfidf);
  }

  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, val] of sparseMap) {
    indices.push(idx);
    values.push(val);
  }

  return { indices, values };
}

/** Extract unique tokens from text (for IDF table updates) */
export function extractUniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}
