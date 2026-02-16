/**
 * Shared Qdrant vector DB client.
 * All modules that use Qdrant import from here instead of defining their own fetch wrapper.
 */

const QDRANT_URL = process.env.QDRANT_URL || "http://Qdrant:6333";

export async function qdrantFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${QDRANT_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Qdrant API error: ${JSON.stringify(data)}`);
  return data;
}

/** Scroll through all points in a collection (handles pagination) */
export async function qdrantScroll(
  collection: string,
  filter?: any,
  limit: number = 100,
  withPayload: boolean = true,
  withVector: boolean = false,
): Promise<any[]> {
  const allPoints: any[] = [];
  let offset: string | number | null = null;
  do {
    const body: any = { limit, with_payload: withPayload, with_vector: withVector };
    if (filter) body.filter = filter;
    if (offset !== null) body.offset = offset;
    const batch = await qdrantFetch(`/collections/${collection}/points/scroll`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    allPoints.push(...(batch.result?.points || []));
    offset = batch.result?.next_page_offset ?? null;
  } while (offset !== null);
  return allPoints;
}

/** Check if a collection uses named vectors (hybrid schema) */
export async function isHybridCollection(collection: string): Promise<boolean> {
  try {
    const info = await qdrantFetch(`/collections/${collection}`);
    const vectors = info.result?.config?.params?.vectors;
    // Named vectors have a "dense" key; unnamed vectors have "size" directly
    return vectors && typeof vectors === "object" && "dense" in vectors;
  } catch {
    return false;
  }
}

