import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// OpenHands API — internal Docker network URL
const OPENHANDS_URL = process.env.OPENHANDS_URL || "http://openhands:3000";
const OPENHANDS_API_KEY = process.env.OPENHANDS_API_KEY || "";

// --- Fetch helper ---

async function ohFetch(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  if (OPENHANDS_API_KEY) {
    headers["X-Session-API-Key"] = OPENHANDS_API_KEY;
  }

  const res = await fetch(`${OPENHANDS_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenHands API ${res.status}: ${body}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ── Server Config ──────────────────────────────────────────

  get_config: {
    description: "Get OpenHands server configuration (app mode, feature flags)",
    params: {},
    handler: async () => ohFetch("/api/options/config"),
  },

  list_models: {
    description: "List available LLM models",
    params: {},
    handler: async () => ohFetch("/api/options/models"),
  },

  list_agents: {
    description: "List available AI agents",
    params: {},
    handler: async () => ohFetch("/api/options/agents"),
  },

  list_security_analyzers: {
    description: "List available security analyzers",
    params: {},
    handler: async () => ohFetch("/api/options/security-analyzers"),
  },

  // ── Settings ───────────────────────────────────────────────

  get_settings: {
    description: "Get current user settings (LLM config, agent, etc.)",
    params: {},
    handler: async () => ohFetch("/api/settings"),
  },

  update_settings: {
    description: "Update user settings (LLM model, API key, agent, language, etc.)",
    params: {
      settings: "Object with settings fields: llm_model, llm_api_key, llm_base_url, agent, language, confirmation_mode, security_analyzer, etc.",
    },
    handler: async (p) => ohFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify(p.settings || p),
    }),
  },

  // ── Conversations (Sessions) ───────────────────────────────

  list_conversations: {
    description: "List conversations with optional filters. Returns paginated results.",
    params: {
      page: "(optional) Page number, default 1",
      limit: "(optional) Results per page, default 20",
      status: "(optional) Filter: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR'",
      query: "(optional) Search by title",
    },
    handler: async (p) => {
      const params = new URLSearchParams();
      if (p.page) params.set("page", String(p.page));
      if (p.limit) params.set("limit", String(p.limit));
      if (p.status) params.set("status", p.status);
      if (p.query) params.set("q", p.query);
      const qs = params.toString();
      return ohFetch(`/api/conversations${qs ? "?" + qs : ""}`);
    },
  },

  create_conversation: {
    description: "Create a new conversation/coding session. Optionally provide initial instructions and a repo to clone.",
    params: {
      initial_user_msg: "(optional) Initial task/prompt for the agent",
      repository: "(optional) Git repo URL to clone into workspace",
      selected_branch: "(optional) Branch to checkout",
      conversation_instructions: "(optional) System-level instructions for the agent",
    },
    handler: async (p) => {
      const body: Record<string, any> = {};
      if (p.initial_user_msg) body.initial_user_msg = p.initial_user_msg;
      if (p.repository) body.repository = p.repository;
      if (p.selected_branch) body.selected_branch = p.selected_branch;
      if (p.conversation_instructions) body.conversation_instructions = p.conversation_instructions;
      return ohFetch("/api/conversations", { method: "POST", body: JSON.stringify(body) });
    },
  },

  get_conversation: {
    description: "Get details of a specific conversation",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}`),
  },

  delete_conversation: {
    description: "Delete a conversation and its data",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}`, { method: "DELETE" }),
  },

  update_conversation: {
    description: "Update a conversation's title",
    params: {
      conversation_id: "Conversation ID",
      title: "New title",
    },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: p.title }),
    }),
  },

  // ── Agent Control ──────────────────────────────────────────

  start_conversation: {
    description: "Start the AI agent loop for a conversation. The agent will begin working on the task.",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}/start`, { method: "POST" }),
  },

  stop_conversation: {
    description: "Stop the AI agent loop for a conversation",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}/stop`, { method: "POST" }),
  },

  // ── Events & Messages ─────────────────────────────────────

  get_events: {
    description: "Get events from a conversation's event stream. Supports pagination.",
    params: {
      conversation_id: "Conversation ID",
      start_id: "(optional) Start from this event ID",
      limit: "(optional) Max events to return, default 50",
      event_type: "(optional) Filter by event type",
    },
    handler: async (p) => {
      const params = new URLSearchParams();
      if (p.start_id !== undefined) params.set("start_id", String(p.start_id));
      if (p.limit) params.set("limit", String(p.limit));
      if (p.event_type) params.set("event_type", p.event_type);
      const qs = params.toString();
      return ohFetch(`/api/conversations/${p.conversation_id}/events${qs ? "?" + qs : ""}`);
    },
  },

  send_message: {
    description: "Send a user message to a running conversation",
    params: {
      conversation_id: "Conversation ID",
      message: "The message text to send",
      image_urls: "(optional) Array of image URLs to include",
    },
    handler: async (p) => {
      const body: Record<string, any> = { message: p.message };
      if (p.image_urls) body.image_urls = p.image_urls;
      return ohFetch(`/api/conversations/${p.conversation_id}/message`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  },

  send_event: {
    description: "Send a raw event to a conversation (advanced). Used for custom actions like CmdRunAction, FileWriteAction, etc.",
    params: {
      conversation_id: "Conversation ID",
      event: "Event object with 'action' field and action-specific params",
    },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}/events`, {
      method: "POST",
      body: JSON.stringify(p.event),
    }),
  },

  // ── Conversation Runtime Info ──────────────────────────────

  get_runtime_config: {
    description: "Get runtime configuration for a conversation (runtime_id, session_id)",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}/config`),
  },

  get_vscode_url: {
    description: "Get the VS Code URL for a conversation's workspace",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}/vscode-url`),
  },

  get_web_hosts: {
    description: "Get web host URLs for a conversation's runtime (ports exposed by the sandbox)",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}/web-hosts`),
  },

  get_microagents: {
    description: "Get microagents loaded in a conversation",
    params: { conversation_id: "Conversation ID" },
    handler: async (p) => ohFetch(`/api/conversations/${p.conversation_id}/microagents`),
  },

  // ── Secrets ────────────────────────────────────────────────

  list_secrets: {
    description: "List stored secret names (values are not returned)",
    params: {},
    handler: async () => ohFetch("/api/secrets"),
  },

  create_secret: {
    description: "Create a new secret (stored server-side, available to agent)",
    params: {
      name: "Secret name",
      value: "Secret value",
      description: "(optional) Description of the secret",
    },
    handler: async (p) => ohFetch("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name: p.name, value: p.value, description: p.description }),
    }),
  },

  update_secret: {
    description: "Update an existing secret's value",
    params: {
      secret_id: "Secret ID",
      name: "(optional) New name",
      value: "(optional) New value",
      description: "(optional) New description",
    },
    handler: async (p) => {
      const body: Record<string, any> = {};
      if (p.name) body.name = p.name;
      if (p.value) body.value = p.value;
      if (p.description !== undefined) body.description = p.description;
      return ohFetch(`/api/secrets/${p.secret_id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
  },

  delete_secret: {
    description: "Delete a stored secret",
    params: { secret_id: "Secret ID" },
    handler: async (p) => ohFetch(`/api/secrets/${p.secret_id}`, { method: "DELETE" }),
  },

  // ── Git Providers ──────────────────────────────────────────

  add_git_providers: {
    description: "Store git provider tokens (GitHub, GitLab, Bitbucket) for the agent to use",
    params: {
      providers: "Array of {provider: 'github'|'gitlab'|'bitbucket', access_token: string}",
    },
    handler: async (p) => ohFetch("/api/add-git-providers", {
      method: "POST",
      body: JSON.stringify(p.providers),
    }),
  },

  clear_git_providers: {
    description: "Clear all stored git provider tokens",
    params: {},
    handler: async () => ohFetch("/api/unset-provider-tokens", { method: "POST" }),
  },
};

// --- Registration ---

export function registerOpenhandsTools(server: McpServer) {
  server.tool(
    "openhands_list",
    "List all available OpenHands AI coding agent tools. OpenHands is a self-hosted autonomous " +
    "coding agent. Tools cover: conversation/session management (create, list, " +
    "start/stop agent), messaging (send tasks, view events), runtime info (VS Code URL, " +
    "web hosts), settings (LLM config), secrets management, and git provider integration. " +
    "Use create_conversation to start a new coding task, then start_conversation to run the agent.",
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
    "openhands_call",
    "Execute an OpenHands tool. Use openhands_list to see available tools. " +
    "Manages the self-hosted OpenHands AI coding agent: conversations, agent control, events, settings, and secrets.",
    {
      tool: z.string().describe("Tool name from openhands_list"),
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
