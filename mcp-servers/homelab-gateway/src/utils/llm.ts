/**
 * Shared OpenRouter LLM chat helper.
 * Provides a single openrouterChat() function for all modules that need AI completions.
 * Includes automatic retry with backoff for 429 rate limit errors.
 * Tracks cumulative API cost from token usage.
 */

import { trackLLM } from "./langfuse.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || "localhost";

// ── Cost tracking ───────────────────────────────────────────────────
// Per-million-token pricing (OpenRouter rates, USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "google/gemini-2.0-flash-001": { input: 0.10, output: 0.40 },
  "perplexity/sonar-pro": { input: 3.00, output: 15.00 },
  "anthropic/claude-sonnet-4.5": { input: 3.00, output: 15.00 },
  "anthropic/claude-3.5-sonnet": { input: 3.00, output: 15.00 },
  "anthropic/claude-3.7-sonnet": { input: 3.00, output: 15.00 },
};
const DEFAULT_PRICING = { input: 1.00, output: 3.00 }; // fallback for unknown models

interface CostTracker {
  totalCost: number;
  passCost: number;
  totalCalls: number;
  passCalls: number;
}

const costTracker: CostTracker = { totalCost: 0, passCost: 0, totalCalls: 0, passCalls: 0 };

function recordCost(model: string, promptTokens: number, completionTokens: number): void {
  const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
  const cost = (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
  costTracker.totalCost += cost;
  costTracker.passCost += cost;
  costTracker.totalCalls++;
  costTracker.passCalls++;
}

export function getCostTracker(): CostTracker {
  return { ...costTracker };
}

export function resetPassCost(): void {
  costTracker.passCost = 0;
  costTracker.passCalls = 0;
}

export function resetAllCost(): void {
  costTracker.totalCost = 0;
  costTracker.passCost = 0;
  costTracker.totalCalls = 0;
  costTracker.passCalls = 0;
}

// ── Chat function ───────────────────────────────────────────────────

export async function openrouterChat(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 2000,
  temperature: number = 0.3,
  timeoutMs: number = 120000
): Promise<string> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not configured");

  const startTime = Date.now();
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) console.log(`[openrouterChat] Retry ${attempt}/${maxRetries} for ${model}...`);
    else console.log(`[openrouterChat] Calling ${model} (max_tokens: ${maxTokens}, timeout: ${timeoutMs}ms)...`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${OPENROUTER_URL}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": `https://mcp.${PUBLIC_DOMAIN}`,
          "X-Title": "Homelab MCP Gateway",
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      });
      clearTimeout(timer);

      if (response.status === 429) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 60000);
        console.log(`[openrouterChat] Rate limited (429), waiting ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${error}`);
      }
      const data = await response.json();

      // Track cost from token usage
      const usage = data.usage;
      if (usage) {
        recordCost(model, usage.prompt_tokens || 0, usage.completion_tokens || 0);
      }

      const content = data.choices?.[0]?.message?.content || "";
      console.log(`[openrouterChat] ${model} responded (${content.length} chars, finish: ${data.choices?.[0]?.finish_reason})`);
      trackLLM({
        model,
        messages,
        output: content,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        elapsed_ms: Date.now() - startTime,
      });
      return content;
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        trackLLM({ model, messages, elapsed_ms: Date.now() - startTime, error: "Request timed out" });
        throw new Error("OpenRouter request timed out");
      }
      if (attempt === maxRetries) throw err;
      // For non-429 errors, don't retry
      throw err;
    }
  }
  throw new Error("OpenRouter max retries exceeded (429)");
}

/** Re-export env vars for modules that need them for conditional checks */
export { OPENROUTER_API_KEY, OPENROUTER_URL };
