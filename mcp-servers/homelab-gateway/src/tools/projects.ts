import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";
const NTFY_URL = process.env.NTFY_URL || "http://ntfy:80";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "homelab-projects";
const N8N_WEBHOOK_BASE = process.env.N8N_WEBHOOK_BASE || "http://n8n:5678/webhook";

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

async function ntfyNotify(message: string, title?: string, priority?: number, tags?: string[]): Promise<void> {
  try {
    const headers: Record<string, string> = {};
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
  try {
    const res = await fetch(`${N8N_WEBHOOK_BASE}/${webhookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.error(`n8n webhook ${webhookPath} returned ${res.status}`);
      return null;
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch (e: any) {
    console.error(`n8n webhook ${webhookPath} failed:`, e.message);
    return null;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const VALID_STAGES = ["queue", "research", "planning", "active", "completed", "archived"];
const STAGE_ORDER = ["queue", "research", "planning", "active", "completed"];
const RESEARCH_SECTIONS = [
  "libraries", "architecture", "security", "dependencies",
  "file-structure", "tools", "containers", "integration", "costs",
];

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
      triggerN8n("project-gitlab-sync", { action: "create", project });

      // Notify
      await ntfyNotify(`New project: ${p.name}`, "Project Created", 3, ["rocket"]);

      return project;
    },
  },

  list_projects: {
    description: "List projects with optional filters. Returns summary with question counts.",
    params: {
      stage: "(optional) Filter by stage: queue|research|planning|active|completed|archived",
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
      triggerN8n("project-gitlab-sync", { action: "update", project });
      return project;
    },
  },

  advance_stage: {
    description: "Move project to next stage with validation gates. queue->research->planning->active->completed.",
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
      if (nextStage === "planning") {
        const research = await pgQuery(
          `SELECT section, status FROM pipeline_research WHERE project_id = $1`, [project.id]
        );
        const incomplete = research.rows.filter((r: any) => r.status !== "complete");
        if (incomplete.length > 0) {
          throw new Error(`Cannot advance to planning: ${incomplete.length} research sections incomplete: ${incomplete.map((r: any) => r.section).join(", ")}`);
        }
        const blocking = await pgQuery(
          `SELECT COUNT(*) as count FROM pipeline_questions WHERE project_id = $1 AND answer IS NULL AND priority = 'blocking'`,
          [project.id]
        );
        if (parseInt(blocking.rows[0].count) > 0) {
          throw new Error(`Cannot advance to planning: ${blocking.rows[0].count} blocking questions unanswered`);
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

      triggerN8n("project-gitlab-sync", { action: "stage_change", project: result.rows[0], from: project.stage, to: nextStage });
      await ntfyNotify(`${project.name}: ${project.stage} -> ${nextStage}`, "Stage Change", 3, ["arrow_right"]);

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
    description: "Set project stage to 'research' and trigger the n8n research pipeline. Creates placeholder research sections.",
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

      // Trigger n8n research pipeline
      triggerN8n("project-research-pipeline", {
        slug: project.slug,
        id: project.id,
        name: project.name,
        description: project.description,
      });

      await ntfyNotify(`Research started for: ${project.name}`, "Research Started", 3, ["mag"]);

      return { ok: true, slug: project.slug, sections: RESEARCH_SECTIONS, message: "Research pipeline triggered" };
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
      section: "Section name (libraries, architecture, security, dependencies, file-structure, tools, containers, integration, costs)",
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
    "List all available Project Pipeline tools. Manages the full project lifecycle: idea capture, research, " +
    "async Q&A, sprint planning, time tracking, and metrics. Tools cover: project CRUD (create/list/get/update/advance/archive), " +
    "research (start/get/update/complete), async questions (add/answer/get_unanswered/get), " +
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
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
