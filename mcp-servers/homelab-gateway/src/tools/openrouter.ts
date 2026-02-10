import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

async function openrouterRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OpenRouter not configured - check OPENROUTER_API_KEY env var");
  }

  const url = `${OPENROUTER_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://mcp.your-domain.com",
      "X-Title": "Homelab MCP Gateway",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter error: ${response.status} - ${error}`);
  }
  return response.json();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  list_models: {
    description: "List available models on OpenRouter with pricing info",
    params: { filter: "Filter models by name (e.g., 'gpt', 'claude', 'llama')" },
    handler: async ({ filter }) => {
      const result = await openrouterRequest("/models");
      let models = result.data || [];

      if (filter) {
        const lowerFilter = filter.toLowerCase();
        models = models.filter((m: any) =>
          m.id.toLowerCase().includes(lowerFilter) ||
          m.name?.toLowerCase().includes(lowerFilter)
        );
      }

      const summary = models.slice(0, 50).map((m: any) => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: { prompt: m.pricing?.prompt, completion: m.pricing?.completion },
      }));
      return { total: models.length, models: summary };
    },
  },
  chat: {
    description: "Send a chat completion request to any model via OpenRouter",
    params: {
      model: "Model ID (e.g., 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet')",
      messages: "JSON array of {role, content} messages",
      temperature: "Sampling temperature 0-2 (optional)",
      max_tokens: "Max tokens to generate (optional)"
    },
    handler: async ({ model, messages, temperature, max_tokens }) => {
      const parsedMessages = typeof messages === "string" ? JSON.parse(messages) : messages;
      const body: any = { model, messages: parsedMessages };
      if (temperature !== undefined) body.temperature = parseFloat(temperature);
      if (max_tokens !== undefined) body.max_tokens = parseInt(max_tokens);

      const result = await openrouterRequest("/chat/completions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        model: result.model,
        content: result.choices?.[0]?.message?.content,
        usage: result.usage,
        finish_reason: result.choices?.[0]?.finish_reason,
      };
    },
  },
  second_opinion: {
    description: "Get a second opinion on a question or code from a different AI model",
    params: {
      model: "Model to consult (default: gpt-4o)",
      question: "The question or topic",
      context: "Additional context like code snippets (optional)"
    },
    handler: async ({ model = "openai/gpt-4o", question, context }) => {
      const messages: any[] = [];
      if (context) {
        messages.push({ role: "system", content: "You are a helpful assistant providing a second opinion. Be concise but thorough." });
        messages.push({ role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` });
      } else {
        messages.push({ role: "user", content: question });
      }

      const result = await openrouterRequest("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model, messages, max_tokens: 2000 }),
      });
      return { model: result.model, opinion: result.choices?.[0]?.message?.content, usage: result.usage };
    },
  },
  compare: {
    description: "Compare responses from multiple models for the same prompt",
    params: { prompt: "The prompt to send to all models", models: "Comma-separated list of model IDs (2-5 models)" },
    handler: async ({ prompt, models }) => {
      const modelList = models.split(",").map((m: string) => m.trim());
      const results = await Promise.allSettled(
        modelList.map(async (model: string) => {
          const result = await openrouterRequest("/chat/completions", {
            method: "POST",
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1000 }),
          });
          return { model, response: result.choices?.[0]?.message?.content, usage: result.usage };
        })
      );

      const comparison = results.map((r, i) =>
        r.status === "fulfilled" ? r.value : { model: modelList[i], error: (r.reason as any)?.message || "Failed" }
      );
      return { prompt, comparisons: comparison };
    },
  },
  credits: {
    description: "Check OpenRouter account credits and usage",
    params: {},
    handler: async () => {
      const result = await openrouterRequest("/auth/key");
      return { usage: result.data?.usage, limit: result.data?.limit, is_free_tier: result.data?.is_free_tier, rate_limit: result.data?.rate_limit };
    },
  },
};

export function registerOpenrouterTools(server: McpServer) {
  server.tool(
    "ai_list",
    "List all available OpenRouter AI tools for calling other LLMs",
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
    "ai_call",
    "Execute an OpenRouter AI tool. Use ai_list to see available tools.",
    {
      tool: z.string().describe("Tool name from ai_list"),
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
