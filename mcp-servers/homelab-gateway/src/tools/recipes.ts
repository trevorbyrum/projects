import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { vaultGet, vaultPut, vaultDelete, vaultList } from "../utils/vault.js";

// Vault for recipe storage, Docker API for container lifecycle

const DOCKER_HOST = process.env.DOCKER_HOST || "http://docker-socket-proxy:2375";
const GITLAB_URL = process.env.GITLAB_URL || "http://gitlab-ce:80";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || "";
const GITLAB_INFRA_PROJECT = "homelab-projects/homelab-infrastructure";

// --- Vault helpers (recipe storage) ---










// --- GitLab API helpers (recipe export) ---

const SECRET_PATTERNS = /PASSWORD|TOKEN|KEY|SECRET|CREDENTIAL|AUTH/i;

function redactSecrets(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    redacted[k] = SECRET_PATTERNS.test(k) ? "***REDACTED***" : v;
  }
  return redacted;
}

async function gitlabCommitFiles(
  files: { path: string; content: string; action: "create" | "update" | "delete" }[],
  message: string,
  branch = "main",
): Promise<{ ok: boolean; message: string }> {
  if (!GITLAB_TOKEN) return { ok: false, message: "GITLAB_TOKEN not configured" };

  const projectPath = encodeURIComponent(GITLAB_INFRA_PROJECT);
  const actions = files.map((f) => ({
    action: f.action,
    file_path: f.path,
    content: f.action !== "delete" ? f.content : undefined,
  }));

  const res = await fetch(`${GITLAB_URL}/api/v4/projects/${projectPath}/repository/commits`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      branch,
      commit_message: message,
      actions,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    // If file already exists and we tried to create, retry with update
    if (res.status === 400 && err.includes("already exists")) {
      const retryActions = actions.map((a) => ({ ...a, action: "update" as const }));
      const retry = await fetch(`${GITLAB_URL}/api/v4/projects/${projectPath}/repository/commits`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ branch, commit_message: message, actions: retryActions }),
      });
      if (!retry.ok) throw new Error(`GitLab commit retry failed (${retry.status}): ${await retry.text()}`);
      return { ok: true, message: "Committed (updated existing files)" };
    }
    throw new Error(`GitLab commit failed (${res.status}): ${err}`);
  }

  return { ok: true, message: "Committed successfully" };
}

// Debounced auto-export (30s timer, batches rapid changes)
let exportTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutoExport(): void {
  if (exportTimer) clearTimeout(exportTimer);
  exportTimer = setTimeout(async () => {
    exportTimer = null;
    try {
      await doExportToGit();
      console.log("[recipes] Auto-export to git completed");
    } catch (e: any) {
      console.error("[recipes] Auto-export failed:", e.message);
    }
  }, 30_000);
}

async function doExportToGit(): Promise<{
  exported: string[];
  skipped: string[];
  message: string;
}> {
  const keys = await vaultList("recipes/");
  if (keys.length === 0) return { exported: [], skipped: [], message: "No recipes to export" };

  const files: { path: string; content: string; action: "create" | "update" }[] = [];
  const exported: string[] = [];

  for (const key of keys) {
    const data = await vaultGet(`recipes/${key}`);
    if (!data) continue;

    // Deep-copy and redact secrets
    const safe = { ...data };
    if (safe.env) safe.env = redactSecrets(safe.env);

    files.push({
      path: `recipes/${key}.json`,
      content: JSON.stringify(safe, null, 2) + "\n",
      action: "update", // use update; GitLab auto-creates if needed with create
    });
    exported.push(key);
  }

  if (files.length === 0) return { exported: [], skipped: keys, message: "No exportable recipes" };

  // Try create first, fall back to update
  const createFiles = files.map((f) => ({ ...f, action: "create" as const }));
  try {
    await gitlabCommitFiles(createFiles, `chore(recipes): export ${exported.length} recipes from Vault`);
  } catch {
    await gitlabCommitFiles(files, `chore(recipes): export ${exported.length} recipes from Vault`);
  }

  return { exported, skipped: [], message: `Exported ${exported.length} recipes to ${GITLAB_INFRA_PROJECT}` };
}

// --- Docker API helpers ---

async function dockerFetch(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${DOCKER_HOST}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers as Record<string, string> || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Docker API ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function containerExists(name: string): Promise<any | null> {
  try {
    return await dockerFetch(`/containers/${name}/json`);
  } catch {
    return null;
  }
}

// --- Recipe types ---

interface ContainerRecipe {
  name: string;           // Recipe name (also default container name)
  image: string;          // Docker image with tag
  description: string;    // What this service does
  env: Record<string, string>;   // Environment variables
  labels: Record<string, string>; // Docker labels (Traefik, etc.)
  ports: Record<string, string>; // host_port: container_port
  volumes: string[];       // bind mounts: "host:container"
  network: string;         // Docker network (usually traefik_proxy)
  restart: string;         // Restart policy
  depends_on: string[];    // Container names this depends on (informational)
  created_at?: string;
  updated_at?: string;
}

function recipeToDockerConfig(recipe: ContainerRecipe, containerName?: string) {
  const name = containerName || recipe.name;

  // Build environment array
  const Env = Object.entries(recipe.env || {}).map(([k, v]) => `${k}=${v}`);

  // Build labels
  const Labels = recipe.labels || {};

  // Build port bindings
  const ExposedPorts: Record<string, {}> = {};
  const PortBindings: Record<string, { HostPort: string }[]> = {};
  for (const [hostPort, containerPort] of Object.entries(recipe.ports || {})) {
    const key = `${containerPort}/tcp`;
    ExposedPorts[key] = {};
    PortBindings[key] = [{ HostPort: String(hostPort) }];
  }

  // Build volume binds
  const Binds = recipe.volumes || [];

  return {
    name,
    body: {
      Image: recipe.image,
      Env,
      Labels,
      ExposedPorts,
      HostConfig: {
        Binds,
        PortBindings,
        RestartPolicy: { Name: recipe.restart || "unless-stopped" },
        NetworkMode: recipe.network || "traefik_proxy",
      },
    },
  };
}

// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ── Recipe CRUD ────────────────────────────────────────────

  list_recipes: {
    description: "List all stored container recipes",
    params: {},
    handler: async () => {
      const keys = await vaultList("recipes/");
      if (keys.length === 0) return { recipes: [], message: "No recipes stored yet" };

      const recipes = [];
      for (const key of keys) {
        const data = await vaultGet(`recipes/${key}`);
        if (data) {
          recipes.push({
            name: key,
            image: data.image,
            description: data.description,
            network: data.network,
            ports: data.ports,
          });
        }
      }
      return { recipes };
    },
  },

  get_recipe: {
    description: "Get full details of a stored recipe including all env vars, volumes, labels",
    params: { name: "Recipe name" },
    handler: async (p) => {
      const data = await vaultGet(`recipes/${p.name}`);
      if (!data) throw new Error(`Recipe '${p.name}' not found`);
      return data;
    },
  },

  store_recipe: {
    description: "Store a new container recipe. Provide the full container configuration.",
    params: {
      name: "Recipe name (also default container name)",
      image: "Docker image with tag (e.g. 'redis:latest')",
      description: "What this service does",
      env: "(optional) Environment variables as {KEY: value} object",
      labels: "(optional) Docker labels as {key: value} (Traefik labels, etc.)",
      ports: "(optional) Port mappings as {host_port: container_port}",
      volumes: "(optional) Bind mounts as array of 'host:container' strings",
      network: "(optional) Docker network, default 'traefik_proxy'",
      restart: "(optional) Restart policy, default 'unless-stopped'",
      depends_on: "(optional) Array of container names this depends on (informational)",
    },
    handler: async (p) => {
      const recipe: ContainerRecipe = {
        name: p.name,
        image: p.image,
        description: p.description || "",
        env: p.env || {},
        labels: p.labels || {},
        ports: p.ports || {},
        volumes: p.volumes || [],
        network: p.network || "traefik_proxy",
        restart: p.restart || "unless-stopped",
        depends_on: p.depends_on || [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await vaultPut(`recipes/${p.name}`, recipe as any);
      scheduleAutoExport(); // fire-and-forget git export
      return { ok: true, name: p.name, message: `Recipe '${p.name}' stored. Use preview_deploy to see the Docker config, or deploy_recipe to create the container.` };
    },
  },

  delete_recipe: {
    description: "Delete a stored recipe (does NOT affect running containers)",
    params: { name: "Recipe name" },
    handler: async (p) => {
      await vaultDelete(`recipes/${p.name}`);
      scheduleAutoExport(); // fire-and-forget git export
      return { ok: true, name: p.name, message: `Recipe '${p.name}' deleted from Vault` };
    },
  },

  // ── Deploy Operations ──────────────────────────────────────

  preview_deploy: {
    description: "Preview what deploying a recipe would do WITHOUT actually creating anything. Shows the Docker API request body and checks for conflicts.",
    params: {
      name: "Recipe name",
      container_name: "(optional) Override container name",
    },
    handler: async (p) => {
      const data = await vaultGet(`recipes/${p.name}`);
      if (!data) throw new Error(`Recipe '${p.name}' not found`);

      const containerName = p.container_name || data.name;
      const { body } = recipeToDockerConfig(data, containerName);

      // Check if container already exists
      const existing = await containerExists(containerName);
      const conflict = existing ? {
        warning: `Container '${containerName}' already exists!`,
        state: existing.State?.Status,
        image: existing.Config?.Image,
        created: existing.Created,
      } : null;

      // Check if dependent containers are running
      const depStatus: Record<string, string> = {};
      for (const dep of data.depends_on || []) {
        const depContainer = await containerExists(dep);
        depStatus[dep] = depContainer ? depContainer.State?.Status || "exists" : "NOT FOUND";
      }

      return {
        container_name: containerName,
        docker_config: body,
        conflict,
        dependency_status: Object.keys(depStatus).length > 0 ? depStatus : "none",
        message: conflict
          ? "CONFLICT: Container already exists. Use redeploy_recipe to replace it, or choose a different container_name."
          : "Ready to deploy. Call deploy_recipe with confirm=true to create the container.",
      };
    },
  },

  deploy_recipe: {
    description: "Deploy a recipe: pull image, create container, start it. Requires confirm=true. Will NOT overwrite existing containers — use redeploy_recipe for that.",
    params: {
      name: "Recipe name",
      container_name: "(optional) Override container name",
      confirm: "Must be true to actually deploy. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true to deploy. Use preview_deploy first to review." };
      }

      const data = await vaultGet(`recipes/${p.name}`);
      if (!data) throw new Error(`Recipe '${p.name}' not found`);

      const containerName = p.container_name || data.name;

      // Check for existing container
      const existing = await containerExists(containerName);
      if (existing) {
        return {
          error: `Container '${containerName}' already exists (status: ${existing.State?.Status}). Use redeploy_recipe to replace it.`,
        };
      }

      const { body } = recipeToDockerConfig(data, containerName);

      // Pull image first
      try {
        const [imageName, tag] = data.image.includes(":") ? data.image.split(":") : [data.image, "latest"];
        await dockerFetch(`/images/create?fromImage=${encodeURIComponent(imageName)}&tag=${encodeURIComponent(tag)}`, { method: "POST" });
      } catch (e: any) {
        // Pull might fail if image is local-only, continue
      }

      // Create container
      const created = await dockerFetch(`/containers/create?name=${encodeURIComponent(containerName)}`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      // Start container
      await dockerFetch(`/containers/${created.Id}/start`, { method: "POST" });

      return {
        ok: true,
        container_id: created.Id,
        container_name: containerName,
        image: data.image,
        network: data.network,
        message: `Container '${containerName}' created and started from recipe '${p.name}'.`,
      };
    },
  },

  redeploy_recipe: {
    description: "Stop, remove, and recreate a container from its recipe. DESTRUCTIVE — the old container and its non-volume data will be lost. Requires confirm=true.",
    params: {
      name: "Recipe name",
      container_name: "(optional) Override container name",
      confirm: "Must be true to redeploy. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true to redeploy. This will stop and remove the existing container." };
      }

      const data = await vaultGet(`recipes/${p.name}`);
      if (!data) throw new Error(`Recipe '${p.name}' not found`);

      const containerName = p.container_name || data.name;
      const { body } = recipeToDockerConfig(data, containerName);

      // Rename old container for rollback instead of deleting
      const existing = await containerExists(containerName);
      const backupName = `${containerName}-rollback-${Date.now()}`;
      if (existing) {
        try { await dockerFetch(`/containers/${containerName}/stop`, { method: "POST" }); } catch {}
        try { await dockerFetch(`/containers/${containerName}/rename?name=${encodeURIComponent(backupName)}`, { method: "POST" }); } catch {}
      }

      // Pull image
      try {
        const [imageName, tag] = data.image.includes(":") ? data.image.split(":") : [data.image, "latest"];
        await dockerFetch(`/images/create?fromImage=${encodeURIComponent(imageName)}&tag=${encodeURIComponent(tag)}`, { method: "POST" });
      } catch {}

      // Create and start — rollback on failure
      try {
        const created = await dockerFetch(`/containers/create?name=${encodeURIComponent(containerName)}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        await dockerFetch(`/containers/${created.Id}/start`, { method: "POST" });

        // Success — clean up the old container
        if (existing) {
          try { await dockerFetch(`/containers/${backupName}?force=true`, { method: "DELETE" }); } catch {}
        }

        return {
          ok: true,
          container_id: created.Id,
          container_name: containerName,
          image: data.image,
          previous_existed: !!existing,
          message: `Container '${containerName}' redeployed from recipe '${p.name}'.`,
        };
      } catch (deployErr: any) {
        // Rollback: restore the old container
        if (existing) {
          try {
            await dockerFetch(`/containers/${backupName}/rename?name=${encodeURIComponent(containerName)}`, { method: "POST" });
            await dockerFetch(`/containers/${containerName}/start`, { method: "POST" });
          } catch {}
        }
        throw new Error(`Redeploy failed, rolled back to previous container: ${deployErr.message}`);
      }
    },
  },

  teardown: {
    description: "Stop and remove a container by name. DESTRUCTIVE. Requires confirm=true. Does NOT delete the recipe.",
    params: {
      container_name: "Container name to stop and remove",
      confirm: "Must be true. Safety check.",
    },
    handler: async (p) => {
      if (p.confirm !== true && p.confirm !== "true") {
        return { error: "Safety check: set confirm=true to teardown." };
      }

      const existing = await containerExists(p.container_name);
      if (!existing) {
        return { error: `Container '${p.container_name}' does not exist.` };
      }

      try { await dockerFetch(`/containers/${p.container_name}/stop`, { method: "POST" }); } catch {}
      await dockerFetch(`/containers/${p.container_name}?force=true`, { method: "DELETE" });

      return { ok: true, container_name: p.container_name, message: `Container '${p.container_name}' stopped and removed.` };
    },
  },

  // ── Utility ────────────────────────────────────────────────

  import_running: {
    description: "Import a currently running container as a recipe. Inspects the container and saves its config to Vault.",
    params: {
      container_name: "Name of the running container to import",
      recipe_name: "(optional) Recipe name, defaults to container name",
    },
    handler: async (p) => {
      const info = await containerExists(p.container_name);
      if (!info) throw new Error(`Container '${p.container_name}' not found`);

      const recipeName = p.recipe_name || p.container_name;

      // Extract config from running container
      const env: Record<string, string> = {};
      for (const e of info.Config?.Env || []) {
        const idx = e.indexOf("=");
        if (idx > 0) env[e.slice(0, idx)] = e.slice(idx + 1);
      }

      const ports: Record<string, string> = {};
      for (const [containerPort, bindings] of Object.entries(info.HostConfig?.PortBindings || {})) {
        const cp = containerPort.replace("/tcp", "").replace("/udp", "");
        const hp = (bindings as any[])?.[0]?.HostPort;
        if (hp) ports[hp] = cp;
      }

      const volumes = info.HostConfig?.Binds || [];
      const network = info.HostConfig?.NetworkMode || "traefik_proxy";

      const recipe: ContainerRecipe = {
        name: recipeName,
        image: info.Config?.Image || "unknown",
        description: `Imported from running container '${p.container_name}'`,
        env,
        labels: info.Config?.Labels || {},
        ports,
        volumes,
        network,
        restart: info.HostConfig?.RestartPolicy?.Name || "unless-stopped",
        depends_on: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await vaultPut(`recipes/${recipeName}`, recipe as any);
      scheduleAutoExport(); // fire-and-forget git export
      return {
        ok: true,
        recipe_name: recipeName,
        image: recipe.image,
        env_count: Object.keys(env).length,
        port_count: Object.keys(ports).length,
        volume_count: volumes.length,
        message: `Container '${p.container_name}' imported as recipe '${recipeName}'. Review with get_recipe and edit if needed.`,
      };
    },
  },

  // ── Git Export ─────────────────────────────────────────────

  export_to_git: {
    description: "Export all recipes from Vault to the homelab-infrastructure GitLab repo as JSON files. Secrets are automatically redacted.",
    params: {},
    handler: async () => doExportToGit(),
  },
};

// --- Registration ---

export function registerRecipeTools(server: McpServer) {
  server.tool(
    "recipe_list",
    "List all available container recipe tools. Recipes are reusable Docker container templates stored in Vault. " +
    "Tools cover: recipe CRUD (list/get/store/delete), deployment (preview/deploy/redeploy/teardown), " +
    "and importing running containers as recipes. Use import_running to capture existing containers, " +
    "store_recipe to create new templates, preview_deploy to review before deploying, and deploy_recipe to launch.",
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
    "recipe_call",
    "Execute a container recipe tool. Use recipe_list to see available tools. " +
    "Manages reusable Docker container templates: store, preview, deploy, redeploy, and teardown containers from recipes.",
    {
      tool: z.string().describe("Tool name from recipe_list"),
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

