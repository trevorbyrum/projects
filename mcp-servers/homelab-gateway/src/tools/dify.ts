import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Dify API — internal Docker network URL (not public, bypasses CF Access)
const DIFY_API_URL = process.env.DIFY_API_URL || "http://dify-api:5001";
const DIFY_EMAIL = process.env.DIFY_EMAIL || "";
const DIFY_PASSWORD = process.env.DIFY_PASSWORD || "";

// Cached auth tokens
let cachedAccessToken = "";
let cachedCsrfToken = "";
let tokenExpiresAt = 0;

// --- Auth ---

async function login(): Promise<void> {
  if (!DIFY_EMAIL || !DIFY_PASSWORD) {
    throw new Error("DIFY_EMAIL and DIFY_PASSWORD must be set in env");
  }

  const b64Password = Buffer.from(DIFY_PASSWORD).toString("base64");
  const res = await fetch(`${DIFY_API_URL}/console/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DIFY_EMAIL, password: b64Password, remember_me: true }),
    redirect: "manual",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dify login failed (${res.status}): ${body}`);
  }

  // Extract tokens from Set-Cookie headers
  const cookies = res.headers.getSetCookie?.() || [];
  for (const cookie of cookies) {
    const match = cookie.match(/^([^=]+)=([^;]+)/);
    if (!match) continue;
    const [, name, value] = match;
    if (name === "__Host-access_token" || name === "access_token") cachedAccessToken = value;
    if (name === "__Host-csrf_token" || name === "csrf_token") cachedCsrfToken = value;
  }

  if (!cachedAccessToken) {
    // Fallback: try raw header parsing
    const rawHeaders = res.headers as any;
    const setCookieRaw = rawHeaders.raw?.()?.["set-cookie"] || [];
    for (const cookie of setCookieRaw) {
      if (cookie.includes("access_token=")) {
        cachedAccessToken = cookie.split("access_token=")[1].split(";")[0];
      }
      if (cookie.includes("csrf_token=")) {
        cachedCsrfToken = cookie.split("csrf_token=")[1].split(";")[0];
      }
    }
  }

  if (!cachedAccessToken) {
    throw new Error("Login succeeded but no access_token in Set-Cookie headers");
  }

  // Token expires in 1hr, refresh at 50min
  tokenExpiresAt = Date.now() + 50 * 60 * 1000;
}

async function ensureAuth(): Promise<void> {
  if (!cachedAccessToken || Date.now() >= tokenExpiresAt) {
    await login();
  }
}

// --- HTTP helpers ---

async function consoleFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  await ensureAuth();
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

  if (res.status === 401) {
    // Token expired, re-login and retry once
    cachedAccessToken = "";
    await ensureAuth();
    const retry = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cachedAccessToken}`,
        "X-CSRF-Token": cachedCsrfToken,
        Cookie: `__Host-access_token=${cachedAccessToken}; __Host-csrf_token=${cachedCsrfToken}`,
        ...options.headers,
      },
    });
    if (!retry.ok) {
      const err = await retry.text();
      throw new Error(`Dify Console API error (${retry.status}): ${err}`);
    }
    if (retry.status === 204) return { success: true };
    return retry.json();
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dify Console API error (${res.status}): ${err}`);
  }
  if (res.status === 204) return { success: true };
  const contentType = res.headers.get("content-type");
  if (contentType?.includes("application/json")) return res.json();
  return res.text();
}

async function appFetch(endpoint: string, apiKey: string, options: RequestInit = {}): Promise<any> {
  const url = `${DIFY_API_URL}/v1${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dify App API error (${res.status}): ${err}`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

// --- Tools ---

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {

  // ===== Auth =====

  login: {
    description: "Authenticate with Dify Console API and cache JWT token. Called automatically by other tools when needed.",
    params: {},
    handler: async () => {
      await login();
      return { status: "authenticated", email: DIFY_EMAIL, expires_in: "1 hour" };
    },
  },

  // ===== App Management =====

  list_apps: {
    description: "List all Dify apps with their type, status, and IDs",
    params: { page: "number (optional) - page number, default 1", limit: "number (optional) - items per page, default 20", name: "string (optional) - filter by name" },
    handler: async ({ page, limit, name }) => {
      const params = new URLSearchParams();
      params.set("page", String(page || 1));
      params.set("limit", String(limit || 20));
      if (name) params.set("name", name);
      return await consoleFetch(`/apps?${params}`);
    },
  },

  create_app: {
    description: "Create a new Dify app (chatbot, workflow, agent, or completion)",
    params: {
      name: "string - app name",
      mode: "string - app type: chat, workflow, agent-chat, advanced-chat, or completion",
      description: "string (optional) - app description",
      icon_type: "string (optional) - 'emoji' or 'image', default 'emoji'",
      icon: "string (optional) - emoji character, default '🤖'",
    },
    handler: async ({ name, mode, description, icon_type, icon }) => {
      return await consoleFetch("/apps", {
        method: "POST",
        body: JSON.stringify({
          name,
          mode,
          description: description || "",
          icon_type: icon_type || "emoji",
          icon: icon || "🤖",
          icon_background: "#FFEAD5",
        }),
      });
    },
  },

  get_app: {
    description: "Get detailed information about a specific app",
    params: { app_id: "string - the app ID" },
    handler: async ({ app_id }) => {
      return await consoleFetch(`/apps/${app_id}`);
    },
  },

  delete_app: {
    description: "Delete a Dify app permanently",
    params: { app_id: "string - the app ID to delete" },
    handler: async ({ app_id }) => {
      await consoleFetch(`/apps/${app_id}`, { method: "DELETE" });
      return { status: "deleted", app_id };
    },
  },

  // ===== App Configuration =====

  get_app_config: {
    description: "Get full app configuration including model, prompt, tools, and settings",
    params: { app_id: "string - the app ID" },
    handler: async ({ app_id }) => {
      return await consoleFetch(`/apps/${app_id}/model-config`);
    },
  },

  update_app_config: {
    description: "Update app configuration (model, prompt, tools, opening statement, etc.)",
    params: {
      app_id: "string - the app ID",
      config: "object - the full or partial model config object (pre_prompt, model, agent_mode, etc.)",
    },
    handler: async ({ app_id, config }) => {
      const parsed = typeof config === "string" ? JSON.parse(config) : config;
      return await consoleFetch(`/apps/${app_id}/model-config`, {
        method: "POST",
        body: JSON.stringify(parsed),
      });
    },
  },

  publish_app: {
    description: "Publish the current draft app configuration to make it live",
    params: { app_id: "string - the app ID" },
    handler: async ({ app_id }) => {
      return await consoleFetch(`/apps/${app_id}/publish`, { method: "POST" });
    },
  },

  // ===== Model Providers =====

  list_model_providers: {
    description: "List all configured model providers and their status",
    params: {},
    handler: async () => {
      return await consoleFetch("/workspaces/current/model-providers");
    },
  },

  configure_model_provider: {
    description: "Configure a model provider with API credentials (e.g. openai, anthropic, ollama)",
    params: {
      provider: "string - provider name (e.g. 'openai', 'anthropic', 'ollama', 'openrouter')",
      credentials: "object - provider-specific credentials (e.g. {openai_api_key: '...'})",
    },
    handler: async ({ provider, credentials }) => {
      const parsed = typeof credentials === "string" ? JSON.parse(credentials) : credentials;
      return await consoleFetch(`/workspaces/current/model-providers/${provider}`, {
        method: "POST",
        body: JSON.stringify({ credentials: parsed }),
      });
    },
  },

  list_models: {
    description: "List available models for a specific provider",
    params: { provider: "string - provider name (e.g. 'openai', 'anthropic')" },
    handler: async ({ provider }) => {
      return await consoleFetch(`/workspaces/current/model-providers/${provider}/models`);
    },
  },

  // ===== Tools & MCP =====

  list_tools: {
    description: "List all available tools (built-in, API-based, and MCP) that can be used in apps",
    params: {},
    handler: async () => {
      return await consoleFetch("/workspaces/current/tools");
    },
  },

  get_app_tools: {
    description: "Get the tools currently enabled for a specific app/agent",
    params: { app_id: "string - the app ID" },
    handler: async ({ app_id }) => {
      const config = await consoleFetch(`/apps/${app_id}/model-config`);
      return {
        app_id,
        agent_mode: config.agent_mode,
        tools: config.agent_mode?.tools || config.tools || [],
      };
    },
  },

  update_app_tools: {
    description: "Enable or disable tools for an agent app. Pass the full tools array.",
    params: {
      app_id: "string - the app ID",
      tools: "array - array of tool config objects to enable for this agent",
    },
    handler: async ({ app_id, tools: toolsConfig }) => {
      const parsed = typeof toolsConfig === "string" ? JSON.parse(toolsConfig) : toolsConfig;
      // Get current config, update tools, and save
      const current = await consoleFetch(`/apps/${app_id}/model-config`);
      if (current.agent_mode) {
        current.agent_mode.tools = parsed;
      }
      return await consoleFetch(`/apps/${app_id}/model-config`, {
        method: "POST",
        body: JSON.stringify(current),
      });
    },
  },

  list_mcp_servers: {
    description: "List all configured MCP tool providers",
    params: {},
    handler: async () => {
      return await consoleFetch("/workspaces/current/tool-providers?category=mcp");
    },
  },

  add_mcp_server: {
    description: "Add an external MCP server as a tool provider",
    params: {
      name: "string - display name for the MCP server",
      url: "string - MCP server URL (SSE or streamable HTTP endpoint)",
      headers: "object (optional) - custom headers for authentication",
    },
    handler: async ({ name, url, headers }) => {
      const parsedHeaders = headers ? (typeof headers === "string" ? JSON.parse(headers) : headers) : {};
      return await consoleFetch("/workspaces/current/tool-providers/mcp/create", {
        method: "POST",
        body: JSON.stringify({ name, url, headers: parsedHeaders }),
      });
    },
  },

  remove_mcp_server: {
    description: "Remove an MCP server tool provider",
    params: { provider_id: "string - the MCP provider ID to remove" },
    handler: async ({ provider_id }) => {
      await consoleFetch(`/workspaces/current/tool-providers/mcp/${provider_id}`, { method: "DELETE" });
      return { status: "removed", provider_id };
    },
  },

  // ===== API Tools (non-MCP) =====

  list_api_tools: {
    description: "List custom API-based tool providers (OpenAPI schema tools)",
    params: {},
    handler: async () => {
      return await consoleFetch("/workspaces/current/tool-providers?category=api");
    },
  },

  create_api_tool: {
    description: "Create a custom API tool provider from an OpenAPI schema",
    params: {
      name: "string - tool provider name",
      schema: "string - OpenAPI schema (JSON or YAML string)",
      credentials: "object (optional) - auth credentials for the API",
    },
    handler: async ({ name, schema, credentials }) => {
      const parsedCreds = credentials ? (typeof credentials === "string" ? JSON.parse(credentials) : credentials) : {};
      return await consoleFetch("/workspaces/current/tool-providers/api/create", {
        method: "POST",
        body: JSON.stringify({ name, schema, credentials: parsedCreds }),
      });
    },
  },

  // ===== Datasets / Knowledge =====

  list_datasets: {
    description: "List all knowledge base datasets",
    params: { page: "number (optional) - page number", limit: "number (optional) - items per page" },
    handler: async ({ page, limit }) => {
      const params = new URLSearchParams();
      params.set("page", String(page || 1));
      params.set("limit", String(limit || 20));
      return await consoleFetch(`/datasets?${params}`);
    },
  },

  create_dataset: {
    description: "Create a new knowledge base dataset",
    params: { name: "string - dataset name", description: "string (optional) - dataset description" },
    handler: async ({ name, description }) => {
      return await consoleFetch("/datasets", {
        method: "POST",
        body: JSON.stringify({ name, description: description || "" }),
      });
    },
  },

  delete_dataset: {
    description: "Delete a knowledge base dataset",
    params: { dataset_id: "string - the dataset ID to delete" },
    handler: async ({ dataset_id }) => {
      await consoleFetch(`/datasets/${dataset_id}`, { method: "DELETE" });
      return { status: "deleted", dataset_id };
    },
  },

  list_documents: {
    description: "List documents in a knowledge base dataset",
    params: { dataset_id: "string - the dataset ID", page: "number (optional)", limit: "number (optional)" },
    handler: async ({ dataset_id, page, limit }) => {
      const params = new URLSearchParams();
      params.set("page", String(page || 1));
      params.set("limit", String(limit || 20));
      return await consoleFetch(`/datasets/${dataset_id}/documents?${params}`);
    },
  },

  upload_document: {
    description: "Upload a text document to a knowledge base dataset",
    params: {
      dataset_id: "string - the dataset ID",
      name: "string - document name",
      text: "string - document text content",
      indexing_technique: "string (optional) - 'high_quality' or 'economy', default 'high_quality'",
    },
    handler: async ({ dataset_id, name, text, indexing_technique }) => {
      return await consoleFetch(`/datasets/${dataset_id}/document/create-by-text`, {
        method: "POST",
        body: JSON.stringify({
          name,
          text,
          indexing_technique: indexing_technique || "high_quality",
          process_rule: { mode: "automatic" },
        }),
      });
    },
  },

  link_dataset: {
    description: "Link a knowledge base dataset to an app for RAG context",
    params: { app_id: "string - the app ID", dataset_ids: "array - array of dataset IDs to link" },
    handler: async ({ app_id, dataset_ids }) => {
      const parsed = typeof dataset_ids === "string" ? JSON.parse(dataset_ids) : dataset_ids;
      return await consoleFetch(`/apps/${app_id}/datasets`, {
        method: "POST",
        body: JSON.stringify({ dataset_ids: parsed }),
      });
    },
  },

  // ===== Workflows =====

  get_workflow: {
    description: "Get the full workflow graph (nodes, edges, variables) for a workflow app",
    params: { app_id: "string - the workflow app ID" },
    handler: async ({ app_id }) => {
      return await consoleFetch(`/apps/${app_id}/workflows/draft`);
    },
  },

  update_workflow: {
    description: "Update the workflow graph (nodes, edges) for a workflow app",
    params: {
      app_id: "string - the workflow app ID",
      graph: "object - the workflow graph with nodes and edges arrays",
    },
    handler: async ({ app_id, graph }) => {
      const parsed = typeof graph === "string" ? JSON.parse(graph) : graph;
      return await consoleFetch(`/apps/${app_id}/workflows/draft`, {
        method: "POST",
        body: JSON.stringify(parsed),
      });
    },
  },

  publish_workflow: {
    description: "Publish a workflow draft to make it executable",
    params: { app_id: "string - the workflow app ID" },
    handler: async ({ app_id }) => {
      return await consoleFetch(`/apps/${app_id}/workflows/publish`, { method: "POST" });
    },
  },

  // ===== App API Keys =====

  get_app_api_keys: {
    description: "Get API keys for a specific app (used for /v1 endpoint access)",
    params: { app_id: "string - the app ID" },
    handler: async ({ app_id }) => {
      return await consoleFetch(`/apps/${app_id}/api-keys`);
    },
  },

  create_app_api_key: {
    description: "Create a new API key for a specific app",
    params: { app_id: "string - the app ID" },
    handler: async ({ app_id }) => {
      return await consoleFetch(`/apps/${app_id}/api-keys`, { method: "POST" });
    },
  },

  // ===== Runtime: Chat / Workflow / Completion =====

  chat: {
    description: "Send a message to a chatbot or agent app via its per-app API key",
    params: {
      api_key: "string - the app's API key (from get_app_api_keys)",
      message: "string - the user message",
      conversation_id: "string (optional) - continue an existing conversation",
      user: "string (optional) - user identifier, default 'api-user'",
    },
    handler: async ({ api_key, message, conversation_id, user }) => {
      const body: any = {
        inputs: {},
        query: message,
        response_mode: "blocking",
        user: user || "api-user",
      };
      if (conversation_id) body.conversation_id = conversation_id;
      return await appFetch("/chat-messages", api_key, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  },

  run_workflow: {
    description: "Execute a workflow app via its per-app API key",
    params: {
      api_key: "string - the app's API key",
      inputs: "object (optional) - workflow input variables",
      user: "string (optional) - user identifier, default 'api-user'",
    },
    handler: async ({ api_key, inputs, user }) => {
      const parsedInputs = inputs ? (typeof inputs === "string" ? JSON.parse(inputs) : inputs) : {};
      return await appFetch("/workflows/run", api_key, {
        method: "POST",
        body: JSON.stringify({
          inputs: parsedInputs,
          response_mode: "blocking",
          user: user || "api-user",
        }),
      });
    },
  },

  completion: {
    description: "Send a text completion request via an app's per-app API key",
    params: {
      api_key: "string - the app's API key",
      inputs: "object - input variables for the completion",
      user: "string (optional) - user identifier, default 'api-user'",
    },
    handler: async ({ api_key, inputs, user }) => {
      const parsedInputs = typeof inputs === "string" ? JSON.parse(inputs) : inputs;
      return await appFetch("/completion-messages", api_key, {
        method: "POST",
        body: JSON.stringify({
          inputs: parsedInputs,
          response_mode: "blocking",
          user: user || "api-user",
        }),
      });
    },
  },

  // ===== Monitoring =====

  list_conversations: {
    description: "List conversations for an app",
    params: {
      app_id: "string - the app ID",
      page: "number (optional) - page number",
      limit: "number (optional) - items per page",
    },
    handler: async ({ app_id, page, limit }) => {
      const params = new URLSearchParams();
      params.set("page", String(page || 1));
      params.set("limit", String(limit || 20));
      return await consoleFetch(`/apps/${app_id}/conversations?${params}`);
    },
  },

  get_app_logs: {
    description: "Get conversation logs and messages for an app",
    params: {
      app_id: "string - the app ID",
      page: "number (optional) - page number",
      limit: "number (optional) - items per page",
    },
    handler: async ({ app_id, page, limit }) => {
      const params = new URLSearchParams();
      params.set("page", String(page || 1));
      params.set("limit", String(limit || 20));
      return await consoleFetch(`/apps/${app_id}/messages?${params}`);
    },
  },

  get_app_stats: {
    description: "Get usage statistics for an app (token usage, request count, etc.)",
    params: {
      app_id: "string - the app ID",
      start: "string (optional) - start date YYYY-MM-DD",
      end: "string (optional) - end date YYYY-MM-DD",
    },
    handler: async ({ app_id, start, end }) => {
      const params = new URLSearchParams();
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      return await consoleFetch(`/apps/${app_id}/statistics/daily-conversations?${params}`);
    },
  },

  // ===== Files =====

  upload_file: {
    description: "Upload a file for use as context in chat or workflow (returns file ID)",
    params: {
      api_key: "string - the app's API key",
      file_content: "string - base64-encoded file content",
      filename: "string - the filename with extension",
      user: "string (optional) - user identifier, default 'api-user'",
    },
    handler: async ({ api_key, file_content, filename, user }) => {
      // Dify expects multipart form data for file uploads
      const boundary = "----DifyFileBoundary" + Date.now();
      const fileBuffer = Buffer.from(file_content, "base64");
      const body = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        "Content-Type: application/octet-stream",
        "",
        fileBuffer.toString("binary"),
        `--${boundary}`,
        `Content-Disposition: form-data; name="user"`,
        "",
        user || "api-user",
        `--${boundary}--`,
      ].join("\r\n");

      const res = await fetch(`${DIFY_API_URL}/v1/files/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${api_key}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`File upload failed (${res.status}): ${err}`);
      }
      return res.json();
    },
  },
};

// --- Registration ---

export function registerDifyTools(server: McpServer) {
  server.tool(
    "dify_list",
    "List all available Dify AI platform tools. Dify is a self-hosted AI app builder at dify.your-domain.com. " +
    "Tools cover: app management (create/edit/delete apps), model provider config, " +
    "tool & MCP server management, knowledge base/RAG datasets, workflow editing, " +
    "runtime execution (chat, workflow, completion), monitoring/logs, and file uploads. " +
    "Console tools auto-authenticate via JWT. App runtime tools require per-app API keys.",
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
    "dify_call",
    "Execute a Dify tool. Use dify_list to see available tools. " +
    "Manages the self-hosted Dify AI platform: apps, models, tools, MCP servers, knowledge bases, workflows, and runtime.",
    {
      tool: z.string().describe("Tool name from dify_list"),
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
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
