import { parentPort } from "node:worker_threads";
import { pipeline, env } from "@xenova/transformers";

// Configure transformers.js
env.cacheDir = "/app/.cache/transformers";
env.allowLocalModels = false;

const MODEL_REGISTRY: Record<string, { id: string; dimensions: number }> = {
  "minilm": { id: "Xenova/all-MiniLM-L6-v2", dimensions: 384 },
  "nomic": { id: "nomic-ai/nomic-embed-text-v1.5", dimensions: 768 },
};

const embedders: Record<string, any> = {};

async function getEmbedder(modelKey: string) {
  if (!embedders[modelKey]) {
    const entry = MODEL_REGISTRY[modelKey];
    if (!entry) throw new Error(`Unknown embedding model: ${modelKey}. Available: ${Object.keys(MODEL_REGISTRY).join(", ")}`);
    console.log(`[embedding-worker] Loading model: ${entry.id} (${entry.dimensions}d)...`);
    embedders[modelKey] = await pipeline("feature-extraction", entry.id);
    console.log(`[embedding-worker] Model loaded: ${entry.id}`);
  }
  return embedders[modelKey];
}

parentPort?.on("message", async (msg: { id: number; text: string; modelKey: string }) => {
  try {
    const model = await getEmbedder(msg.modelKey);
    const output = await model(msg.text, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data) as number[];
    parentPort?.postMessage({ id: msg.id, embedding });
  } catch (err: any) {
    parentPort?.postMessage({ id: msg.id, error: err.message });
  }
});

parentPort?.postMessage({ type: "ready" });
