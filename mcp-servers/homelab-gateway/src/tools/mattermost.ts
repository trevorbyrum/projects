import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MM_URL = process.env.MATTERMOST_URL || "http://mattermost:8065";
const MM_TOKEN = process.env.MATTERMOST_TOKEN || "";

async function mmFetch(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${MM_URL}/api/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MM_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Mattermost API error (${res.status}): ${err}`);
  }
  const text = await res.text();
  if (!text) return { status: "ok" };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {

  // ===== Teams =====

  list_teams: {
    description: "List all teams",
    params: {},
    handler: async () => mmFetch("/teams"),
  },

  get_team: {
    description: "Get team by ID or name",
    params: { team: "string - team ID or name" },
    handler: async ({ team }) => {
      // Try by name first, fall back to ID
      try {
        return await mmFetch(`/teams/name/${team}`);
      } catch {
        return await mmFetch(`/teams/${team}`);
      }
    },
  },

  create_team: {
    description: "Create a new team",
    params: {
      name: "string - unique team name (lowercase, no spaces)",
      display_name: "string - display name",
      type: "string (optional) - 'O' for open (default), 'I' for invite-only",
    },
    handler: async ({ name, display_name, type }) => {
      return await mmFetch("/teams", {
        method: "POST",
        body: JSON.stringify({ name, display_name, type: type || "O" }),
      });
    },
  },

  // ===== Channels =====

  list_channels: {
    description: "List channels in a team",
    params: {
      team_id: "string - the team ID",
      include_private: "boolean (optional) - include private channels (default false)",
    },
    handler: async ({ team_id, include_private }) => {
      const pub = await mmFetch(`/teams/${team_id}/channels?per_page=200`);
      if (include_private) {
        // Need to get private channels via user's membership
        const priv = await mmFetch(`/teams/${team_id}/channels/private?per_page=200`).catch(() => []);
        return [...pub, ...priv];
      }
      return pub;
    },
  },

  get_channel: {
    description: "Get channel by ID or by team_id + channel name",
    params: {
      channel_id: "string (optional) - channel ID",
      team_id: "string (optional) - team ID (required with channel_name)",
      channel_name: "string (optional) - channel name (required with team_id)",
    },
    handler: async ({ channel_id, team_id, channel_name }) => {
      if (channel_id) return await mmFetch(`/channels/${channel_id}`);
      if (team_id && channel_name) return await mmFetch(`/teams/${team_id}/channels/name/${channel_name}`);
      throw new Error("Provide channel_id or both team_id and channel_name");
    },
  },

  create_channel: {
    description: "Create a new channel in a team",
    params: {
      team_id: "string - the team ID",
      name: "string - unique channel name (lowercase, hyphens ok)",
      display_name: "string - display name",
      type: "string (optional) - 'O' for public (default), 'P' for private",
      purpose: "string (optional) - channel purpose",
      header: "string (optional) - channel header (shown at top)",
    },
    handler: async ({ team_id, name, display_name, type, purpose, header }) => {
      return await mmFetch("/channels", {
        method: "POST",
        body: JSON.stringify({
          team_id,
          name,
          display_name,
          type: type || "O",
          purpose: purpose || "",
          header: header || "",
        }),
      });
    },
  },

  archive_channel: {
    description: "Archive (soft-delete) a channel",
    params: { channel_id: "string - the channel ID" },
    handler: async ({ channel_id }) => {
      return await mmFetch(`/channels/${channel_id}`, { method: "DELETE" });
    },
  },

  add_to_channel: {
    description: "Add a user or bot to a channel",
    params: {
      channel_id: "string - the channel ID",
      user_id: "string - the user or bot ID to add",
    },
    handler: async ({ channel_id, user_id }) => {
      return await mmFetch(`/channels/${channel_id}/members`, {
        method: "POST",
        body: JSON.stringify({ user_id }),
      });
    },
  },

  // ===== Users =====

  list_users: {
    description: "List users (includes bots if requested)",
    params: {
      page: "number (optional) - page number (default 0)",
      per_page: "number (optional) - results per page (default 60)",
      include_bots: "boolean (optional) - include bot accounts",
    },
    handler: async ({ page, per_page, include_bots }) => {
      const params = new URLSearchParams();
      params.set("page", String(page || 0));
      params.set("per_page", String(per_page || 60));
      if (include_bots) params.set("role", "");
      return await mmFetch(`/users?${params}`);
    },
  },

  get_user: {
    description: "Get user by ID, username, or email",
    params: { user: "string - user ID, username, or email" },
    handler: async ({ user }) => {
      if (user.includes("@")) return await mmFetch(`/users/email/${user}`);
      try {
        return await mmFetch(`/users/username/${user}`);
      } catch {
        return await mmFetch(`/users/${user}`);
      }
    },
  },

  // ===== Bots =====

  list_bots: {
    description: "List all bot accounts",
    params: { include_deleted: "boolean (optional) - include deleted bots" },
    handler: async ({ include_deleted }) => {
      const params = include_deleted ? "?include_deleted=true" : "";
      return await mmFetch(`/bots${params}`);
    },
  },

  create_bot: {
    description: "Create a bot account (returns bot_id, use create_bot_token to get an access token)",
    params: {
      username: "string - bot username (lowercase, no spaces)",
      display_name: "string - display name",
      description: "string (optional) - bot description",
    },
    handler: async ({ username, display_name, description }) => {
      return await mmFetch("/bots", {
        method: "POST",
        body: JSON.stringify({ username, display_name, description: description || "" }),
      });
    },
  },

  create_bot_token: {
    description: "Create an access token for a bot (save this - it's only shown once)",
    params: {
      bot_user_id: "string - the bot's user_id (from create_bot response)",
      description: "string - token description",
    },
    handler: async ({ bot_user_id, description }) => {
      return await mmFetch(`/users/${bot_user_id}/tokens`, {
        method: "POST",
        body: JSON.stringify({ description }),
      });
    },
  },

  // ===== Webhooks =====

  list_incoming_webhooks: {
    description: "List incoming webhooks (for external services to POST messages into channels)",
    params: { team_id: "string (optional) - filter by team" },
    handler: async ({ team_id }) => {
      const params = team_id ? `?team_id=${team_id}` : "";
      return await mmFetch(`/hooks/incoming${params}`);
    },
  },

  create_incoming_webhook: {
    description: "Create an incoming webhook (returns a URL that accepts POST requests to send messages)",
    params: {
      channel_id: "string - target channel ID",
      display_name: "string - webhook display name",
      description: "string (optional) - webhook description",
      username: "string (optional) - override display username for posts",
      icon_url: "string (optional) - override icon URL for posts",
    },
    handler: async ({ channel_id, display_name, description, username, icon_url }) => {
      const hook = await mmFetch("/hooks/incoming", {
        method: "POST",
        body: JSON.stringify({
          channel_id,
          display_name,
          description: description || "",
          username: username || "",
          icon_url: icon_url || "",
        }),
      });
      return {
        ...hook,
        webhook_url: `${MM_URL}/hooks/${hook.id}`,
      };
    },
  },

  list_outgoing_webhooks: {
    description: "List outgoing webhooks (Mattermost POSTs to external URL when trigger words are used)",
    params: { team_id: "string (optional) - filter by team" },
    handler: async ({ team_id }) => {
      const params = team_id ? `?team_id=${team_id}` : "";
      return await mmFetch(`/hooks/outgoing${params}`);
    },
  },

  create_outgoing_webhook: {
    description: "Create an outgoing webhook (triggers external URL when specific words appear in messages)",
    params: {
      team_id: "string - the team ID",
      channel_id: "string (optional) - restrict to specific channel",
      display_name: "string - webhook display name",
      trigger_words: "array - words that trigger the webhook",
      callback_urls: "array - URLs to POST the message to",
      content_type: "string (optional) - 'application/json' (default) or 'application/x-www-form-urlencoded'",
    },
    handler: async ({ team_id, channel_id, display_name, trigger_words, callback_urls, content_type }) => {
      const tw = typeof trigger_words === "string" ? JSON.parse(trigger_words) : trigger_words;
      const cu = typeof callback_urls === "string" ? JSON.parse(callback_urls) : callback_urls;
      return await mmFetch("/hooks/outgoing", {
        method: "POST",
        body: JSON.stringify({
          team_id,
          channel_id: channel_id || "",
          display_name,
          trigger_words: tw,
          callback_urls: cu,
          content_type: content_type || "application/json",
        }),
      });
    },
  },

  delete_webhook: {
    description: "Delete an incoming or outgoing webhook",
    params: {
      hook_id: "string - the webhook ID",
      type: "string - 'incoming' or 'outgoing'",
    },
    handler: async ({ hook_id, type }) => {
      const path = type === "outgoing" ? `/hooks/outgoing/${hook_id}` : `/hooks/incoming/${hook_id}`;
      await mmFetch(path, { method: "DELETE" });
      return { status: "deleted", hook_id, type };
    },
  },

  // ===== Slash Commands =====

  list_commands: {
    description: "List custom slash commands for a team",
    params: { team_id: "string - the team ID" },
    handler: async ({ team_id }) => {
      return await mmFetch(`/commands?team_id=${team_id}`);
    },
  },

  create_command: {
    description: "Create a custom slash command that triggers an external URL",
    params: {
      team_id: "string - the team ID",
      trigger: "string - the slash command trigger word (without /)",
      url: "string - the callback URL to POST to",
      method: "string (optional) - 'P' for POST (default) or 'G' for GET",
      display_name: "string (optional) - command display name",
      description: "string (optional) - command description",
      auto_complete: "boolean (optional) - show in autocomplete (default true)",
      auto_complete_hint: "string (optional) - hint text shown in autocomplete",
    },
    handler: async ({ team_id, trigger, url, method: reqMethod, display_name, description, auto_complete, auto_complete_hint }) => {
      return await mmFetch("/commands", {
        method: "POST",
        body: JSON.stringify({
          team_id,
          trigger,
          url,
          method: reqMethod || "P",
          display_name: display_name || trigger,
          description: description || "",
          auto_complete: auto_complete !== false,
          auto_complete_hint: auto_complete_hint || "",
        }),
      });
    },
  },

  // ===== Admin Config =====

  get_config: {
    description: "Get specific Mattermost server config section",
    params: { section: "string (optional) - config section name (e.g. 'EmailSettings', 'ServiceSettings'). Omit for full config." },
    handler: async ({ section }) => {
      const config = await mmFetch("/config");
      if (section) return { [section]: config[section] };
      // Return section names only to avoid dumping massive config
      return { sections: Object.keys(config) };
    },
  },

  update_config: {
    description: "Update Mattermost server config (pass partial config, merged with existing)",
    params: { config: "object - partial config to merge (e.g. {EmailSettings: {SendPushNotifications: true}})" },
    handler: async ({ config }) => {
      const parsed = typeof config === "string" ? JSON.parse(config) : config;
      const current = await mmFetch("/config");
      // Deep merge
      for (const [section, values] of Object.entries(parsed)) {
        if (typeof values === "object" && values !== null) {
          current[section] = { ...current[section], ...(values as object) };
        }
      }
      return await mmFetch("/config", {
        method: "PUT",
        body: JSON.stringify(current),
      });
    },
  },

  // ===== Personal Access Tokens =====

  create_personal_token: {
    description: "Create a personal access token for a user (for API access)",
    params: {
      user_id: "string - the user ID",
      description: "string - token description",
    },
    handler: async ({ user_id, description }) => {
      return await mmFetch(`/users/${user_id}/tokens`, {
        method: "POST",
        body: JSON.stringify({ description }),
      });
    },
  },

  list_user_tokens: {
    description: "List personal access tokens for a user",
    params: { user_id: "string - the user ID" },
    handler: async ({ user_id }) => {
      return await mmFetch(`/users/${user_id}/tokens`);
    },
  },

  revoke_token: {
    description: "Revoke a personal access token",
    params: { token_id: "string - the token ID (not the token value)" },
    handler: async ({ token_id }) => {
      return await mmFetch("/users/tokens/revoke", {
        method: "POST",
        body: JSON.stringify({ token_id }),
      });
    },
  },

  // ===== Emoji & Reactions (useful for approval workflows) =====

  list_custom_emoji: {
    description: "List custom emoji",
    params: {},
    handler: async () => mmFetch("/emoji?per_page=200"),
  },

  // ===== Posts (limited - for webhook testing only) =====

  create_post: {
    description: "Create a post in a channel (use sparingly - prefer webhooks/n8n for automation)",
    params: {
      channel_id: "string - the channel ID",
      message: "string - the message text (supports markdown)",
      props: "object (optional) - additional post properties (attachments, etc.)",
    },
    handler: async ({ channel_id, message, props }) => {
      const parsedProps = props ? (typeof props === "string" ? JSON.parse(props) : props) : {};
      return await mmFetch("/posts", {
        method: "POST",
        body: JSON.stringify({ channel_id, message, props: parsedProps }),
      });
    },
  },
};

// --- Registration ---

export function registerMattermostTools(server: McpServer) {
  server.tool(
    "mm_list",
    "List all available Mattermost admin/setup tools. Mattermost is the self-hosted team chat at chat.your-domain.com. " +
    "Tools cover: team management, channel CRUD, user/bot management, incoming/outgoing webhooks, " +
    "slash commands, personal access tokens, and server config. " +
    "For automated messaging, use n8n Mattermost nodes or incoming webhooks instead.",
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
    "mm_call",
    "Execute a Mattermost admin tool. Use mm_list to see available tools. " +
    "Manages the self-hosted Mattermost: teams, channels, bots, webhooks, slash commands, and config.",
    {
      tool: z.string().describe("Tool name from mm_list"),
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
