import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Redis as IORedis } from "ioredis";

// --- Config ---

const VAULT_ADDR = process.env.VAULT_ADDR || "http://Vault:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";
const VAULT_MOUNT = process.env.VAULT_MOUNT || "homelab";
const REDIS_HOST = process.env.REDIS_HOST || "Redis";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379");
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const N8N_API_URL = process.env.N8N_API_URL || "http://n8n:5678";
const N8N_API_KEY = process.env.N8N_API_KEY || "";

const BLUEPRINT_PREFIX = "blueprints";
const TEMPLATE_PREFIX = "blueprint-templates";
const REDIS_DB = 3; // dedicated DB for blueprint counters

// --- Vault helpers ---

async function vaultGet(path: string): Promise<any> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/data/${path}`, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Vault GET ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data?.data || null;
}

async function vaultPut(path: string, data: Record<string, any>): Promise<void> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/data/${path}`, {
    method: "POST",
    headers: { "X-Vault-Token": VAULT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`Vault PUT ${res.status}: ${await res.text()}`);
}

async function vaultDelete(path: string): Promise<void> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/metadata/${path}`, {
    method: "DELETE",
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Vault DELETE ${res.status}: ${await res.text()}`);
}

async function vaultList(prefix: string): Promise<string[]> {
  const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_MOUNT}/metadata/${prefix}?list=true`, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Vault LIST ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data?.keys || [];
}

// --- Redis helpers ---

function getRedisClient(): InstanceType<typeof IORedis> {
  return new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    db: REDIS_DB,
    lazyConnect: true,
    connectTimeout: 5000,
  });
}

async function withRedis<T>(fn: (client: InstanceType<typeof IORedis>) => Promise<T>): Promise<T> {
  const client = getRedisClient();
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

// --- n8n helpers ---

async function n8nWebhook(path: string, body: any): Promise<any> {
  const url = `${N8N_API_URL}/webhook/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`n8n webhook ${res.status}: ${await res.text()}`);
  return res.json();
}

async function n8nFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${N8N_API_URL}/api/v1${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY,
      ...(options.headers as Record<string, string> || {}),
    },
  });
  if (!res.ok) throw new Error(`n8n API ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Blueprint validation ---

interface BlueprintGuardrails {
  max_daily_actions?: number;
  requires_approval?: string[];
  auto_disable_after?: string;
}

interface Blueprint {
  name: string;
  description: string;
  components: {
    dify_app?: Record<string, any>;
    n8n_workflows?: Array<Record<string, any>>;
    database?: Record<string, any>;
    knowledge_base?: Record<string, any>;
    [key: string]: any;
  };
  guardrails: BlueprintGuardrails;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

function validateBlueprint(bp: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!bp.name || typeof bp.name !== "string") errors.push("Missing or invalid 'name' (string required)");
  if (bp.name && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(bp.name)) errors.push("Name must be lowercase alphanumeric with hyphens, no leading/trailing hyphens");
  if (!bp.description || typeof bp.description !== "string") errors.push("Missing or invalid 'description' (string required)");
  if (!bp.components || typeof bp.components !== "object") errors.push("Missing or invalid 'components' (object required)");
  if (bp.components) {
    const keys = Object.keys(bp.components);
    if (keys.length === 0) errors.push("'components' must have at least one component");
  }
  if (!bp.guardrails || typeof bp.guardrails !== "object") errors.push("Missing or invalid 'guardrails' (object required)");
  if (bp.guardrails) {
    if (bp.guardrails.max_daily_actions !== undefined && typeof bp.guardrails.max_daily_actions !== "number") {
      errors.push("'guardrails.max_daily_actions' must be a number");
    }
    if (bp.guardrails.requires_approval !== undefined && !Array.isArray(bp.guardrails.requires_approval)) {
      errors.push("'guardrails.requires_approval' must be an array of strings");
    }
    if (bp.guardrails.auto_disable_after !== undefined && typeof bp.guardrails.auto_disable_after !== "string") {
      errors.push("'guardrails.auto_disable_after' must be a string (e.g. '30 days inactive')");
    }
  }
  return { valid: errors.length === 0, errors };
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function parseDuration(dur: string): number | null {
  const match = dur.match(/^(\d+)\s*(day|days|week|weeks|month|months)\s*(inactive)?$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("day")) return n * 86400 * 1000;
  if (unit.startsWith("week")) return n * 7 * 86400 * 1000;
  if (unit.startsWith("month")) return n * 30 * 86400 * 1000;
  return null;
}

// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ── Blueprint CRUD ─────────────────────────────────────────

  save_blueprint: {
    description: "Validate and store an agent blueprint in Vault. The blueprint defines all components (Dify apps, n8n workflows, databases, knowledge bases) and guardrails (action budgets, approval gates, auto-sunset) for an automation agent.",
    params: {
      blueprint: "Full blueprint JSON object with name, description, components, and guardrails",
    },
    handler: async (p) => {
      const bp = typeof p.blueprint === "string" ? JSON.parse(p.blueprint) : p.blueprint;
      const validation = validateBlueprint(bp);
      if (!validation.valid) {
        return { error: "Blueprint validation failed", errors: validation.errors };
      }

      // Check for existing blueprint with same name
      const existing = await vaultGet(`${BLUEPRINT_PREFIX}/${bp.name}/spec`);

      const now = new Date().toISOString();
      const toStore: Blueprint = {
        ...bp,
        status: existing ? "updated" : "draft",
        created_at: existing?.created_at || now,
        updated_at: now,
      };

      await vaultPut(`${BLUEPRINT_PREFIX}/${bp.name}/spec`, toStore as any);
      return {
        ok: true,
        name: bp.name,
        status: toStore.status,
        components: Object.keys(bp.components),
        guardrails: bp.guardrails,
        message: existing
          ? `Blueprint '${bp.name}' updated. Use deploy_blueprint to apply changes.`
          : `Blueprint '${bp.name}' saved as draft. Use deploy_blueprint with confirm=true to provision.`,
      };
    },
  },

  list_blueprints: {
    description: "List all stored agent blueprints with their status and component summary",
    params: {},
    handler: async () => {
      const keys = await vaultList(`${BLUEPRINT_PREFIX}/`);
      if (keys.length === 0) return { blueprints: [], message: "No blueprints stored yet" };

      const blueprints = [];
      for (const key of keys) {
        // Keys from Vault list include trailing slash for "directories"
        const name = key.replace(/\/$/, "");
        const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${name}/spec`);
        if (spec) {
          blueprints.push({
            name: spec.name,
            description: spec.description,
            status: spec.status || "draft",
            components: Object.keys(spec.components || {}),
            guardrails: spec.guardrails,
            created_at: spec.created_at,
            updated_at: spec.updated_at,
          });
        }
      }
      return { blueprints, count: blueprints.length };
    },
  },

  get_blueprint: {
    description: "Get full details of a blueprint including all component definitions and guardrails",
    params: { name: "Blueprint name" },
    handler: async (p) => {
      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);
      const state = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/state`);
      return { spec, state: state || { status: "not_deployed" } };
    },
  },

  get_blueprint_status: {
    description: "Check deployment status of each component in a blueprint",
    params: { name: "Blueprint name" },
    handler: async (p) => {
      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);
      const state = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/state`);

      // Get action count from Redis
      let actionCount = 0;
      try {
        actionCount = await withRedis(async (client) => {
          const key = `agent:${p.name}:actions:${todayKey()}`;
          const val = await client.get(key);
          return parseInt(val || "0");
        });
      } catch { /* Redis may not be available */ }

      return {
        name: p.name,
        description: spec.description,
        blueprint_status: spec.status || "draft",
        deployment_state: state || { status: "not_deployed" },
        today_actions: actionCount,
        max_daily_actions: spec.guardrails?.max_daily_actions || "unlimited",
        auto_disable_after: spec.guardrails?.auto_disable_after || "never",
      };
    },
  },

  deploy_blueprint: {
    description: "Trigger the n8n Blueprint Deployer pipeline to provision all components. Requires confirm=true. The deployer creates Dify apps, n8n workflows, database tables, knowledge bases, and registers everything in the knowledge graph.",
    params: {
      name: "Blueprint name to deploy",
      confirm: "Must be true to actually deploy. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true to deploy. Use get_blueprint to review first." };
      }

      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);

      // Update status
      spec.status = "deploying";
      spec.updated_at = new Date().toISOString();
      await vaultPut(`${BLUEPRINT_PREFIX}/${p.name}/spec`, spec);

      // Initialize state tracking
      const componentStates: Record<string, string> = {};
      for (const key of Object.keys(spec.components)) {
        componentStates[key] = "pending";
      }
      await vaultPut(`${BLUEPRINT_PREFIX}/${p.name}/state`, {
        status: "deploying",
        components: componentStates,
        started_at: new Date().toISOString(),
      });

      // Trigger n8n deployer webhook
      try {
        const result = await n8nWebhook("blueprint-deploy", {
          blueprint_name: p.name,
          blueprint: spec,
        });
        return {
          ok: true,
          name: p.name,
          message: `Blueprint '${p.name}' deployment triggered. The n8n deployer pipeline will provision components and update state.`,
          deployer_response: result,
        };
      } catch (err: any) {
        // If n8n webhook isn't set up yet, store state for manual deploy
        spec.status = "deploy_pending";
        await vaultPut(`${BLUEPRINT_PREFIX}/${p.name}/spec`, spec);
        await vaultPut(`${BLUEPRINT_PREFIX}/${p.name}/state`, {
          status: "deploy_pending",
          components: componentStates,
          error: `n8n deployer not reachable: ${err.message}`,
          started_at: new Date().toISOString(),
        });
        return {
          ok: false,
          name: p.name,
          message: `Blueprint saved with status 'deploy_pending'. The n8n deployer pipeline is not yet configured. Set up the 'blueprint-deploy' webhook workflow in n8n, or provision components manually.`,
          error: err.message,
        };
      }
    },
  },

  teardown_blueprint: {
    description: "Remove all deployed components for a blueprint. DESTRUCTIVE — deactivates n8n workflows, deletes Dify apps, drops tables. Requires confirm=true. Does NOT delete the blueprint spec from Vault.",
    params: {
      name: "Blueprint name to tear down",
      confirm: "Must be true to actually tear down. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true to tear down. This will remove all deployed components." };
      }

      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);

      // Try n8n teardown webhook
      try {
        const result = await n8nWebhook("blueprint-teardown", {
          blueprint_name: p.name,
          blueprint: spec,
        });

        spec.status = "torn_down";
        spec.updated_at = new Date().toISOString();
        await vaultPut(`${BLUEPRINT_PREFIX}/${p.name}/spec`, spec);

        return {
          ok: true,
          name: p.name,
          message: `Blueprint '${p.name}' teardown triggered.`,
          deployer_response: result,
        };
      } catch (err: any) {
        return {
          ok: false,
          name: p.name,
          message: `Teardown webhook not reachable. Manually remove components or set up the 'blueprint-teardown' webhook in n8n.`,
          error: err.message,
        };
      }
    },
  },

  delete_blueprint: {
    description: "Permanently delete a blueprint spec and all its state from Vault. Does NOT teardown deployed components — use teardown_blueprint first. Requires confirm=true.",
    params: {
      name: "Blueprint name to delete",
      confirm: "Must be true. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true. Use teardown_blueprint first to remove deployed components." };
      }

      await vaultDelete(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      await vaultDelete(`${BLUEPRINT_PREFIX}/${p.name}/state`);
      await vaultDelete(`${BLUEPRINT_PREFIX}/${p.name}/credentials`);

      // Clean up Redis counters
      try {
        await withRedis(async (client) => {
          const keys = await client.keys(`agent:${p.name}:*`);
          if (keys.length > 0) await client.del(...keys);
        });
      } catch { /* Redis cleanup is best-effort */ }

      return { ok: true, name: p.name, message: `Blueprint '${p.name}' permanently deleted from Vault.` };
    },
  },

  // ── Guardrails ─────────────────────────────────────────────

  check_action_budget: {
    description: "Check if an agent has remaining action budget for today. Returns whether the agent can proceed and how many actions remain.",
    params: { name: "Blueprint/agent name" },
    handler: async (p) => {
      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);

      const limit = spec.guardrails?.max_daily_actions;
      if (!limit) return { name: p.name, allowed: true, budget: "unlimited", used_today: 0 };

      const used = await withRedis(async (client) => {
        const key = `agent:${p.name}:actions:${todayKey()}`;
        const val = await client.get(key);
        return parseInt(val || "0");
      });

      return {
        name: p.name,
        allowed: used < limit,
        budget: limit,
        used_today: used,
        remaining: Math.max(0, limit - used),
      };
    },
  },

  record_action: {
    description: "Record an action for an agent. Increments the daily counter and updates last-activity timestamp. Call this after every agent action for guardrail tracking.",
    params: {
      name: "Blueprint/agent name",
      action_type: "(optional) Type of action for logging",
    },
    handler: async (p) => {
      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);

      const result = await withRedis(async (client) => {
        const dayKey = `agent:${p.name}:actions:${todayKey()}`;
        const activityKey = `agent:${p.name}:last_activity`;

        const count = await client.incr(dayKey);
        // Auto-expire daily counters after 48 hours
        await client.expire(dayKey, 172800);
        // Update last activity
        await client.set(activityKey, new Date().toISOString());

        return { count };
      });

      const limit = spec.guardrails?.max_daily_actions;
      const overBudget = limit ? result.count > limit : false;

      return {
        name: p.name,
        action_count_today: result.count,
        budget: limit || "unlimited",
        over_budget: overBudget,
        message: overBudget
          ? `WARNING: Agent '${p.name}' has exceeded its daily action budget (${result.count}/${limit}). Consider disabling.`
          : `Action recorded (${result.count}/${limit || "∞"}).`,
      };
    },
  },

  check_sunset: {
    description: "Check if an agent should be auto-disabled due to inactivity based on its auto_disable_after guardrail.",
    params: { name: "Blueprint/agent name" },
    handler: async (p) => {
      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);

      const autoDisable = spec.guardrails?.auto_disable_after;
      if (!autoDisable) return { name: p.name, should_disable: false, reason: "No auto_disable_after configured" };

      const duration = parseDuration(autoDisable);
      if (!duration) return { name: p.name, should_disable: false, reason: `Could not parse duration: '${autoDisable}'` };

      let lastActivity: string | null = null;
      try {
        lastActivity = await withRedis(async (client) => {
          return client.get(`agent:${p.name}:last_activity`);
        });
      } catch { /* Redis not available */ }

      if (!lastActivity) {
        // Use blueprint creation date as fallback
        lastActivity = spec.created_at || new Date().toISOString();
      }

      const lastTime = new Date(lastActivity as string).getTime();
      const now = Date.now();
      const elapsed = now - lastTime;
      const shouldDisable = elapsed > duration;

      return {
        name: p.name,
        should_disable: shouldDisable,
        last_activity: lastActivity,
        inactive_for_ms: elapsed,
        threshold_ms: duration,
        threshold_human: autoDisable,
        message: shouldDisable
          ? `Agent '${p.name}' should be disabled — inactive for ${Math.round(elapsed / 86400000)} days (limit: ${autoDisable}).`
          : `Agent '${p.name}' is active. Last activity: ${lastActivity}.`,
      };
    },
  },

  kill_agent: {
    description: "Emergency stop: immediately deactivate all n8n workflows and mark the agent as killed. Requires confirm=true.",
    params: {
      name: "Blueprint/agent name to kill",
      reason: "(optional) Reason for killing the agent",
      confirm: "Must be true. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true to kill this agent." };
      }

      const spec = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/spec`);
      if (!spec) throw new Error(`Blueprint '${p.name}' not found`);

      const state = await vaultGet(`${BLUEPRINT_PREFIX}/${p.name}/state`);
      const results: string[] = [];

      // Deactivate n8n workflows if we know their IDs
      if (state?.n8n_workflow_ids) {
        for (const wfId of state.n8n_workflow_ids) {
          try {
            await n8nFetch(`/workflows/${wfId}`, {
              method: "PATCH",
              body: JSON.stringify({ active: false }),
            });
            results.push(`Deactivated n8n workflow ${wfId}`);
          } catch (err: any) {
            results.push(`Failed to deactivate workflow ${wfId}: ${err.message}`);
          }
        }
      }

      // Update state
      spec.status = "killed";
      spec.updated_at = new Date().toISOString();
      await vaultPut(`${BLUEPRINT_PREFIX}/${p.name}/spec`, spec);
      await vaultPut(`${BLUEPRINT_PREFIX}/${p.name}/state`, {
        ...state,
        status: "killed",
        killed_at: new Date().toISOString(),
        kill_reason: p.reason || "Manual kill",
      });

      return {
        ok: true,
        name: p.name,
        actions_taken: results,
        message: `Agent '${p.name}' killed. Status set to 'killed'. Reason: ${p.reason || "Manual kill"}.`,
      };
    },
  },

  // ── Templates ──────────────────────────────────────────────

  list_templates: {
    description: "List available blueprint templates (starting-point blueprints for common automation patterns)",
    params: {},
    handler: async () => {
      const keys = await vaultList(`${TEMPLATE_PREFIX}/`);
      if (keys.length === 0) return { templates: [], message: "No templates stored yet" };

      const templates = [];
      for (const key of keys) {
        const name = key.replace(/\/$/, "");
        const data = await vaultGet(`${TEMPLATE_PREFIX}/${name}`);
        if (data) {
          templates.push({
            name,
            description: data.description,
            components: Object.keys(data.components || {}),
            pattern: data.pattern || "custom",
          });
        }
      }
      return { templates, count: templates.length };
    },
  },

  get_template: {
    description: "Get a blueprint template. Use as a starting point to customize for a specific use case.",
    params: { name: "Template name" },
    handler: async (p) => {
      const data = await vaultGet(`${TEMPLATE_PREFIX}/${p.name}`);
      if (!data) throw new Error(`Template '${p.name}' not found`);
      return data;
    },
  },

  save_template: {
    description: "Store a blueprint as a reusable template",
    params: {
      name: "Template name",
      template: "Blueprint JSON to use as template (same format as save_blueprint)",
    },
    handler: async (p) => {
      const tmpl = typeof p.template === "string" ? JSON.parse(p.template) : p.template;
      if (!tmpl.description) throw new Error("Template must have a description");
      if (!tmpl.components) throw new Error("Template must have components");
      await vaultPut(`${TEMPLATE_PREFIX}/${p.name}`, tmpl);
      return { ok: true, name: p.name, message: `Template '${p.name}' saved.` };
    },
  },
};

// --- Registration ---

export function registerBlueprintTools(server: McpServer) {
  server.tool(
    "blueprint_list",
    "List all available agent blueprint tools. Blueprints are modular automation specs that define " +
    "Dify AI apps, n8n workflows, database tables, knowledge bases, and guardrails (action budgets, " +
    "approval gates, auto-sunset). Tools cover: blueprint CRUD (save/list/get/status/delete), " +
    "deployment (deploy/teardown), guardrails (check_action_budget/record_action/check_sunset/kill_agent), " +
    "and templates (list/get/save). Use the automation-architect agent to generate blueprints from " +
    "natural language, or create them manually.",
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
    "blueprint_call",
    "Execute a blueprint tool. Use blueprint_list to see available tools. " +
    "Manages agent blueprints: the modular, guardrailed automation system. " +
    "Each blueprint describes a complete agent (AI apps, workflows, databases, knowledge bases) " +
    "with built-in safety (action budgets, approval gates, auto-sunset, kill switch).",
    {
      tool: z.string().describe("Tool name from blueprint_list"),
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
