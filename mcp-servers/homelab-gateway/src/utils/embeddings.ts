import { pipeline, env } from "@xenova/transformers";

// Configure transformers.js
env.cacheDir = "/app/.cache/transformers";
env.allowLocalModels = false;

// Lazy-load the embedder
let embedder: any = null;

async function getEmbedder() {
  if (!embedder) {
    console.log("Loading embedding model (first run may take a moment)...");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("Embedding model loaded.");
  }
  return embedder;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map((t) => getEmbedding(t)));
}
