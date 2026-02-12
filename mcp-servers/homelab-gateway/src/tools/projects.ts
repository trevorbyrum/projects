import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";
import { searchPreferences } from "./preferences.js";
import { gitlabFetch, createWorkspaceDirect, createCodingSessionDirect, mergeSprintDirect, promoteCodeToProjectRepo, getConversationStatus } from "./workspaces.js";
import { startAndRunWarRoom } from "./war-room.js";
import { mmAlert, mmPipelineUpdate, mmDeliverable, mmPostWithId, mmUpdatePost, mmPost } from "./mm-notify.js";

const { Pool } = pg;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";
const N8N_WEBHOOK_BASE = process.env.N8N_WEBHOOK_BASE || "http://n8n:5678/webhook";

// n8n 2.4.6 webhook URLs include workflowId prefix: /webhook/{workflowId}/webhook/{path}
const N8N_WEBHOOK_IDS: Record<string, string> = {
  "project-gitlab-sync": "your-webhook-id",
  "project-research-pipeline": "your-webhook-id",
  "project-research-resume": "your-webhook-id",
  "dev-team-orchestrator": "",  // path-only webhook format (API-created)
};

let pool: pg.Pool | null = null;

// -- Async Workflow Job Store -------------------------------------------------
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

// -- Structured Logging -------------------------------------------------------

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

async function ntfyNotify(message: string, title?: string, _priority?: number, tags?: string[]): Promise<void> {
  const emoji = tags?.length ? `:${tags[0]}: ` : "";
  const titleStr = title ? `**${emoji}${title}**\n` : "";
  await mmPost("dev-logs", `${titleStr}${message}`);
}

async function ntfyError(module: string, op: string, error: string, meta?: Record<string, any>) {
  log("error", module, op, error, meta);
  await mmAlert(module, op, error, meta);
}

async function ntfyWarn(module: string, op: string, message: string, meta?: Record<string, any>) {
  log("warn", module, op, message, meta);
  const metaStr = meta ? "\n```json\n" + JSON.stringify(meta, null, 2) + "\n```" : "";
  await mmPost("alerts", `#### :warning: Warning in \`${module}.${op}\`\n${message}${metaStr}`);
}


// Dify workflow API keys per research section
const DIFY_SECTION_KEYS: Record<string, string> = {
  "libraries":         "your-dify-key",
  "architecture":      "your-dify-key",
  "security":          "your-dify-key",
  "dependencies":      "your-dify-key",
  "file-structure":    "your-dify-key",
  "tools":             "your-dify-key",
  "containers":        "your-dify-key",
  "integration":       "your-dify-key",
  "costs":             "your-dify-key",
  "open-source-scan":  "your-dify-key",
  "best-practices":    "your-dify-key",
  "ui-ux-research":    "your-dify-key",
  "prior-art":         "your-dify-key",
};

// Dev-team Dify workflow API keys
const DIFY_DEVTEAM_KEYS: Record<string, string> = {
  "architect-design":        "your-dify-key",
  "architect-revise":        "your-dify-key",
  "security-review":         "your-dify-key",
  "pm-generate-sow":         "your-dify-key",
  "pm-generate-task-prompts":"your-dify-key",
  "code-reviewer":           "your-dify-key",
  "focused-research":        "your-dify-key",
};

const DIFY_API_BASE = process.env.DIFY_API_BASE || "http://dify-api:5001";

// Overwatch classification workflow
const DIFY_OVERWATCH_KEY = process.env.DIFY_OVERWATCH_CLASSIFY_KEY || "";

// Market Viability Dify workflow keys (6 sections)
const DIFY_MARKET_KEYS: Record<string, string> = {
  "tam-sam-som":           process.env.DIFY_MARKET_TAM_KEY || "",
  "competitor-landscape":  process.env.DIFY_MARKET_COMPETITORS_KEY || "",
  "differentiation":       process.env.DIFY_MARKET_DIFFERENTIATION_KEY || "",
  "demand-validation":     process.env.DIFY_MARKET_DEMAND_KEY || "",
  "pricing-strategy":      process.env.DIFY_MARKET_PRICING_KEY || "",
  "market-timing":         process.env.DIFY_MARKET_TIMING_KEY || "",
};

// Marketing Strategy Dify workflow keys (6 sections)
const DIFY_STRATEGY_KEYS: Record<string, string> = {
  "go-to-market":      process.env.DIFY_STRATEGY_GTM_KEY || "",
  "channel-selection":  process.env.DIFY_STRATEGY_CHANNELS_KEY || "",
  "content-strategy":   process.env.DIFY_STRATEGY_CONTENT_KEY || "",
  "social-media":       process.env.DIFY_STRATEGY_SOCIAL_KEY || "",
  "campaign-design":    process.env.DIFY_STRATEGY_CAMPAIGNS_KEY || "",
  "brand-positioning":  process.env.DIFY_STRATEGY_BRAND_KEY || "",
};

// Market/Strategy Report Compiler
const DIFY_REPORT_KEY = process.env.DIFY_MARKET_STRATEGY_REPORT_KEY || "";

// Automation Design Dify workflow keys (5 sections)
const DIFY_AUTO_KEYS: Record<string, string> = {
  "workflow-design":       process.env.DIFY_AUTO_WORKFLOW_KEY || "",
  "tool-selection":        process.env.DIFY_AUTO_TOOLS_KEY || "",
  "integration-mapping":   process.env.DIFY_AUTO_INTEGRATION_KEY || "",
  "trigger-action-arch":   process.env.DIFY_AUTO_TRIGGERS_KEY || "",
  "guardrail-design":      process.env.DIFY_AUTO_GUARDRAILS_KEY || "",
};

// Agent Pipeline Dify workflow keys (4 sections)
const DIFY_AGENT_KEYS: Record<string, string> = {
  "agent-discovery":       process.env.DIFY_AGENT_DISCOVERY_KEY || "",
  "prompt-audit":          process.env.DIFY_AGENT_PROMPT_AUDIT_KEY || "",
  "lightrag-assessment":   process.env.DIFY_AGENT_LIGHTRAG_KEY || "",
  "agent-scaffolding":     process.env.DIFY_AGENT_SCAFFOLDING_KEY || "",
};

// Product Launch Dify workflow keys (4 sections)
const DIFY_LAUNCH_KEYS: Record<string, string> = {
  "marketplace-setup":  process.env.DIFY_LAUNCH_MARKETPLACE_KEY || "",
  "landing-page":       process.env.DIFY_LAUNCH_LANDING_KEY || "",
  "pricing-config":     process.env.DIFY_LAUNCH_PRICING_KEY || "",
  "distribution":       process.env.DIFY_LAUNCH_DISTRIBUTION_KEY || "",
};

// -- Module Registry ----------------------------------------------------------

interface ModuleDef {
  id: string;
  displayName: string;
  category: "research" | "design" | "strategy" | "build" | "launch";
  dependsOn: string[];
  softDependsOn?: string[];
  sections: string[];
  difyKeys: Record<string, string>;
  hitlGate?: boolean;
  coercedBy?: string[];
  reInvocable?: boolean;
}

const MODULE_REGISTRY: Record<string, ModuleDef> = {
  "tech-research": {
    id: "tech-research", displayName: "Technical Research", category: "research",
    dependsOn: [],
    sections: ["libraries","security","ui-ux-research","architecture","dependencies",
               "file-structure","tools","containers","integration","costs",
               "open-source-scan","best-practices","prior-art"],
    difyKeys: DIFY_SECTION_KEYS,
  },
  "market-viability": {
    id: "market-viability", displayName: "Market Viability", category: "research",
    dependsOn: [],
    sections: ["tam-sam-som","competitor-landscape","differentiation",
               "demand-validation","pricing-strategy","market-timing"],
    difyKeys: DIFY_MARKET_KEYS,
  },
  "marketing-strategy": {
    id: "marketing-strategy", displayName: "Marketing Strategy", category: "strategy",
    dependsOn: [],
    softDependsOn: ["market-viability"],
    coercedBy: ["market-viability"],
    sections: ["go-to-market","channel-selection","content-strategy",
               "social-media","campaign-design","brand-positioning"],
    difyKeys: DIFY_STRATEGY_KEYS,
  },
  "automation-design": {
    id: "automation-design", displayName: "Automation Design", category: "design",
    dependsOn: [],
    sections: ["workflow-design","tool-selection","integration-mapping",
               "trigger-action-arch","guardrail-design"],
    difyKeys: DIFY_AUTO_KEYS,
  },
  "agent-pipeline": {
    id: "agent-pipeline", displayName: "Agent Pipeline", category: "design",
    dependsOn: [],
    softDependsOn: ["automation-design"],
    coercedBy: ["tech-research", "automation-design"],
    sections: ["agent-discovery","prompt-audit","lightrag-assessment","agent-scaffolding"],
    difyKeys: DIFY_AGENT_KEYS,
    reInvocable: true,
  },
  "architecture": {
    id: "architecture", displayName: "Architecture", category: "design",
    dependsOn: ["tech-research"],
    sections: ["architecture-design"],
    difyKeys: DIFY_DEVTEAM_KEYS,
  },
  "security-review": {
    id: "security-review", displayName: "Security Review", category: "design",
    dependsOn: ["architecture"],
    sections: ["security-assessment"],
    difyKeys: DIFY_DEVTEAM_KEYS,
  },
  "war-room": {
    id: "war-room", displayName: "War Room", category: "design",
    dependsOn: [],
    sections: ["war-room-debate"],
    difyKeys: {},
    hitlGate: true,
  },
  "sprint-planning": {
    id: "sprint-planning", displayName: "Sprint Planning", category: "build",
    dependsOn: ["architecture", "security-review"],
    sections: ["sow-generation", "sprint-decomposition"],
    difyKeys: DIFY_DEVTEAM_KEYS,
  },
  "sprint-build": {
    id: "sprint-build", displayName: "Sprint Build", category: "build",
    dependsOn: ["sprint-planning"],
    sections: [],
    difyKeys: {},
  },
  "product-launch": {
    id: "product-launch", displayName: "Product Launch", category: "launch",
    dependsOn: ["sprint-build"],
    sections: ["marketplace-setup","landing-page","pricing-config","distribution"],
    difyKeys: DIFY_LAUNCH_KEYS,
    hitlGate: true,
  },
};

// Map of module sections to preference search queries (extends existing SECTION_PREF_QUERIES)
const MODULE_PREF_QUERIES: Record<string, string> = {
  ...SECTION_PREF_QUERIES,
  "tam-sam-som":          "market size total addressable market opportunity",
  "competitor-landscape": "competitors competitive analysis market positioning",
  "differentiation":      "differentiation unique selling proposition competitive advantage",
  "demand-validation":    "demand validation customer research market need",
  "pricing-strategy":     "pricing model subscription freemium monetization",
  "market-timing":        "market timing launch strategy window opportunity",
  "go-to-market":         "go to market strategy launch plan",
  "channel-selection":    "marketing channels distribution customer acquisition",
  "content-strategy":     "content marketing strategy blog social media",
  "social-media":         "social media marketing platform engagement",
  "campaign-design":      "marketing campaign design advertising",
  "brand-positioning":    "brand positioning identity messaging",
  "workflow-design":      "workflow automation design process",
  "tool-selection":       "automation tools selection evaluation",
  "integration-mapping":  "integration mapping API connections",
  "trigger-action-arch":  "trigger action architecture event-driven",
  "guardrail-design":     "guardrails safety limits automation controls",
  "agent-discovery":      "AI agents discovery capabilities needed",
  "prompt-audit":         "prompt engineering library audit optimization",
  "lightrag-assessment":  "LightRAG knowledge base assessment",
  "agent-scaffolding":    "agent scaffolding creation deployment",
};

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


// -- Sandbox + Workspace Auto-Creation ----------------------------------------

const SANDBOX_REPO = process.env.OPENHANDS_SANDBOX_REPO || "homelab-projects/openhands-sandbox";
const GITLAB_PROJECTS_GROUP_ID = process.env.GITLAB_PROJECTS_GROUP_ID || "34";

async function ensureGitLabRepo(slug: string, name: string, description: string): Promise<void> {
  const encoded = encodeURIComponent(`homelab-projects/${slug}`);
  try {
    await gitlabFetch(`/api/v4/projects/${encoded}`);
    return; // Already exists
  } catch {
    // Create it
    await gitlabFetch(`/api/v4/projects`, {
      method: "POST",
      body: JSON.stringify({
        name: slug,
        namespace_id: parseInt(GITLAB_PROJECTS_GROUP_ID),
        description: `${name}: ${description}`,
        visibility: "private",
        initialize_with_readme: true,
        auto_devops_enabled: false,
      }),
    });
    log("info", "execution", "repo", `Created production repo homelab-projects/${slug}`);
  }
}

async function ensureWorkspace(project: any): Promise<void> {
  const ws = await pgQuery(`SELECT id FROM project_workspaces WHERE project_id = $1`, [project.id]);
  if (ws.rowCount > 0) return;

  // 1. Auto-create production repo if it doesn't exist
  await ensureGitLabRepo(project.slug, project.name, project.description || "");

  // 2. Create workspace pointing to sandbox repo (not the production repo)
  await createWorkspaceDirect(project.slug, project.name, SANDBOX_REPO);
  log("info", "execution", "workspace", `Auto-created workspace for ${project.slug} (sandbox: ${SANDBOX_REPO})`);
}

async function pushMicroagent(project: any): Promise<void> {
  const encoded = encodeURIComponent(SANDBOX_REPO);

  // Gather research context
  const research = await pgQuery(
    `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
    [project.id]
  );
  const arch = research.rows.find((r: any) => r.section === 'architecture-design')?.findings || "";
  const security = research.rows.find((r: any) => r.section === 'security-assessment')?.findings || "";
  const techStack = JSON.stringify(project.scope_of_work?.tech_stack || {}, null, 2);

  const archStr = typeof arch === "string" ? arch.slice(0, 5000) : JSON.stringify(arch).slice(0, 5000);
  const secStr = typeof security === "string" ? security.slice(0, 3000) : JSON.stringify(security).slice(0, 3000);

  const microagentContent = `# ${project.name} - Project Guidelines\n\n## Architecture\n${archStr}\n\n## Security Requirements\n${secStr}\n\n## Tech Stack\n${techStack}\n`;

  const filePath = encodeURIComponent(`.openhands/microagents/${project.slug}.md`);

  // Try to update existing file first, fall back to create
  try {
    await gitlabFetch(`/api/v4/projects/${encoded}/repository/files/${filePath}`, {
      method: "PUT",
      body: JSON.stringify({
        branch: "main",
        content: microagentContent,
        commit_message: `Update microagent for ${project.slug}`,
      }),
    });
  } catch {
    try {
      await gitlabFetch(`/api/v4/projects/${encoded}/repository/files/${filePath}`, {
        method: "POST",
        body: JSON.stringify({
          branch: "main",
          content: microagentContent,
          commit_message: `Add microagent for ${project.slug}`,
        }),
      });
    } catch (e: any) {
      log("warn", "execution", "microagent", `Failed to push microagent: ${e.message}`);
    }
  }
  log("info", "execution", "microagent", `Microagent pushed for ${project.slug}`);
}

function parseSowIntoSprints(sow: any): any[] {
  if (!sow) return [];
  // Handle various nested formats the Dify workflow might produce
  const sprints = sow.sprints || sow.sprint_plan || sow.sow?.sprints || sow.sow?.sprint_plan || [];
  if (!Array.isArray(sprints)) return [];
  return sprints;
}

// -- Sprint Execution Pipeline ------------------------------------------------

async function runSprintExecution(project: any, sprintNumber: number, feedback?: string): Promise<void> {
  log("info", "execution", "sprint", `Starting sprint ${sprintNumber} execution for ${project.slug}`);

  // Ensure workspace + repos exist
  await ensureWorkspace(project);

  // Push microagent with project context
  try { await pushMicroagent(project); } catch { /* non-blocking */ }

  // Get sprint row
  const sprintResult = await pgQuery(
    `SELECT * FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2`,
    [project.id, sprintNumber]
  );
  if (sprintResult.rowCount === 0) throw new Error(`Sprint ${sprintNumber} not found for ${project.slug}`);
  const sprintRow = sprintResult.rows[0];

  // Build task list from sprint
  const tasks = sprintRow.tasks || [];
  const taskList = Array.isArray(tasks)
    ? tasks.map((t: any, i: number) => `${i + 1}. ${typeof t === "string" ? t : t.task || t.name || JSON.stringify(t)}`).join("\n")
    : JSON.stringify(tasks);

  // Determine branch name (sandbox convention)
  const branchName = `${project.slug}/sprint-${sprintNumber}`;

  // Chain from previous sprint if it exists, otherwise from main
  let baseBranch = "main";
  if (sprintNumber > 1) {
    const prevSprint = (await pgQuery(
      `SELECT branch_name FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2 AND status = 'completed'`,
      [project.id, sprintNumber - 1]
    )).rows[0];
    if (prevSprint?.branch_name) baseBranch = prevSprint.branch_name;
  }

  // Create the branch in sandbox repo via GitLab API
  const encodedSandbox = encodeURIComponent(SANDBOX_REPO);
  try {
    await gitlabFetch(`/api/v4/projects/${encodedSandbox}/repository/branches`, {
      method: "POST",
      body: JSON.stringify({ branch: branchName, ref: baseBranch }),
    });
    log("info", "execution", "branch", `Created branch ${branchName} from ${baseBranch}`);
  } catch {
    log("info", "execution", "branch", `Branch ${branchName} may already exist, continuing`);
  }

  // Store branch name on sprint
  await pgQuery(`UPDATE pipeline_sprints SET branch_name = $1, status = 'active', started_at = NOW() WHERE id = $2`, [branchName, sprintRow.id]);

  // Build the coding prompt — try Dify detailed prompt first, fall back to basic
  let codingPrompt = `Sprint ${sprintNumber}: ${sprintRow.name}\nProject: ${project.name}\nBranch: ${branchName}\n\nTasks:\n${taskList}`;
  let detailedPrompt = codingPrompt;

  try {
    // Gather all context: architecture, security findings
    const research = await pgQuery(
      `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
      [project.id]
    );
    const archFindings = research.rows.find((r: any) => r.section === 'architecture-design')?.findings || "";
    const fileStructure = research.rows.find((r: any) => r.section === 'file-structure')?.findings || "";
    const securityFindings = research.rows.find((r: any) => r.section === 'security-assessment')?.findings || "";

    const archStr = typeof archFindings === "string" ? archFindings : JSON.stringify(archFindings);
    const fileStr = typeof fileStructure === "string" ? fileStructure : JSON.stringify(fileStructure);
    const secStr = typeof securityFindings === "string" ? securityFindings : JSON.stringify(securityFindings);

    const difyKey = DIFY_DEVTEAM_KEYS["pm-generate-task-prompts"];
    if (difyKey && difyKey.startsWith("app-")) {
      const result = await callDify(difyKey, {
        project_name: project.name,
        sprint_name: sprintRow.name,
        sprint_tasks: taskList,
        architecture: archStr.slice(0, 20000),
        file_structure: fileStr.slice(0, 10000),
        security_requirements: secStr.slice(0, 10000),
        tech_stack: JSON.stringify(project.scope_of_work?.tech_stack || {}),
      }, "pm-generate-task-prompts");

      if (result?.data?.status === "succeeded") {
        detailedPrompt = result.data.outputs?.result || detailedPrompt;
      }
    }
  } catch (err: any) {
    log("warn", "execution", "prompt", `Detailed prompt generation failed, using basic prompt: ${err.message}`);
  }

  // Prepend feedback if this is a retry
  if (feedback) {
    detailedPrompt = `IMPORTANT - Previous attempt was REJECTED. You MUST address this feedback:\n${feedback}\n\n---\n\n${detailedPrompt}`;
  }

  // Build rich conversation instructions
  const instructions = `You are a senior developer working on ${project.name}.

CRITICAL RULES:
- Work ONLY on branch: ${branchName}
- Commit frequently with clear messages
- Follow the architecture and patterns described in the task prompt exactly
- Run any tests you create before committing
- Push your branch when done: git push origin ${branchName}

PROJECT CONTEXT:
${project.description || ""}

TECH STACK:
${JSON.stringify(project.scope_of_work?.tech_stack || {}, null, 2)}`;

  // Create the OpenHands coding session
  try {
    const session = await createCodingSessionDirect(
      project.slug, sprintNumber, detailedPrompt,
      instructions, branchName
    );

    log("info", "execution", "session", `OpenHands session created for sprint ${sprintNumber}`, {
      conversation_id: session.conversation_id, branch: branchName,
    });

    await mmPipelineUpdate(project.name, `Sprint ${sprintNumber} coding started. Branch: \`${branchName}\`\nConversation: \`${session.conversation_id}\``, "computer");

    // Fire-and-forget monitoring
    monitorCodingSession(project, sprintRow, session.conversation_id, branchName).catch(async (err) => {
      log("error", "execution", "monitor", `Session monitor crashed: ${err.message}`);
      await ntfyError("execution", "monitor", `Monitor crashed for ${project.slug} sprint ${sprintNumber}: ${err.message}`, {});
    });
  } catch (err: any) {
    log("error", "execution", "session", `Failed to create coding session: ${err.message}`);
    await pgQuery(`UPDATE pipeline_sprints SET status = 'pending' WHERE id = $1`, [sprintRow.id]);
    throw err;
  }
}

async function monitorCodingSession(project: any, sprintRow: any, conversationId: string, branchName: string): Promise<void> {
  const MAX_POLLS = 120; // 120 * 30s = 60 minutes max
  const POLL_INTERVAL = 30000; // 30 seconds

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

    try {
      const status = await getConversationStatus(conversationId);
      const convStatus = status?.conversation?.status || status?.conversation?.state;

      if (convStatus === "FINISHED" || convStatus === "completed" || convStatus === "stopped") {
        log("info", "execution", "monitor", `Session ${conversationId} finished for sprint ${sprintRow.sprint_number}`);

        // Run code reviewer via Dify
        let reviewOutput = "";
        try {
          const reviewKey = DIFY_DEVTEAM_KEYS["code-reviewer"];
          if (reviewKey && reviewKey.startsWith("app-")) {
            const reviewResult = await callDify(reviewKey, {
              project_name: project.name,
              code_diff: `Branch: ${branchName} (see sandbox repo for full diff)`,
              sprint_tasks: JSON.stringify(sprintRow.tasks || []),
            }, "code-reviewer");
            if (reviewResult?.data?.status === "succeeded") {
              reviewOutput = reviewResult.data.outputs?.result || "";
            }
          }
        } catch (err: any) {
          log("warn", "execution", "review", `Code review failed: ${err.message}`);
          reviewOutput = "(Code review unavailable)";
        }

        // Run war room code review (architect perspective)
        let warRoomReview = "";
        try {
          const architectKey = DIFY_DEVTEAM_KEYS["architect-revise"];
          if (architectKey && architectKey.startsWith("app-")) {
            const research = await pgQuery(
              `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND section = 'architecture-design' AND status = 'complete'`,
              [project.id]
            );
            const archFindings = research.rows[0]?.findings || "";
            const archStr = typeof archFindings === "string" ? archFindings : JSON.stringify(archFindings);

            const archReview = await callDify(architectKey, {
              project_name: project.name,
              previous_design: archStr.slice(0, 8000),
              feedback: `Review this sprint's code changes for architecture compliance:\n${reviewOutput.slice(0, 4000)}`,
              security_findings: "",
            }, "architect-revise");
            if (archReview?.data?.status === "succeeded") {
              warRoomReview = archReview.data.outputs?.result || "";
            }
          }
        } catch {
          log("warn", "execution", "warroom-review", "War room code review failed (non-blocking)");
        }

        // Submit for human review
        const reviewContent = `## Sprint ${sprintRow.sprint_number}: ${sprintRow.name}\n\n` +
          `**Branch:** \`${branchName}\` (sandbox repo)\n` +
          `**Conversation:** \`${conversationId}\`\n\n` +
          `### Code Review\n${reviewOutput || "(No review output)"}\n\n` +
          (warRoomReview ? `### Architecture Review\n${warRoomReview}\n\n` : "") +
          `### Tasks\n${JSON.stringify(sprintRow.tasks || [], null, 2)}`;

        await tools.submit_for_review.handler({
          slug: project.slug,
          title: `Sprint ${sprintRow.sprint_number}: ${sprintRow.name}`,
          content: reviewContent,
          review_type: "sprint",
          sprint_number: sprintRow.sprint_number,
        });

        return;
      }

      if (convStatus === "ERROR" || convStatus === "error") {
        log("error", "execution", "monitor", `Session ${conversationId} errored`);
        await pgQuery(`UPDATE pipeline_sprints SET status = 'pending' WHERE id = $1`, [sprintRow.id]);
        await mmPipelineUpdate(project.name, `Sprint ${sprintRow.sprint_number} coding session errored: ${conversationId}`, "x");
        return;
      }

      // Still running — continue polling
      if (poll % 10 === 0 && poll > 0) {
        log("info", "execution", "monitor", `Session ${conversationId} still running (poll ${poll})`);
      }
    } catch (err: any) {
      log("warn", "execution", "monitor", `Poll error (will retry): ${err.message}`);
    }
  }

  // Timed out
  log("warn", "execution", "monitor", `Session ${conversationId} timed out after ${MAX_POLLS * POLL_INTERVAL / 60000} minutes`);
  await mmPipelineUpdate(project.name, `Sprint ${sprintRow.sprint_number} coding session timed out`, "warning");
}


// -- Module Engine -----------------------------------------------------------

/**
 * Resolve which modules are ready to start given current active modules and their statuses.
 * A module is "ready" if:
 * 1. It's in the active_modules list
 * 2. Its status is 'pending'
 * 3. All hard deps (dependsOn) that are ALSO in active_modules are 'complete'
 * 4. All soft deps (softDependsOn) that are ALSO in active_modules are 'complete'
 */
function getReadyModules(activeModules: string[], moduleStatuses: Record<string, string>): string[] {
  const ready: string[] = [];
  for (const modId of activeModules) {
    const def = MODULE_REGISTRY[modId];
    if (!def) continue;
    if (moduleStatuses[modId] !== "pending") continue;

    // Check hard deps — only those that are also active
    const hardDepsOk = def.dependsOn.every(dep =>
      !activeModules.includes(dep) || moduleStatuses[dep] === "complete"
    );
    if (!hardDepsOk) continue;

    // Check soft deps — only those that are also active
    const softDepsOk = (def.softDependsOn || []).every(dep =>
      !activeModules.includes(dep) || moduleStatuses[dep] === "complete"
    );
    if (!softDepsOk) continue;

    ready.push(modId);
  }
  return ready;
}

/**
 * Apply coercion rules to a set of active modules.
 * Returns the expanded set with coerced modules added.
 */
function applyCoercionRules(modules: string[]): string[] {
  const result = new Set(modules);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [modId, def] of Object.entries(MODULE_REGISTRY)) {
      if (result.has(modId)) continue;
      if (def.coercedBy && def.coercedBy.some(trigger => result.has(trigger))) {
        result.add(modId);
        changed = true;
      }
    }
  }
  return Array.from(result);
}

/**
 * Derive the legacy stage field from module progress.
 * Maps module states to the closest legacy stage for backward compat.
 */
function deriveStage(moduleProgress: Record<string, string>, activeModules: string[]): string {
  if (activeModules.length === 0) return "queue";

  const statuses = activeModules.map(m => moduleProgress[m] || "pending");
  const allComplete = statuses.every(s => s === "complete" || s === "skipped");
  if (allComplete) return "completed";

  // Check what's currently in_progress or complete to derive stage
  const inProgressOrComplete = activeModules.filter(m =>
    moduleProgress[m] === "in_progress" || moduleProgress[m] === "complete"
  );

  if (inProgressOrComplete.some(m => m === "sprint-build")) return "active";
  if (inProgressOrComplete.some(m => m === "sprint-planning")) return "planning";
  if (inProgressOrComplete.some(m => m === "security-review")) return "security_review";
  if (inProgressOrComplete.some(m => m === "architecture" || m === "war-room")) return "architecture";
  if (inProgressOrComplete.some(m => MODULE_REGISTRY[m]?.category === "research" || MODULE_REGISTRY[m]?.category === "strategy" || MODULE_REGISTRY[m]?.category === "design")) return "research";

  return "research";
}

/**
 * Generic module pipeline runner. Processes all sections of a module sequentially
 * via Dify workflows, storing results in pipeline_research.
 */
async function runModulePipeline(
  project: { id: number; slug: string; name: string; description: string | null },
  moduleId: string
): Promise<void> {
  const moduleDef = MODULE_REGISTRY[moduleId];
  if (!moduleDef) throw new Error(`Unknown module: ${moduleId}`);

  log("info", "module", moduleId, `Starting module pipeline for ${project.slug}`);

  // Mark module as in_progress
  await pgQuery(
    `UPDATE pipeline_module_runs SET status = 'in_progress', started_at = NOW(), updated_at = NOW()
     WHERE project_id = $1 AND module_id = $2`,
    [project.id, moduleId]
  );
  await pgQuery(
    `UPDATE pipeline_projects SET module_progress = module_progress || $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify({ [moduleId]: "in_progress" }), project.id]
  );

  await mmPipelineUpdate(project.name, `Module **${moduleDef.displayName}** started`, "gear");

  // Special handling: war-room uses existing startAndRunWarRoom, not section-by-section Dify
  if (moduleId === "war-room") {
    try {
      await startAndRunWarRoom(project.id);
      await advanceModule(project, moduleId);
    } catch (err: any) {
      await failModule(project, moduleId, err.message);
    }
    return;
  }

  // Special handling: sprint-build uses existing runSprintExecution
  if (moduleId === "sprint-build") {
    // Auto-start sprint 1 (or next pending sprint)
    try {
      const nextSprint = await pgQuery(
        `SELECT sprint_number FROM pipeline_sprints WHERE project_id = $1 AND status = 'pending' ORDER BY sprint_number ASC LIMIT 1`,
        [project.id]
      );
      if (nextSprint.rowCount > 0) {
        const projFull = (await pgQuery(`SELECT * FROM pipeline_projects WHERE id = $1`, [project.id])).rows[0];
        await runSprintExecution(projFull, nextSprint.rows[0].sprint_number);
      }
      // Don't call advanceModule here — sprint monitor handles completion
    } catch (err: any) {
      await failModule(project, moduleId, err.message);
    }
    return;
  }

  // Special handling: sprint-planning uses existing SoW + sprint decomposition flow
  if (moduleId === "sprint-planning") {
    try {
      // Gather context
      const research = await pgQuery(
        `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
        [project.id]
      );
      const archFindings = research.rows.find((r: any) => r.section === "architecture-design")?.findings || "";
      const secFindings = research.rows.find((r: any) => r.section === "security-assessment")?.findings || "";
      const allFindings = research.rows.map((r: any) => `## ${r.section}\n${typeof r.findings === "string" ? r.findings : JSON.stringify(r.findings)}`).join("\n\n");

      // Generate SoW via Dify
      const sowKey = DIFY_DEVTEAM_KEYS["pm-generate-sow"];
      if (sowKey && sowKey.startsWith("app-")) {
        const sowResult = await callDify(sowKey, {
          project_name: project.name,
          project_description: project.description || "",
          research_findings: allFindings.slice(0, 30000),
          architecture: (typeof archFindings === "string" ? archFindings : JSON.stringify(archFindings)).slice(0, 15000),
          security_findings: (typeof secFindings === "string" ? secFindings : JSON.stringify(secFindings)).slice(0, 10000),
        }, "pm-generate-sow");

        if (sowResult?.data?.status === "succeeded") {
          const sowOutput = sowResult.data.outputs?.result || sowResult.data.outputs;
          let sowData: any;
          try { sowData = typeof sowOutput === "string" ? JSON.parse(sowOutput) : sowOutput; } catch { sowData = { raw: sowOutput }; }
          await pgQuery(`UPDATE pipeline_projects SET scope_of_work = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(sowData), project.id]);

          // Parse sprints from SoW
          const sprints = parseSowIntoSprints(sowData);
          for (let i = 0; i < sprints.length; i++) {
            const s = sprints[i];
            const sprintNumber = s.sprint_number || s.number || i + 1;
            const name = s.name || s.title || `Sprint ${sprintNumber}`;
            const tasks = s.tasks || s.deliverables || s.items || [];
            await pgQuery(
              `INSERT INTO pipeline_sprints (project_id, sprint_number, name, description, tasks, estimated_hours, estimated_loc, complexity)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (project_id, sprint_number) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, tasks = EXCLUDED.tasks`,
              [project.id, sprintNumber, name, s.description || null, tasks.length > 0 ? JSON.stringify(tasks) : null, s.estimated_hours || null, s.estimated_loc || null, s.complexity || null]
            );
          }

          // Store SoW section
          await pgQuery(
            `INSERT INTO pipeline_research (project_id, section, findings, status)
             VALUES ($1, 'sow-generation', $2, 'complete')
             ON CONFLICT (project_id, section) DO UPDATE SET findings = $2, status = 'complete', updated_at = NOW()`,
            [project.id, JSON.stringify(sowData)]
          );

          await mmDeliverable(project.name, "Scope of Work", typeof sowOutput === "string" ? sowOutput : JSON.stringify(sowOutput, null, 2), "sow");
        }
      }
      await advanceModule(project, moduleId);
    } catch (err: any) {
      await failModule(project, moduleId, err.message);
    }
    return;
  }

  // Standard section-by-section Dify pipeline
  const serverContext = "Unraid Tower server with Docker, Traefik reverse proxy, PostgreSQL, Neo4j, n8n, Dify";
  let completedCount = 0;
  const totalSections = moduleDef.sections.length;
  const accumulatedFindings: Record<string, any> = {};

  // Load user preferences
  let projectPreferences: any[] = [];
  try {
    projectPreferences = await searchPreferences(
      `${project.name} ${project.description || ""} ${moduleDef.displayName}`,
      15
    );
  } catch { /* use empty */ }

  // Load findings from other completed modules for cross-module context
  const existingResearch = await pgQuery(
    `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
    [project.id]
  );
  for (const row of existingResearch.rows) {
    if (row.findings) {
      accumulatedFindings[row.section] = { findings: row.findings };
    }
  }

  for (const section of moduleDef.sections) {
    try {
      const apiKey = moduleDef.difyKeys[section];
      if (!apiKey || !apiKey.startsWith("app-")) {
        log("warn", "module", section, `No Dify API key for ${moduleId}/${section} — skipping`);
        await pgQuery(
          `UPDATE pipeline_research SET status = 'skipped', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
          [project.id, section]
        );
        completedCount++;
        continue;
      }

      // Mark section in_progress
      await pgQuery(
        `UPDATE pipeline_research SET status = 'in_progress', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
        [project.id, section]
      );

      // Get section-specific preferences
      let sectionPreferences = projectPreferences;
      const prefQuery = MODULE_PREF_QUERIES[section];
      if (prefQuery) {
        try {
          const sectionSpecific = await searchPreferences(prefQuery, 10);
          const seen = new Set(sectionPreferences.map((p: any) => p.id));
          for (const sp of sectionSpecific) {
            if (!seen.has(sp.id)) {
              sectionPreferences = [...sectionPreferences, sp];
              seen.add(sp.id);
            }
          }
        } catch { /* use base */ }
      }

      const inputs: Record<string, string> = {
        project_name: project.name,
        project_description: project.description || "",
        section,
        server_context: serverContext,
        existing_findings: Object.keys(accumulatedFindings).length > 0
          ? JSON.stringify(accumulatedFindings) : "",
        user_preferences: sectionPreferences.length > 0
          ? JSON.stringify(sectionPreferences.map((p: any) => ({
              domain: p.domain, topic: p.topic, context: p.context,
              preference: p.preference, anti_pattern: p.anti_pattern,
              examples: p.examples, confidence: p.confidence,
            }))) : "",
      };

      const difyResponse = await callDify(apiKey, inputs, `${moduleId}-${section}`);

      const data = difyResponse?.data;
      if (!data || data.status !== "succeeded") {
        const errMsg = data?.error || "Dify workflow did not succeed";
        log("error", "module", section, `Dify failed for ${project.slug}/${moduleId}: ${errMsg}`);
        await pgQuery(
          `UPDATE pipeline_research SET status = 'pending', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
          [project.id, section]
        );
        continue;
      }

      // Parse result
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
          findings = { raw: resultRaw };
        }
      }

      if (findings) {
        accumulatedFindings[section] = { findings, concerns, recommendations, confidence_score: confidenceScore };
      }

      await pgQuery(
        `UPDATE pipeline_research
         SET findings = $1, concerns = $2, recommendations = $3, confidence_score = $4, status = 'complete', updated_at = NOW()
         WHERE project_id = $5 AND section = $6`,
        [findings ? JSON.stringify(findings) : null, concerns, recommendations, confidenceScore, project.id, section]
      );

      for (const q of questions) {
        try {
          await pgQuery(
            `INSERT INTO pipeline_questions (project_id, question, context, priority) VALUES ($1, $2, $3, $4)`,
            [project.id, q.question, q.context || null, q.priority || "normal"]
          );
        } catch { /* ignore dup */ }
      }

      completedCount++;
      const elapsed = data.elapsed_time ? `${data.elapsed_time.toFixed(1)}s` : "?";
      const tokens = data.total_tokens || "?";

      await ntfyNotify(
        `${project.name} / ${moduleDef.displayName} / ${section} (${elapsed}, ${tokens} tokens). ${completedCount}/${totalSections}`,
        "Module Section Done", 3, ["microscope"]
      );

    } catch (err: any) {
      log("error", "module", section, `Error in ${project.slug}/${moduleId}/${section}: ${err.message}`);
      try {
        await pgQuery(
          `UPDATE pipeline_research SET status = 'pending', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
          [project.id, section]
        );
      } catch { /* ignore */ }
    }
  }

  // Module complete
  const failedCount = totalSections - completedCount;
  if (failedCount > 0) {
    log("warn", "module", moduleId, `Module ${moduleId} for ${project.slug}: ${completedCount}/${totalSections} sections succeeded`);
  }

  await pgQuery(
    `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
    [project.id, "module_complete", JSON.stringify({ module: moduleId, completed: completedCount, failed: failedCount, total: totalSections })]
  );

  // Check if this module should produce a deliverable report
  if (moduleId === "market-viability" || moduleId === "marketing-strategy") {
    await tryCompileMarketStrategyReport(project, moduleId);
  }

  await advanceModule(project, moduleId);
}

/**
 * Compile market/strategy report when appropriate modules complete.
 * - Both market-viability + marketing-strategy complete → combined report
 * - Only marketing-strategy complete (standalone) → strategy-only report
 */
async function tryCompileMarketStrategyReport(
  project: { id: number; slug: string; name: string; description: string | null },
  justCompleted: string
): Promise<void> {
  const projRow = (await pgQuery(`SELECT active_modules, module_progress FROM pipeline_projects WHERE id = $1`, [project.id])).rows[0];
  const activeModules: string[] = projRow?.active_modules || [];
  const progress: Record<string, string> = projRow?.module_progress || {};

  const marketActive = activeModules.includes("market-viability");
  const strategyActive = activeModules.includes("marketing-strategy");
  const marketDone = progress["market-viability"] === "complete";
  const strategyDone = progress["marketing-strategy"] === "complete";

  // Only compile when all active market/strategy modules are done
  if (marketActive && !marketDone) return;
  if (strategyActive && !strategyDone) return;
  if (!marketActive && !strategyActive) return;

  const mode = marketActive ? "combined" : "strategy-only";

  // Gather all findings from market + strategy sections
  const sections = [
    ...(marketActive ? MODULE_REGISTRY["market-viability"].sections : []),
    ...(strategyActive ? MODULE_REGISTRY["marketing-strategy"].sections : []),
  ];

  const research = await pgQuery(
    `SELECT section, findings, concerns, recommendations FROM pipeline_research
     WHERE project_id = $1 AND section = ANY($2) AND status = 'complete'`,
    [project.id, sections]
  );

  const findingsText = research.rows.map((r: any) =>
    `## ${r.section}\n${typeof r.findings === "string" ? r.findings : JSON.stringify(r.findings)}`
  ).join("\n\n");

  // Try to compile via Dify if key is configured
  if (DIFY_REPORT_KEY && DIFY_REPORT_KEY.startsWith("app-")) {
    try {
      const result = await callDify(DIFY_REPORT_KEY, {
        project_name: project.name,
        project_description: project.description || "",
        mode,
        findings: findingsText.slice(0, 30000),
      }, "market-strategy-report");

      if (result?.data?.status === "succeeded") {
        const report = result.data.outputs?.result || findingsText;
        const title = mode === "combined" ? "Market & Strategy Report" : "Marketing Strategy Report";
        await mmDeliverable(project.name, title, typeof report === "string" ? report : JSON.stringify(report, null, 2), "research");
        return;
      }
    } catch (err: any) {
      log("warn", "module", "report", `Report compilation failed, posting raw: ${err.message}`);
    }
  }

  // Fallback: post raw findings as deliverable
  const title = mode === "combined" ? "Market & Strategy Report" : "Marketing Strategy Report";
  await mmDeliverable(project.name, title, findingsText, "research");
}

/**
 * Called when a module completes. Updates status, finds newly-unblocked modules, and starts them.
 */
async function advanceModule(
  project: { id: number; slug: string; name: string; description: string | null },
  moduleId: string
): Promise<void> {
  log("info", "module", "advance", `Module ${moduleId} complete for ${project.slug}`);

  // Mark module complete
  await pgQuery(
    `UPDATE pipeline_module_runs SET status = 'complete', completed_at = NOW(), updated_at = NOW()
     WHERE project_id = $1 AND module_id = $2`,
    [project.id, moduleId]
  );
  await pgQuery(
    `UPDATE pipeline_projects SET module_progress = module_progress || $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify({ [moduleId]: "complete" }), project.id]
  );

  await mmPipelineUpdate(project.name, `Module **${MODULE_REGISTRY[moduleId]?.displayName || moduleId}** complete`, "white_check_mark");

  // Load current state
  const projRow = (await pgQuery(`SELECT active_modules, module_progress FROM pipeline_projects WHERE id = $1`, [project.id])).rows[0];
  const activeModules: string[] = projRow.active_modules || [];
  const moduleProgress: Record<string, string> = { ...(projRow.module_progress || {}), [moduleId]: "complete" };

  // Derive and update stage
  const newStage = deriveStage(moduleProgress, activeModules);
  await pgQuery(`UPDATE pipeline_projects SET stage = $1, updated_at = NOW() WHERE id = $2`, [newStage, project.id]);

  // Find newly ready modules
  const readyModules = getReadyModules(activeModules, moduleProgress);

  for (const readyMod of readyModules) {
    const def = MODULE_REGISTRY[readyMod];

    // Check HitL gate
    if (def?.hitlGate) {
      await mmPostWithId("human-review",
        `### :gate: HitL Gate: ${def.displayName}\n**Project:** ${project.name} (\`${project.slug}\`)\n\nModule **${def.displayName}** is ready to start but requires human approval.\n\n:white_check_mark: Use \`classify_project\` → \`start_module\` to proceed.`
      );
      log("info", "module", "hitl", `Module ${readyMod} gated for HitL — awaiting approval`);
      continue;
    }

    // Auto-start ready module
    log("info", "module", "auto-start", `Auto-starting module ${readyMod} for ${project.slug}`);
    startModuleAsync(project, readyMod);
  }
}

/**
 * Mark a module as failed.
 */
async function failModule(
  project: { id: number; slug: string; name: string; description: string | null },
  moduleId: string,
  error: string
): Promise<void> {
  log("error", "module", moduleId, `Module ${moduleId} failed for ${project.slug}: ${error}`);
  await pgQuery(
    `UPDATE pipeline_module_runs SET status = 'failed', error = $1, updated_at = NOW()
     WHERE project_id = $2 AND module_id = $3`,
    [error, project.id, moduleId]
  );
  await pgQuery(
    `UPDATE pipeline_projects SET module_progress = module_progress || $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify({ [moduleId]: "failed" }), project.id]
  );
  await ntfyError("module", moduleId, `Module ${moduleId} failed for ${project.slug}: ${error}`, { slug: project.slug });
}

/**
 * Fire-and-forget module start with error handling.
 */
function startModuleAsync(
  project: { id: number; slug: string; name: string; description: string | null },
  moduleId: string
): void {
  runModulePipeline(project, moduleId).catch(async (err) => {
    await failModule(project, moduleId, err.message);
  });
}


// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  // -- Project CRUD -----------------------------------------------------------

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
      await mmPipelineUpdate(p.name, "New project created", "rocket");

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
    description: "Move project to next stage with validation gates. For legacy (non-Overwatch) projects: queue->research->architecture->security_review->planning->active->completed. For Overwatch projects, use get_module_status instead.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      // Overwatch projects use module engine — advance_stage delegates to deriveStage
      if (project.overwatch_approved) {
        const activeModules: string[] = project.active_modules || [];
        const moduleProgress: Record<string, string> = project.module_progress || {};
        const derivedStage = deriveStage(moduleProgress, activeModules);
        if (derivedStage !== project.stage) {
          await pgQuery(
            `UPDATE pipeline_projects SET stage = $1, updated_at = NOW() WHERE id = $2`,
            [derivedStage, project.id]
          );
          await mmPipelineUpdate(project.name, `Stage derived: ${project.stage} → ${derivedStage}`, "arrow_right");
          return { ...project, stage: derivedStage, message: "Stage derived from module progress (Overwatch mode)" };
        }
        return { ...project, message: `Stage is already '${project.stage}'. Module progress drives stage in Overwatch mode. Use get_module_status for details.` };
      }

      const currentIdx = STAGE_ORDER.indexOf(project.stage);
      if (currentIdx === -1 || currentIdx >= STAGE_ORDER.length - 1) {
        throw new Error(`Cannot advance from stage '${project.stage}'`);
      }
      const nextStage = STAGE_ORDER[currentIdx + 1];

      // Validation gates
      if (nextStage === "architecture") {
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
        const archDesign = await pgQuery(
          `SELECT id FROM pipeline_research WHERE project_id = $1 AND section = 'architecture-design' AND status = 'complete'`,
          [project.id]
        );
        if (archDesign.rowCount === 0) {
          throw new Error("Cannot advance to security_review: architecture design not stored");
        }
      }

      if (nextStage === "planning") {
        const secReview = await pgQuery(
          `SELECT id FROM pipeline_research WHERE project_id = $1 AND section = 'security-assessment' AND status = 'complete'`,
          [project.id]
        );
        if (secReview.rowCount === 0) {
          throw new Error("Cannot advance to planning: security review not complete");
        }
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
          await ntfyError("stage", "orchestrator", `Dev-team orchestrator FAILED to trigger for ${p.slug} \u2192 ${nextStage}`, {
            slug: p.slug, stage: nextStage,
          });
        } else {
          log("info", "stage", "advance", `Dev-team orchestrator triggered OK for ${nextStage}`, { slug: p.slug, result: orchResult });
        }
      }

      await ntfyNotify(`${project.name}: ${project.stage} \u2192 ${nextStage}`, "Stage Change", 3, ["arrow_right"]);
      await mmPipelineUpdate(project.name, `Stage: ${project.stage} \u2192 ${nextStage}`, "arrow_right");

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

  // -- Research ---------------------------------------------------------------

  start_research: {
    description: "Set project stage to 'research' and run the Dify research pipeline. Creates placeholder research sections and processes them sequentially via Dify.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      for (const section of RESEARCH_SECTIONS) {
        await pgQuery(
          `INSERT INTO pipeline_research (project_id, section) VALUES ($1, $2) ON CONFLICT (project_id, section) DO NOTHING`,
          [project.id, section]
        );
      }

      await pgQuery(
        `UPDATE pipeline_projects SET stage = 'research', research_started_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [project.id]
      );

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "research_started", JSON.stringify({ sections: RESEARCH_SECTIONS })]
      );

      runResearchPipeline({
        id: project.id, slug: project.slug, name: project.name, description: project.description,
      }).catch(async (err) => {
        await ntfyError("research", "pipeline", `Pipeline CRASHED for ${project.slug}: ${err.message}`, {
          slug: project.slug, error: err.message, stack: err.stack?.slice(0, 500),
        });
      });

      await ntfyNotify(`Research started for: ${project.name}`, "Research Started", 3, ["mag"]);
      await mmPipelineUpdate(project.name, "Research pipeline started", "mag");

      return { ok: true, slug: project.slug, sections: RESEARCH_SECTIONS, message: "Dify research pipeline launched (runs in background)" };
    },
  },

  get_research: {
    description: "Get all research sections for a project.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`SELECT * FROM pipeline_research WHERE project_id = $1 ORDER BY section`, [proj.rows[0].id]);
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
      const fields: string[] = []; const params: any[] = []; let idx = 1;
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
    params: { slug: "Project slug", scope_of_work: "Compiled SOW as JSON object" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];
      await pgQuery(`UPDATE pipeline_research SET status = 'complete', updated_at = NOW() WHERE project_id = $1 AND status != 'complete'`, [project.id]);
      await pgQuery(`UPDATE pipeline_projects SET scope_of_work = $1, research_completed_at = NOW(), updated_at = NOW() WHERE id = $2`, [JSON.stringify(p.scope_of_work), project.id]);
      await pgQuery(`INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`, [project.id, "research_completed", JSON.stringify({ sections_count: RESEARCH_SECTIONS.length })]);
      await ntfyNotify(`Research complete for: ${project.name}. SOW ready.`, "Research Complete", 4, ["white_check_mark"]);
      await mmPipelineUpdate(project.name, "Research pipeline complete. SOW ready.", "white_check_mark");
      return { ok: true, slug: p.slug, message: "Research completed and SOW stored" };
    },
  },

  // -- Questions (Async Q&A) --------------------------------------------------

  add_question: {
    description: "Post a question about a project. Sends Mattermost notification for async Q&A.",
    params: { slug: "Project slug", question: "The question text", context: "(optional) Context for why this question matters", priority: "(optional) blocking|normal|nice-to-have, default normal" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`INSERT INTO pipeline_questions (project_id, question, context, priority) VALUES ($1, $2, $3, $4) RETURNING *`, [proj.rows[0].id, p.question, p.context || null, p.priority || "normal"]);
      const priorityTag = p.priority === "blocking" ? "exclamation" : "question";
      const priorityLevel = p.priority === "blocking" ? 4 : 3;
      await ntfyNotify(`[${proj.rows[0].name}] ${p.question}`, `${(p.priority || "normal").toUpperCase()} Question`, priorityLevel, [priorityTag]);
      return result.rows[0];
    },
  },

  answer_question: {
    description: "Answer a question by ID. Checks if this unblocks research and triggers resume if so.",
    params: { id: "Question ID", answer: "The answer text" },
    handler: async (p) => {
      const result = await pgQuery(`UPDATE pipeline_questions SET answer = $1, answered_at = NOW() WHERE id = $2 RETURNING *`, [p.answer, p.id]);
      if (result.rowCount === 0) throw new Error(`Question ${p.id} not found`);
      const question = result.rows[0];
      if (question.priority === "blocking") {
        const remaining = await pgQuery(`SELECT COUNT(*) as count FROM pipeline_questions WHERE project_id = $1 AND priority = 'blocking' AND answer IS NULL`, [question.project_id]);
        if (parseInt(remaining.rows[0].count) === 0) {
          const needsInput = await pgQuery(`SELECT section FROM pipeline_research WHERE project_id = $1 AND status = 'needs_input'`, [question.project_id]);
          if (needsInput.rowCount > 0) {
            const proj = await pgQuery(`SELECT slug FROM pipeline_projects WHERE id = $1`, [question.project_id]);
            triggerN8n("project-research-resume", { slug: proj.rows[0].slug, sections: needsInput.rows.map((r: any) => r.section) });
            return { ...question, research_resumed: true, sections: needsInput.rows.map((r: any) => r.section) };
          }
        }
      }
      return question;
    },
  },

  get_unanswered: {
    description: "Get all unanswered questions, optionally filtered by project. Sorted: blocking first.",
    params: { slug: "(optional) Filter by project slug" },
    handler: async (p) => {
      let sql = `SELECT pq.*, pp.slug, pp.name as project_name FROM pipeline_questions pq JOIN pipeline_projects pp ON pp.id = pq.project_id WHERE pq.answer IS NULL`;
      const params: any[] = [];
      if (p.slug) { sql += ` AND pp.slug = $1`; params.push(p.slug); }
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
      const result = await pgQuery(`SELECT * FROM pipeline_questions WHERE project_id = $1 ORDER BY asked_at ASC`, [proj.rows[0].id]);
      return { slug: p.slug, questions: result.rows, count: result.rowCount };
    },
  },

  // -- Sprints ----------------------------------------------------------------

  add_sprint: {
    description: "Add a sprint plan to a project.",
    params: { slug: "Project slug", sprint_number: "Sprint number (sequential)", name: "Sprint name", description: "(optional) Sprint description", tasks: "(optional) Array of {task, estimated_hours, status} objects", estimated_hours: "(optional) Total estimated hours", estimated_loc: "(optional) Estimated lines of code", complexity: "(optional) low|medium|high|extreme" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`INSERT INTO pipeline_sprints (project_id, sprint_number, name, description, tasks, estimated_hours, estimated_loc, complexity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [proj.rows[0].id, p.sprint_number, p.name, p.description || null, p.tasks ? JSON.stringify(p.tasks) : null, p.estimated_hours || null, p.estimated_loc || null, p.complexity || null]);
      return result.rows[0];
    },
  },

  update_sprint: {
    description: "Update sprint fields: status, actual hours, actual LOC, tasks.",
    params: { slug: "Project slug", sprint_number: "Sprint number", status: "(optional) pending|active|completed", actual_hours: "(optional) Actual hours worked", actual_loc: "(optional) Actual lines of code", tasks: "(optional) Updated tasks array" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const fields: string[] = []; const params: any[] = []; let idx = 1;
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
    params: { slug: "Project slug", sprint_number: "Sprint number" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`UPDATE pipeline_sprints SET status = 'active', started_at = NOW() WHERE project_id = $1 AND sprint_number = $2 RETURNING *`, [proj.rows[0].id, p.sprint_number]);
      if (result.rowCount === 0) throw new Error(`Sprint ${p.sprint_number} not found`);
      await pgQuery(`INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`, [proj.rows[0].id, "sprint_started", JSON.stringify({ sprint_number: p.sprint_number, name: result.rows[0].name })]);
      await ntfyNotify(`Sprint ${p.sprint_number} started: ${result.rows[0].name}`, `${proj.rows[0].name}`, 3, ["runner"]);
      return result.rows[0];
    },
  },

  complete_sprint: {
    description: "Complete a sprint. Records timestamp and updates project actual_hours.",
    params: { slug: "Project slug", sprint_number: "Sprint number", actual_hours: "(optional) Final actual hours for this sprint", actual_loc: "(optional) Final actual LOC" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const updates = ["status = 'completed'", "completed_at = NOW()"]; const params: any[] = []; let idx = 1;
      if (p.actual_hours !== undefined) { updates.push(`actual_hours = $${idx++}`); params.push(p.actual_hours); }
      if (p.actual_loc !== undefined) { updates.push(`actual_loc = $${idx++}`); params.push(p.actual_loc); }
      params.push(proj.rows[0].id, p.sprint_number);
      const sql = `UPDATE pipeline_sprints SET ${updates.join(", ")} WHERE project_id = $${idx++} AND sprint_number = $${idx} RETURNING *`;
      const result = await pgQuery(sql, params);
      if (result.rowCount === 0) throw new Error(`Sprint ${p.sprint_number} not found`);
      await pgQuery(`UPDATE pipeline_projects SET actual_hours = (SELECT COALESCE(SUM(actual_hours), 0) FROM pipeline_sprints WHERE project_id = $1), updated_at = NOW() WHERE id = $1`, [proj.rows[0].id]);
      await pgQuery(`INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`, [proj.rows[0].id, "sprint_completed", JSON.stringify({ sprint_number: p.sprint_number, actual_hours: result.rows[0].actual_hours })]);
      await ntfyNotify(`Sprint ${p.sprint_number} complete!`, `${proj.rows[0].name}`, 3, ["checkered_flag"]);
      return result.rows[0];
    },
  },

  // -- Agent Tasks ------------------------------------------------------------

  create_agent_task: {
    description: "Create an agent task for a project sprint. Used by the dev-team orchestrator to queue work items.",
    params: { slug: "Project slug", sprint_number: "(optional) Sprint number", task_type: "Task type: architect|security|code|review|test|ui", agent_model: "(optional) Model to use (e.g. deepseek/deepseek-r1, anthropic/claude-sonnet-4-5)", prompt: "Task prompt for the agent", tools_enabled: "(optional) Array of gateway tool names this agent can use", guardrails: "(optional) Object: {max_actions, max_tokens, timeout_minutes}" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      let sprintId = null;
      if (p.sprint_number) { const sprint = await pgQuery(`SELECT id FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2`, [proj.rows[0].id, p.sprint_number]); if (sprint.rowCount > 0) sprintId = sprint.rows[0].id; }
      const result = await pgQuery(`INSERT INTO agent_tasks (project_id, sprint_id, task_type, agent_model, prompt, tools_enabled, guardrails) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [proj.rows[0].id, sprintId, p.task_type, p.agent_model || null, p.prompt, p.tools_enabled || null, p.guardrails ? JSON.stringify(p.guardrails) : null]);
      return result.rows[0];
    },
  },

  list_agent_tasks: {
    description: "List agent tasks for a project, optionally filtered by status or type.",
    params: { slug: "Project slug", status: "(optional) Filter: queued|assigned|in_progress|completed|failed|escalated", task_type: "(optional) Filter by type: architect|security|code|review|test|ui", sprint_number: "(optional) Filter by sprint" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      let sql = `SELECT at.*, ps.sprint_number, ps.name as sprint_name FROM agent_tasks at LEFT JOIN pipeline_sprints ps ON ps.id = at.sprint_id WHERE at.project_id = $1`;
      const params: any[] = [proj.rows[0].id]; let idx = 2;
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
    params: { id: "Agent task ID", status: "(optional) New status: queued|assigned|in_progress|completed|failed|escalated", result: "(optional) Result as JSON object", iteration: "(optional) New iteration count" },
    handler: async (p) => {
      const fields: string[] = []; const params: any[] = []; let idx = 1;
      if (p.status !== undefined) { fields.push(`status = $${idx++}`); params.push(p.status); if (p.status === "in_progress") fields.push("started_at = NOW()"); if (p.status === "completed" || p.status === "failed") fields.push("completed_at = NOW()"); }
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
    params: { workflow: "Workflow name from DIFY_DEVTEAM_KEYS", inputs: "Input variables as object (project_name, research_findings, architecture_design, etc.)", async: "(optional) Set to true to run in background and return job_id immediately" },
    handler: async (p) => {
      const apiKey = DIFY_DEVTEAM_KEYS[p.workflow];
      if (!apiKey) throw new Error(`Unknown dev-team workflow: ${p.workflow}. Available: ${Object.keys(DIFY_DEVTEAM_KEYS).join(", ")}`);
      if (!apiKey.startsWith("app-")) throw new Error(`Dify API key not configured for workflow: ${p.workflow}`);

      if (p.async) {
        const jobId = `job-${++jobCounter}-${Date.now()}`;
        const job: AsyncJob = { id: jobId, workflow: p.workflow, status: "running", started_at: new Date().toISOString() };
        asyncJobs.set(jobId, job);
        log("info", "devteam", p.workflow, `Async job started: ${jobId}`, { inputs_keys: Object.keys(p.inputs || {}) });

        callDify(apiKey, p.inputs || {}, p.workflow).then(async (difyResponse) => {
          const data = difyResponse?.data;
          if (!data || data.status !== "succeeded") {
            job.status = "failed"; job.error = data?.error || "unknown error"; job.completed_at = new Date().toISOString();
            await ntfyError("devteam", p.workflow, `Async job ${jobId} failed: ${job.error}`, { workflow: p.workflow });
          } else {
            job.status = "succeeded"; job.result = data.outputs?.result || data.outputs; job.elapsed_time = data.elapsed_time; job.total_tokens = data.total_tokens; job.completed_at = new Date().toISOString();
            log("info", "devteam", p.workflow, `Async job ${jobId} succeeded`, { tokens: data.total_tokens, elapsed: data.elapsed_time });
            const resultText = typeof job.result === "string" ? job.result : JSON.stringify(job.result, null, 2);
            const contentType = ["focused-research", "pm-generate-sow"].includes(p.workflow) ? (p.workflow === "pm-generate-sow" ? "sow" : "research") : "other";
            await mmDeliverable(p.inputs?.project_name || p.workflow, `${p.workflow} (job ${jobId})`, resultText, contentType);
            await mmPipelineUpdate(p.inputs?.project_name || p.workflow, `${p.workflow} completed (${data.elapsed_time?.toFixed(1)}s, ${data.total_tokens} tokens)`, "white_check_mark");
          }
        }).catch(async (e: any) => {
          job.status = "failed"; job.error = e.message; job.completed_at = new Date().toISOString();
          await ntfyError("devteam", p.workflow, `Async job ${jobId} error: ${e.message}`, { workflow: p.workflow });
        });

        return { job_id: jobId, workflow: p.workflow, status: "running", message: "Workflow started in background. Poll with get_devteam_result." };
      }

      const difyResponse = await callDify(apiKey, p.inputs || {}, p.workflow);
      const data = difyResponse?.data;
      if (!data || data.status !== "succeeded") {
        const errMsg = `Dify workflow ${p.workflow} failed: ${data?.error || "unknown error"}`;
        await ntfyError("devteam", p.workflow, errMsg, { workflow: p.workflow, status: data?.status, error: data?.error });
        throw new Error(errMsg);
      }
      log("info", "devteam", p.workflow, `Workflow succeeded`, { tokens: data.total_tokens, elapsed: data.elapsed_time });
      const outputResult = data.outputs?.result || data.outputs;
      if (["focused-research", "pm-generate-sow"].includes(p.workflow)) {
        const resultText = typeof outputResult === "string" ? outputResult : JSON.stringify(outputResult, null, 2);
        const cType = p.workflow === "pm-generate-sow" ? "sow" : "research";
        await mmDeliverable(p.inputs?.project_name || p.workflow, p.workflow, resultText, cType);
      }
      await mmPipelineUpdate(p.inputs?.project_name || p.workflow, `${p.workflow} completed (${data.elapsed_time?.toFixed(1)}s, ${data.total_tokens} tokens)`, "white_check_mark");
      return { workflow: p.workflow, result: data.outputs?.result || data.outputs, elapsed_time: data.elapsed_time, total_tokens: data.total_tokens };
    },
  },

  get_devteam_result: {
    description: "Check status/result of an async dev-team workflow job. Returns status (running|succeeded|failed) and result when done.",
    params: { job_id: "(optional) Specific job ID to check. Omit to list all recent jobs." },
    handler: async (p) => {
      if (p.job_id) { const job = asyncJobs.get(p.job_id); if (!job) throw new Error(`Job '${p.job_id}' not found. Jobs are in-memory and lost on container restart.`); return job; }
      const jobs = Array.from(asyncJobs.values()).reverse().slice(0, 20);
      return { jobs, total: asyncJobs.size };
    },
  },

  // -- Artifacts & Tracking ---------------------------------------------------

  add_artifact: {
    description: "Link a file, container, service, repo, or URL to a project.",
    params: { slug: "Project slug", type: "Artifact type: file|link|container|service|repo", name: "Artifact name", path_or_url: "(optional) Path or URL", description: "(optional) Description" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`INSERT INTO pipeline_artifacts (project_id, type, name, path_or_url, description) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [proj.rows[0].id, p.type, p.name, p.path_or_url || null, p.description || null]);
      return result.rows[0];
    },
  },

  list_artifacts: {
    description: "List all artifacts for a project.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`SELECT * FROM pipeline_artifacts WHERE project_id = $1 ORDER BY created_at`, [proj.rows[0].id]);
      return { slug: p.slug, artifacts: result.rows, count: result.rowCount };
    },
  },

  log_event: {
    description: "Log a manual event for a project.",
    params: { slug: "Project slug", event_type: "Event type string (e.g. 'note', 'decision', 'blocker', 'milestone')", details: "(optional) Event details as JSON object" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3) RETURNING *`, [proj.rows[0].id, p.event_type, p.details ? JSON.stringify(p.details) : null]);
      return result.rows[0];
    },
  },

  run_sprint: {
    description: "Execute a sprint by launching an OpenHands coding session with detailed prompts from Dify. Auto-creates workspace/repos if needed. Monitors completion and submits for review.",
    params: { slug: "Project slug", sprint_number: "Sprint number to execute", feedback: "(optional) Feedback from a previous rejected attempt" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];
      const sprint = await pgQuery(`SELECT * FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2`, [project.id, p.sprint_number]);
      if (sprint.rowCount === 0) throw new Error(`Sprint ${p.sprint_number} not found for ${p.slug}`);
      runSprintExecution(project, parseInt(p.sprint_number), p.feedback || undefined).catch(async (err) => {
        log("error", "run_sprint", "execute", `Sprint execution failed: ${err.message}`);
        await ntfyError("run_sprint", "execute", `Sprint ${p.sprint_number} failed for ${p.slug}: ${err.message}`, {});
      });
      return { ok: true, slug: p.slug, sprint_number: p.sprint_number, message: `Sprint ${p.sprint_number} execution launched in background. Monitor via Mattermost #pipeline-updates.` };
    },
  },

  populate_sprints_from_sow: {
    description: "Parse the project's scope_of_work into individual sprint records in pipeline_sprints. Handles various SoW formats.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];
      if (!project.scope_of_work) throw new Error("No scope_of_work on project");
      const sprints = parseSowIntoSprints(project.scope_of_work);
      if (sprints.length === 0) throw new Error("No sprints found in scope_of_work. Expected .sprints or .sprint_plan array.");
      const created = [];
      for (let i = 0; i < sprints.length; i++) {
        const s = sprints[i];
        const sprintNumber = s.sprint_number || s.number || i + 1;
        const name = s.name || s.title || `Sprint ${sprintNumber}`;
        const tasks = s.tasks || s.deliverables || s.items || [];
        try {
          await pgQuery(`INSERT INTO pipeline_sprints (project_id, sprint_number, name, description, tasks, estimated_hours, estimated_loc, complexity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (project_id, sprint_number) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, tasks = EXCLUDED.tasks, estimated_hours = EXCLUDED.estimated_hours, estimated_loc = EXCLUDED.estimated_loc, complexity = EXCLUDED.complexity`, [project.id, sprintNumber, name, s.description || null, tasks.length > 0 ? JSON.stringify(tasks) : null, s.estimated_hours || null, s.estimated_loc || null, s.complexity || null]);
          created.push({ sprint_number: sprintNumber, name, task_count: tasks.length });
        } catch (err: any) { log("warn", "sprints", "populate", `Failed to insert sprint ${sprintNumber}: ${err.message}`); }
      }
      await mmPipelineUpdate(project.name, `Populated ${created.length} sprints from SoW`, "clipboard");
      return { slug: p.slug, sprints_created: created, count: created.length };
    },
  },

  get_metrics: {
    description: "Build analytics: avg hours per complexity, estimate accuracy, cost per project, LOC velocity.",
    params: {},
    handler: async () => {
      const [stages, complexity, accuracy, costs, recent] = await Promise.all([
        pgQuery(`SELECT stage, COUNT(*) as count FROM pipeline_projects GROUP BY stage ORDER BY stage`),
        pgQuery(`SELECT complexity, COUNT(*) as sprints, AVG(actual_hours) as avg_hours, AVG(actual_loc) as avg_loc FROM pipeline_sprints WHERE status = 'completed' AND complexity IS NOT NULL GROUP BY complexity`),
        pgQuery(`SELECT COUNT(*) as completed_projects, AVG(CASE WHEN estimated_hours > 0 THEN actual_hours / estimated_hours ELSE NULL END) as hours_accuracy_ratio, AVG(CASE WHEN estimated_cost > 0 THEN actual_cost / estimated_cost ELSE NULL END) as cost_accuracy_ratio FROM pipeline_projects WHERE stage = 'completed'`),
        pgQuery(`SELECT SUM(actual_cost) as total_cost, AVG(actual_cost) as avg_cost FROM pipeline_projects WHERE actual_cost > 0`),
        pgQuery(`SELECT event_type, COUNT(*) as count FROM pipeline_events WHERE timestamp > NOW() - INTERVAL '7 days' GROUP BY event_type`),
      ]);
      return { projects_by_stage: stages.rows, hours_by_complexity: complexity.rows, estimate_accuracy: accuracy.rows[0], cost_summary: costs.rows[0], recent_activity_7d: recent.rows };
    },
  },

  get_timeline: {
    description: "Get event history for a project.",
    params: { slug: "Project slug", limit: "(optional) Max events, default 50" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT id FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const result = await pgQuery(`SELECT * FROM pipeline_events WHERE project_id = $1 ORDER BY timestamp DESC LIMIT $2`, [proj.rows[0].id, p.limit || 50]);
      return { slug: p.slug, events: result.rows, count: result.rowCount };
    },
  },

  // -- Human-in-the-Loop Review System ----------------------------------------

  submit_for_review: {
    description: "Submit a deliverable for human review in Mattermost. Posts to #human-review with approve/reject instructions. Creates a pending review agent_task.",
    params: { slug: "Project slug", title: "Review title (e.g. 'Architecture Design v1')", content: "Content to review (markdown)", review_type: "Type: sow|architecture|security|research|other", sprint_number: "(optional) Associated sprint number" },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");
      if (!p.title) throw new Error("title is required");
      if (!p.content) throw new Error("content is required");
      if (!p.review_type) throw new Error("review_type is required");
      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      let sprintId = null;
      if (p.sprint_number) { const sprint = await pgQuery(`SELECT id FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2`, [proj.rows[0].id, p.sprint_number]); if (sprint.rowCount > 0) sprintId = sprint.rows[0].id; }
      const task = await pgQuery(`INSERT INTO agent_tasks (project_id, sprint_id, task_type, prompt, status) VALUES ($1, $2, 'review', $3, 'pending_review') RETURNING *`, [proj.rows[0].id, sprintId, `Review ${p.review_type}: ${p.title}`]);
      const taskId = task.rows[0].id;
      const maxContent = 12000;
      const displayContent = p.content.length > maxContent ? p.content.slice(0, maxContent) + "\n\n---\n*[Content truncated \u2014 full version in deliverables channel]*" : p.content;
      const reviewMsg = `### :eyes: Review Required: ${p.title}\n**Project:** ${proj.rows[0].name} (\`${p.slug}\`)\n**Type:** ${p.review_type} | **Task ID:** \`${taskId}\`\n\n---\n\n${displayContent}\n\n---\n\n:white_check_mark: \`/pipeline approve ${taskId}\`  |  :x: \`/pipeline reject ${taskId} <reason>\``;
      const postResult = await mmPostWithId("human-review", reviewMsg);
      const mmPostId = postResult?.id || null;
      await pgQuery(`UPDATE agent_tasks SET result = $1 WHERE id = $2`, [JSON.stringify({ mm_post_id: mmPostId, review_type: p.review_type, title: p.title, slug: p.slug }), taskId]);
      await mmDeliverable(proj.rows[0].name, p.title, p.content, p.review_type);
      log("info", "review", "submit", `Review submitted: task ${taskId} for ${p.slug}`, { review_type: p.review_type, title: p.title });
      await mmPipelineUpdate(proj.rows[0].name, `Review submitted: ${p.title} (task #${taskId})`, "eyes");
      return { task_id: taskId, status: "pending_review", mm_post_id: mmPostId };
    },
  },

  check_review: {
    description: "Check the status of a review task (pending_review, completed/approved, or failed/rejected).",
    params: { task_id: "Agent task ID to check" },
    handler: async (p) => {
      if (!p.task_id) throw new Error("task_id is required");
      const result = await pgQuery(`SELECT at.*, pp.slug, pp.name as project_name FROM agent_tasks at JOIN pipeline_projects pp ON pp.id = at.project_id WHERE at.id = $1 AND at.task_type = 'review'`, [p.task_id]);
      if (result.rowCount === 0) throw new Error(`Review task ${p.task_id} not found`);
      const task = result.rows[0]; const meta = task.result || {};
      return { task_id: task.id, slug: task.slug, project: task.project_name, status: task.status, review_type: meta.review_type, title: meta.title, approved: meta.approved, reviewed_by: meta.reviewed_by, reviewed_at: meta.reviewed_at, rejection_reason: meta.rejection_reason, created_at: task.created_at, completed_at: task.completed_at };
    },
  },

  list_pending_reviews: {
    description: "List all pending review tasks awaiting human approval.",
    params: { slug: "(optional) Filter by project slug" },
    handler: async (p) => {
      let sql = `SELECT at.*, pp.slug, pp.name as project_name FROM agent_tasks at JOIN pipeline_projects pp ON pp.id = at.project_id WHERE at.task_type = 'review' AND at.status = 'pending_review'`;
      const params: any[] = [];
      if (p.slug) { sql += ` AND pp.slug = $1`; params.push(p.slug); }
      sql += ` ORDER BY at.created_at ASC`;
      const result = await pgQuery(sql, params);
      return { pending_reviews: result.rows.map((r: any) => ({ task_id: r.id, slug: r.slug, project: r.project_name, title: r.result?.title, review_type: r.result?.review_type, created_at: r.created_at })), count: result.rowCount };
    },
  },

  // -- Overwatch Agent (Project Classification & Module Routing) ---------------

  classify_project: {
    description: "Classify a project using the Overwatch agent. Analyzes project idea and selects which pipeline modules to activate. Project must be in 'queue' stage. Posts classification to #human-review for approval.",
    params: {
      slug: "Project slug",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      if (project.stage !== "queue") {
        throw new Error(`Project must be in 'queue' stage to classify (current: ${project.stage})`);
      }
      if (project.overwatch_approved) {
        throw new Error(`Project already classified and approved`);
      }

      // Build module descriptions for the LLM
      const moduleDescriptions = Object.entries(MODULE_REGISTRY).map(([id, def]) => {
        const deps = def.dependsOn.length > 0 ? ` (depends on: ${def.dependsOn.join(", ")})` : "";
        const coerced = def.coercedBy ? ` [auto-included when: ${def.coercedBy.join(" or ")}]` : "";
        return `- **${id}** (${def.displayName}): ${def.category} module, ${def.sections.length} sections${deps}${coerced}`;
      }).join("\n");

      let classification: any;

      // Try Dify overwatch-classify workflow
      if (DIFY_OVERWATCH_KEY && DIFY_OVERWATCH_KEY.startsWith("app-")) {
        try {
          const result = await callDify(DIFY_OVERWATCH_KEY, {
            project_name: project.name,
            project_description: project.description || "",
            project_tags: JSON.stringify(project.tags || []),
            available_modules: moduleDescriptions,
          }, "overwatch-classify");

          if (result?.data?.status === "succeeded") {
            const raw = result.data.outputs?.result;
            try {
              classification = typeof raw === "string" ? JSON.parse(raw) : raw;
            } catch {
              classification = { raw, error: "Failed to parse classification JSON" };
            }
          }
        } catch (err: any) {
          log("warn", "overwatch", "classify", `Dify classification failed, using heuristic: ${err.message}`);
        }
      }

      // Fallback heuristic classification if Dify not available
      if (!classification || !classification.active_modules) {
        const desc = (project.description || "").toLowerCase();
        const tags = (project.tags || []).map((t: string) => t.toLowerCase());
        const allText = `${desc} ${tags.join(" ")}`;

        let projectType = "personal-tool";
        let revenueModel = "none";
        let deliverableType = "software";
        let activeModules: string[] = ["tech-research", "architecture", "security-review", "sprint-planning", "sprint-build"];

        if (allText.includes("client") || allText.includes("freelance") || allText.includes("contract")) {
          projectType = "client-work";
          revenueModel = "client-billing";
        }
        if (allText.includes("saas") || allText.includes("product") || allText.includes("gumroad") || allText.includes("marketplace")) {
          projectType = "market-product";
          revenueModel = "subscription";
          activeModules = ["tech-research", "market-viability", "architecture", "security-review", "sprint-planning", "sprint-build", "product-launch"];
        }
        if (allText.includes("automat") || allText.includes("workflow") || allText.includes("n8n") || allText.includes("bot")) {
          deliverableType = "automation";
          if (projectType === "personal-tool") {
            activeModules = ["automation-design", "sprint-planning", "sprint-build"];
          }
        }
        if (allText.includes("marketing") || allText.includes("social media") || allText.includes("campaign")) {
          if (!activeModules.includes("marketing-strategy")) {
            activeModules.push("marketing-strategy");
          }
        }

        classification = {
          project_type: projectType,
          revenue_model: revenueModel,
          deliverable_type: deliverableType,
          active_modules: activeModules,
          reasoning: "Heuristic classification (Dify overwatch workflow not configured)",
          estimated_hours: null,
          risk_level: "medium",
        };
      }

      // Apply coercion rules
      const expandedModules = applyCoercionRules(classification.active_modules || []);
      classification.active_modules = expandedModules;

      // Store classification
      await pgQuery(
        `UPDATE pipeline_projects SET
          overwatch_classification = $1,
          project_type = $2,
          revenue_model = $3,
          deliverable_type = $4,
          active_modules = $5,
          updated_at = NOW()
         WHERE id = $6`,
        [
          JSON.stringify(classification),
          classification.project_type || "personal-tool",
          classification.revenue_model || "none",
          classification.deliverable_type || "software",
          JSON.stringify(expandedModules),
          project.id,
        ]
      );

      // Create pipeline_module_runs rows
      for (const modId of expandedModules) {
        const def = MODULE_REGISTRY[modId];
        if (!def) continue;
        await pgQuery(
          `INSERT INTO pipeline_module_runs (project_id, module_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (project_id, module_id) DO NOTHING`,
          [project.id, modId]
        );
        // Create pipeline_research rows for each section
        for (const section of def.sections) {
          await pgQuery(
            `INSERT INTO pipeline_research (project_id, section)
             VALUES ($1, $2)
             ON CONFLICT (project_id, section) DO NOTHING`,
            [project.id, section]
          );
        }
      }

      // Post to Mattermost for review
      const moduleList = expandedModules.map(m => {
        const def = MODULE_REGISTRY[m];
        return `- **${m}** (${def?.displayName || m}) — ${def?.sections.length || 0} sections`;
      }).join("\n");

      await mmPostWithId("human-review",
        `### :telescope: Overwatch Classification: ${project.name}\n` +
        `**Slug:** \`${project.slug}\`\n` +
        `**Type:** ${classification.project_type} | **Revenue:** ${classification.revenue_model} | **Deliverable:** ${classification.deliverable_type}\n` +
        `**Risk:** ${classification.risk_level || "?"} | **Est Hours:** ${classification.estimated_hours || "?"}\n\n` +
        `**Reasoning:** ${classification.reasoning || "N/A"}\n\n` +
        `**Active Modules (${expandedModules.length}):**\n${moduleList}\n\n` +
        `---\n:white_check_mark: Approve: \`approve_classification\` with slug \`${project.slug}\`\n` +
        `:pencil: Override: \`approve_classification\` with \`override_modules\` param`
      );

      await mmPipelineUpdate(project.name, `Overwatch classification complete: ${classification.project_type} (${expandedModules.length} modules)`, "telescope");

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "overwatch_classified", JSON.stringify(classification)]
      );

      return {
        slug: project.slug,
        classification,
        active_modules: expandedModules,
        message: "Classification complete. Awaiting approval via approve_classification.",
      };
    },
  },

  approve_classification: {
    description: "Approve Overwatch classification and start the modular pipeline. Optionally override modules, type, or revenue model.",
    params: {
      slug: "Project slug",
      override_modules: "(optional) Comma-separated module IDs to replace the classified modules",
      override_type: "(optional) Override project_type: personal-tool|client-work|market-product|automation|hybrid",
      override_revenue: "(optional) Override revenue_model: none|subscription|one-time|client-billing|freemium",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      if (!project.overwatch_classification) {
        throw new Error(`Project has no classification. Run classify_project first.`);
      }
      if (project.overwatch_approved) {
        throw new Error(`Classification already approved.`);
      }

      // Apply overrides
      let activeModules: string[] = project.active_modules || [];
      if (p.override_modules) {
        const overrideList = p.override_modules.split(",").map((m: string) => m.trim()).filter(Boolean);
        // Validate all modules exist
        for (const m of overrideList) {
          if (!MODULE_REGISTRY[m]) throw new Error(`Unknown module: ${m}. Available: ${Object.keys(MODULE_REGISTRY).join(", ")}`);
        }
        activeModules = applyCoercionRules(overrideList);

        // Create module_runs and research rows for any new modules
        for (const modId of activeModules) {
          const def = MODULE_REGISTRY[modId];
          if (!def) continue;
          await pgQuery(
            `INSERT INTO pipeline_module_runs (project_id, module_id, status)
             VALUES ($1, $2, 'pending')
             ON CONFLICT (project_id, module_id) DO NOTHING`,
            [project.id, modId]
          );
          for (const section of def.sections) {
            await pgQuery(
              `INSERT INTO pipeline_research (project_id, section)
               VALUES ($1, $2)
               ON CONFLICT (project_id, section) DO NOTHING`,
              [project.id, section]
            );
          }
        }
      }

      const projectType = p.override_type || project.project_type;
      const revenueModel = p.override_revenue || project.revenue_model;

      // Initialize module_progress
      const moduleProgress: Record<string, string> = {};
      for (const m of activeModules) {
        moduleProgress[m] = "pending";
      }

      // Set approved + update fields
      await pgQuery(
        `UPDATE pipeline_projects SET
          overwatch_approved = TRUE,
          active_modules = $1,
          module_progress = $2,
          project_type = $3,
          revenue_model = $4,
          stage = 'research',
          research_started_at = NOW(),
          updated_at = NOW()
         WHERE id = $5`,
        [JSON.stringify(activeModules), JSON.stringify(moduleProgress), projectType, revenueModel, project.id]
      );

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "overwatch_approved", JSON.stringify({ active_modules: activeModules, overrides: { modules: !!p.override_modules, type: !!p.override_type, revenue: !!p.override_revenue } })]
      );

      // Find and start ready modules
      const readyModules = getReadyModules(activeModules, moduleProgress);
      const started: string[] = [];

      for (const modId of readyModules) {
        const def = MODULE_REGISTRY[modId];
        if (def?.hitlGate) {
          log("info", "overwatch", "approve", `Module ${modId} gated for HitL`);
          continue;
        }
        startModuleAsync(
          { id: project.id, slug: project.slug, name: project.name, description: project.description },
          modId
        );
        started.push(modId);
      }

      await mmPipelineUpdate(project.name, `Classification approved. Starting ${started.length} modules: ${started.join(", ")}`, "rocket");

      return {
        slug: project.slug,
        approved: true,
        active_modules: activeModules,
        started_modules: started,
        message: `Approved. ${started.length} modules starting: ${started.join(", ")}`,
      };
    },
  },

  get_module_status: {
    description: "Get module pipeline status for a project. Shows all active modules, their progress, dependencies, and which modules are ready to start.",
    params: { slug: "Project slug" },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      if (!project.overwatch_classification) {
        return { slug: p.slug, message: "Project not classified. Use classify_project first.", legacy_mode: true, stage: project.stage };
      }

      const moduleRuns = await pgQuery(
        `SELECT * FROM pipeline_module_runs WHERE project_id = $1 ORDER BY module_id`,
        [project.id]
      );

      const activeModules: string[] = project.active_modules || [];
      const moduleProgress: Record<string, string> = project.module_progress || {};
      const readyModules = getReadyModules(activeModules, moduleProgress);

      const modules = moduleRuns.rows.map((r: any) => {
        const def = MODULE_REGISTRY[r.module_id];
        return {
          module_id: r.module_id,
          display_name: def?.displayName || r.module_id,
          category: def?.category,
          status: r.status,
          sections: def?.sections.length || 0,
          started_at: r.started_at,
          completed_at: r.completed_at,
          error: r.error,
          depends_on: def?.dependsOn.filter(d => activeModules.includes(d)) || [],
          soft_depends_on: (def?.softDependsOn || []).filter(d => activeModules.includes(d)),
          is_ready: readyModules.includes(r.module_id),
          has_hitl_gate: def?.hitlGate || false,
        };
      });

      // Get section-level progress for in_progress modules
      const inProgressModules = modules.filter((m: any) => m.status === "in_progress").map((m: any) => m.module_id as string);
      let sectionProgress: any[] = [];
      if (inProgressModules.length > 0) {
        const allSections = inProgressModules.flatMap((modId: string) => MODULE_REGISTRY[modId]?.sections || []);
        if (allSections.length > 0) {
          const sectionRows = await pgQuery(
            `SELECT section, status FROM pipeline_research WHERE project_id = $1 AND section = ANY($2)`,
            [project.id, allSections]
          );
          sectionProgress = sectionRows.rows;
        }
      }

      return {
        slug: p.slug,
        project_type: project.project_type,
        revenue_model: project.revenue_model,
        deliverable_type: project.deliverable_type,
        overwatch_approved: project.overwatch_approved,
        stage: project.stage,
        modules,
        ready_to_start: readyModules,
        section_progress: sectionProgress,
      };
    },
  },

  start_module: {
    description: "Manually start a specific module for a classified project. Use for HitL-gated modules or re-invocable modules like agent-pipeline.",
    params: {
      slug: "Project slug",
      module_id: "Module to start (e.g. 'war-room', 'agent-pipeline', 'product-launch')",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      if (!project.overwatch_approved) {
        throw new Error("Project not classified/approved. Run classify_project and approve_classification first.");
      }

      const moduleId = p.module_id;
      const def = MODULE_REGISTRY[moduleId];
      if (!def) throw new Error(`Unknown module: ${moduleId}. Available: ${Object.keys(MODULE_REGISTRY).join(", ")}`);

      const activeModules: string[] = project.active_modules || [];
      const moduleProgress: Record<string, string> = project.module_progress || {};

      // For re-invocable modules, allow restart even if complete
      if (def.reInvocable && moduleProgress[moduleId] === "complete") {
        await pgQuery(
          `UPDATE pipeline_module_runs SET status = 'pending', started_at = NULL, completed_at = NULL, updated_at = NOW()
           WHERE project_id = $1 AND module_id = $2`,
          [project.id, moduleId]
        );
        moduleProgress[moduleId] = "pending";
        await pgQuery(
          `UPDATE pipeline_projects SET module_progress = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(moduleProgress), project.id]
        );
      }

      // If not in active modules, add it
      if (!activeModules.includes(moduleId)) {
        activeModules.push(moduleId);
        await pgQuery(
          `UPDATE pipeline_projects SET active_modules = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(activeModules), project.id]
        );
        // Ensure module_run row exists
        await pgQuery(
          `INSERT INTO pipeline_module_runs (project_id, module_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (project_id, module_id) DO NOTHING`,
          [project.id, moduleId]
        );
        // Ensure research rows
        for (const section of def.sections) {
          await pgQuery(
            `INSERT INTO pipeline_research (project_id, section)
             VALUES ($1, $2)
             ON CONFLICT (project_id, section) DO NOTHING`,
            [project.id, section]
          );
        }
      }

      // Check deps
      const hardDepsOk = def.dependsOn.every(dep =>
        !activeModules.includes(dep) || moduleProgress[dep] === "complete"
      );
      if (!hardDepsOk) {
        const blockers = def.dependsOn.filter(dep => activeModules.includes(dep) && moduleProgress[dep] !== "complete");
        throw new Error(`Cannot start ${moduleId}: blocked by ${blockers.join(", ")}`);
      }

      const softDepsOk = (def.softDependsOn || []).every(dep =>
        !activeModules.includes(dep) || moduleProgress[dep] === "complete"
      );
      if (!softDepsOk) {
        const waitingOn = (def.softDependsOn || []).filter(dep => activeModules.includes(dep) && moduleProgress[dep] !== "complete");
        log("warn", "module", "start", `Starting ${moduleId} with incomplete soft deps: ${waitingOn.join(", ")}`);
      }

      // Start module
      startModuleAsync(
        { id: project.id, slug: project.slug, name: project.name, description: project.description },
        moduleId
      );

      return {
        slug: project.slug,
        module_id: moduleId,
        status: "starting",
        message: `Module ${def.displayName} starting in background.`,
      };
    },
  },
};

// --- Registration ---

export function registerProjectTools(server: McpServer) {
  server.tool(
    "project_list",
    "List all available Project Pipeline tools. Manages the full dev-team automation lifecycle: idea capture, " +
    "Overwatch classification (classify/approve/route), modular research pipelines, architecture, security review, " +
    "planning, building, and completion. Tools cover: " +
    "project CRUD (create/list/get/update/advance/archive), Overwatch (classify_project/approve_classification/get_module_status/start_module), " +
    "research (start/get/update/complete), " +
    "agent tasks (create/list/update/run_devteam_workflow), human-in-the-loop reviews (submit_for_review/check_review/list_pending_reviews), async questions (add/answer/get_unanswered/get), " +
    "sprints (add/update/start/complete/populate_from_sow/run), artifacts (add/list), and tracking (log_event/get_metrics/get_timeline).",
    {},
    async () => {
      const toolList = Object.entries(tools).map(([name, def]) => ({
        tool: name, description: def.description, params: def.params,
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
        const criticalTools = ["advance_stage", "start_research", "run_devteam_workflow", "create_agent_task"];
        if (criticalTools.includes(tool)) {
          await ntfyError("call", tool, `Tool ${tool} failed: ${error.message}`, { tool, params: Object.keys(params || {}) });
        }
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}


// -- Exported HitL Handler (called from Express webhook route in index.ts) ----

export async function handleReviewAction(
  action: string, taskIdStr: string, reason: string | undefined, reviewerName: string
): Promise<string> {
  if (action === "list") {
    const pending = await pgQuery(`SELECT at.id, at.prompt, at.created_at, pp.name as project_name FROM agent_tasks at JOIN pipeline_projects pp ON pp.id = at.project_id WHERE at.task_type = 'review' AND at.status = 'pending_review' ORDER BY at.created_at ASC`);
    if (pending.rowCount === 0) return "No pending reviews.";
    const reviewLines = pending.rows.map((r: any) => `- **#${r.id}** ${r.project_name}: ${r.prompt} (${new Date(r.created_at).toLocaleDateString()})`);
    return `**Pending Reviews (${pending.rowCount}):**\n${reviewLines.join("\n")}`;
  }

  const taskId = parseInt(taskIdStr);
  if (isNaN(taskId)) {
    return "Invalid task ID. Usage: `/pipeline approve <task-id>` or `/pipeline reject <task-id> <reason>` or `/pipeline retry <task-id>` or `/pipeline list`";
  }

  const result = await pgQuery(`SELECT at.*, pp.slug, pp.name as project_name FROM agent_tasks at JOIN pipeline_projects pp ON pp.id = at.project_id WHERE at.id = $1 AND at.task_type = 'review'`, [taskId]);
  if (result.rowCount === 0) return `Review task #${taskId} not found.`;
  const task = result.rows[0];
  const existingResult = task.result || {};

  if (action === "approve") {
    if (task.status !== "pending_review") return `Task #${taskId} is not pending review (current status: ${task.status}).`;

    // Sprint-specific approval: promote code + merge
    if (existingResult.review_type === "sprint" && existingResult.slug) {
      const sprintRow = task.sprint_id ? (await pgQuery(`SELECT * FROM pipeline_sprints WHERE id = $1`, [task.sprint_id])).rows[0] : null;
      if (sprintRow) {
        const sandboxBranch = sprintRow.branch_name || `${existingResult.slug}/sprint-${sprintRow.sprint_number}`;
        const targetBranch = `sprint-${sprintRow.sprint_number}`;
        try {
          const promoResult = await promoteCodeToProjectRepo(existingResult.slug, sandboxBranch, targetBranch);
          log("info", "review", "promote", promoResult.message);
          try { await mergeSprintDirect(existingResult.slug, targetBranch); } catch (mergeErr: any) {
            log("error", "review", "merge", `Merge failed: ${mergeErr.message}`);
            await mmPipelineUpdate(task.project_name, `Merge failed for sprint: ${mergeErr.message}. Resolve conflicts and retry.`, "x");
            return `:warning: Sprint approved but merge failed: ${mergeErr.message}`;
          }
          await pgQuery(`UPDATE pipeline_sprints SET status = 'completed', completed_at = NOW() WHERE id = $1`, [sprintRow.id]);
          await pgQuery(`UPDATE pipeline_projects SET actual_hours = (SELECT COALESCE(SUM(actual_hours), 0) FROM pipeline_sprints WHERE project_id = $1), updated_at = NOW() WHERE id = $1`, [task.project_id]);
          await pgQuery(`INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`, [task.project_id, "sprint_completed", JSON.stringify({ sprint_number: sprintRow.sprint_number, branch: sandboxBranch })]);
        } catch (promoteErr: any) {
          log("error", "review", "promote", `Code promotion failed: ${promoteErr.message}`);
          await mmPipelineUpdate(task.project_name, `Promotion failed: ${promoteErr.message}`, "x");
          return `:warning: Sprint approved but promotion failed: ${promoteErr.message}`;
        }
      }
    }

    await pgQuery(`UPDATE agent_tasks SET status = 'completed', completed_at = NOW(), result = $1 WHERE id = $2`, [JSON.stringify({ ...existingResult, approved: true, reviewed_by: reviewerName, reviewed_at: new Date().toISOString() }), taskId]);
    if (existingResult.mm_post_id) {
      await mmUpdatePost(existingResult.mm_post_id, `### :white_check_mark: APPROVED: ${existingResult.title || "Review"}\n**Project:** ${task.project_name} (\`${task.slug}\`)\n**Approved by:** @${reviewerName}\n**Task ID:** \`${taskId}\``);
    }
    await mmPipelineUpdate(task.project_name, `Review #${taskId} approved by @${reviewerName}: ${existingResult.title || ""}`, "white_check_mark");
    log("info", "review", "approve", `Task ${taskId} approved by ${reviewerName}`, { slug: task.slug });
    return `:white_check_mark: Review #${taskId} approved! (${existingResult.title || task.prompt})`;

  } else if (action === "reject") {
    if (task.status !== "pending_review") return `Task #${taskId} is not pending review (current status: ${task.status}).`;
    if (!reason) return "Please provide a rejection reason: \`/pipeline reject <task-id> <reason>\`";

    await pgQuery(`UPDATE agent_tasks SET status = 'failed', completed_at = NOW(), result = $1 WHERE id = $2`, [JSON.stringify({ ...existingResult, approved: false, reviewed_by: reviewerName, reviewed_at: new Date().toISOString(), rejection_reason: reason }), taskId]);
    if (existingResult.mm_post_id) {
      await mmUpdatePost(existingResult.mm_post_id, `### :x: REJECTED: ${existingResult.title || "Review"}\n**Project:** ${task.project_name} (\`${task.slug}\`)\n**Rejected by:** @${reviewerName}\n**Reason:** ${reason}\n**Task ID:** \`${taskId}\``);
    }
    await mmPipelineUpdate(task.project_name, `Review #${taskId} rejected by @${reviewerName}: ${reason}`, "x");
    log("info", "review", "reject", `Task ${taskId} rejected by ${reviewerName}: ${reason}`, { slug: task.slug });
    return `:x: Review #${taskId} rejected. Reason: ${reason}`;

  } else if (action === "retry") {
    if (task.status !== "failed") return `Can only retry failed/rejected reviews. Task #${taskId} status: ${task.status}`;
    const reviewType = existingResult.review_type;
    const rejectionReason = existingResult.rejection_reason || reason || "No specific feedback";
    const feedbackMsg = reason ? `${rejectionReason}\n\nAdditional notes: ${reason}` : rejectionReason;

    if (reviewType === "sprint" && existingResult.slug) {
      const projData = (await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [existingResult.slug])).rows[0];
      if (!projData) return `Project ${existingResult.slug} not found.`;
      const sprint = task.sprint_id ? (await pgQuery(`SELECT * FROM pipeline_sprints WHERE id = $1`, [task.sprint_id])).rows[0] : null;
      if (sprint) {
        await pgQuery(`UPDATE pipeline_sprints SET status = 'active' WHERE id = $1`, [sprint.id]);
        await pgQuery(`UPDATE agent_tasks SET status = 'queued' WHERE id = $1`, [taskId]);
        runSprintExecution(projData, sprint.sprint_number, feedbackMsg).catch(async (err) => {
          log("error", "review", "retry", `Retry failed for sprint ${sprint.sprint_number}: ${err.message}`);
          await ntfyError("review", "retry", `Sprint retry failed: ${err.message}`, { slug: existingResult.slug });
        });
        await mmPipelineUpdate(task.project_name, `Retrying sprint ${sprint.sprint_number} with feedback from review`, "arrows_counterclockwise");
        return `:arrows_counterclockwise: Retrying sprint ${sprint.sprint_number} with feedback. New coding session starting...`;
      }
    }
    return `Retry not supported for review type: ${reviewType}. Only sprint reviews can be retried.`;

  } else {
    return `Unknown action: \`${action}\`. Available: \`approve\`, \`reject\`, \`retry\`, \`list\`.\nUsage: \`/pipeline approve <task-id>\` or \`/pipeline reject <task-id> <reason>\` or \`/pipeline retry <task-id> [notes]\` or \`/pipeline list\``;
  }
}
