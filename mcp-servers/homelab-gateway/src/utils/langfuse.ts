/**
 * Langfuse observability integration.
 * Provides LLM call tracking with traces, spans, and generations.
 * All tracking is fire-and-forget — errors never break pipeline execution.
 */

import Langfuse from "langfuse";

let instance: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (!sk) return null;
  if (!instance) {
    instance = new Langfuse({
      secretKey: sk,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY || "",
      baseUrl: process.env.LANGFUSE_BASE_URL || "http://langfuse-web:3000",
      flushAt: 15,
      flushInterval: 10000,
    });
    console.log("[langfuse] Client initialized");
  }
  return instance;
}

/** Track a Dify workflow call as a trace + generation */
export function trackDify(opts: {
  workflow: string;
  inputs: Record<string, string>;
  output?: any;
  tokens?: number;
  cost?: number;
  elapsed_ms: number;
  status?: string;
  error?: string;
  sessionId?: string;
  tags?: string[];
}): void {
  try {
    const lf = getLangfuse();
    if (!lf) return;
    const trace = lf.trace({
      name: `dify/${opts.workflow}`,
      sessionId: opts.sessionId || opts.inputs.project_slug || opts.inputs.slug || "unknown",
      userId: "mcp-gateway",
      tags: opts.tags || ["dify"],
      metadata: { workflow: opts.workflow },
    });
    trace.generation({
      name: opts.workflow,
      model: `dify/${opts.workflow}`,
      input: opts.inputs,
      output: opts.error ? { error: opts.error } : opts.output,
      usage: { total: opts.tokens || 0 },
      startTime: new Date(Date.now() - opts.elapsed_ms),
      endTime: new Date(),
      level: opts.error ? "ERROR" : "DEFAULT",
      statusMessage: opts.error || opts.status,
      metadata: {
        elapsed_ms: opts.elapsed_ms,
        dify_status: opts.status,
        dify_cost: opts.cost,
      },
    });
  } catch (_) {
    // Never let tracking break pipelines
  }
}

/** Track an OpenRouter LLM call as a trace + generation */
export function trackLLM(opts: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  output?: string;
  promptTokens?: number;
  completionTokens?: number;
  elapsed_ms: number;
  error?: string;
  sessionId?: string;
  tags?: string[];
}): void {
  try {
    const lf = getLangfuse();
    if (!lf) return;
    const trace = lf.trace({
      name: `llm/${opts.model.split("/").pop()}`,
      sessionId: opts.sessionId || "openrouter",
      userId: "mcp-gateway",
      tags: opts.tags || ["openrouter"],
      metadata: { model: opts.model },
    });
    trace.generation({
      name: opts.model.split("/").pop() || opts.model,
      model: opts.model,
      input: opts.messages,
      output: opts.error ? { error: opts.error } : { content: opts.output },
      usage: {
        input: opts.promptTokens || 0,
        output: opts.completionTokens || 0,
        total: (opts.promptTokens || 0) + (opts.completionTokens || 0),
      },
      startTime: new Date(Date.now() - opts.elapsed_ms),
      endTime: new Date(),
      level: opts.error ? "ERROR" : "DEFAULT",
      statusMessage: opts.error,
      metadata: { elapsed_ms: opts.elapsed_ms },
    });
  } catch (_) {
    // Never let tracking break pipelines
  }
}

/** Flush pending events (call periodically or before shutdown) */
export async function flushLangfuse(): Promise<void> {
  if (instance) {
    try { await instance.flushAsync(); } catch (_) {}
  }
}

/** Graceful shutdown */
export async function shutdownLangfuse(): Promise<void> {
  if (instance) {
    try {
      await instance.shutdownAsync();
      console.log("[langfuse] Shutdown complete");
    } catch (_) {}
    instance = null;
  }
}

