/**
 * Mattermost slash command handlers for /todo and /queue.
 * Backed by Postgres — items are tracked in mm_todo_items table.
 * Queue is derived from pipeline_projects (no new table).
 */
import { pgQuery } from "../utils/postgres.js";

// ── Schema ──────────────────────────────────────────────────

let schemaReady = false;

export async function ensureTodoSchema(): Promise<void> {
  if (schemaReady) return;
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS mm_todo_items (
      id SERIAL PRIMARY KEY,
      item TEXT NOT NULL,
      context TEXT,
      priority TEXT DEFAULT 'info',
      source TEXT DEFAULT 'system',
      project_name TEXT,
      created_by TEXT DEFAULT 'system',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      completed_by TEXT
    )
  `);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_mm_todo_open
    ON mm_todo_items (completed_at) WHERE completed_at IS NULL
  `);
  schemaReady = true;
}

// ── /todo handler ───────────────────────────────────────────

export async function handleTodoCommand(text: string, userName: string): Promise<string> {
  await ensureTodoSchema();

  const parts = text.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase() || "list";

  if (sub === "done") {
    const id = parseInt(parts[1]);
    if (!id || isNaN(id)) return ":warning: Usage: `/todo done <id>`";
    const res = await pgQuery(
      `UPDATE mm_todo_items SET completed_at = NOW(), completed_by = $1
       WHERE id = $2 AND completed_at IS NULL RETURNING id`,
      [userName, id]
    );
    if (res.rowCount === 0) return `:warning: Item #${id} not found or already completed.`;
    return `:white_check_mark: Marked #${id} as done.`;
  }

  if (sub === "add") {
    const item = parts.slice(1).join(" ");
    if (!item) return ":warning: Usage: `/todo add <text>`";
    const res = await pgQuery(
      `INSERT INTO mm_todo_items (item, source, created_by) VALUES ($1, 'manual', $2) RETURNING id`,
      [item, userName]
    );
    return `:white_check_mark: Added item #${res.rows[0].id}: ${item}`;
  }

  if (sub === "help") {
    return [
      "#### :clipboard: /todo — To-Do List",
      "| Command | Description |",
      "|---------|-------------|",
      "| `/todo` | List open items |",
      "| `/todo add <text>` | Add a manual item |",
      "| `/todo done <id>` | Mark item as completed |",
      "| `/todo help` | Show this help |",
    ].join("\n");
  }

  // Default: list
  const res = await pgQuery(`
    SELECT id, item, context, priority, project_name, created_by, created_at
    FROM mm_todo_items
    WHERE completed_at IS NULL
    ORDER BY
      CASE priority WHEN 'blocking' THEN 1 WHEN 'action-needed' THEN 2 ELSE 3 END,
      created_at ASC
  `);

  if (res.rows.length === 0) return ":white_check_mark: To-do list is empty!";

  const header = `#### :clipboard: To-Do List (${res.rows.length} open)\n\n| # | Priority | Item | Context | Age |\n|---|----------|------|---------|-----|`;
  const rows = res.rows.map((r: any) => {
    const icon = r.priority === "blocking" ? ":red_circle: blocking"
      : r.priority === "action-needed" ? ":large_orange_circle: action-needed"
      : ":large_blue_circle: info";
    const ctx = r.context || r.project_name || "—";
    const age = formatAge(r.created_at);
    return `| ${r.id} | ${icon} | ${r.item} | ${ctx} | ${age} |`;
  });

  return [header, ...rows, "", "`/todo done <#>` · `/todo add <text>`"].join("\n");
}

// ── /queue handler ──────────────────────────────────────────

export async function handleQueueCommand(text: string, _userName: string): Promise<string> {
  const stageFilter = text.trim().toLowerCase() || null;

  let sql = `
    SELECT pp.id, pp.name, pp.slug, pp.stage, pp.priority, pp.updated_at,
      (SELECT COUNT(*) FROM pipeline_sprints ps WHERE ps.project_id = pp.id) AS sprints,
      (SELECT COUNT(*) FROM pipeline_questions pq WHERE pq.project_id = pp.id AND pq.answer IS NULL) AS pending_qs,
      (SELECT COUNT(*) FROM agent_tasks at2 WHERE at2.project_id = pp.id AND at2.status = 'pending_review') AS reviews
    FROM pipeline_projects pp
    WHERE pp.completed_at IS NULL
  `;
  const params: any[] = [];

  if (stageFilter) {
    params.push(stageFilter);
    sql += ` AND pp.stage = $${params.length}`;
  }

  sql += `
    ORDER BY pp.priority ASC, pp.updated_at DESC
  `;

  const res = await pgQuery(sql, params);

  if (res.rows.length === 0) {
    return stageFilter
      ? `:bar_chart: No projects in **${stageFilter}** stage.`
      : ":bar_chart: Project queue is empty!";
  }

  const header = `#### :bar_chart: Project Queue (${res.rows.length} active)\n\n| Priority | Project | Stage | Sprints | Pending Q's | Reviews |\n|----------|---------|-------|---------|-------------|---------|`;

  const priorityLabels: Record<number, string> = {
    1: ":exclamation: critical",
    2: ":exclamation: high",
    3: "medium",
    4: "low",
    5: "backlog",
  };

  const rows = res.rows.map((r: any) => {
    const pri = priorityLabels[r.priority] || `${r.priority}`;
    return `| ${pri} | **${r.name}** | ${r.stage} | ${r.sprints} | ${r.pending_qs} | ${r.reviews} |`;
  });

  // Summary line
  const stages = res.rows.reduce((acc: Record<string, number>, r: any) => {
    acc[r.stage] = (acc[r.stage] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(stages).map(([s, c]) => `${c} ${s}`).join(" · ");

  return [header, ...rows, "", `${res.rows.length} projects · ${summary}`].join("\n");
}

// ── Helpers ─────────────────────────────────────────────────

function formatAge(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

