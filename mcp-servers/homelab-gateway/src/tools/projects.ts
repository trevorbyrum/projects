import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";
import { searchPreferences } from "./preferences.js";

const { Pool } = pg;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";
const NTFY_URL = process.env.NTFY_URL || "http://ntfy:80";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "homelab-projects";
const NTFY_USER = process.env.NTFY_USER || "";
const NTFY_PASSWORD = process.env.NTFY_PASSWORD || "";
const N8N_WEBHOOK_BASE = process.env.N8N_WEBHOOK_BASE || "http://n8n:5678/webhook";

// n8n 2.4.6 webhook URLs include workflowId prefix: /webhook/{workflowId}/webhook/{path}
const N8N_WEBHOOK_IDS: Record<string, string> = {
  "project-gitlab-sync": "",
  "project-research-pipeline": "",
  "project-research-resume": "",
  "dev-team-orchestrator": "",  // path-only webhook format (API-created)
  "dev-team-architecture": "",  // path-only webhook format (API-created)
  "dev-team-planning": "",        // path-only webhook format (API-created)
  "dev-team-sprint-runner": "",  // path-only webhook format (API-created)
  "dev-team-review-loop": "",    // path-only webhook format (API-created)
};

let pool: pg.Pool | null = null;

// ── Async Workflow Job Store ────────────────────────────────
interface AsyncJob {
  id: string;
  workflow: string;
  status: "running" | "succeeded" | "failed";
  started_at: string;
  completed_at?: string;
  result?: any;
  error?: string;
  elapsed_time?: number;
  total_tokens?: number;
}
const asyncJobs = new Map<string, AsyncJob>();
let jobCounter = 0;

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

async function ntfyNotify(message: string, title?: string, priority?: number, tags?: string[]): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (NTFY_USER && NTFY_PASSWORD) headers["Authorization"] = "Basic " + Buffer.from(`${NTFY_USER}:${NTFY_PASSWORD}`).toString("base64");
    if (title) headers["Title"] = title;
    if (priority) headers["Priority"] = String(priority);
    if (tags?.length) headers["Tags"] = tags.join(",");
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: "POST",
      body: message,
      headers,
    });
  } catch (e: any) {
    console.error("ntfy notification failed:", e.message);
  }
}

async function triggerN8n(webhookPath: string, data: Record<string, any>): Promise<any> {
  const startTime = Date.now();
  try {
    const wfId = N8N_WEBHOOK_IDS[webhookPath] || "";
    const fullPath = wfId ? `${wfId}/webhook/${webhookPath}` : webhookPath;
    log("info", "n8n", "trigger", `Calling webhook: ${webhookPath}`, { data_keys: Object.keys(data) });

    const res = await fetch(`${N8N_WEBHOOK_BASE}/${fullPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const elapsed = Date.now() - startTime;

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      await ntfyError("n8n", webhookPath, `Webhook returned HTTP ${res.status}`, {
        webhook: webhookPath, status: res.status, body: body.slice(0, 500), elapsed_ms: elapsed,
      });
      return null;
    }

    const text = await res.text();
    log("info", "n8n", "trigger", `Webhook ${webhookPath} OK (${elapsed}ms)`, { response_length: text.length });
    try { return JSON.parse(text); } catch { return text; }
  } catch (e: any) {
    const elapsed = Date.now() - startTime;
    await ntfyError("n8n", webhookPath, `Webhook call failed: ${e.message}`, {
      webhook: webhookPath, error: e.message, elapsed_ms: elapsed,
    });
    return null;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const VALID_STAGES = ["queue", "research", "architecture", "security_review", "planning", "active", "completed", "archived"];
const STAGE_ORDER = ["queue", "research", "architecture", "security_review", "planning", "active", "completed"];
// Section order: ui-ux-research moved early (position 3) so design decisions inform downstream sections
const RESEARCH_SECTIONS = [
  "libraries", "security", "ui-ux-research",
  "architecture", "dependencies", "file-structure",
  "tools", "containers", "integration", "costs",
  "open-source-scan", "best-practices", "prior-art",
];

// Maps each research section to a preference search query for relevant design/dev preferences
const SECTION_PREF_QUERIES: Record<string, string> = {
  "libraries":        "libraries tooling frameworks packages",
  "security":         "security authentication authorization best practices",
  "ui-ux-research":   "UI UX design aesthetic visual patterns accessibility",
  "architecture":     "architecture patterns state management data flow",
  "dependencies":     "dependencies package management versioning",
  "file-structure":   "file structure project organization code layout",
  "tools":            "development tools build system linting testing",
  "containers":       "containers Docker deployment infrastructure",
  "integration":      "API integration services communication",
  "costs":            "cost estimation hosting infrastructure pricing",
  "open-source-scan": "open source licensing compliance",
  "best-practices":   "best practices coding standards conventions",
  "prior-art":        "prior art similar projects inspiration",
};

// ── Structured Logging ──────────────────────────────────────

function log(level: "info" | "warn" | "error", module: string, op: string, msg: string, meta?: Record<string, any>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [projects/${module}] [${op}]`;
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  if (level === "error") {
    console.error(`${prefix} ${msg}${metaStr}`);
  } else if (level === "warn") {
    console.warn(`${prefix} ${msg}${metaStr}`);
  } else {
    console.log(`${prefix} ${msg}${metaStr}`);
  }
}

async function ntfyError(module: string, op: string, error: string, meta?: Record<string, any>) {
  const details = meta ? "\n" + JSON.stringify(meta, null, 2) : "";
  log("error", module, op, error, meta);
  await ntfyNotify(
    `[${module}/${op}] ${error}${details}`,
    "Pipeline Error",
    5,
    ["rotating_light"]
  );
}

async function ntfyWarn(module: string, op: string, message: string, meta?: Record<string, any>) {
  const details = meta ? "\n" + JSON.stringify(meta, null, 2) : "";
  log("warn", module, op, message, meta);
  await ntfyNotify(
    `[${module}/${op}] ${message}${details}`,
    "Pipeline Warning",
    4,
    ["warning"]
  );
}


// Dify workflow API keys per research section
const DIFY_SECTION_KEYS: Record<string, string> = {
  "libraries":         "app-YOUR_SECTION_KEY",
  "architecture":      "app-YOUR_SECTION_KEY",
  "security":          "app-YOUR_SECTION_KEY",
  "dependencies":      "app-YOUR_SECTION_KEY",
  "file-structure":    "app-YOUR_SECTION_KEY",
  "tools":             "app-YOUR_SECTION_KEY",
  "containers":        "app-YOUR_SECTION_KEY",
  "integration":       "app-YOUR_SECTION_KEY",
  "costs":             "app-YOUR_SECTION_KEY",
  "open-source-scan":  "app-YOUR_SECTION_KEY",
  "best-practices":    "app-YOUR_SECTION_KEY",
  "ui-ux-research":    "app-YOUR_SECTION_KEY",
  "prior-art":         "app-YOUR_SECTION_KEY",
};

// Dev-team Dify workflow API keys
const DIFY_DEVTEAM_KEYS: Record<string, string> = {
  "architect-design":        "app-YOUR_DEVTEAM_KEY",
  "architect-revise":        "app-YOUR_DEVTEAM_KEY",
  "security-review":         "app-YOUR_DEVTEAM_KEY",
  "pm-generate-sow":         "app-YOUR_DEVTEAM_KEY",
  "pm-generate-task-prompts":"app-YOUR_DEVTEAM_KEY",
  "code-reviewer":           "app-YOUR_DEVTEAM_KEY",
};

const DIFY_API_BASE = process.env.DIFY_API_BASE || "http://dify-api:5001";

async function callDify(apiKey: string, inputs: Record<string, string>, workflowName?: string): Promise<any> {
  const startTime = Date.now();
  const label = workflowName || apiKey.slice(0, 12);
  log("info", "dify", "call", `Calling workflow: ${label}`, { input_keys: Object.keys(inputs) });

  try {
    const res = await fetch(`${DIFY_API_BASE}/v1/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        inputs,
        response_mode: "blocking",
        user: "mcp-gateway",
      }),
    });
    const elapsed = Date.now() - startTime;

    if (!res.ok) {
      const body = await res.text();
      const errMsg = `Dify workflow ${label} returned HTTP ${res.status}: ${body.slice(0, 500)}`;
      await ntfyError("dify", label, errMsg, { status: res.status, elapsed_ms: elapsed });
      throw new Error(errMsg);
    }

    const result = await res.json();
    log("info", "dify", "call", `Workflow ${label} completed (${elapsed}ms)`, {
      status: result?.data?.status,
      tokens: result?.data?.total_tokens,
      elapsed_ms: elapsed,
    });
    return result;
  } catch (e: any) {
    if (!e.message.includes("Dify workflow")) {
      // Network/fetch error (not our rethrown error)
      const elapsed = Date.now() - startTime;
      await ntfyError("dify", label, `Workflow call failed: ${e.message}`, { elapsed_ms: elapsed });
    }
    throw e;
  }
}

async function runResearchPipeline(project: { id: number; slug: string; name: string; description: string | null }): Promise<void> {
  const serverContext = "Unraid Tower server with Docker, Traefik reverse proxy, PostgreSQL, Neo4j, n8n, Dify";
  let completedCount = 0;
  const totalSections = RESEARCH_SECTIONS.length;
  const accumulatedFindings: Record<string, any> = {};

  // Load user preferences once for the project context
  let projectPreferences: any[] = [];
  try {
    projectPreferences = await searchPreferences(
      `${project.name} ${project.description || ""} development preferences`,
      15
    );
    log("info", "research", "preferences", `Loaded ${projectPreferences.length} base preferences for ${project.slug}`);
  } catch (prefErr: any) {
    log("warn", "research", "preferences", `Failed to load preferences: ${prefErr.message}`);
  }

  for (const section of RESEARCH_SECTIONS) {
    try {
      const apiKey = DIFY_SECTION_KEYS[section];
      if (!apiKey) {
        await ntfyError("research", section, `No Dify API key configured for section: ${section}`, { slug: project.slug });
        continue;
      }

      // Mark section as in_progress
      await pgQuery(
        `UPDATE pipeline_research SET status = 'in_progress', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
        [project.id, section]
      );

      log("info", "research", section, `Starting section for ${project.slug}`);

      // Get section-specific preferences
      let sectionPreferences = projectPreferences;
      const prefQuery = SECTION_PREF_QUERIES[section];
      if (prefQuery) {
        try {
          const sectionSpecific = await searchPreferences(prefQuery, 10);
          // Merge and deduplicate by ID
          const seen = new Set(sectionPreferences.map((p: any) => p.id));
          for (const sp of sectionSpecific) {
            if (!seen.has(sp.id)) {
              sectionPreferences = [...sectionPreferences, sp];
              seen.add(sp.id);
            }
          }
        } catch { /* use base preferences */ }
      }

      // Build inputs with accumulated findings and preferences
      const inputs: Record<string, string> = {
        project_name: project.name,
        project_description: project.description || "",
        section,
        server_context: serverContext,
        existing_findings: Object.keys(accumulatedFindings).length > 0
          ? JSON.stringify(accumulatedFindings)
          : "",
        user_preferences: sectionPreferences.length > 0
          ? JSON.stringify(sectionPreferences.map((p: any) => ({
              domain: p.domain, topic: p.topic, context: p.context,
              preference: p.preference, anti_pattern: p.anti_pattern,
              examples: p.examples, confidence: p.confidence,
            })))
          : "",
      };

      const difyResponse = await callDify(apiKey, inputs, `research-${section}`);

      // Parse the Dify response
      const data = difyResponse?.data;
      if (!data || data.status !== "succeeded") {
        const errMsg = data?.error || "Dify workflow did not succeed";
        log("error", "research", section, `Dify failed for ${project.slug}: ${errMsg}`);
        await pgQuery(
          `UPDATE pipeline_research SET status = 'pending', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
          [project.id, section]
        );
        await ntfyNotify(
          `Research FAILED for ${project.name} / ${section}: ${errMsg}`,
          "Research Section Failed",
          4,
          ["x"]
        );
        continue;
      }

      // Parse the result string - may be JSON or plain text
      let findings: any = null;
      let concerns: string[] = [];
      let recommendations: string[] = [];
      let confidenceScore: number | null = null;
      let questions: Array<{ question: string; context: string; priority: string }> = [];

      const resultRaw = data.outputs?.result;
      if (resultRaw) {
        try {
          const parsed = typeof resultRaw === "string" ? JSON.parse(resultRaw) : resultRaw;
          findings = parsed.findings ?? null;
          concerns = Array.isArray(parsed.concerns) ? parsed.concerns : [];
          recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
          confidenceScore = typeof parsed.confidence_score === "number" ? parsed.confidence_score : null;
          questions = Array.isArray(parsed.questions) ? parsed.questions : [];
        } catch {
          // If result is not valid JSON, store the raw text as findings
          findings = { raw: resultRaw };
        }
      }

      // Accumulate findings for downstream sections
      if (findings) {
        accumulatedFindings[section] = {
          findings,
          concerns,
          recommendations,
          confidence_score: confidenceScore,
        };
      }

      // Update the research section in PG
      await pgQuery(
        `UPDATE pipeline_research
         SET findings = $1, concerns = $2, recommendations = $3, confidence_score = $4, status = 'complete', updated_at = NOW()
         WHERE project_id = $5 AND section = $6`,
        [
          findings ? JSON.stringify(findings) : null,
          concerns,
          recommendations,
          confidenceScore,
          project.id,
          section,
        ]
      );

      // Insert any questions
      for (const q of questions) {
        try {
          await pgQuery(
            `INSERT INTO pipeline_questions (project_id, question, context, priority)
             VALUES ($1, $2, $3, $4)`,
            [project.id, q.question, q.context || null, q.priority || "normal"]
          );
        } catch (qErr: any) {
          log("warn", "research", section, `Failed to insert question for ${project.slug}: ${qErr.message}`);
        }
      }

      completedCount++;
      const elapsed = data.elapsed_time ? `${data.elapsed_time.toFixed(1)}s` : "?";
      const tokens = data.total_tokens || "?";

      await ntfyNotify(
        `${project.name} / ${section} complete (${elapsed}, ${tokens} tokens). ${completedCount}/${totalSections} done.`,
        "Research Section Done",
        3,
        ["microscope"]
      );

      log("info", "research", section, `Complete for ${project.slug} (${elapsed}, ${tokens} tokens)`);

    } catch (err: any) {
      log("error", "research", section, `Error for ${project.slug}: ${err.message}`);
      // Mark section back to pending so it can be retried
      try {
        await pgQuery(
          `UPDATE pipeline_research SET status = 'pending', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
          [project.id, section]
        );
      } catch { /* ignore */ }

      await ntfyNotify(
        `Research ERROR for ${project.name} / ${section}: ${err.message}`,
        "Research Section Error",
        4,
        ["x"]
      );
    }
  }

  // Final summary notification
  const failedCount = totalSections - completedCount;
  const summaryMsg = failedCount === 0
    ? `All ${totalSections} research sections complete for ${project.name}!`
    : `Research finished for ${project.name}: ${completedCount}/${totalSections} succeeded, ${failedCount} failed.`;
  const summaryPriority = failedCount === 0 ? 4 : 3;
  const summaryTag = failedCount === 0 ? "white_check_mark" : "warning";

  await ntfyNotify(summaryMsg, "Research Pipeline Complete", summaryPriority, [summaryTag]);

  await pgQuery(
    `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
    [project.id, "research_pipeline_complete", JSON.stringify({ completed: completedCount, failed: failedCount, total: totalSections })]
  );

  log("info", "research", "pipeline", `Pipeline finished for ${project.slug}: ${completedCount}/${totalSections} succeeded`);
}

// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // ── Project CRUD ─────────────────────────────────────────

  create_project: {
    description: "Create a new project idea. Inserts into PG and triggers GitLab sync via n8n.",
    params: {
      name: "Project name",
      description: "(optional) Project description",
      tags: "(optional) Array of tag strings",
      priority: "(optional) 1 (highest) to 5 (lowest), default 3",
    },
    handler: async (p) => {
      const slug = slugify(p.name);
      const tags = p.tags || [];
      const priority = p.priority || 3;

      const result = await pgQuery(
        `INSERT INTO pipeline_projects (slug, name, description, tags, priority)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, slug, name, stage, priority, created_at`,
        [slug, p.name, p.description || null, tags, priority]
      );
      const project = result.rows[0];

      // Log event
      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "project_created", JSON.stringify({ name: p.name, slug, priority })]
      );

      // Trigger n8n GitLab sync
      await triggerN8n("project-gitlab-sync", { action: "create", project });

      // Notify
      await ntfyNotify(`New project: ${p.name}`, "Project Created", 3, ["rocket"]);

      return project;
    },
  },

  list_projects: {
    description: "List projects with optional filters. Returns summary with question counts.",
    params: {
      stage: "(optional) Filter by stage: queue|research|architecture|security_review|planning|active|completed|archived",
      priority: "(optional) Filter by priority (1-5)",
      tag: "(optional) Filter by tag",
      limit: "(optional) Max results, default 50",
    },
    handler: async (p) => {
      let sql = `
        SELECT pp.*,
          (SELECT COUNT(*) FROM pipeline_questions pq WHERE pq.project_id = pp.id AND pq.answer IS NULL) AS unanswered_questions,
          (SELECT COUNT(*) FROM pipeline_sprints ps WHERE ps.project_id = pp.id) AS sprint_count
        FROM pipeline_projects pp WHERE 1=1`;
      const params: any[] = [];
      let idx = 1;

      if (p.stage) { sql += ` AND pp.stage = $${idx++}`; params.push(p.stage); }
      if (p.priority) { sql += ` AND pp.priority = $${idx++}`; params.push(p.priority); }
      if (p.tag) { sql += ` AND $${idx++} = ANY(pp.tags)`; params.push(p.tag); }
      sql += ` ORDER BY pp.priority ASC, pp.created_at DESC LIMIT $${idx++}`;
      params.push(p.limit || 50);

      const result = await pgQuery(sql, params);
      return { projects: result.rows, count: result.rowCount };
    },
  },

  get_project: {
    description: "Get full project details by slug: project data + research sections + sprints + artifacts + question count.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      const [research, sprints, artifacts, questions] = await Promise.all([
        pgQuery(`SELECT * FROM pipeline_research WHERE project_id = $1 ORDER BY section`, [project.id]),
        pgQuery(`SELECT * FROM pipeline_sprints WHERE project_id = $1 ORDER BY sprint_number`, [project.id]),
        pgQuery(`SELECT * FROM pipeline_artifacts WHERE project_id = $1 ORDER BY created_at`, [project.id]),
        pgQuery(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE answer IS NULL) as unanswered FROM pipeline_questions WHERE project_id = $1`, [project.id]),
      ]);

      return {
        ...project,
        research: research.rows,
        sprints: sprints.rows,
        artifacts: artifacts.rows,
        questions: questions.rows[0],
      };
    },
  },

  update_project: {
    description: "Update project fields. Syncs changes to GitLab via n8n.",
    params: {
      slug: "Project slug",
      name: "(optional) New name",
      description: "(optional) New description",
      priority: "(optional) New priority (1-5)",
      tags: "(optional) New tags array",
      estimated_hours: "(optional) Estimated hours",
      estimated_cost: "(optional) Estimated cost",
      feasibility_score: "(optional) Feasibility score (1-10)",
      scope_of_work: "(optional) SOW as JSON object",
    },
    handler: async (p) => {
      const fields: string[] = [];
      const params: any[] = [];
      let idx = 1;

      const updatable = ["name", "description", "priority", "tags", "estimated_hours", "estimated_cost", "feasibility_score", "scope_of_work"];
      for (const field of updatable) {
        if (p[field] !== undefined) {
          const value = field === "scope_of_work" ? JSON.stringify(p[field]) : p[field];
          fields.push(`${field} = $${idx++}`);
          params.push(value);
        }
      }
      if (fields.length === 0) throw new Error("No fields to update");

      fields.push(`updated_at = NOW()`);
      params.push(p.slug);
      const sql = `UPDATE pipeline_projects SET ${fields.join(", ")} WHERE slug = $${idx} RETURNING *`;
      const result = await pgQuery(sql, params);
      if (result.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const project = result.rows[0];
      await triggerN8n("project-gitlab-sync", { action: "update", project });
      return project;
    },
  },

  advance_stage: {
    description: "Move project to next stage with validation gates. queue→research→architecture→security_review→planning→active→completed.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      const currentIdx = STAGE_ORDER.indexOf(project.stage);
      if (currentIdx === -1 || currentIdx >= STAGE_ORDER.length - 1) {
        throw new Error(`Cannot advance from stage '${project.stage}'`);
      }
      const nextStage = STAGE_ORDER[currentIdx + 1];

      // Validation gates
      if (nextStage === "architecture") {
        // All research sections must be complete
        const research = await pgQuery(
          `SELECT section, status FROM pipeline_research WHERE project_id = $1`, [project.id]
        );
        const incomplete = research.rows.filter((r: any) => r.status !== "complete");
        if (incomplete.length > 0) {
          throw new Error(`Cannot advance to architecture: ${incomplete.length} research sections incomplete: ${incomplete.map((r: any) => r.section).join(", ")}`);
        }
        const blocking = await pgQuery(
          `SELECT COUNT(*) as count FROM pipeline_questions WHERE project_id = $1 AND answer IS NULL AND priority = 'blocking'`,
          [project.id]
        );
        if (parseInt(blocking.rows[0].count) > 0) {
          throw new Error(`Cannot advance to architecture: ${blocking.rows[0].count} blocking questions unanswered`);
        }
      }

      if (nextStage === "security_review") {
        // Architecture design must be stored in research table as section type 'architecture-design'
        const archDesign = await pgQuery(
          `SELECT id FROM pipeline_research WHERE project_id = $1 AND section = 'architecture-design' AND status = 'complete'`,
          [project.id]
        );
        if (archDesign.rowCount === 0) {
          throw new Error("Cannot advance to security_review: architecture design not stored");
        }
      }

      if (nextStage === "planning") {
        // No blocking security issues
        const secReview = await pgQuery(
          `SELECT id FROM pipeline_research WHERE project_id = $1 AND section = 'security-assessment' AND status = 'complete'`,
          [project.id]
        );
        if (secReview.rowCount === 0) {
          throw new Error("Cannot advance to planning: security review not complete");
        }
        // Check for blocking security findings in agent_tasks
        const blockingSec = await pgQuery(
          `SELECT COUNT(*) as count FROM agent_tasks WHERE project_id = $1 AND task_type = 'security' AND status = 'failed'`,
          [project.id]
        );
        if (parseInt(blockingSec.rows[0].count) > 0) {
          throw new Error("Cannot advance to planning: unresolved blocking security issues");
        }
      }

      if (nextStage === "active") {
        if (!project.scope_of_work) {
          throw new Error("Cannot advance to active: scope_of_work not populated");
        }
        const sprints = await pgQuery(
          `SELECT COUNT(*) as count FROM pipeline_sprints WHERE project_id = $1`, [project.id]
        );
        if (parseInt(sprints.rows[0].count) === 0) {
          throw new Error("Cannot advance to active: no sprints defined");
        }
      }

      if (nextStage === "completed") {
        const sprints = await pgQuery(
          `SELECT sprint_number, status FROM pipeline_sprints WHERE project_id = $1 AND status != 'completed'`,
          [project.id]
        );
        if (sprints.rowCount > 0) {
          throw new Error(`Cannot complete: ${sprints.rowCount} sprints not completed: ${sprints.rows.map((s: any) => s.sprint_number).join(", ")}`);
        }
      }

      // Apply stage change
      const timestamps: Record<string, string> = {
        research: "research_started_at",
        active: "build_started_at",
        completed: "completed_at",
      };
      const tsField = timestamps[nextStage];
      const tsClause = tsField ? `, ${tsField} = NOW()` : "";

      const result = await pgQuery(
        `UPDATE pipeline_projects SET stage = $1, updated_at = NOW()${tsClause} WHERE id = $2 RETURNING *`,
        [nextStage, project.id]
      );

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "stage_changed", JSON.stringify({ from: project.stage, to: nextStage })]
      );

      await triggerN8n("project-gitlab-sync", { action: "stage_change", project: result.rows[0], from: project.stage, to: nextStage });

      // Trigger dev-team orchestrator for automated stages
      const automatedStages = ["architecture", "security_review", "active"];
      if (automatedStages.includes(nextStage)) {
        log("info", "stage", "advance", `Triggering dev-team-orchestrator for stage: ${nextStage}`, { slug: p.slug });
        const orchResult = await triggerN8n("dev-team-orchestrator", {
          action: "stage_entered",
          stage: nextStage,
          project: result.rows[0],
        });
        if (!orchResult) {
          await ntfyError("stage", "orchestrator", `Dev-team orchestrator FAILED to trigger for ${p.slug} → ${nextStage}`, {
            slug: p.slug, stage: nextStage,
          });
        } else {
          log("info", "stage", "advance", `Dev-team orchestrator triggered OK for ${nextStage}`, { slug: p.slug, result: orchResult });
        }
      }

      await ntfyNotify(`${project.name}: ${project.stage} → ${nextStage}`, "Stage Change", 3, ["arrow_right"]);

      return result.rows[0];
    },
  },

  archive_project: {
    description: "Soft-archive a project (sets stage to 'archived').",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const result = await pgQuery(
        `UPDATE pipeline_projects SET stage = 'archived', updated_at = NOW() WHERE slug = $1 RETURNING *`,
        [p.slug]
      );
      if (result.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [result.rows[0].id, "project_archived", JSON.stringify({ slug: p.slug })]
      );
      return result.rows[0];
    },
  },

  // ── Research ─────────────────────────────────────────────

  start_research: {
    description: "Set project stage to 'research' and run the Dify research pipeline. Creates placeholder research sections and processes them sequentially via Dify.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      // Create research section rows
      for (const section of RESEARCH_SECTIONS) {
        await pgQuery(
          `INSERT INTO pipeline_research (project_id, section) VALUES ($1, $2) ON CONFLICT (project_id, section) DO NOTHING`,
          [project.id, section]
        );
      }

      // Update stage
      await pgQuery(
        `UPDATE pipeline_projects SET stage = 'research', research_started_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [project.id]
      );

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "research_started", JSON.stringify({ sections: RESEARCH_SECTIONS })]
      );

      // Fire-and-forget: run Dify research pipeline in background
      runResearchPipeline({
        id: project.id,
        slug: project.slug,
        name: project.name,
        description: project.description,
      }).catch(async (err) => {
        await ntfyError("research", "pipeline", `Pipeline CRASHED for ${project.slug}: ${err.message}`, {
          slug: project.slug, error: err.message, stack: err.stack?.slice(0, 500),
        });
      });

      await ntfyNotify(`Research started for: ${project.name}`, "Research Started", 3, ["mag"]);

      return { ok: true, slug: project.slug, sections: RESEARCH_SECTIONS, message: "Dify research pipeline launched (runs in background)" };
    },
  },

  get_research: {
    description: "Get all research sections for a project.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `SELECT * FROM pipeline_research WHERE project_id = $1 ORDER BY section`, [proj.rows[0].id]
      );
      return { slug: p.slug, sections: result.rows };
    },
  },

  update_research: {
    description: "Update a specific research section with findings.",
    params: {
      slug: "Project slug",
      section: "Section name (libraries, architecture, security, dependencies, file-structure, tools, containers, integration, costs, open-source-scan, best-practices, ui-ux-research, prior-art, architecture-design, security-assessment)",
      findings: "(optional) Findings as JSON object",
      concerns: "(optional) Array of concern strings",
      recommendations: "(optional) Array of recommendation strings",
      confidence_score: "(optional) Confidence score 1-10",
      status: "(optional) pending|in_progress|complete|needs_input",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const fields: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (p.findings !== undefined) { fields.push(`findings = $${idx++}`); params.push(JSON.stringify(p.findings)); }
      if (p.concerns !== undefined) { fields.push(`concerns = $${idx++}`); params.push(p.concerns); }
      if (p.recommendations !== undefined) { fields.push(`recommendations = $${idx++}`); params.push(p.recommendations); }
      if (p.confidence_score !== undefined) { fields.push(`confidence_score = $${idx++}`); params.push(p.confidence_score); }
      if (p.status !== undefined) { fields.push(`status = $${idx++}`); params.push(p.status); }
      fields.push(`updated_at = NOW()`);

      if (fields.length <= 1) throw new Error("No fields to update");

      params.push(proj.rows[0].id, p.section);
      const sql = `UPDATE pipeline_research SET ${fields.join(", ")} WHERE project_id = $${idx++} AND section = $${idx} RETURNING *`;
      const result = await pgQuery(sql, params);
      if (result.rowCount === 0) throw new Error(`Section '${p.section}' not found for project '${p.slug}'`);

      return result.rows[0];
    },
  },

  complete_research: {
    description: "Mark research done and compile/store scope of work.",
    params: {
      slug: "Project slug",
      scope_of_work: "Compiled SOW as JSON object",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      // Mark all research sections complete
      await pgQuery(
        `UPDATE pipeline_research SET status = 'complete', updated_at = NOW() WHERE project_id = $1 AND status != 'complete'`,
        [project.id]
      );

      // Store SOW and update timestamps
      await pgQuery(
        `UPDATE pipeline_projects SET scope_of_work = $1, research_completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(p.scope_of_work), project.id]
      );

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "research_completed", JSON.stringify({ sections_count: RESEARCH_SECTIONS.length })]
      );

      await ntfyNotify(`Research complete for: ${project.name}. SOW ready.`, "Research Complete", 4, ["white_check_mark"]);

      return { ok: true, slug: p.slug, message: "Research completed and SOW stored" };
    },
  },

  // ── Questions (Async Q&A) ────────────────────────────────

  add_question: {
    description: "Post a question about a project. Sends ntfy notification for async Q&A.",
    params: {
      slug: "Project slug",
      question: "The question text",
      context: "(optional) Context for why this question matters",
      priority: "(optional) blocking|normal|nice-to-have, default normal",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `INSERT INTO pipeline_questions (project_id, question, context, priority)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [proj.rows[0].id, p.question, p.context || null, p.priority || "normal"]
      );

      const priorityTag = p.priority === "blocking" ? "exclamation" : "question";
      const priorityLevel = p.priority === "blocking" ? 4 : 3;
      await ntfyNotify(
        `[${proj.rows[0].name}] ${p.question}`,
        `${(p.priority || "normal").toUpperCase()} Question`,
        priorityLevel,
        [priorityTag]
      );

      return result.rows[0];
    },
  },

  answer_question: {
    description: "Answer a question by ID. Checks if this unblocks research and triggers resume if so.",
    params: {
      id: "Question ID",
      answer: "The answer text",
    },
    handler: async (p) => {
      const result = await pgQuery(
        `UPDATE pipeline_questions SET answer = $1, answered_at = NOW() WHERE id = $2 RETURNING *`,
        [p.answer, p.id]
      );
      if (result.rowCount === 0) throw new Error(`Question ${p.id} not found`);

      const question = result.rows[0];

      // Check if this was a blocking question and if research can resume
      if (question.priority === "blocking") {
        const remaining = await pgQuery(
          `SELECT COUNT(*) as count FROM pipeline_questions WHERE project_id = $1 AND priority = 'blocking' AND answer IS NULL`,
          [question.project_id]
        );
        if (parseInt(remaining.rows[0].count) === 0) {
          // All blocking questions answered — check for needs_input sections
          const needsInput = await pgQuery(
            `SELECT section FROM pipeline_research WHERE project_id = $1 AND status = 'needs_input'`,
            [question.project_id]
          );
          if (needsInput.rowCount > 0) {
            const proj = await pgQuery(`SELECT slug FROM pipeline_projects WHERE id = $1`, [question.project_id]);
            triggerN8n("project-research-resume", {
              slug: proj.rows[0].slug,
              sections: needsInput.rows.map((r: any) => r.section),
            });
            return { ...question, research_resumed: true, sections: needsInput.rows.map((r: any) => r.section) };
          }
        }
      }

      return question;
    },
  },

  get_unanswered: {
    description: "Get all unanswered questions, optionally filtered by project. Sorted: blocking first.",
    params: {
      slug: "(optional) Filter by project slug",
    },
    handler: async (p) => {
      let sql = `
        SELECT pq.*, pp.slug, pp.name as project_name
        FROM pipeline_questions pq
        JOIN pipeline_projects pp ON pp.id = pq.project_id
        WHERE pq.answer IS NULL`;
      const params: any[] = [];

      if (p.slug) {
        sql += ` AND pp.slug = $1`;
        params.push(p.slug);
      }
      sql += ` ORDER BY CASE pq.priority WHEN 'blocking' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, pq.asked_at ASC`;

      const result = await pgQuery(sql, params);
      return { questions: result.rows, count: result.rowCount };
    },
  },

  get_questions: {
    description: "Get all questions for a project (answered and unanswered).",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `SELECT * FROM pipeline_questions WHERE project_id = $1 ORDER BY asked_at ASC`,
        [proj.rows[0].id]
      );
      return { slug: p.slug, questions: result.rows, count: result.rowCount };
    },
  },

  // ── Sprints ──────────────────────────────────────────────

  add_sprint: {
    description: "Add a sprint plan to a project.",
    params: {
      slug: "Project slug",
      sprint_number: "Sprint number (sequential)",
      name: "Sprint name",
      description: "(optional) Sprint description",
      tasks: "(optional) Array of {task, estimated_hours, status} objects",
      estimated_hours: "(optional) Total estimated hours",
      estimated_loc: "(optional) Estimated lines of code",
      complexity: "(optional) low|medium|high|extreme",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `INSERT INTO pipeline_sprints (project_id, sprint_number, name, description, tasks, estimated_hours, estimated_loc, complexity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          proj.rows[0].id, p.sprint_number, p.name, p.description || null,
          p.tasks ? JSON.stringify(p.tasks) : null, p.estimated_hours || null,
          p.estimated_loc || null, p.complexity || null,
        ]
      );
      return result.rows[0];
    },
  },

  update_sprint: {
    description: "Update sprint fields: status, actual hours, actual LOC, tasks.",
    params: {
      slug: "Project slug",
      sprint_number: "Sprint number",
      status: "(optional) pending|active|completed",
      actual_hours: "(optional) Actual hours worked",
      actual_loc: "(optional) Actual lines of code",
      tasks: "(optional) Updated tasks array",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const fields: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (p.status !== undefined) { fields.push(`status = $${idx++}`); params.push(p.status); }
      if (p.actual_hours !== undefined) { fields.push(`actual_hours = $${idx++}`); params.push(p.actual_hours); }
      if (p.actual_loc !== undefined) { fields.push(`actual_loc = $${idx++}`); params.push(p.actual_loc); }
      if (p.tasks !== undefined) { fields.push(`tasks = $${idx++}`); params.push(JSON.stringify(p.tasks)); }
      if (fields.length === 0) throw new Error("No fields to update");

      params.push(proj.rows[0].id, p.sprint_number);
      const sql = `UPDATE pipeline_sprints SET ${fields.join(", ")} WHERE project_id = $${idx++} AND sprint_number = $${idx} RETURNING *`;
      const result = await pgQuery(sql, params);
      if (result.rowCount === 0) throw new Error(`Sprint ${p.sprint_number} not found`);

      return result.rows[0];
    },
  },

  start_sprint: {
    description: "Set a sprint to active and record start timestamp.",
    params: {
      slug: "Project slug",
      sprint_number: "Sprint number",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `UPDATE pipeline_sprints SET status = 'active', started_at = NOW() WHERE project_id = $1 AND sprint_number = $2 RETURNING *`,
        [proj.rows[0].id, p.sprint_number]
      );
      if (result.rowCount === 0) throw new Error(`Sprint ${p.sprint_number} not found`);

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [proj.rows[0].id, "sprint_started", JSON.stringify({ sprint_number: p.sprint_number, name: result.rows[0].name })]
      );

      await ntfyNotify(`Sprint ${p.sprint_number} started: ${result.rows[0].name}`, `${proj.rows[0].name}`, 3, ["runner"]);
      return result.rows[0];
    },
  },

  complete_sprint: {
    description: "Complete a sprint. Records timestamp and updates project actual_hours.",
    params: {
      slug: "Project slug",
      sprint_number: "Sprint number",
      actual_hours: "(optional) Final actual hours for this sprint",
      actual_loc: "(optional) Final actual LOC",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const updates = ["status = 'completed'", "completed_at = NOW()"];
      const params: any[] = [];
      let idx = 1;

      if (p.actual_hours !== undefined) { updates.push(`actual_hours = $${idx++}`); params.push(p.actual_hours); }
      if (p.actual_loc !== undefined) { updates.push(`actual_loc = $${idx++}`); params.push(p.actual_loc); }

      params.push(proj.rows[0].id, p.sprint_number);
      const sql = `UPDATE pipeline_sprints SET ${updates.join(", ")} WHERE project_id = $${idx++} AND sprint_number = $${idx} RETURNING *`;
      const result = await pgQuery(sql, params);
      if (result.rowCount === 0) throw new Error(`Sprint ${p.sprint_number} not found`);

      // Update project total actual_hours
      await pgQuery(
        `UPDATE pipeline_projects SET actual_hours = (SELECT COALESCE(SUM(actual_hours), 0) FROM pipeline_sprints WHERE project_id = $1), updated_at = NOW() WHERE id = $1`,
        [proj.rows[0].id]
      );

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [proj.rows[0].id, "sprint_completed", JSON.stringify({ sprint_number: p.sprint_number, actual_hours: result.rows[0].actual_hours })]
      );

      await ntfyNotify(`Sprint ${p.sprint_number} complete!`, `${proj.rows[0].name}`, 3, ["checkered_flag"]);
      return result.rows[0];
    },
  },

  // ── Agent Tasks ────────────────────────────────────────

  create_agent_task: {
    description: "Create an agent task for a project sprint. Used by the dev-team orchestrator to queue work items.",
    params: {
      slug: "Project slug",
      sprint_number: "(optional) Sprint number",
      task_type: "Task type: architect|security|code|review|test|ui",
      agent_model: "(optional) Model to use (e.g. deepseek/deepseek-r1, anthropic/claude-sonnet-4-5)",
      prompt: "Task prompt for the agent",
      tools_enabled: "(optional) Array of gateway tool names this agent can use",
      guardrails: "(optional) Object: {max_actions, max_tokens, timeout_minutes}",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      let sprintId = null;
      if (p.sprint_number) {
        const sprint = await pgQuery(
          `SELECT id FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2`,
          [proj.rows[0].id, p.sprint_number]
        );
        if (sprint.rowCount > 0) sprintId = sprint.rows[0].id;
      }

      const result = await pgQuery(
        `INSERT INTO agent_tasks (project_id, sprint_id, task_type, agent_model, prompt, tools_enabled, guardrails)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          proj.rows[0].id, sprintId, p.task_type, p.agent_model || null,
          p.prompt, p.tools_enabled || null,
          p.guardrails ? JSON.stringify(p.guardrails) : null,
        ]
      );
      return result.rows[0];
    },
  },

  list_agent_tasks: {
    description: "List agent tasks for a project, optionally filtered by status or type.",
    params: {
      slug: "Project slug",
      status: "(optional) Filter: queued|assigned|in_progress|completed|failed|escalated",
      task_type: "(optional) Filter by type: architect|security|code|review|test|ui",
      sprint_number: "(optional) Filter by sprint",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      let sql = `SELECT at.*, ps.sprint_number, ps.name as sprint_name
        FROM agent_tasks at
        LEFT JOIN pipeline_sprints ps ON ps.id = at.sprint_id
        WHERE at.project_id = $1`;
      const params: any[] = [proj.rows[0].id];
      let idx = 2;

      if (p.status) { sql += ` AND at.status = $${idx++}`; params.push(p.status); }
      if (p.task_type) { sql += ` AND at.task_type = $${idx++}`; params.push(p.task_type); }
      if (p.sprint_number) { sql += ` AND ps.sprint_number = $${idx++}`; params.push(p.sprint_number); }
      sql += ` ORDER BY at.created_at ASC`;

      const result = await pgQuery(sql, params);
      return { slug: p.slug, tasks: result.rows, count: result.rowCount };
    },
  },

  update_agent_task: {
    description: "Update an agent task status, result, or iteration count.",
    params: {
      id: "Agent task ID",
      status: "(optional) New status: queued|assigned|in_progress|completed|failed|escalated",
      result: "(optional) Result as JSON object",
      iteration: "(optional) New iteration count",
    },
    handler: async (p) => {
      const fields: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (p.status !== undefined) {
        fields.push(`status = $${idx++}`);
        params.push(p.status);
        if (p.status === "in_progress") fields.push("started_at = NOW()");
        if (p.status === "completed" || p.status === "failed") fields.push("completed_at = NOW()");
      }
      if (p.result !== undefined) { fields.push(`result = $${idx++}`); params.push(JSON.stringify(p.result)); }
      if (p.iteration !== undefined) { fields.push(`iteration = $${idx++}`); params.push(p.iteration); }
      if (fields.length === 0) throw new Error("No fields to update");

      params.push(p.id);
      const sql = `UPDATE agent_tasks SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
      const result = await pgQuery(sql, params);
      if (result.rowCount === 0) throw new Error(`Agent task ${p.id} not found`);
      return result.rows[0];
    },
  },

  run_devteam_workflow: {
    description: "Run a dev-team Dify workflow. Pass async=true to return immediately with a job_id (poll with get_devteam_result). Default: blocking.",
    params: {
      workflow: "Workflow name from DIFY_DEVTEAM_KEYS",
      inputs: "Input variables as object (project_name, research_findings, architecture_design, etc.)",
      async: "(optional) Set to true to run in background and return job_id immediately",
    },
    handler: async (p) => {
      const apiKey = DIFY_DEVTEAM_KEYS[p.workflow];
      if (!apiKey) throw new Error(`Unknown dev-team workflow: ${p.workflow}. Available: ${Object.keys(DIFY_DEVTEAM_KEYS).join(", ")}`);
      if (!apiKey.startsWith("app-")) throw new Error(`Dify API key not configured for workflow: ${p.workflow}`);

      // Async mode: fire and return job_id
      if (p.async) {
        const jobId = `job-${++jobCounter}-${Date.now()}`;
        const job: AsyncJob = { id: jobId, workflow: p.workflow, status: "running", started_at: new Date().toISOString() };
        asyncJobs.set(jobId, job);
        log("info", "devteam", p.workflow, `Async job started: ${jobId}`, { inputs_keys: Object.keys(p.inputs || {}) });

        callDify(apiKey, p.inputs || {}, p.workflow).then((difyResponse) => {
          const data = difyResponse?.data;
          if (!data || data.status !== "succeeded") {
            job.status = "failed";
            job.error = data?.error || "unknown error";
            job.completed_at = new Date().toISOString();
            ntfyError("devteam", p.workflow, `Async job ${jobId} failed: ${job.error}`, { workflow: p.workflow });
          } else {
            job.status = "succeeded";
            job.result = data.outputs?.result || data.outputs;
            job.elapsed_time = data.elapsed_time;
            job.total_tokens = data.total_tokens;
            job.completed_at = new Date().toISOString();
            log("info", "devteam", p.workflow, `Async job ${jobId} succeeded`, { tokens: data.total_tokens, elapsed: data.elapsed_time });
          }
        }).catch((e: any) => {
          job.status = "failed";
          job.error = e.message;
          job.completed_at = new Date().toISOString();
          ntfyError("devteam", p.workflow, `Async job ${jobId} error: ${e.message}`, { workflow: p.workflow });
        });

        return { job_id: jobId, workflow: p.workflow, status: "running", message: "Workflow started in background. Poll with get_devteam_result." };
      }

      // Blocking mode (original behavior)
      const difyResponse = await callDify(apiKey, p.inputs || {}, p.workflow);
      const data = difyResponse?.data;
      if (!data || data.status !== "succeeded") {
        const errMsg = `Dify workflow ${p.workflow} failed: ${data?.error || "unknown error"}`;
        await ntfyError("devteam", p.workflow, errMsg, {
          workflow: p.workflow, status: data?.status, error: data?.error,
        });
        throw new Error(errMsg);
      }
      log("info", "devteam", p.workflow, `Workflow succeeded`, {
        tokens: data.total_tokens, elapsed: data.elapsed_time,
      });
      return {
        workflow: p.workflow,
        result: data.outputs?.result || data.outputs,
        elapsed_time: data.elapsed_time,
        total_tokens: data.total_tokens,
      };
    },
  },

  get_devteam_result: {
    description: "Check status/result of an async dev-team workflow job. Returns status (running|succeeded|failed) and result when done.",
    params: {
      job_id: "(optional) Specific job ID to check. Omit to list all recent jobs.",
    },
    handler: async (p) => {
      if (p.job_id) {
        const job = asyncJobs.get(p.job_id);
        if (!job) throw new Error(`Job '${p.job_id}' not found. Jobs are in-memory and lost on container restart.`);
        return job;
      }
      const jobs = Array.from(asyncJobs.values()).reverse().slice(0, 20);
      return { jobs, total: asyncJobs.size };
    },
  },

  // ── Artifacts & Tracking ─────────────────────────────────

  add_artifact: {
    description: "Link a file, container, service, repo, or URL to a project.",
    params: {
      slug: "Project slug",
      type: "Artifact type: file|link|container|service|repo",
      name: "Artifact name",
      path_or_url: "(optional) Path or URL",
      description: "(optional) Description",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `INSERT INTO pipeline_artifacts (project_id, type, name, path_or_url, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [proj.rows[0].id, p.type, p.name, p.path_or_url || null, p.description || null]
      );
      return result.rows[0];
    },
  },

  list_artifacts: {
    description: "List all artifacts for a project.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `SELECT * FROM pipeline_artifacts WHERE project_id = $1 ORDER BY created_at`, [proj.rows[0].id]
      );
      return { slug: p.slug, artifacts: result.rows, count: result.rowCount };
    },
  },

  log_event: {
    description: "Log a manual event for a project.",
    params: {
      slug: "Project slug",
      event_type: "Event type string (e.g. 'note', 'decision', 'blocker', 'milestone')",
      details: "(optional) Event details as JSON object",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3) RETURNING *`,
        [proj.rows[0].id, p.event_type, p.details ? JSON.stringify(p.details) : null]
      );
      return result.rows[0];
    },
  },

  get_metrics: {
    description: "Build analytics: avg hours per complexity, estimate accuracy, cost per project, LOC velocity.",
    params: {},
    handler: async () => {
      const [stages, complexity, accuracy, costs, recent] = await Promise.all([
        // Projects by stage
        pgQuery(`SELECT stage, COUNT(*) as count FROM pipeline_projects GROUP BY stage ORDER BY stage`),
        // Avg hours by complexity
        pgQuery(`SELECT complexity, COUNT(*) as sprints, AVG(actual_hours) as avg_hours, AVG(actual_loc) as avg_loc FROM pipeline_sprints WHERE status = 'completed' AND complexity IS NOT NULL GROUP BY complexity`),
        // Estimate accuracy
        pgQuery(`SELECT
          COUNT(*) as completed_projects,
          AVG(CASE WHEN estimated_hours > 0 THEN actual_hours / estimated_hours ELSE NULL END) as hours_accuracy_ratio,
          AVG(CASE WHEN estimated_cost > 0 THEN actual_cost / estimated_cost ELSE NULL END) as cost_accuracy_ratio
          FROM pipeline_projects WHERE stage = 'completed'`),
        // Total costs
        pgQuery(`SELECT SUM(actual_cost) as total_cost, AVG(actual_cost) as avg_cost FROM pipeline_projects WHERE actual_cost > 0`),
        // Recent activity
        pgQuery(`SELECT event_type, COUNT(*) as count FROM pipeline_events WHERE timestamp > NOW() - INTERVAL '7 days' GROUP BY event_type`),
      ]);

      return {
        projects_by_stage: stages.rows,
        hours_by_complexity: complexity.rows,
        estimate_accuracy: accuracy.rows[0],
        cost_summary: costs.rows[0],
        recent_activity_7d: recent.rows,
      };
    },
  },

  get_timeline: {
    description: "Get event history for a project.",
    params: {
      slug: "Project slug",
      limit: "(optional) Max events, default 50",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      const result = await pgQuery(
        `SELECT * FROM pipeline_events WHERE project_id = $1 ORDER BY timestamp DESC LIMIT $2`,
        [proj.rows[0].id, p.limit || 50]
      );
      return { slug: p.slug, events: result.rows, count: result.rowCount };
    },
  },
};

// --- Registration ---

export function registerProjectTools(server: McpServer) {
  server.tool(
    "project_list",
    "List all available Project Pipeline tools. Manages the full dev-team automation lifecycle: idea capture, " +
    "research (13 sections), architecture, security review, planning, building, and completion. Tools cover: " +
    "project CRUD (create/list/get/update/advance/archive), research (start/get/update/complete), " +
    "agent tasks (create/list/update/run_devteam_workflow), async questions (add/answer/get_unanswered/get), " +
    "sprints (add/update/start/complete), artifacts (add/list), and tracking (log_event/get_metrics/get_timeline).",
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
    "project_call",
    "Execute a Project Pipeline tool. Use project_list to see available tools. " +
    "Manages project lifecycle from idea capture through research, planning, building, and completion.",
    {
      tool: z.string().describe("Tool name from project_list"),
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
        // Send ntfy for unexpected errors in critical tools
        const criticalTools = ["advance_stage", "start_research", "run_devteam_workflow", "create_agent_task"];
        if (criticalTools.includes(tool)) {
          await ntfyError("call", tool, `Tool ${tool} failed: ${error.message}`, {
            tool, params: Object.keys(params || {}),
          });
        }
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
