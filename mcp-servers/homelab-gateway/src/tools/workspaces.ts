import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";
import { chromium } from "playwright";
import { stat } from "fs/promises";

const { Pool } = pg;

// --- Environment ---

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";

const OPENHANDS_URL = process.env.OPENHANDS_URL || "http://openhands:3000";
const OPENHANDS_API_KEY = process.env.OPENHANDS_API_KEY || "";

const GITLAB_URL = process.env.GITLAB_URL || "http://gitlab-ce:80";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || process.env.GITHUB_TOKEN || "";

const FIGMA_API_KEY = process.env.FIGMA_API_KEY || "";

const NTFY_URL = process.env.NTFY_URL || "http://ntfy:80";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "homelab-projects";
const NTFY_USER = process.env.NTFY_USER || "";
const NTFY_PASSWORD = process.env.NTFY_PASSWORD || "";

// -- Structured Logging --

function log(level: "info" | "warn" | "error", module: string, op: string, msg: string, meta?: Record<string, any>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [workspaces/${module}] [${op}]`;
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  if (level === "error") {
    console.error(`${prefix} ${msg}${metaStr}`);
  } else if (level === "warn") {
    console.warn(`${prefix} ${msg}${metaStr}`);
  } else {
    console.log(`${prefix} ${msg}${metaStr}`);
  }
}

async function ntfyNotify(message: string, title?: string, priority?: number, tags?: string[]): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (NTFY_USER && NTFY_PASSWORD) headers["Authorization"] = "Basic " + Buffer.from(`${NTFY_USER}:${NTFY_PASSWORD}`).toString("base64");
    if (title) headers["Title"] = title;
    if (priority) headers["Priority"] = String(priority);
    if (tags?.length) headers["Tags"] = tags.join(",");
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: "POST", body: message, headers });
  } catch (e: any) {
    console.error("ntfy notification failed:", e.message);
  }
}

async function ntfyError(module: string, op: string, error: string, meta?: Record<string, any>) {
  const details = meta ? "\n" + JSON.stringify(meta, null, 2) : "";
  log("error", module, op, error, meta);
  await ntfyNotify(`[workspaces/${module}/${op}] ${error}${details}`, "Workspace Error", 5, ["rotating_light"]);
}


// --- PG Pool (lazy init) ---

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
      throw new Error("PostgreSQL not configured - check POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB");
    }
    pool = new Pool({
      host: POSTGRES_HOST,
      port: POSTGRES_PORT,
      user: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      database: POSTGRES_DB,
    });
  }
  return pool;
}

async function pgQuery(sql: string, params: any[] = []): Promise<any> {
  const client = await getPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// --- GitLab API helper ---

async function gitlabFetch(path: string, options: RequestInit = {}): Promise<any> {
  const startTime = Date.now();
  const method = (options.method || "GET").toUpperCase();
  log("info", "gitlab", "fetch", `${method} ${path}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "PRIVATE-TOKEN": GITLAB_TOKEN,
    ...(options.headers as Record<string, string> || {}),
  };

  try {
    const res = await fetch(`${GITLAB_URL}${path}`, { ...options, headers });
    const elapsed = Date.now() - startTime;

    if (!res.ok) {
      const body = await res.text();
      const errMsg = `GitLab API ${res.status}: ${body.slice(0, 500)}`;
      await ntfyError("gitlab", path, errMsg, { method, status: res.status, elapsed_ms: elapsed });
      throw new Error(errMsg);
    }

    log("info", "gitlab", "fetch", `${method} ${path} OK (${elapsed}ms)`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  } catch (e: any) {
    if (!e.message.includes("GitLab API")) {
      const elapsed = Date.now() - startTime;
      await ntfyError("gitlab", path, `GitLab fetch failed: ${e.message}`, { method, elapsed_ms: elapsed });
    }
    throw e;
  }
}

// --- OpenHands API helper ---

async function ohFetch(path: string, options: RequestInit = {}): Promise<any> {
  const startTime = Date.now();
  const method = (options.method || "GET").toUpperCase();
  log("info", "openhands", "fetch", `${method} ${path}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  if (OPENHANDS_API_KEY) {
    headers["X-Session-API-Key"] = OPENHANDS_API_KEY;
  }

  try {
    const res = await fetch(`${OPENHANDS_URL}${path}`, { ...options, headers });
    const elapsed = Date.now() - startTime;

    if (!res.ok) {
      const body = await res.text();
      const errMsg = `OpenHands API ${res.status}: ${body.slice(0, 500)}`;
      await ntfyError("openhands", path, errMsg, { method, status: res.status, elapsed_ms: elapsed });
      throw new Error(errMsg);
    }

    log("info", "openhands", "fetch", `${method} ${path} OK (${elapsed}ms)`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  } catch (e: any) {
    if (!e.message.includes("OpenHands API")) {
      const elapsed = Date.now() - startTime;
      await ntfyError("openhands", path, `OpenHands fetch failed: ${e.message}`, { method, elapsed_ms: elapsed });
    }
    throw e;
  }
}

// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  create_workspace: {
    description:
      "Create a full project workspace: GitLab repo, filesystem path, optional Figma link, and DB record. " +
      "Creates a PRIVATE repo under the specified GitLab group.",
    params: {
      slug: "Project slug (required). Used for repo name, directory name, and pipeline_projects lookup.",
      figma_file_key: "(optional) Figma file key to link to the workspace.",
      gitlab_group_id: "(optional) GitLab group/namespace ID for the repo. Default: 34 (Homelab Projects).",
    },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");
      if (!GITLAB_TOKEN) throw new Error("GITLAB_TOKEN not configured");

      const slug: string = p.slug;
      const groupId = p.gitlab_group_id || 34;

      const projRes = await pgQuery(
        "SELECT id, name FROM pipeline_projects WHERE slug = $1",
        [slug]
      );
      if (projRes.rows.length === 0) {
        throw new Error(`No pipeline_projects record found for slug: ${slug}`);
      }
      const project = projRes.rows[0];

      const repo = await gitlabFetch("/api/v4/projects", {
        method: "POST",
        body: JSON.stringify({
          name: slug,
          path: slug,
          namespace_id: groupId,
          visibility: "private",
          initialize_with_readme: true,
          description: `Workspace repo for ${project.name}`,
        }),
      });

      const workspacePath = `/mnt/user/appdata/projects/${slug}`;

      const insertRes = await pgQuery(
        `INSERT INTO project_workspaces
           (project_id, gitlab_repo_url, gitlab_branch, figma_file_key, workspace_path, status)
         VALUES ($1, $2, 'main', $3, $4, 'active')
         ON CONFLICT (project_id) DO UPDATE SET
           gitlab_repo_url = EXCLUDED.gitlab_repo_url,
           figma_file_key = COALESCE(EXCLUDED.figma_file_key, project_workspaces.figma_file_key),
           workspace_path = EXCLUDED.workspace_path
         RETURNING *`,
        [project.id, repo.http_url_to_repo, p.figma_file_key || null, workspacePath]
      );

      log("info", "workspace", "create", `Workspace created for ${slug}`, {
        gitlab_id: repo.id, workspace_path: workspacePath,
      });
      await ntfyNotify(
        `Workspace created: ${slug}\nGitLab: ${repo.web_url}\nPath: ${workspacePath}`,
        "Workspace Created", 3, ["file_folder"]
      );

      return {
        workspace: insertRes.rows[0],
        gitlab: {
          id: repo.id,
          url: repo.http_url_to_repo,
          web_url: repo.web_url,
        },
        filesystem: {
          path: workspacePath,
          note: "Directory not created automatically — requires host-side mkdir via SSH or docker exec.",
        },
      };
    },
  },

  get_workspace: {
    description: "Get full workspace state for a project by slug. Joins project info from pipeline_projects.",
    params: {
      slug: "Project slug (required)",
    },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");

      const res = await pgQuery(
        `SELECT w.*, pp.name AS project_name, pp.slug AS project_slug, pp.status AS project_status
         FROM project_workspaces w
         JOIN pipeline_projects pp ON pp.id = w.project_id
         WHERE pp.slug = $1`,
        [p.slug]
      );

      if (res.rows.length === 0) {
        throw new Error(`No workspace found for slug: ${p.slug}`);
      }

      return res.rows[0];
    },
  },

  create_coding_session: {
    description:
      "Spin up an OpenHands conversation for a sprint task. Creates the conversation via " +
      "OpenHands API and stores the conversation_id in the workspace record.",
    params: {
      slug: "Project slug (required)",
      sprint_number: "Sprint number (required) — used to find the sprint record",
      prompt: "The task prompt for the agent (required)",
      repository: "(optional) Git repo URL. Defaults to the workspace's gitlab_repo_url.",
      conversation_instructions: "(optional) System-level instructions for the agent",
    },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");
      if (!p.sprint_number) throw new Error("sprint_number is required");
      if (!p.prompt) throw new Error("prompt is required");

      const wsRes = await pgQuery(
        `SELECT w.*, pp.id AS proj_id
         FROM project_workspaces w
         JOIN pipeline_projects pp ON pp.id = w.project_id
         WHERE pp.slug = $1`,
        [p.slug]
      );
      if (wsRes.rows.length === 0) throw new Error(`No workspace for slug: ${p.slug}`);
      const ws = wsRes.rows[0];

      const sprintRes = await pgQuery(
        "SELECT id FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2",
        [ws.proj_id, p.sprint_number]
      );
      if (sprintRes.rows.length === 0) throw new Error(`No sprint #${p.sprint_number} for project ${p.slug}`);
      const sprint = sprintRes.rows[0];

      const repoUrl = p.repository || ws.gitlab_repo_url;
      const body: Record<string, any> = {
        initial_user_msg: p.prompt,
      };
      if (repoUrl) body.repository = repoUrl;
      if (ws.gitlab_branch) body.selected_branch = ws.gitlab_branch;
      if (p.conversation_instructions) body.conversation_instructions = p.conversation_instructions;

      const conv = await ohFetch("/api/conversations", {
        method: "POST",
        body: JSON.stringify(body),
      });

      const conversationId = conv.conversation_id || conv.id;

      await pgQuery(
        `UPDATE project_workspaces
         SET openhands_conversation_ids = openhands_conversation_ids || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify(conversationId), ws.id]
      );

      await pgQuery(
        `INSERT INTO agent_tasks (project_id, sprint_id, task_type, agent_model, prompt, status, started_at)
         VALUES ($1, $2, 'coding_session', 'openhands', $3, 'running', NOW())`,
        [ws.proj_id, sprint.id, p.prompt]
      );

      log("info", "session", "create", `Coding session created for ${p.slug} sprint #${p.sprint_number}`, {
        conversation_id: conversationId, workspace_id: ws.id, sprint_id: sprint.id,
      });
      await ntfyNotify(
        `Coding session started: ${p.slug} sprint #${p.sprint_number}\nConversation: ${conversationId}`,
        "Coding Session Started", 3, ["computer"]
      );

      return {
        conversation_id: conversationId,
        conversation: conv,
        workspace_id: ws.id,
        sprint_id: sprint.id,
      };
    },
  },

  get_session_status: {
    description:
      "Check OpenHands conversation progress. Returns conversation details and the last 10 events.",
    params: {
      conversation_id: "OpenHands conversation ID (required)",
    },
    handler: async (p) => {
      if (!p.conversation_id) throw new Error("conversation_id is required");

      const [conversation, events] = await Promise.all([
        ohFetch(`/api/conversations/${p.conversation_id}`),
        ohFetch(`/api/conversations/${p.conversation_id}/events?limit=10`),
      ]);

      return { conversation, recent_events: events };
    },
  },

  capture_screenshot: {
    description:
      "Take a Playwright screenshot of a running dev server URL. " +
      "Saves to the workspace directory on the host filesystem.",
    params: {
      url: "The URL to screenshot (required)",
      slug: "Project slug — used to determine save directory (required)",
      filename: "(optional) Output filename. Default: 'screenshot.png'",
    },
    handler: async (p) => {
      if (!p.url) throw new Error("url is required");
      if (!p.slug) throw new Error("slug is required");

      const filename = p.filename || "screenshot.png";
      const savePath = `/mnt/user/appdata/projects/${p.slug}/${filename}`;

      const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(p.url, { waitUntil: "networkidle", timeout: 30000 });
        await page.screenshot({ path: savePath, fullPage: false });
        await page.close();

        log("info", "screenshot", "capture", `Screenshot captured: ${p.url}`, { path: savePath });
        return {
          saved_to: savePath,
          url: p.url,
          viewport: "1280x720",
          note: "Screenshot saved. Path is on the host filesystem (bind-mounted).",
        };
      } finally {
        await browser.close();
      }
    },
  },

  compare_visuals: {
    description:
      "Compare two images for visual QA (Figma render vs screenshot). " +
      "Currently reports file metadata — pixel diffing will be added later.",
    params: {
      slug: "Project slug (required)",
      image_a_path: "Absolute path to the first image (required)",
      image_b_path: "Absolute path to the second image (required)",
    },
    handler: async (p) => {
      if (!p.slug || !p.image_a_path || !p.image_b_path) {
        throw new Error("slug, image_a_path, and image_b_path are all required");
      }

      const getStat = async (filePath: string) => {
        try {
          const s = await stat(filePath);
          return { path: filePath, size_bytes: s.size, modified: s.mtime.toISOString() };
        } catch {
          return { path: filePath, error: "File not found or inaccessible" };
        }
      };

      const [statA, statB] = await Promise.all([
        getStat(p.image_a_path),
        getStat(p.image_b_path),
      ]);

      return {
        image_a: statA,
        image_b: statB,
        comparison: {
          status: "placeholder",
          note: "Pixel-level diffing not yet implemented. File metadata shown above. " +
                "Future: will use pixelmatch or sharp to compute diff percentage.",
        },
      };
    },
  },

  merge_sprint: {
    description:
      "Merge a sprint branch to main in GitLab. Creates a merge request and immediately merges it.",
    params: {
      slug: "Project slug (required)",
      source_branch: "Branch to merge into main (required)",
    },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");
      if (!p.source_branch) throw new Error("source_branch is required");
      if (!GITLAB_TOKEN) throw new Error("GITLAB_TOKEN not configured");

      const wsRes = await pgQuery(
        `SELECT w.gitlab_repo_url
         FROM project_workspaces w
         JOIN pipeline_projects pp ON pp.id = w.project_id
         WHERE pp.slug = $1`,
        [p.slug]
      );
      if (wsRes.rows.length === 0) throw new Error(`No workspace for slug: ${p.slug}`);

      const encodedPath = encodeURIComponent(`homelab-projects/${p.slug}`);
      const glProject = await gitlabFetch(`/api/v4/projects/${encodedPath}`);

      const mr = await gitlabFetch(`/api/v4/projects/${glProject.id}/merge_requests`, {
        method: "POST",
        body: JSON.stringify({
          source_branch: p.source_branch,
          target_branch: "main",
          title: `Merge ${p.source_branch} into main`,
          remove_source_branch: true,
        }),
      });

      const merged = await gitlabFetch(
        `/api/v4/projects/${glProject.id}/merge_requests/${mr.iid}/merge`,
        { method: "PUT" }
      );

      log("info", "merge", "sprint", `Sprint merged for ${p.slug}: ${p.source_branch} -> main`, {
        mr_iid: mr.iid, commit: merged.merge_commit_sha,
      });
      await ntfyNotify(
        `Sprint merged: ${p.slug}\n${p.source_branch} -> main\nMR: ${mr.web_url}`,
        "Sprint Merged", 3, ["merged"]
      );

      return {
        merge_request: {
          iid: mr.iid,
          title: mr.title,
          web_url: mr.web_url,
        },
        merge_result: {
          state: merged.state,
          merged_by: merged.merged_by?.username,
          merge_commit_sha: merged.merge_commit_sha,
        },
      };
    },
  },

  generate_recipe: {
    description:
      "Generate a container recipe spec from completed project artifacts. " +
      "Reads workspace state, sprints, and tasks, then composes a recipe JSON " +
      "suitable for the blueprint/recipe system.",
    params: {
      slug: "Project slug (required)",
    },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");

      const wsRes = await pgQuery(
        `SELECT w.*, pp.name, pp.slug, pp.description, pp.tech_stack
         FROM project_workspaces w
         JOIN pipeline_projects pp ON pp.id = w.project_id
         WHERE pp.slug = $1`,
        [p.slug]
      );
      if (wsRes.rows.length === 0) throw new Error(`No workspace for slug: ${p.slug}`);
      const ws = wsRes.rows[0];

      const sprintRes = await pgQuery(
        `SELECT sprint_number, title, status, deliverables
         FROM pipeline_sprints
         WHERE project_id = $1 ORDER BY sprint_number`,
        [ws.project_id]
      );

      const taskRes = await pgQuery(
        `SELECT task_type, agent_model, status, result, completed_at
         FROM agent_tasks
         WHERE project_id = $1 AND status = 'completed'
         ORDER BY completed_at`,
        [ws.project_id]
      );

      const recipe = {
        name: ws.name,
        slug: ws.slug,
        description: ws.description,
        source: {
          type: "gitlab",
          repo_url: ws.gitlab_repo_url,
          branch: ws.gitlab_branch,
        },
        tech_stack: ws.tech_stack,
        container: {
          image: `registry.your-domain.com/${ws.slug}:latest`,
          ports: [],
          env_vars: [],
          volumes: [],
        },
        traefik: {
          host: `${ws.slug}.your-domain.com`,
          entrypoint: "web",
        },
        build_history: {
          sprints: sprintRes.rows,
          agent_tasks_completed: taskRes.rows.length,
        },
        figma_file_key: ws.figma_file_key,
        generated_at: new Date().toISOString(),
      };

      log("info", "recipe", "generate", `Recipe generated for ${p.slug}`, {
        sprints: sprintRes.rowCount, tasks: taskRes.rowCount,
      });
      await ntfyNotify(
        `Container recipe generated: ${ws.slug}\nSprints: ${sprintRes.rowCount}, Tasks completed: ${taskRes.rowCount}`,
        "Recipe Generated", 3, ["package"]
      );

      return recipe;
    },
  },
};

// --- Registration ---

export function registerWorkspaceTools(server: McpServer) {
  server.tool(
    "workspace_list",
    "List all available Workspace orchestration tools. Workspaces tie together a project's " +
    "GitLab repo, OpenHands coding sessions, Figma designs, and filesystem artifacts into a " +
    "unified development context. Tools cover: workspace creation (GitLab repo + DB record), " +
    "coding sessions (OpenHands conversation management), visual QA (Playwright screenshots), " +
    "git operations (merge sprint branches), and recipe generation for deployment.",
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
    "workspace_call",
    "Execute a Workspace tool. Use workspace_list to see available tools. " +
    "Orchestrates project workspaces: GitLab repos, OpenHands coding sessions, " +
    "visual QA, sprint merges, and recipe generation.",
    {
      tool: z.string().describe("Tool name from workspace_list"),
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
        log("error", "call", tool, `Tool failed: ${error.message}`);
        const criticalTools = ["create_workspace", "create_coding_session", "merge_sprint"];
        if (criticalTools.includes(tool)) {
          await ntfyError("call", tool, `Workspace tool ${tool} failed: ${error.message}`, {
            tool, params: Object.keys(params || {}),
          });
        }
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
