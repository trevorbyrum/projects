import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchPreferences } from "./preferences.js";
import { pgQuery } from "../utils/postgres.js";
import { gitlabFetch, createWorkspaceDirect, createCodingSessionDirect, mergeSprintDirect, promoteCodeToProjectRepo, getConversationStatus } from "./workspaces.js";
import { startAndRunWarRoom } from "./war-room.js";
import { mmAlert, mmPipelineUpdate, mmDeliverable, mmDeliverablePdf, mmPostWithId, mmUpdatePost, mmPost, mmTodo, mmQueueUpdate, mmNotify, mmError, mmWarn } from "./mm-notify.js";
import { renderSowPdf } from "./pdf-renderer.js";
import {
  writeResearchDoc, readResearchDoc, getRepoForModule,
  generateModuleSummary, generateProjectSummary,
  findingsToMarkdown,
} from "../utils/research-docs.js";
import { trackDify, flushLangfuse } from "../utils/langfuse.js";
import { openrouterChat } from "../utils/llm.js";



const N8N_WEBHOOK_BASE = process.env.N8N_WEBHOOK_BASE || "http://n8n:5678/webhook";

// n8n 2.4.6 webhook URLs include workflowId prefix: /webhook/{workflowId}/webhook/{path}
const N8N_WEBHOOK_IDS: Record<string, string> = {
  "project-gitlab-sync": process.env.N8N_WH_GITLAB_SYNC || "",
  "project-research-pipeline": process.env.N8N_WH_RESEARCH_PIPELINE || "",
  "project-research-resume": process.env.N8N_WH_RESEARCH_RESUME || "",
  "dev-team-orchestrator": process.env.N8N_WH_DEVTEAM_ORCHESTRATOR || "",
};

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
      await mmError("n8n", webhookPath, `Webhook returned HTTP ${res.status}`, {
        webhook: webhookPath, status: res.status, body: body.slice(0, 500), elapsed_ms: elapsed,
      });
      return null;
    }

    const text = await res.text();
    log("info", "n8n", "trigger", `Webhook ${webhookPath} OK (${elapsed}ms)`, { response_length: text.length });
    try { return JSON.parse(text); } catch { return text; }
  } catch (e: any) {
    const elapsed = Date.now() - startTime;
    await mmError("n8n", webhookPath, `Webhook call failed: ${e.message}`, {
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
  "prior-art", "libraries", "architecture",
  "dependencies", "file-structure", "tools",
  "containers", "integration", "security",
  "costs", "open-source-scan", "ui-ux-research",
  "best-practices",
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

// Explicit dependency graph: section → sections it depends on
const SECTION_DEPENDENCIES: Record<string, string[]> = {
  "prior-art":        [],
  "libraries":        ["prior-art"],
  "security":         ["prior-art"],
  "ui-ux-research":   ["prior-art"],
  "architecture":     ["libraries", "security"],
  "dependencies":     ["libraries"],
  "file-structure":   ["architecture"],
  "tools":            ["architecture", "dependencies"],
  "containers":       ["architecture"],
  "integration":      ["architecture", "containers"],
  "costs":            ["containers", "tools"],
  "open-source-scan": ["libraries", "dependencies"],
  "best-practices":   ["architecture", "security", "tools"],
};

/** Kahn's algorithm: returns sections grouped into parallel tiers */
function kahnTieredSort(sections: string[], deps: Record<string, string[]>): string[][] {
  const inDegree: Record<string, number> = {};
  const dependents: Record<string, string[]> = {};
  const processed = new Set<string>();
  for (const s of sections) {
    inDegree[s] = 0;
    dependents[s] = [];
  }
  for (const s of sections) {
    for (const dep of (deps[s] || [])) {
      if (sections.includes(dep)) {
        inDegree[s]++;
        dependents[dep].push(s);
      }
    }
  }
  const tiers: string[][] = [];
  while (processed.size < sections.length) {
    const tier = sections.filter(s => !processed.has(s) && inDegree[s] === 0);
    if (tier.length === 0) {
      // Cycle detected — dump remaining into final tier
      tiers.push(sections.filter(s => !processed.has(s)));
      break;
    }
    tiers.push(tier);
    for (const s of tier) {
      processed.add(s);
      for (const dep of dependents[s]) {
        if (inDegree[dep] > 0) inDegree[dep]--;
      }
    }
  }
  return tiers;
}

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




// Dify workflow API keys per research section
const DIFY_SECTION_KEYS: Record<string, string> = {
  "libraries":         process.env.DIFY_KEY_LIBRARIES || "",
  "architecture":      process.env.DIFY_KEY_ARCHITECTURE || "",
  "security":          process.env.DIFY_KEY_SECURITY || "",
  "dependencies":      process.env.DIFY_KEY_DEPENDENCIES || "",
  "file-structure":    process.env.DIFY_KEY_FILE_STRUCTURE || "",
  "tools":             process.env.DIFY_KEY_TOOLS || "",
  "containers":        process.env.DIFY_KEY_CONTAINERS || "",
  "integration":       process.env.DIFY_KEY_INTEGRATION || "",
  "costs":             process.env.DIFY_KEY_COSTS || "",
  "open-source-scan":  process.env.DIFY_KEY_OPEN_SOURCE_SCAN || "",
  "best-practices":    process.env.DIFY_KEY_BEST_PRACTICES || "",
  "ui-ux-research":    process.env.DIFY_KEY_UI_UX_RESEARCH || "",
  "prior-art":         process.env.DIFY_KEY_PRIOR_ART || "",
};

// Dev-team Dify workflow API keys
const DIFY_DEVTEAM_KEYS: Record<string, string> = {
  "architect-design":        process.env.DIFY_KEY_ARCHITECT_DESIGN || "",
  "architect-revise":        process.env.DIFY_KEY_ARCHITECT_REVISE || "",
  "security-review":         process.env.DIFY_KEY_SECURITY_REVIEW || "",
  "pm-generate-sow":         process.env.DIFY_KEY_PM_GENERATE_SOW || "",
  "pm-generate-task-prompts":process.env.DIFY_KEY_PM_GENERATE_TASKS || "",
  "code-reviewer":           process.env.DIFY_KEY_CODE_REVIEWER || "",
  "focused-research":        process.env.DIFY_KEY_FOCUSED_RESEARCH || "",
};

const DIFY_API_BASE = process.env.DIFY_API_BASE || "http://dify-api:5001";

// ── Overwatch Module Key Maps ─────────────────────────────────────────────────

// Overwatch classification workflow key
const DIFY_OVERWATCH_KEY = process.env.DIFY_OVERWATCH_CLASSIFY_KEY || "";

// Market Viability section keys
const DIFY_MARKET_KEYS: Record<string, string> = {
  "tam-sam-som":           process.env.DIFY_MARKET_TAM_KEY || "",
  "competitor-landscape":  process.env.DIFY_MARKET_COMPETITORS_KEY || "",
  "differentiation":       process.env.DIFY_MARKET_DIFFERENTIATION_KEY || "",
  "demand-validation":     process.env.DIFY_MARKET_DEMAND_KEY || "",
  "pricing-strategy":      process.env.DIFY_MARKET_PRICING_KEY || "",
  "market-timing":         process.env.DIFY_MARKET_TIMING_KEY || "",
};

// Marketing Strategy section keys
const DIFY_STRATEGY_KEYS: Record<string, string> = {
  "go-to-market":        process.env.DIFY_STRATEGY_GTM_KEY || "",
  "channel-selection":   process.env.DIFY_STRATEGY_CHANNELS_KEY || "",
  "content-strategy":    process.env.DIFY_STRATEGY_CONTENT_KEY || "",
  "social-media":        process.env.DIFY_STRATEGY_SOCIAL_KEY || "",
  "campaign-design":     process.env.DIFY_STRATEGY_CAMPAIGNS_KEY || "",
  "brand-positioning":   process.env.DIFY_STRATEGY_BRAND_KEY || "",
};

// Report Compiler key
const DIFY_REPORT_KEY = process.env.DIFY_MARKET_STRATEGY_REPORT_KEY || "";

// Automation Design section keys
const DIFY_AUTO_KEYS: Record<string, string> = {
  "workflow-design":      process.env.DIFY_AUTO_WORKFLOW_KEY || "",
  "tool-selection":       process.env.DIFY_AUTO_TOOLS_KEY || "",
  "integration-mapping":  process.env.DIFY_AUTO_INTEGRATION_KEY || "",
  "trigger-action-arch":  process.env.DIFY_AUTO_TRIGGERS_KEY || "",
  "guardrail-design":     process.env.DIFY_AUTO_GUARDRAILS_KEY || "",
};

// Agent Pipeline section keys
const DIFY_AGENT_KEYS: Record<string, string> = {
  "agent-discovery":      process.env.DIFY_AGENT_DISCOVERY_KEY || "",
  "prompt-audit":         process.env.DIFY_AGENT_PROMPT_AUDIT_KEY || "",
  "lightrag-assessment":  process.env.DIFY_AGENT_LIGHTRAG_KEY || "",
  "agent-scaffolding":    process.env.DIFY_AGENT_SCAFFOLDING_KEY || "",
};

// Product Launch section keys
const DIFY_LAUNCH_KEYS: Record<string, string> = {
  "marketplace-setup":  process.env.DIFY_LAUNCH_MARKETPLACE_KEY || "",
  "landing-page":       process.env.DIFY_LAUNCH_LANDING_KEY || "",
  "pricing-config":     process.env.DIFY_LAUNCH_PRICING_KEY || "",
  "distribution":       process.env.DIFY_LAUNCH_DISTRIBUTION_KEY || "",
};

// Module definition type
interface ModuleDefinition {
  id: string;
  name: string;
  sections: string[];
  difyKeys: Record<string, string> | null;
  dependsOn: string[];
  softDependsOn: string[];
  hitlGate: boolean;
  reInvocable: boolean;
  coercionRules?: { requiredTypes: string[]; excludedTypes?: string[] };
}

// MODULE_REGISTRY — defines all Overwatch pipeline modules
const MODULE_REGISTRY: Record<string, ModuleDefinition> = {
  "tech-research": {
    id: "tech-research",
    name: "Technical Research",
    sections: [
      "market-analysis", "competitive-landscape", "technical-stack", "api-integration-research",
      "data-model", "scalability-strategy", "monetization", "risk-assessment", "user-personas",
      "open-source-scan", "best-practices", "ui-ux-research", "prior-art",
    ],
    difyKeys: null,
    dependsOn: [],
    softDependsOn: [],
    hitlGate: false,
    reInvocable: false,
  },
  "market-viability": {
    id: "market-viability",
    name: "Market Viability Analysis",
    sections: ["tam-sam-som", "competitor-landscape", "differentiation", "demand-validation", "pricing-strategy", "market-timing"],
    difyKeys: DIFY_MARKET_KEYS,
    dependsOn: [],
    softDependsOn: ["tech-research"],
    hitlGate: false,
    reInvocable: false,
    coercionRules: { requiredTypes: ["market-product", "client-work"] },
  },
  "marketing-strategy": {
    id: "marketing-strategy",
    name: "Marketing Strategy",
    sections: ["go-to-market", "channel-selection", "content-strategy", "social-media", "campaign-design", "brand-positioning"],
    difyKeys: DIFY_STRATEGY_KEYS,
    dependsOn: ["market-viability"],
    softDependsOn: ["tech-research"],
    hitlGate: false,
    reInvocable: false,
    coercionRules: { requiredTypes: ["market-product"] },
  },
  "report-compiler": {
    id: "report-compiler",
    name: "Market & Strategy Report",
    sections: ["market-strategy-compile-report"],
    difyKeys: { "market-strategy-compile-report": DIFY_REPORT_KEY },
    dependsOn: ["market-viability", "marketing-strategy"],
    softDependsOn: [],
    hitlGate: false,
    reInvocable: true,
    coercionRules: { requiredTypes: ["market-product"] },
  },
  "automation-design": {
    id: "automation-design",
    name: "Automation Design",
    sections: ["workflow-design", "tool-selection", "integration-mapping", "trigger-action-arch", "guardrail-design"],
    difyKeys: DIFY_AUTO_KEYS,
    dependsOn: [],
    softDependsOn: ["tech-research"],
    hitlGate: false,
    reInvocable: false,
    coercionRules: { requiredTypes: ["automation"] },
  },
  "architecture": {
    id: "architecture",
    name: "Architecture Design",
    sections: ["architect-design"],
    difyKeys: null,
    dependsOn: ["tech-research"],
    softDependsOn: [],
    hitlGate: false,
    reInvocable: false,
  },
  "security-review": {
    id: "security-review",
    name: "Security Review",
    sections: ["security-review"],
    difyKeys: null,
    dependsOn: ["architecture"],
    softDependsOn: [],
    hitlGate: true,
    reInvocable: true,
  },
  "war-room": {
    id: "war-room",
    name: "War Room",
    sections: ["war-room-session"],
    difyKeys: null,
    dependsOn: ["architecture"],
    softDependsOn: ["security-review"],
    hitlGate: true,
    reInvocable: true,
  },
  "agent-pipeline": {
    id: "agent-pipeline",
    name: "Agent Pipeline",
    sections: ["agent-discovery", "prompt-audit", "lightrag-assessment", "agent-scaffolding"],
    difyKeys: DIFY_AGENT_KEYS,
    dependsOn: ["tech-research"],
    softDependsOn: ["architecture"],
    hitlGate: false,
    reInvocable: false,
    coercionRules: { requiredTypes: ["automation", "hybrid"] },
  },
  "sprint-planning": {
    id: "sprint-planning",
    name: "Sprint Planning",
    sections: ["pm-generate-sow"],
    difyKeys: null,
    dependsOn: ["architecture", "security-review"],
    softDependsOn: ["war-room"],
    hitlGate: true,
    reInvocable: true,
  },
  "product-launch": {
    id: "product-launch",
    name: "Product Launch",
    sections: ["marketplace-setup", "landing-page", "pricing-config", "distribution"],
    difyKeys: DIFY_LAUNCH_KEYS,
    dependsOn: ["sprint-planning"],
    softDependsOn: ["marketing-strategy"],
    hitlGate: true,
    reInvocable: false,
    coercionRules: { requiredTypes: ["market-product"] },
  },
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
      await mmError("dify", label, errMsg, { status: res.status, elapsed_ms: elapsed });
      throw new Error(errMsg);
    }

    const result = await res.json();
    log("info", "dify", "call", `Workflow ${label} completed (${elapsed}ms)`, {
      status: result?.data?.status,
      tokens: result?.data?.total_tokens,
      elapsed_ms: elapsed,
    });
    trackDify({
      workflow: label,
      inputs,
      output: result?.data?.outputs,
      tokens: result?.data?.total_tokens,
      cost: result?.data?.total_price,
      elapsed_ms: elapsed,
      status: result?.data?.status,
    });
    return result;
  } catch (e: any) {
    if (!e.message.includes("Dify workflow")) {
      // Network/fetch error (not our rethrown error)
      const elapsed = Date.now() - startTime;
      await mmError("dify", label, `Workflow call failed: ${e.message}`, { elapsed_ms: elapsed });
    }
    throw e;
  }
}

type SectionStat = { section: string; status: "success" | "failed" | "error" | "skipped"; elapsed?: string; tokens?: number; error?: string };

function buildResearchReport(projectName: string, stats: SectionStat[], crashError?: string): string {
  const succeeded = stats.filter(s => s.status === "success").length;
  const failed = stats.filter(s => s.status !== "success").length;
  const totalTokens = stats.reduce((sum, s) => sum + (s.tokens || 0), 0);
  let msg = `**Research ${crashError ? "CRASHED" : "Complete"}** for **${projectName}**\n\n`;
  msg += "| Section | Result | Time | Tokens |\n";
  msg += "|:--|:--|--:|--:|\n";
  for (const s of stats) {
    const icon = s.status === "success" ? ":white_check_mark:" : ":x:";
    const label = s.status === "success" ? "OK" : s.error ? s.error.slice(0, 60) : s.status;
    msg += `| ${s.section} | ${icon} ${label} | ${s.elapsed || "\u2014"} | ${s.tokens?.toLocaleString() || "\u2014"} |\n`;
  }
  msg += `\n**${succeeded}/${stats.length}** succeeded`;
  if (totalTokens > 0) msg += ` | **${totalTokens.toLocaleString()}** tokens`;
  if (crashError) msg += `\n\n:rotating_light: **Crash:** ${crashError.slice(0, 200)}`;
  return msg;
}

export async function runResearchPipeline(project: { id: number; slug: string; name: string; description: string | null }): Promise<void> {
  const serverContext = "Unraid Tower server with Docker, Traefik reverse proxy, PostgreSQL, Neo4j, n8n, Dify";
  let completedCount = 0;
  const totalSections = RESEARCH_SECTIONS.length;
  const accumulatedFindings: Record<string, any> = {};
  const sectionStats: SectionStat[] = [];

  // Pre-create research rows (for overwatch module flow which bypasses start_research)
  for (const sec of RESEARCH_SECTIONS) {
    await pgQuery(
      `INSERT INTO pipeline_research (project_id, section) VALUES ($1, $2) ON CONFLICT (project_id, section) DO NOTHING`,
      [project.id, sec],
    );
  }

  // Load already-completed sections so we can skip them and seed accumulated findings
  const existingRes = await pgQuery(
    `SELECT section, status, findings FROM pipeline_research WHERE project_id = $1`,
    [project.id]
  );
  const sectionStatus: Record<string, string> = {};
  for (const row of existingRes.rows) {
    sectionStatus[row.section] = row.status;
    if (row.status === "complete" && row.findings) {
      try {
        accumulatedFindings[row.section] = { findings: typeof row.findings === "string" ? JSON.parse(row.findings) : row.findings };
      } catch { /* ignore parse errors */ }
      completedCount++;
    }
  }
  // Reset any sections stuck in_progress (stale from previous container)
  for (const row of existingRes.rows) {
    if (row.status === "in_progress") {
      await pgQuery(
        `UPDATE pipeline_research SET status = 'pending', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
        [project.id, row.section]
      );
      sectionStatus[row.section] = "pending";
      log("info", "research", row.section, `Reset stale in_progress section for ${project.slug}`);
    }
  }

  if (completedCount === totalSections) {
    log("info", "research", "pipeline", `All ${totalSections} sections already complete for ${project.slug} — skipping`);
    return;
  }
  log("info", "research", "pipeline", `Resuming ${project.slug}: ${completedCount}/${totalSections} already complete`);

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

  // Process a single research section (extracted for parallel execution)
  async function processSection(section: string): Promise<void> {
    // Skip already-completed sections
    if (sectionStatus[section] === "complete") {
      sectionStats.push({ section, status: "skipped", error: "Already complete" });
      return;
    }

    const apiKey = DIFY_SECTION_KEYS[section];
    if (!apiKey) {
      sectionStats.push({ section, status: "skipped", error: "No Dify API key configured" });
      return;
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
        const seen = new Set(sectionPreferences.map((p: any) => p.id));
        for (const sp of sectionSpecific) {
          if (!seen.has(sp.id)) {
            sectionPreferences = [...sectionPreferences, sp];
            seen.add(sp.id);
          }
        }
      } catch { /* use base preferences */ }
    }

    // Build inputs — only pass findings from upstream dependencies, not all accumulated
    const deps = SECTION_DEPENDENCIES[section] || [];
    const upstreamFindings: Record<string, any> = {};
    for (const dep of deps) {
      if (accumulatedFindings[dep]) upstreamFindings[dep] = accumulatedFindings[dep];
    }

    const inputs: Record<string, string> = {
      project_name: project.name,
      project_description: project.description || "",
      section,
      server_context: serverContext,
      existing_findings: Object.keys(upstreamFindings).length > 0
        ? JSON.stringify(upstreamFindings).slice(0, 45000)
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

    const data = difyResponse?.data;
    if (!data || data.status !== "succeeded") {
      const errMsg = data?.error || "Dify workflow did not succeed";
      log("error", "research", section, `Dify failed for ${project.slug}: ${errMsg}`);
      await pgQuery(
        `UPDATE pipeline_research SET status = 'pending', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
        [project.id, section]
      );
      sectionStats.push({ section, status: "failed", error: errMsg });
      return;
    }

    // Parse the result
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

    // Accumulate findings for downstream tiers
    if (findings) {
      accumulatedFindings[section] = { findings, concerns, recommendations, confidence_score: confidenceScore };
    }

    // Update PG
    await pgQuery(
      `UPDATE pipeline_research
       SET findings = $1, concerns = $2, recommendations = $3, confidence_score = $4, status = 'complete', updated_at = NOW()
       WHERE project_id = $5 AND section = $6`,
      [findings ? JSON.stringify(findings) : null, concerns, recommendations, confidenceScore, project.id, section]
    );

    // Dual-write to GitLab
    try {
      const mdContent = findingsToMarkdown(section, findings, concerns, recommendations);
      const repo = getRepoForModule("tech-research");
      const filePath = await writeResearchDoc(project.slug, repo, "tech-research", section, mdContent, {
        status: "complete", confidence: confidenceScore ?? undefined, model: "dify/research-" + section,
      });
      await pgQuery(
        `UPDATE pipeline_research SET file_path = $1, repo = $2 WHERE project_id = $3 AND section = $4`,
        [filePath, "dev-research", project.id, section]
      );
    } catch (fileErr: any) {
      log("warn", "research", section, `File write failed (non-blocking): ${fileErr.message}`);
    }

    // Insert questions
    for (const q of questions) {
      try {
        await pgQuery(
          `INSERT INTO pipeline_questions (project_id, question, context, priority) VALUES ($1, $2, $3, $4)`,
          [project.id, q.question, q.context || null, q.priority || "normal"]
        );
      } catch (qErr: any) {
        log("warn", "research", section, `Failed to insert question: ${qErr.message}`);
      }
    }

    completedCount++;
    const elapsed = data.elapsed_time ? `${data.elapsed_time.toFixed(1)}s` : "?";
    const tokens = data.total_tokens || "?";
    sectionStats.push({ section, status: "success", elapsed, tokens: typeof tokens === "number" ? tokens : undefined });
    log("info", "research", section, `Complete for ${project.slug} (${elapsed}, ${tokens} tokens)`);
  }

  // ── Tiered Parallel Execution (Kahn's algorithm) ──────────
  try {
    // Filter to sections that still need processing
    const pending = RESEARCH_SECTIONS.filter(s => sectionStatus[s] !== "complete");
    const tiers = kahnTieredSort(pending, SECTION_DEPENDENCIES);
    log("info", "research", "pipeline", `Execution plan for ${project.slug}: ${tiers.map((t, i) => `T${i}[${t.join(",")}]`).join(" → ")}`);

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      log("info", "research", "tier", `Tier ${i}: running ${tier.length} section(s) in parallel [${tier.join(", ")}]`);

      const results = await Promise.allSettled(tier.map(section => processSection(section)));

      // Log any rejected promises (unexpected errors not caught inside processSection)
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "rejected") {
          const err = (results[j] as PromiseRejectedResult).reason;
          log("error", "research", tier[j], `Uncaught error for ${project.slug}: ${err?.message || err}`);
          try {
            await pgQuery(
              `UPDATE pipeline_research SET status = 'pending', updated_at = NOW() WHERE project_id = $1 AND section = $2`,
              [project.id, tier[j]]
            );
          } catch { /* ignore */ }
          sectionStats.push({ section: tier[j], status: "error", error: err?.message || "Unknown error" });
        }
      }
    }
  } catch (crashErr: any) {
    log("error", "research", "pipeline", `Pipeline CRASHED for ${project.slug}: ${crashErr.message}`);
    await mmPipelineUpdate(project.name, buildResearchReport(project.name, sectionStats, crashErr.message), "rotating_light");
    throw crashErr;
  }

  // Final summary notification — single report with all section results
  const failedCount = totalSections - completedCount;
  await mmPipelineUpdate(project.name, buildResearchReport(project.name, sectionStats), failedCount === 0 ? "white_check_mark" : "warning");

  await pgQuery(
    `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
    [project.id, "research_pipeline_complete", JSON.stringify({ completed: completedCount, failed: failedCount, total: totalSections })]
  );

  // Generate tech-research module summary from accumulated findings
  try {
    const summaryFindings = Object.entries(accumulatedFindings).map(([sec, data]) => ({
      section: sec,
      content: findingsToMarkdown(sec, (data as any).findings, (data as any).concerns, (data as any).recommendations),
    }));
    if (summaryFindings.length > 0) {
      await generateModuleSummary(project.slug, "tech-research", summaryFindings);
      log("info", "research", "summary", `Generated tech-research summary for ${project.slug}`);
    }
  } catch (sumErr: any) {
    log("warn", "research", "summary", `Module summary generation failed (non-blocking): ${sumErr.message}`);
  }

  log("info", "research", "pipeline", `Pipeline finished for ${project.slug}: ${completedCount}/${totalSections} succeeded`);
}


// ── Sandbox + Workspace Auto-Creation ──────────────────────

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

  // Gather research context — prefer file reads, fall back to DB
  let archStr = "";
  let secStr = "";
  const techStack = JSON.stringify(project.scope_of_work?.tech_stack || {}, null, 2);

  try {
    const archDoc = await readResearchDoc(project.slug, getRepoForModule("architecture"), "architecture", "architecture-design");
    if (archDoc) archStr = archDoc.content.slice(0, 5000);
  } catch { /* fall through to DB */ }
  try {
    const secDoc = await readResearchDoc(project.slug, getRepoForModule("security-review"), "security-review", "security-review");
    if (secDoc) secStr = secDoc.content.slice(0, 3000);
  } catch { /* fall through to DB */ }

  // DB fallback
  if (!archStr || !secStr) {
    const research = await pgQuery(
      `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
      [project.id]
    );
    if (!archStr) {
      const arch = research.rows.find((r: any) => r.section === 'architecture-design')?.findings || "";
      archStr = (typeof arch === "string" ? arch : JSON.stringify(arch)).slice(0, 5000);
    }
    if (!secStr) {
      const security = research.rows.find((r: any) => r.section === 'security-assessment')?.findings || "";
      secStr = (typeof security === "string" ? security : JSON.stringify(security)).slice(0, 3000);
    }
  }

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


// ── SoW Generation via OpenRouter ────────────────────────────

interface FortuneFiveSow {
  executive_summary: string;
  overview: string;
  objectives: Array<{ objective: string; success_metric: string; target: string }>;
  scope: { in_scope: string[]; out_of_scope: string[] };
  deliverables: Array<{ name: string; description: string; acceptance_criteria: string; sprint_delivery: number }>;
  architecture: string;
  tech_stack: Record<string, string[]>;
  sprints: Array<{
    sprint_number: number;
    name: string;
    description: string;
    complexity: "low" | "medium" | "high" | "extreme";
    estimated_hours: number;
    tasks: Array<{ task: string; estimated_hours: number; status: string; dependencies?: string[] }>;
  }>;
  milestones: Array<{ name: string; sprint: number; criteria: string; deliverables: string[] }>;
  risks: Array<{ risk: string; likelihood: "Low" | "Medium" | "High"; impact: "Low" | "Medium" | "High"; severity: "Low" | "Medium" | "High" | "Critical"; mitigation: string }>;
  acceptance_criteria: Array<{ criterion: string; measurement: string; target: string }>;
  assumptions: string[];
  constraints: string[];
  level_of_effort: { total_hours: number; total_sprints: number; duration_weeks: number; complexity_distribution: Record<string, number> };
}

function validateSow(sow: any): string[] {
  const errors: string[] = [];
  if (!sow.executive_summary || sow.executive_summary.length < 100) errors.push("executive_summary must be >100 characters");
  if (!sow.overview || sow.overview.length < 50) errors.push("overview is missing or too short");
  if (!Array.isArray(sow.objectives) || sow.objectives.length < 3) errors.push("Need at least 3 objectives");
  if (!sow.scope?.in_scope?.length) errors.push("scope.in_scope is empty");
  if (!sow.scope?.out_of_scope?.length) errors.push("scope.out_of_scope is empty");
  if (!Array.isArray(sow.deliverables) || sow.deliverables.length < 3) errors.push("Need at least 3 deliverables");
  for (const d of sow.deliverables || []) {
    if (!d.description) errors.push(`Deliverable '${d.name}' missing description`);
    if (!d.acceptance_criteria) errors.push(`Deliverable '${d.name}' missing acceptance_criteria`);
  }
  if (!sow.architecture || sow.architecture.length < 50) errors.push("architecture is missing or too short");
  if (!sow.tech_stack || Object.keys(sow.tech_stack).length === 0) errors.push("tech_stack is empty");
  if (!Array.isArray(sow.sprints) || sow.sprints.length === 0) errors.push("sprints array is empty");
  if (!Array.isArray(sow.milestones) || sow.milestones.length === 0) errors.push("milestones array is empty");
  if (!Array.isArray(sow.risks) || sow.risks.length < 3) errors.push("Need at least 3 risks");
  for (const r of sow.risks || []) {
    if (!r.mitigation || r.mitigation.length < 10) errors.push(`Risk '${r.risk}' has empty or trivial mitigation`);
  }
  if (!Array.isArray(sow.acceptance_criteria) || sow.acceptance_criteria.length < 3) errors.push("Need at least 3 acceptance_criteria");
  if (!Array.isArray(sow.assumptions) || sow.assumptions.length === 0) errors.push("assumptions is empty");
  if (!Array.isArray(sow.constraints) || sow.constraints.length === 0) errors.push("constraints is empty");
  if (!sow.level_of_effort?.total_hours) errors.push("level_of_effort.total_hours is missing");
  // Check for empty strings in arrays
  for (const key of ["assumptions", "constraints"] as const) {
    if (Array.isArray(sow[key])) {
      for (const item of sow[key]) {
        if (typeof item === "string" && item.trim() === "") errors.push(`Empty string in ${key}`);
      }
    }
  }
  return errors;
}

const SOW_SYSTEM_PROMPT = `You are a senior engagement manager at McKinsey & Company preparing a Statement of Work for a Fortune 500 client. You produce structured, comprehensive SOW documents that meet the highest standards of tier-1 consulting firms.

Rules:
- Output ONLY valid JSON. No markdown, no code fences, no commentary.
- Every field must contain substantive, specific content. Generic placeholder text is unacceptable.
- Each section must demonstrate deep understanding of the project requirements.
- Risk mitigations: Every risk MUST have a detailed, actionable mitigation strategy. An empty mitigation column is a career-ending mistake at a tier-1 firm.
- Executive summary: Write as if presenting to a C-suite audience. Lead with business impact, not technical details.
- Objectives must be SMART (Specific, Measurable, Achievable, Relevant, Time-bound).
- Deliverables must each have full description AND acceptance criteria.
- Sprint tasks must have realistic hour estimates that sum correctly.
- Do not use markdown formatting in string values (no **, no #, no backticks). The PDF renderer handles formatting.`;

async function generateCompleteSow(project: {
  id: number; slug: string; name: string; description: string | null;
  priority?: number; tags?: string[]; estimated_hours?: number;
}): Promise<FortuneFiveSow> {
  log("info", "sow", "generate", `Generating Fortune 500 SoW for ${project.slug}`);

  // Gather ALL research data
  const researchRows = await pgQuery(
    `SELECT section, findings, concerns, recommendations FROM pipeline_research WHERE project_id = $1 AND findings IS NOT NULL AND status = 'complete'`,
    [project.id]
  );
  const researchData: Record<string, any> = {};
  for (const row of researchRows.rows) {
    researchData[row.section] = {
      findings: row.findings,
      concerns: row.concerns,
      recommendations: row.recommendations,
    };
  }

  const userPrompt = `Generate a comprehensive Statement of Work JSON for this project.

PROJECT: ${project.name}
DESCRIPTION: ${project.description || "No description provided"}
PRIORITY: ${project.priority || "N/A"}
TAGS: ${JSON.stringify(project.tags || [])}
ESTIMATED HOURS: ${project.estimated_hours || "To be determined based on analysis"}

RESEARCH DATA (from completed pipeline analysis):
${JSON.stringify(researchData, null, 2).slice(0, 45000)}

Return a JSON object with exactly these fields:
- executive_summary (string, 2-3 paragraphs, strategic business value)
- overview (string, project background, business drivers, problem statement)
- objectives (array of {objective, success_metric, target}, minimum 3, SMART format)
- scope ({in_scope: string[], out_of_scope: string[]})
- deliverables (array of {name, description, acceptance_criteria, sprint_delivery}, minimum 3)
- architecture (string, technical architecture, component breakdown)
- tech_stack (object mapping category names to string arrays, e.g. {"Frontend": ["React 18", "TypeScript"]})
- sprints (array of {sprint_number, name, description, complexity, estimated_hours, tasks: [{task, estimated_hours, status, dependencies?}]})
- milestones (array of {name, sprint, criteria, deliverables: string[]})
- risks (array of {risk, likelihood, impact, severity, mitigation}, minimum 3. EVERY risk MUST have a substantive mitigation)
- acceptance_criteria (array of {criterion, measurement, target}, minimum 3)
- assumptions (string array, minimum 2)
- constraints (string array, minimum 2)
- level_of_effort ({total_hours, total_sprints, duration_weeks, complexity_distribution: {"low": N, "medium": N, "high": N, "extreme": N}})

Output ONLY the JSON object. No markdown, no explanation.`;

  const callLlm = async (correctionNote?: string): Promise<FortuneFiveSow> => {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: SOW_SYSTEM_PROMPT },
      { role: "user", content: correctionNote ? `${userPrompt}\n\nCORRECTION NEEDED: ${correctionNote}` : userPrompt },
    ];

    const raw = await openrouterChat("anthropic/claude-sonnet-4.5", messages, 16000, 0.3, 180000);

    // Extract JSON from response (handle potential markdown wrapping)
    let jsonStr = raw.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonStr);
  };

  // First attempt
  let sow: FortuneFiveSow;
  try {
    sow = await callLlm();
  } catch (err: any) {
    log("error", "sow", "generate", `First LLM call failed: ${err.message}`);
    await mmError("sow", "generate", `SoW generation LLM call failed for ${project.name}: ${err.message}`);
    throw new Error(`SoW generation failed: ${err.message}`);
  }

  // Validate
  let validationErrors = validateSow(sow);
  if (validationErrors.length > 0) {
    log("warn", "sow", "validate", `First attempt had ${validationErrors.length} issues, retrying`, { errors: validationErrors });

    // Retry with corrective prompt
    try {
      sow = await callLlm(`The previous response failed validation. Fix these issues:\n${validationErrors.map(e => `- ${e}`).join("\n")}`);
      validationErrors = validateSow(sow);
    } catch (retryErr: any) {
      log("error", "sow", "generate", `Retry LLM call failed: ${retryErr.message}`);
      await mmError("sow", "generate", `SoW generation retry failed for ${project.name}: ${retryErr.message}`);
      throw new Error(`SoW generation retry failed: ${retryErr.message}`);
    }

    if (validationErrors.length > 0) {
      const errMsg = `SoW validation failed after retry for ${project.name}: ${validationErrors.join(", ")}`;
      log("error", "sow", "validate", errMsg);
      await mmError("sow", "validate", errMsg);
      throw new Error(errMsg);
    }
  }

  log("info", "sow", "generate", `SoW generated successfully for ${project.slug}`, {
    sections: Object.keys(sow).length,
    sprints: sow.sprints.length,
    risks: sow.risks.length,
    total_hours: sow.level_of_effort.total_hours,
  });

  return sow;
}

function parseSowIntoSprints(sow: any): any[] {
  if (!sow) return [];
  // Handle various nested formats the Dify workflow might produce
  const sprints = sow.sprints || sow.sprint_plan || sow.sow?.sprints || sow.sow?.sprint_plan || [];
  if (!Array.isArray(sprints)) return [];
  return sprints;
}

// ── Sprint Execution Pipeline ────────────────────────────────

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
    // Gather all context — prefer file reads, fall back to DB
    let archStr = "";
    let fileStr = "";
    let secStr = "";

    try {
      const archDoc = await readResearchDoc(project.slug, getRepoForModule("architecture"), "architecture", "architecture-design");
      if (archDoc) archStr = archDoc.content;
    } catch { /* fall through */ }
    try {
      const fileDoc = await readResearchDoc(project.slug, getRepoForModule("tech-research"), "tech-research", "file-structure");
      if (fileDoc) fileStr = fileDoc.content;
    } catch { /* fall through */ }
    try {
      const secDoc = await readResearchDoc(project.slug, getRepoForModule("security-review"), "security-review", "security-review");
      if (secDoc) secStr = secDoc.content;
    } catch { /* fall through */ }

    // DB fallback for any missing
    if (!archStr || !fileStr || !secStr) {
      const research = await pgQuery(
        `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
        [project.id]
      );
      if (!archStr) {
        const f = research.rows.find((r: any) => r.section === 'architecture-design')?.findings || "";
        archStr = typeof f === "string" ? f : JSON.stringify(f);
      }
      if (!fileStr) {
        const f = research.rows.find((r: any) => r.section === 'file-structure')?.findings || "";
        fileStr = typeof f === "string" ? f : JSON.stringify(f);
      }
      if (!secStr) {
        const f = research.rows.find((r: any) => r.section === 'security-assessment')?.findings || "";
        secStr = typeof f === "string" ? f : JSON.stringify(f);
      }
    }

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
      await mmError("execution", "monitor", `Monitor crashed for ${project.slug} sprint ${sprintNumber}: ${err.message}`, {});
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
            // Fetch real diff from GitLab Compare API
            let codeDiff = `Branch: ${branchName} (full diff unavailable)`;
            try {
              const SANDBOX_REPO = process.env.OPENHANDS_SANDBOX_REPO || "homelab-projects/openhands-sandbox";
              const compareRes = await gitlabFetch(
                `/api/v4/projects/${encodeURIComponent(SANDBOX_REPO)}/repository/compare?from=main&to=${encodeURIComponent(branchName)}&straight=true`
              );
              if (compareRes?.diffs) {
                const diffParts = compareRes.diffs.map((d: any) =>
                  `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff || "(binary file)"}`
                );
                codeDiff = diffParts.join("\n\n").slice(0, 30000);
              }
            } catch (diffErr: any) {
              log("warn", "execution", "diff", `Failed to fetch diff: ${diffErr.message}`);
            }
            const reviewResult = await callDify(reviewKey, {
              project_name: project.name,
              code_diff: codeDiff,
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
            // Prefer file read, fall back to DB
            let archStr = "";
            try {
              const archDoc = await readResearchDoc(project.slug, getRepoForModule("architecture"), "architecture", "architecture-design");
              if (archDoc) archStr = archDoc.content;
            } catch { /* fall through */ }
            if (!archStr) {
              const research = await pgQuery(
                `SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND section = 'architecture-design' AND status = 'complete'`,
                [project.id]
              );
              const archFindings = research.rows[0]?.findings || "";
              archStr = typeof archFindings === "string" ? archFindings : JSON.stringify(archFindings);
            }

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

        // Mark coding_session agent_task as pending_review
        await pgQuery(
          `UPDATE agent_tasks SET status = 'pending_review', completed_at = NOW() WHERE project_id = $1 AND sprint_id = $2 AND task_type = 'coding_session' AND status = 'running'`,
          [project.id, sprintRow.id],
        );

        return;
      }

      if (convStatus === "ERROR" || convStatus === "error") {
        log("error", "execution", "monitor", `Session ${conversationId} errored`);
        await pgQuery(`UPDATE pipeline_sprints SET status = 'pending' WHERE id = $1`, [sprintRow.id]);
        await pgQuery(
          `UPDATE agent_tasks SET status = 'failed', completed_at = NOW() WHERE project_id = $1 AND sprint_id = $2 AND task_type = 'coding_session' AND status = 'running'`,
          [project.id, sprintRow.id],
        );
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
  await pgQuery(
    `UPDATE agent_tasks SET status = 'failed', completed_at = NOW() WHERE project_id = $1 AND sprint_id = $2 AND task_type = 'coding_session' AND status = 'running'`,
    [project.id, sprintRow.id],
  );
  await pgQuery(`UPDATE pipeline_sprints SET status = 'pending' WHERE id = $1`, [sprintRow.id]);
  await mmPipelineUpdate(project.name, `Sprint ${sprintRow.sprint_number} coding session timed out`, "warning");
}



// ── Overwatch Helper Functions ────────────────────────────────────────────────

function deriveStage(activeModules: string[], moduleProgress: Record<string, string>): string {
  if (!activeModules || activeModules.length === 0) return "queue";
  const statuses = Object.values(moduleProgress || {});
  if (statuses.length > 0 && statuses.every((s) => s === "completed")) return "completed";
  if (moduleProgress["sprint-planning"] === "in-progress" || moduleProgress["sprint-planning"] === "completed") return "planning";
  if (moduleProgress["security-review"] === "in-progress" || moduleProgress["security-review"] === "completed") return "security-review";
  if (moduleProgress["architecture"] === "in-progress" || moduleProgress["architecture"] === "completed") return "architecture";
  if (moduleProgress["tech-research"] === "in-progress" || moduleProgress["tech-research"] === "completed") return "research";
  return "research";
}

function getReadyModules(activeModules: string[], moduleProgress: Record<string, string>): string[] {
  const ready: string[] = [];
  for (const modId of activeModules) {
    const mod = MODULE_REGISTRY[modId];
    if (!mod) continue;
    const status = moduleProgress[modId];
    if (status && status !== "pending") continue;
    const hardDepsOk = mod.dependsOn.every((dep) => moduleProgress[dep] === "completed");
    if (hardDepsOk) ready.push(modId);
  }
  return ready;
}

function applyCoercionRules(projectType: string, modules: string[]): string[] {
  const result = new Set(modules);
  for (const [modId, mod] of Object.entries(MODULE_REGISTRY)) {
    if (mod.coercionRules) {
      const { requiredTypes, excludedTypes } = mod.coercionRules;
      if (requiredTypes.includes(projectType)) result.add(modId);
      if (excludedTypes && excludedTypes.includes(projectType)) result.delete(modId);
    }
  }
  result.add("tech-research");
  result.add("architecture");
  result.add("security-review");
  result.add("sprint-planning");
  return Array.from(result);
}

async function startModuleAsync(slug: string, moduleId: string, project: any): Promise<void> {
  const mod = MODULE_REGISTRY[moduleId];
  if (!mod) { log("error", "overwatch", "start-module", `Unknown module: ${moduleId}`); return; }
  log("info", "overwatch", "start-module", `Starting module ${mod.name} for ${slug}`);

  await pgQuery(
    `UPDATE pipeline_projects SET module_progress = COALESCE(module_progress, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE slug = $2`,
    [JSON.stringify({ [moduleId]: "in-progress" }), slug],
  );
  await pgQuery(
    `INSERT INTO pipeline_module_runs (project_id, module_id, status, started_at) VALUES ($1, $2, 'in_progress', NOW()) ON CONFLICT (project_id, module_id) DO UPDATE SET status = 'in_progress', started_at = NOW(), error = NULL`,
    [project.id, moduleId],
  );

  try {
    await runModulePipeline(slug, moduleId, project);
    await pgQuery(
      `UPDATE pipeline_projects SET module_progress = COALESCE(module_progress, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE slug = $2`,
      [JSON.stringify({ [moduleId]: "completed" }), slug],
    );
    await pgQuery(`UPDATE pipeline_module_runs SET status = 'complete', completed_at = NOW() WHERE project_id = $1 AND module_id = $2`, [project.id, moduleId]);
    log("info", "overwatch", "module-complete", `Module ${mod.name} completed for ${slug}`);

    // Generate module summary after completion (non-blocking)
    try {
      const repo = getRepoForModule(moduleId);
      const docs = await import("../utils/research-docs.js");
      const sectionDocs = await docs.readResearchDocs(slug, repo, moduleId);
      if (sectionDocs.length > 0) {
        const findings = sectionDocs.map(d => ({ section: d.meta.section || d.path, content: d.content }));
        await generateModuleSummary(slug, moduleId, findings);
        log("info", "overwatch", "module-summary", `Generated summary for ${moduleId} module of ${slug}`);
      }
    } catch (sumErr: any) {
      log("warn", "overwatch", "module-summary", `Summary generation failed (non-blocking): ${sumErr.message}`);
    }

    await mmPipelineUpdate(project.name, `Module "${mod.name}" completed`, "success");
    await advanceModule(slug, moduleId);
  } catch (err: any) {
    await pgQuery(
      `UPDATE pipeline_projects SET module_progress = COALESCE(module_progress, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE slug = $2`,
      [JSON.stringify({ [moduleId]: "failed" }), slug],
    );
    await pgQuery(`UPDATE pipeline_module_runs SET status = 'failed', completed_at = NOW(), error = $3 WHERE project_id = $1 AND module_id = $2`, [project.id, moduleId, err.message]);
    log("error", "overwatch", "module-failed", `Module ${mod.name} failed for ${slug}: ${err.message}`);
    await mmPipelineUpdate(project.name, `Module "${mod.name}" failed: ${err.message}`, "error");
  }
}

/**
 * Extract findings from a Dify API response wrapper.
 * Handles: raw API wrapper (data.outputs.result), markdown code blocks, plain JSON.
 */
function extractDifyFindings(difyResponse: any): any {
  let raw: any;
  if (typeof difyResponse === "string") {
    raw = difyResponse;
  } else {
    raw = difyResponse?.data?.outputs?.result
      || difyResponse?.outputs?.result
      || difyResponse?.data?.outputs
      || difyResponse;
  }
  const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);

  // Try to extract JSON from markdown code blocks
  const bt = String.fromCharCode(96);
  const startMarker = bt.repeat(3) + "json";
  const startIdx = rawStr.indexOf(startMarker);
  let jsonStr = rawStr;
  if (startIdx !== -1) {
    const afterStart = rawStr.indexOf(String.fromCharCode(10), startIdx);
    if (afterStart !== -1) {
      const endIdx = rawStr.indexOf(bt.repeat(3), afterStart + 1);
      if (endIdx !== -1) {
        jsonStr = rawStr.substring(afterStart + 1, endIdx).trim();
      }
    }
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    return { raw: rawStr };
  }
}

async function runModulePipeline(slug: string, moduleId: string, project: any): Promise<void> {
  const mod = MODULE_REGISTRY[moduleId];
  if (!mod) throw new Error(`Unknown module: ${moduleId}`);

  switch (moduleId) {
    case "tech-research":
      await runResearchPipeline({ id: project.id, slug, name: project.name, description: project.description });
      return;
    case "architecture": {
      const archRes = await pgQuery(`SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND findings IS NOT NULL AND status = 'complete'`, [project.id]);
      const researchFindings: Record<string, any> = {};
      for (const row of archRes.rows) researchFindings[row.section] = row.findings;
      const archResult = await callDify(DIFY_DEVTEAM_KEYS["architect-design"], {
        project_name: project.name,
        project_description: project.description || "",
        research_findings: JSON.stringify(researchFindings),
        requirements: JSON.stringify(project.tags || []),
      }, "architect-design");
      const archParsed = extractDifyFindings(archResult);
      await pgQuery(
        `INSERT INTO pipeline_research (project_id, section, status, findings, updated_at) VALUES ($1, $2, 'complete', $3, NOW()) ON CONFLICT (project_id, section) DO UPDATE SET status = 'complete', findings = $3, updated_at = NOW()`,
        [project.id, "architecture--architecture-design", JSON.stringify(archParsed)],
      );
      try {
        const mdContent = findingsToMarkdown("architecture-design", archParsed);
        const repo = getRepoForModule("architecture");
        const filePath = await writeResearchDoc(slug, repo, "architecture", "architecture-design", mdContent, {
          status: "complete", model: "dify/architect-design",
        });
        await pgQuery(
          `UPDATE pipeline_research SET file_path = $1, repo = $2 WHERE project_id = $3 AND section = $4`,
          [filePath, "dev-research", project.id, "architecture--architecture-design"],
        );
      } catch (fileErr: any) {
        log("warn", "overwatch", "file-write", `File write failed for architecture-design (non-blocking): ${fileErr.message}`);
      }
      return;
    }
    case "security-review": {
      // Prefer architecture design output; fall back to research findings
      const secArchRow = await pgQuery(
        `SELECT findings FROM pipeline_research WHERE project_id = $1 AND section IN ('architecture--architecture-design', 'architecture') AND findings IS NOT NULL ORDER BY CASE section WHEN 'architecture--architecture-design' THEN 0 ELSE 1 END LIMIT 1`,
        [project.id],
      );
      const archDesign = secArchRow.rows[0]?.findings ? JSON.stringify(secArchRow.rows[0].findings) : "No architecture design available";
      const secTechRow = await pgQuery(`SELECT findings FROM pipeline_research WHERE project_id = $1 AND section = 'libraries' AND findings IS NOT NULL`, [project.id]);
      const techStack = secTechRow.rows[0]?.findings ? JSON.stringify(secTechRow.rows[0].findings) : "";
      const secResult = await callDify(DIFY_DEVTEAM_KEYS["security-review"], {
        project_name: project.name,
        architecture_design: archDesign,
        tech_stack: techStack,
      }, "security-review");
      const secParsed = extractDifyFindings(secResult);
      await pgQuery(
        `INSERT INTO pipeline_research (project_id, section, status, findings, updated_at) VALUES ($1, $2, 'complete', $3, NOW()) ON CONFLICT (project_id, section) DO UPDATE SET status = 'complete', findings = $3, updated_at = NOW()`,
        [project.id, "security-review--security-assessment", JSON.stringify(secParsed)],
      );
      try {
        const mdContent = findingsToMarkdown("security-assessment", secParsed);
        const repo = getRepoForModule("security-review");
        const filePath = await writeResearchDoc(slug, repo, "security-review", "security-assessment", mdContent, {
          status: "complete", model: "dify/security-review",
        });
        await pgQuery(
          `UPDATE pipeline_research SET file_path = $1, repo = $2 WHERE project_id = $3 AND section = $4`,
          [filePath, "dev-research", project.id, "security-review--security-assessment"],
        );
      } catch (fileErr: any) {
        log("warn", "overwatch", "file-write", `File write failed for security-review (non-blocking): ${fileErr.message}`);
      }
      return;
    }
    case "war-room": {
      const warResult = await startAndRunWarRoom(project.id);
      const warSession = await pgQuery(`SELECT state FROM war_room_sessions WHERE id = $1`, [warResult.sessionId]);
      if (warSession.rows[0]?.state === "escalated") {
        throw new Error("War room escalated — topics need human review. Use resume_war_room after resolving.");
      }
      return;
    }
    case "sprint-planning": {
      const sowGenerated = await generateCompleteSow(project);
      await pgQuery(
        `INSERT INTO pipeline_research (project_id, section, status, findings, updated_at) VALUES ($1, $2, 'complete', $3, NOW()) ON CONFLICT (project_id, section) DO UPDATE SET status = 'complete', findings = $3, updated_at = NOW()`,
        [project.id, "sprint-planning--sow", JSON.stringify(sowGenerated)],
      );
      // Store SoW on the project record
      await pgQuery(
        `UPDATE pipeline_projects SET scope_of_work = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(sowGenerated), project.id],
      );
      try {
        const mdContent = findingsToMarkdown("statement-of-work", sowGenerated);
        const repo = getRepoForModule("sprint-planning");
        const filePath = await writeResearchDoc(slug, repo, "sprint-planning", "sow", mdContent, {
          status: "complete", model: "openrouter/claude-sonnet-4.5",
        });
        await pgQuery(
          `UPDATE pipeline_research SET file_path = $1, repo = $2 WHERE project_id = $3 AND section = $4`,
          [filePath, "dev-research", project.id, "sprint-planning--sow"],
        );
      } catch (fileErr: any) {
        log("warn", "overwatch", "file-write", `File write failed for sprint-planning/sow (non-blocking): ${fileErr.message}`);
      }
      return;
    }
  }

  if (!mod.difyKeys) { log("warn", "overwatch", "no-keys", `Module ${moduleId} has no Dify keys configured`); return; }

  const existingRes = await pgQuery(`SELECT section, findings FROM pipeline_research WHERE project_id = $1 AND findings IS NOT NULL`, [project.id]);
  const existingFindings: Record<string, any> = {};
  for (const row of existingRes.rows) existingFindings[row.section] = row.findings;

  for (const section of mod.sections) {
    const apiKey = mod.difyKeys[section];
    if (!apiKey) { log("warn", "overwatch", "skip-section", `No API key for ${moduleId}/${section}`); continue; }
    log("info", "overwatch", "section", `Running ${moduleId}/${section} for ${slug}`);

    try {
      const result = await callDify(apiKey, {
        project_name: project.name,
        project_description: project.description || "",
        existing_findings: JSON.stringify(existingFindings),
        user_preferences: JSON.stringify(project.tags || []),
        server_context: JSON.stringify({ slug, project_type: project.project_type, stage: project.stage, active_modules: project.active_modules }),
      }, `${moduleId}/${section}`);

      const parsed = extractDifyFindings(result);
      await pgQuery(
        `INSERT INTO pipeline_research (project_id, section, status, findings, updated_at) VALUES ($1, $2, 'complete', $3, NOW()) ON CONFLICT (project_id, section) DO UPDATE SET status = 'complete', findings = $3, updated_at = NOW()`,
        [project.id, `${moduleId}--${section}`, JSON.stringify(parsed)],
      );
      existingFindings[`${moduleId}--${section}`] = parsed;

      // Dual-write: persist as markdown in GitLab
      try {
        const mdContent = findingsToMarkdown(section, parsed);
        const repo = getRepoForModule(moduleId);
        const filePath = await writeResearchDoc(slug, repo, moduleId, section, mdContent, {
          status: "complete",
          model: `dify/${moduleId}-${section}`,
        });
        await pgQuery(
          `UPDATE pipeline_research SET file_path = $1, repo = $2 WHERE project_id = $3 AND section = $4`,
          [filePath, getRepoForModule(moduleId) === repo ? "dev-research" : "market-research", project.id, `${moduleId}--${section}`],
        );
      } catch (fileErr: any) {
        log("warn", "overwatch", "file-write", `File write failed for ${moduleId}/${section} (non-blocking): ${fileErr.message}`);
      }
    } catch (err: any) {
      log("error", "overwatch", "section-failed", `${moduleId}/${section} failed: ${err.message}`);
      await pgQuery(
        `INSERT INTO pipeline_research (project_id, section, status, findings, updated_at) VALUES ($1, $2, 'failed', $3, NOW()) ON CONFLICT (project_id, section) DO UPDATE SET status = 'failed', findings = $3, updated_at = NOW()`,
        [project.id, `${moduleId}--${section}`, JSON.stringify({ error: err.message })],
      );
    }
  }

  if (moduleId === "marketing-strategy" || moduleId === "market-viability") {
    await tryCompileMarketStrategyReport(slug, project);
  }
}

async function advanceModule(slug: string, completedModuleId: string): Promise<void> {
  const res = await pgQuery(`SELECT id, active_modules, module_progress, name, description, tags, project_type, stage FROM pipeline_projects WHERE slug = $1`, [slug]);
  if (res.rowCount === 0) return;
  const project = res.rows[0];
  const activeModules: string[] = project.active_modules || [];
  const moduleProgress: Record<string, string> = project.module_progress || {};

  const ready = getReadyModules(activeModules, moduleProgress);
  for (const modId of ready) {
    const mod = MODULE_REGISTRY[modId];
    if (!mod) continue;
    if (mod.hitlGate) {
      log("info", "overwatch", "hitl-gate", `Module ${mod.name} is ready but requires human approval`);
      await mmPipelineUpdate(project.name, `Module "${mod.name}" is ready — awaiting human approval`, "info");
      await pgQuery(
        `UPDATE pipeline_projects SET module_progress = COALESCE(module_progress, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE slug = $2`,
        [JSON.stringify({ [modId]: "awaiting-approval" }), slug],
      );
      continue;
    }
    await pgQuery(
      `UPDATE pipeline_projects SET module_progress = COALESCE(module_progress, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE slug = $2`,
      [JSON.stringify({ [modId]: "starting" }), slug],
    );
    startModuleAsync(slug, modId, project).catch((err) => log("error", "overwatch", "auto-start-failed", `Failed to auto-start ${modId}: ${err.message}`));
  }

  // Re-read module_progress for accurate stage derivation (concurrent modules may have updated it)
  const freshRes = await pgQuery(`SELECT module_progress FROM pipeline_projects WHERE slug = $1`, [slug]);
  const freshProgress: Record<string, string> = freshRes.rows[0]?.module_progress || {};
  await pgQuery(`UPDATE pipeline_projects SET stage = $1, updated_at = NOW() WHERE slug = $2`, [deriveStage(activeModules, freshProgress), slug]);
}

async function tryCompileMarketStrategyReport(slug: string, project: any): Promise<void> {
  const progress: Record<string, string> = project.module_progress || {};
  if (progress["market-viability"] !== "completed" || progress["marketing-strategy"] !== "completed") return;
  if (progress["report-compiler"] === "completed" || progress["report-compiler"] === "in-progress") return;
  const activeModules: string[] = project.active_modules || [];
  if (!activeModules.includes("report-compiler")) return;
  log("info", "overwatch", "report-compiler", `Auto-triggering report compilation for ${slug}`);
  startModuleAsync(slug, "report-compiler", project).catch((err) => log("error", "overwatch", "report-failed", `Report compilation failed: ${err.message}`));
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
      await mmPipelineUpdate(p.name, "New project created", "rocket");
      await mmQueueUpdate(p.name, "added", `Priority ${priority} — ${p.description?.slice(0, 60) || "no description"}`);

      return project;
    },
  },

  list_projects: {
    description: "List projects with optional filters. Returns summary with question counts. By default excludes abandoned/complete projects — pass status='abandoned' or status='complete' to see those.",
    params: {
      stage: "(optional) Filter by stage: queue|research|architecture|security_review|planning|active|completed|archived",
      status: "(optional) Filter by status: pending|in_progress|paused|abandoned|complete. Default: excludes abandoned and complete.",
      priority: "(optional) Filter by priority (1-5)",
      tag: "(optional) Filter by tag",
      include_all: "(optional) Set to true to include abandoned and complete projects",
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
      if (p.status) {
        sql += ` AND pp.status = $${idx++}`; params.push(p.status);
      } else if (!p.include_all) {
        sql += ` AND pp.status NOT IN ('abandoned', 'complete')`;
      }
      if (p.priority) { sql += ` AND pp.priority = $${idx++}`; params.push(p.priority); }
      if (p.tag) { sql += ` AND $${idx++} = ANY(pp.tags)`; params.push(p.tag); }
      sql += ` ORDER BY CASE pp.status WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 WHEN 'paused' THEN 3 WHEN 'complete' THEN 4 WHEN 'abandoned' THEN 5 END, pp.priority ASC, pp.created_at DESC LIMIT $${idx++}`;
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
      status: "(optional) Status: pending|in_progress|paused|abandoned|complete",
    },
    handler: async (p) => {
      const fields: string[] = [];
      const params: any[] = [];
      let idx = 1;

      const updatable = ["name", "description", "priority", "tags", "estimated_hours", "estimated_cost", "feasibility_score", "scope_of_work", "status"];
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
        // Generate project-level executive summary (non-blocking)
        generateProjectSummary(project.slug).catch((e: any) => {
          log("warn", "stage", "project-summary", `Project summary generation failed: ${e.message}`);
        });
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
          await mmError("stage", "orchestrator", `Dev-team orchestrator FAILED to trigger for ${p.slug} → ${nextStage}`, {
            slug: p.slug, stage: nextStage,
          });
        } else {
          log("info", "stage", "advance", `Dev-team orchestrator triggered OK for ${nextStage}`, { slug: p.slug, result: orchResult });
        }
      }

      await mmPipelineUpdate(project.name, `Stage: ${project.stage} \u2192 ${nextStage}`, "arrow_right");
      await mmQueueUpdate(project.name, "stage-changed", `${project.stage} \u2192 ${nextStage}`);

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
      await mmQueueUpdate(result.rows[0].name, "archived");
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
        await mmError("research", "pipeline", `Pipeline CRASHED for ${project.slug}: ${err.message}`, {
          slug: project.slug, error: err.message, stack: err.stack?.slice(0, 500),
        });
      });

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
    description: "Mark research done, generate Fortune 500 SoW, render PDF, deliver to Mattermost.",
    params: {
      slug: "Project slug",
      scope_of_work: "(optional) Compiled SOW as JSON object — if omitted, auto-generates via LLM",
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

      // Generate or use provided SoW
      let sowData: any;
      if (p.scope_of_work && typeof p.scope_of_work === "object" && Object.keys(p.scope_of_work).length > 0) {
        sowData = p.scope_of_work;
        log("info", "research", "complete", `Using provided SoW for ${project.slug}`);
      } else {
        log("info", "research", "complete", `Auto-generating SoW for ${project.slug}`);
        sowData = await generateCompleteSow(project);
      }

      // Store SOW and update timestamps
      await pgQuery(
        `UPDATE pipeline_projects SET scope_of_work = $1, research_completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(sowData), project.id]
      );

      // Generate and distribute SoW PDF
      try {
        const pdfBuffer = await renderSowPdf({
          project_name: project.name,
          project_slug: project.slug,
          scope_of_work: sowData,
          priority: project.priority,
        });
        const isoDate = new Date().toISOString().split("T")[0];
        await mmDeliverablePdf(
          { name: project.name, slug: project.slug },
          `SoW-${project.slug}-${isoDate}`,
          pdfBuffer,
          `Fortune 500 Statement of Work generated for **${project.name}**`
        );
      } catch (pdfErr: any) {
        log("warn", "research", "sow-pdf", `SoW PDF generation failed (non-blocking): ${pdfErr.message}`);
      }

      await pgQuery(
        `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
        [project.id, "research_completed", JSON.stringify({ sections_count: RESEARCH_SECTIONS.length })]
      );

      // Generate tech-research module summary from completed sections
      try {
        const researchRows = await pgQuery(
          `SELECT section, findings, concerns, recommendations FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
          [project.id]
        );
        const summaryFindings = researchRows.rows
          .filter((r: any) => r.findings)
          .map((r: any) => ({
            section: r.section,
            content: findingsToMarkdown(
              r.section,
              r.findings,
              r.concerns || [],
              r.recommendations || [],
            ),
          }));
        if (summaryFindings.length > 0) {
          await generateModuleSummary(project.slug, "tech-research", summaryFindings);
        }
      } catch (sumErr: any) {
        log("warn", "research", "complete-summary", `Summary generation failed (non-blocking): ${sumErr.message}`);
      }

      await mmPipelineUpdate(project.name, "Research pipeline complete. SOW ready.", "white_check_mark");

      return { ok: true, slug: p.slug, message: "Research completed and SOW stored" };
    },
  },

  // ── Questions (Async Q&A) ────────────────────────────────

  add_question: {
    description: "Post a question about a project. Sends Mattermost notification for async Q&A.",
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
      await mmNotify(
        `[${proj.rows[0].name}] ${p.question}`,
        `${(p.priority || "normal").toUpperCase()} Question`,
        priorityLevel,
        [priorityTag]
      );

      // Post to to-do channel for blocking/normal questions
      if (p.priority === "blocking") {
        await mmTodo(`Answer: ${p.question}`, proj.rows[0].name, "blocking");
      } else if (p.priority !== "nice-to-have") {
        await mmTodo(`Answer: ${p.question}`, proj.rows[0].name, "info");
      }

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

      await mmNotify(`Sprint ${p.sprint_number} started: ${result.rows[0].name}`, `${proj.rows[0].name}`, 3, ["runner"]);
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

      await mmNotify(`Sprint ${p.sprint_number} complete!`, `${proj.rows[0].name}`, 3, ["checkered_flag"]);
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

        callDify(apiKey, p.inputs || {}, p.workflow).then(async (difyResponse) => {
          const data = difyResponse?.data;
          if (!data || data.status !== "succeeded") {
            job.status = "failed";
            job.error = data?.error || "unknown error";
            job.completed_at = new Date().toISOString();
            await mmError("devteam", p.workflow, `Async job ${jobId} failed: ${job.error}`, { workflow: p.workflow });
          } else {
            job.status = "succeeded";
            job.result = data.outputs?.result || data.outputs;
            job.elapsed_time = data.elapsed_time;
            job.total_tokens = data.total_tokens;
            job.completed_at = new Date().toISOString();
            log("info", "devteam", p.workflow, `Async job ${jobId} succeeded`, { tokens: data.total_tokens, elapsed: data.elapsed_time });
            // Post deliverable to Mattermost
            const resultText = typeof job.result === "string" ? job.result : JSON.stringify(job.result, null, 2);
            const contentType = ["focused-research", "pm-generate-sow"].includes(p.workflow) ? (p.workflow === "pm-generate-sow" ? "sow" : "research") : "other";
            await mmDeliverable(p.inputs?.project_slug ? { name: p.inputs.project_name || p.workflow, slug: p.inputs.project_slug } : (p.inputs?.project_name || p.workflow), `${p.workflow} (job ${jobId})`, resultText, contentType);
            // Completion logged silently — no per-workflow ping

          }
        }).catch(async (e: any) => {
          job.status = "failed";
          job.error = e.message;
          job.completed_at = new Date().toISOString();
          await mmError("devteam", p.workflow, `Async job ${jobId} error: ${e.message}`, { workflow: p.workflow });
        });

        return { job_id: jobId, workflow: p.workflow, status: "running", message: "Workflow started in background. Poll with get_devteam_result." };
      }

      // Blocking mode (original behavior)
      const difyResponse = await callDify(apiKey, p.inputs || {}, p.workflow);
      const data = difyResponse?.data;
      if (!data || data.status !== "succeeded") {
        const errMsg = `Dify workflow ${p.workflow} failed: ${data?.error || "unknown error"}`;
        await mmError("devteam", p.workflow, errMsg, {
          workflow: p.workflow, status: data?.status, error: data?.error,
        });
        throw new Error(errMsg);
      }
      log("info", "devteam", p.workflow, `Workflow succeeded`, {
        tokens: data.total_tokens, elapsed: data.elapsed_time,
      });

      // Post deliverable for SoW and research workflows
      const outputResult = data.outputs?.result || data.outputs;
      if (["focused-research", "pm-generate-sow"].includes(p.workflow)) {
        const resultText = typeof outputResult === "string" ? outputResult : JSON.stringify(outputResult, null, 2);
        const cType = p.workflow === "pm-generate-sow" ? "sow" : "research";
        await mmDeliverable(p.inputs?.project_slug ? { name: p.inputs.project_name || p.workflow, slug: p.inputs.project_slug } : (p.inputs?.project_name || p.workflow), p.workflow, resultText, cType);
      }
      // Completion logged silently — no per-workflow ping
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

  run_sprint: {
    description: "Execute a sprint by launching an OpenHands coding session with detailed prompts from Dify. Auto-creates workspace/repos if needed. Monitors completion and submits for review.",
    params: {
      slug: "Project slug",
      sprint_number: "Sprint number to execute",
      feedback: "(optional) Feedback from a previous rejected attempt",
    },
    handler: async (p) => {
      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      const sprint = await pgQuery(
        `SELECT * FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2`,
        [project.id, p.sprint_number]
      );
      if (sprint.rowCount === 0) throw new Error(`Sprint ${p.sprint_number} not found for ${p.slug}`);

      // Fire-and-forget execution (runs in background)
      runSprintExecution(project, parseInt(p.sprint_number), p.feedback || undefined).catch(async (err) => {
        log("error", "run_sprint", "execute", `Sprint execution failed: ${err.message}`);
        await mmError("run_sprint", "execute", `Sprint ${p.sprint_number} failed for ${p.slug}: ${err.message}`, {});
      });

      return {
        ok: true,
        slug: p.slug,
        sprint_number: p.sprint_number,
        message: `Sprint ${p.sprint_number} execution launched in background. Monitor via Mattermost #pipeline-updates.`,
      };
    },
  },

  populate_sprints_from_sow: {
    description: "Parse the project's scope_of_work into individual sprint records in pipeline_sprints. Handles various SoW formats.",
    params: {
      slug: "Project slug",
    },
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
          await pgQuery(
            `INSERT INTO pipeline_sprints (project_id, sprint_number, name, description, tasks, estimated_hours, estimated_loc, complexity)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (project_id, sprint_number) DO UPDATE SET
               name = EXCLUDED.name, description = EXCLUDED.description, tasks = EXCLUDED.tasks,
               estimated_hours = EXCLUDED.estimated_hours, estimated_loc = EXCLUDED.estimated_loc, complexity = EXCLUDED.complexity`,
            [
              project.id, sprintNumber, name, s.description || null,
              tasks.length > 0 ? JSON.stringify(tasks) : null,
              s.estimated_hours || null, s.estimated_loc || null, s.complexity || null,
            ]
          );
          created.push({ sprint_number: sprintNumber, name, task_count: tasks.length });
        } catch (err: any) {
          log("warn", "sprints", "populate", `Failed to insert sprint ${sprintNumber}: ${err.message}`);
        }
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

  // ── Human-in-the-Loop Review System ─────────────────────────

  submit_for_review: {
    description: "Submit a deliverable for human review in Mattermost. Posts to #human-review with approve/reject instructions. Creates a pending review agent_task.",
    params: {
      slug: "Project slug",
      title: "Review title (e.g. 'Architecture Design v1')",
      content: "Content to review (markdown)",
      review_type: "Type: sow|architecture|security|research|other",
      sprint_number: "(optional) Associated sprint number",
    },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");
      if (!p.title) throw new Error("title is required");
      if (!p.content) throw new Error("content is required");
      if (!p.review_type) throw new Error("review_type is required");

      const proj = await pgQuery(`SELECT id, name FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);

      let sprintId = null;
      if (p.sprint_number) {
        const sprint = await pgQuery(
          `SELECT id FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2`,
          [proj.rows[0].id, p.sprint_number]
        );
        if (sprint.rowCount > 0) sprintId = sprint.rows[0].id;
      }

      const task = await pgQuery(
        `INSERT INTO agent_tasks (project_id, sprint_id, task_type, prompt, status)
         VALUES ($1, $2, 'review', $3, 'pending_review') RETURNING *`,
        [proj.rows[0].id, sprintId, `Review ${p.review_type}: ${p.title}`]
      );
      const taskId = task.rows[0].id;

      const maxContent = 12000;
      const displayContent = p.content.length > maxContent
        ? p.content.slice(0, maxContent) + "\n\n---\n*[Content truncated \u2014 full version in deliverables channel]*"
        : p.content;

      const reviewMsg =
        `### :eyes: Review Required: ${p.title}\n` +
        `**Project:** ${proj.rows[0].name} (\`${p.slug}\`)\n` +
        `**Type:** ${p.review_type} | **Task ID:** \`${taskId}\`\n\n` +
        `---\n\n${displayContent}\n\n---\n\n` +
        `:white_check_mark: \`/pipeline approve ${taskId}\`  |  ` +
        `:x: \`/pipeline reject ${taskId} <reason>\``;

      const postResult = await mmPostWithId("human-review", reviewMsg);
      const mmPostId = postResult?.id || null;

      await pgQuery(
        `UPDATE agent_tasks SET result = $1 WHERE id = $2`,
        [JSON.stringify({ mm_post_id: mmPostId, review_type: p.review_type, title: p.title, slug: p.slug }), taskId]
      );

      await mmDeliverable({ name: proj.rows[0].name, slug: p.slug }, p.title, p.content, p.review_type);
      log("info", "review", "submit", `Review submitted: task ${taskId} for ${p.slug}`, { review_type: p.review_type, title: p.title });
      await mmPipelineUpdate(proj.rows[0].name, `Review submitted: ${p.title} (task #${taskId})`, "eyes");
      await mmTodo(`Review: ${p.title} — \`/pipeline approve ${taskId}\``, proj.rows[0].name, "action-needed");

      return { task_id: taskId, status: "pending_review", mm_post_id: mmPostId };
    },
  },

  check_review: {
    description: "Check the status of a review task (pending_review, completed/approved, or failed/rejected).",
    params: { task_id: "Agent task ID to check" },
    handler: async (p) => {
      if (!p.task_id) throw new Error("task_id is required");

      const result = await pgQuery(
        `SELECT at.*, pp.slug, pp.name as project_name
         FROM agent_tasks at
         JOIN pipeline_projects pp ON pp.id = at.project_id
         WHERE at.id = $1 AND at.task_type = 'review'`,
        [p.task_id]
      );
      if (result.rowCount === 0) throw new Error(`Review task ${p.task_id} not found`);
      const task = result.rows[0];
      const meta = task.result || {};

      return {
        task_id: task.id,
        slug: task.slug,
        project: task.project_name,
        status: task.status,
        review_type: meta.review_type,
        title: meta.title,
        approved: meta.approved,
        reviewed_by: meta.reviewed_by,
        reviewed_at: meta.reviewed_at,
        rejection_reason: meta.rejection_reason,
        created_at: task.created_at,
        completed_at: task.completed_at,
      };
    },
  },

  list_pending_reviews: {
    description: "List all pending review tasks awaiting human approval.",
    params: {
      slug: "(optional) Filter by project slug",
    },
    handler: async (p) => {
      let sql = `SELECT at.*, pp.slug, pp.name as project_name
        FROM agent_tasks at
        JOIN pipeline_projects pp ON pp.id = at.project_id
        WHERE at.task_type = 'review' AND at.status = 'pending_review'`;
      const params: any[] = [];
      if (p.slug) {
        sql += ` AND pp.slug = $1`;
        params.push(p.slug);
      }
      sql += ` ORDER BY at.created_at ASC`;
      const result = await pgQuery(sql, params);
      return {
        pending_reviews: result.rows.map((r: any) => ({
          task_id: r.id,
          slug: r.slug,
          project: r.project_name,
          title: r.result?.title,
          review_type: r.result?.review_type,
          created_at: r.created_at,
        })),
        count: result.rowCount,
      };
    },
  },

  // ── Overwatch Module Tools ────────────────────────────────────────────────

  classify_project: {
    description: "Classify a project using Overwatch AI. Determines project_type, revenue_model, deliverable_type, and recommended modules.",
    params: { slug: "Project slug" },
    handler: async (p: Record<string, any>) => {
      const slug = p.slug;
      if (!slug) throw new Error("slug is required");
      const res = await pgQuery(`SELECT id, name, description, tags, project_type FROM pipeline_projects WHERE slug = $1`, [slug]);
      if (res.rowCount === 0) throw new Error(`Project not found: ${slug}`);
      const project = res.rows[0];
      if (project.overwatch_classification && project.overwatch_approved) return { status: "already_classified", project_type: project.project_type, message: "Project already classified and approved. Use start_module to manage modules." };

      let classification: any;
      if (DIFY_OVERWATCH_KEY) {
        try {
          const moduleDescriptions = Object.entries(MODULE_REGISTRY).map(([id, m]) => `${id}: ${m.name} (sections: ${m.sections.join(", ")})`).join("\n");
          const result = await callDify(DIFY_OVERWATCH_KEY, { project_name: project.name, project_description: project.description || "", tags: JSON.stringify(project.tags || []), module_descriptions: moduleDescriptions }, "overwatch-classify");
          // Extract classification from Dify response
          const raw = typeof result === "string" ? result : (result?.data?.outputs?.result || result?.outputs?.result || JSON.stringify(result));
          const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
          // Parse JSON from markdown code block if present
          const bt = String.fromCharCode(96);
          const startMarker = bt.repeat(3) + "json" + String.fromCharCode(10);
          const endMarker = String.fromCharCode(10) + bt.repeat(3);
          const startIdx = rawStr.indexOf(startMarker);
          let jsonStr = rawStr;
          if (startIdx !== -1) {
            const afterStart = startIdx + startMarker.length;
            const endIdx = rawStr.indexOf(endMarker, afterStart);
            if (endIdx !== -1) jsonStr = rawStr.substring(afterStart, endIdx);
          }
          classification = JSON.parse(jsonStr);
          // Normalize field names
          if (classification.active_modules && !classification.recommended_modules) {
            classification.recommended_modules = classification.active_modules;
          }
        } catch (err: any) {
          log("warn", "overwatch", "classify-fallback", `Dify classification failed, using heuristic: ${err.message}`);
        }
      }

      if (!classification) {
        const desc = (project.description || "").toLowerCase();
        const tags = (project.tags || []).map((t: string) => t.toLowerCase());
        const allText = `${desc} ${tags.join(" ")}`;
        let projectType = "personal-tool";
        if (allText.match(/market|sell|revenue|monetiz|saas|subscription|pricing/)) projectType = "market-product";
        else if (allText.match(/client|contract|freelance|agency|deliver/)) projectType = "client-work";
        else if (allText.match(/automat|workflow|pipeline|n8n|integrat|bot/)) projectType = "automation";
        else if (allText.match(/hybrid|platform|marketplace/)) projectType = "hybrid";
        let revenueModel = "none";
        if (projectType === "market-product") {
          if (allText.match(/subscri|saas|monthly|annual/)) revenueModel = "subscription";
          else if (allText.match(/one.?time|license|purchase/)) revenueModel = "one-time";
          else if (allText.match(/free|open.?source|oss/)) revenueModel = "freemium";
          else revenueModel = "tbd";
        }
        const baseModules = applyCoercionRules(projectType, ["tech-research", "architecture", "security-review", "sprint-planning"]);
        classification = { project_type: projectType, revenue_model: revenueModel, deliverable_type: projectType === "automation" ? "workflow" : "application", recommended_modules: baseModules, confidence_score: 0.6, reasoning: "Heuristic classification based on project description and tags" };
      }

      await pgQuery(`UPDATE pipeline_projects SET overwatch_classification = $1, updated_at = NOW() WHERE slug = $2`, [JSON.stringify(classification), slug]);
      await mmPipelineUpdate(project.name, `Overwatch classified as "${classification.project_type}" with ${(classification.recommended_modules || []).length} modules. Awaiting approval.`, "info");
      return { status: "classified", slug, classification, next_step: "Call approve_classification to confirm or override" };
    },
  },

  approve_classification: {
    description: "Approve (or override) an Overwatch classification. Activates modules and starts the pipeline.",
    params: { slug: "Project slug", override_type: "(optional) Override project_type", override_modules: "(optional) JSON array of module IDs", override_revenue: "(optional) Override revenue_model" },
    handler: async (p: Record<string, any>) => {
      const slug = p.slug;
      if (!slug) throw new Error("slug is required");
      const res = await pgQuery(`SELECT id, name, description, tags, overwatch_classification, overwatch_approved, active_modules, module_progress, project_type, stage FROM pipeline_projects WHERE slug = $1`, [slug]);
      if (res.rowCount === 0) throw new Error(`Project not found: ${slug}`);
      const project = res.rows[0];
      if (project.overwatch_approved) return { status: "already_approved", message: "Classification already approved. Use start_module to manually start additional modules." };
      const classification = project.overwatch_classification;
      if (!classification) return { status: "not_classified", message: "Run classify_project first." };

      const projectType = p.override_type || classification.project_type;
      const revenueModel = p.override_revenue || classification.revenue_model;
      const deliverableType = classification.deliverable_type;
      let modules: string[];
      if (p.override_modules) { modules = typeof p.override_modules === "string" ? JSON.parse(p.override_modules) : p.override_modules; }
      else { modules = classification.recommended_modules || []; }
      modules = applyCoercionRules(projectType, modules);

      const moduleProgress: Record<string, string> = {};
      for (const modId of modules) moduleProgress[modId] = "pending";

      await pgQuery(`UPDATE pipeline_projects SET project_type = $1, revenue_model = $2, deliverable_type = $3, active_modules = $4, module_progress = $5, overwatch_approved = true, stage = 'research', updated_at = NOW() WHERE slug = $6`,
        [projectType, revenueModel, deliverableType, JSON.stringify(modules), JSON.stringify(moduleProgress), slug]);

      const updated = (await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [slug])).rows[0];
      await mmPipelineUpdate(project.name, `Classification approved: ${projectType} with ${modules.length} modules. Starting pipeline.`, "success");

      const ready = getReadyModules(modules, moduleProgress);
      const started: string[] = [];
      for (const modId of ready) {
        const mod = MODULE_REGISTRY[modId];
        if (!mod) continue;
        if (mod.hitlGate) { moduleProgress[modId] = "awaiting-approval"; continue; }
        moduleProgress[modId] = "starting";
        started.push(modId);
        startModuleAsync(slug, modId, updated).catch((err) => log("error", "overwatch", "start-failed", `Failed to start ${modId}: ${err.message}`));
      }
      await pgQuery(`UPDATE pipeline_projects SET module_progress = $1, updated_at = NOW() WHERE slug = $2`, [JSON.stringify(moduleProgress), slug]);
      return { status: "approved", project_type: projectType, revenue_model: revenueModel, active_modules: modules, auto_started: started, awaiting_approval: Object.entries(moduleProgress).filter(([, s]) => s === "awaiting-approval").map(([k]) => k) };
    },
  },

  start_module: {
    description: "Manually start a module (for HitL-gated or re-invocable modules).",
    params: { slug: "Project slug", module_id: "Module ID to start" },
    handler: async (p: Record<string, any>) => {
      const { slug, module_id } = p;
      if (!slug || !module_id) throw new Error("slug and module_id are required");
      const mod = MODULE_REGISTRY[module_id];
      if (!mod) throw new Error(`Unknown module: ${module_id}. Available: ${Object.keys(MODULE_REGISTRY).join(", ")}`);
      const res = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [slug]);
      if (res.rowCount === 0) throw new Error(`Project not found: ${slug}`);
      const project = res.rows[0];
      const activeModules: string[] = project.active_modules || [];
      const moduleProgress: Record<string, string> = project.module_progress || {};
      if (!activeModules.includes(module_id)) return { status: "error", message: `Module ${module_id} is not in active_modules for this project` };
      const currentStatus = moduleProgress[module_id];
      if (currentStatus === "in-progress" || currentStatus === "starting") return { status: "error", message: `Module ${module_id} is already running` };
      if (currentStatus === "completed" && !mod.reInvocable) return { status: "error", message: `Module ${module_id} is completed and not re-invocable` };
      const depsOk = mod.dependsOn.every((dep) => moduleProgress[dep] === "completed");
      if (!depsOk) { const missing = mod.dependsOn.filter((dep) => moduleProgress[dep] !== "completed"); return { status: "blocked", message: `Dependencies not met: ${missing.join(", ")}` }; }

      moduleProgress[module_id] = "starting";
      await pgQuery(`UPDATE pipeline_projects SET module_progress = $1, updated_at = NOW() WHERE slug = $2`, [JSON.stringify(moduleProgress), slug]);
      startModuleAsync(slug, module_id, project).catch((err) => log("error", "overwatch", "manual-start-failed", `Failed to start ${module_id}: ${err.message}`));
      return { status: "started", module: module_id, name: mod.name, message: `Module ${mod.name} starting in background` };
    },
  },

  get_module_status: {
    description: "Get the full Overwatch module pipeline status for a project.",
    params: { slug: "Project slug" },
    handler: async (p: Record<string, any>) => {
      const slug = p.slug;
      if (!slug) throw new Error("slug is required");
      const res = await pgQuery(`SELECT id, name, slug, project_type, revenue_model, stage, active_modules, module_progress, overwatch_classification, overwatch_approved FROM pipeline_projects WHERE slug = $1`, [slug]);
      if (res.rowCount === 0) throw new Error(`Project not found: ${slug}`);
      const project = res.rows[0];
      const activeModules: string[] = project.active_modules || [];
      const moduleProgress: Record<string, string> = project.module_progress || {};
      const runsRes = await pgQuery(`SELECT module_id, status, started_at, completed_at, error FROM pipeline_module_runs WHERE project_id = $1 ORDER BY started_at`, [project.id]);
      const modules = activeModules.map((modId) => {
        const mod = MODULE_REGISTRY[modId];
        const run = runsRes.rows.find((r: any) => r.module_id === modId);
        return { id: modId, name: mod?.name || modId, status: moduleProgress[modId] || "unknown", sections: mod?.sections || [], depends_on: mod?.dependsOn || [], hitl_gate: mod?.hitlGate || false, re_invocable: mod?.reInvocable || false, started_at: run?.started_at, completed_at: run?.completed_at, error: run?.error };
      });
      const ready = getReadyModules(activeModules, moduleProgress);
      return {
        slug, project_type: project.project_type, stage: project.stage, overwatch_approved: project.overwatch_approved, modules,
        summary: { total: activeModules.length, completed: Object.values(moduleProgress).filter((s) => s === "completed").length, in_progress: Object.values(moduleProgress).filter((s) => s === "in-progress" || s === "starting").length, pending: Object.values(moduleProgress).filter((s) => s === "pending").length, failed: Object.values(moduleProgress).filter((s) => s === "failed").length, awaiting_approval: Object.values(moduleProgress).filter((s) => s === "awaiting-approval").length },
        ready_to_start: ready,
      };
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
    "agent tasks (create/list/update/run_devteam_workflow), human-in-the-loop reviews (submit_for_review/check_review/list_pending_reviews), async questions (add/answer/get_unanswered/get), " +
    "sprints (add/update/start/complete), artifacts (add/list), tracking (log_event/get_metrics/get_timeline), " +
    "and Overwatch modules (classify_project/approve_classification/start_module/get_module_status).",
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
        // Send notification for unexpected errors in critical tools
        const criticalTools = ["advance_stage", "start_research", "run_devteam_workflow", "create_agent_task"];
        if (criticalTools.includes(tool)) {
          await mmError("call", tool, `Tool ${tool} failed: ${error.message}`, {
            tool, params: Object.keys(params || {}),
          });
        }
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}


// ── Exported HitL Handler (called from Express webhook route in index.ts) ──

export async function handleReviewAction(
  action: string,
  taskIdStr: string,
  reason: string | undefined,
  reviewerName: string
): Promise<string> {
  if (action === "list") {
    const pending = await pgQuery(
      `SELECT at.id, at.prompt, at.created_at, pp.name as project_name
       FROM agent_tasks at
       JOIN pipeline_projects pp ON pp.id = at.project_id
       WHERE at.task_type = 'review' AND at.status = 'pending_review'
       ORDER BY at.created_at ASC`
    );
    if (pending.rowCount === 0) return "No pending reviews.";
    const reviewLines = pending.rows.map(
      (r: any) => `- **#${r.id}** ${r.project_name}: ${r.prompt} (${new Date(r.created_at).toLocaleDateString()})`
    );
    return `**Pending Reviews (${pending.rowCount}):**\n${reviewLines.join("\n")}`;
  }

  const taskId = parseInt(taskIdStr);
  if (isNaN(taskId)) {
    return "Invalid task ID. Usage: `/pipeline approve <task-id>` or `/pipeline reject <task-id> <reason>` or `/pipeline retry <task-id>` or `/pipeline list`";
  }

  const result = await pgQuery(
    `SELECT at.*, pp.slug, pp.name as project_name
     FROM agent_tasks at
     JOIN pipeline_projects pp ON pp.id = at.project_id
     WHERE at.id = $1 AND at.task_type = 'review'`,
    [taskId]
  );
  if (result.rowCount === 0) return `Review task #${taskId} not found.`;
  const task = result.rows[0];
  const existingResult = task.result || {};

  if (action === "approve") {
    if (task.status !== "pending_review") {
      return `Task #${taskId} is not pending review (current status: ${task.status}).`;
    }

    // Sprint-specific approval: promote code + merge
    if (existingResult.review_type === "sprint" && existingResult.slug) {
      const sprintRow = task.sprint_id
        ? (await pgQuery(`SELECT * FROM pipeline_sprints WHERE id = $1`, [task.sprint_id])).rows[0]
        : null;

      if (sprintRow) {
        const sandboxBranch = sprintRow.branch_name || `${existingResult.slug}/sprint-${sprintRow.sprint_number}`;
        const targetBranch = `sprint-${sprintRow.sprint_number}`;

        // For sprint 2+, compare from the previous sprint's sandbox branch (incremental diff)
        let promoteBaseBranch: string | undefined;
        if (sprintRow.sprint_number > 1) {
          const prevSprint = (await pgQuery(
            `SELECT branch_name FROM pipeline_sprints WHERE project_id = $1 AND sprint_number = $2 AND status = 'completed'`,
            [task.project_id, sprintRow.sprint_number - 1]
          )).rows[0];
          if (prevSprint?.branch_name) promoteBaseBranch = prevSprint.branch_name;
        }

        try {
          // 1. Promote code from sandbox to production repo
          const promoResult = await promoteCodeToProjectRepo(existingResult.slug, sandboxBranch, targetBranch, promoteBaseBranch);
          log("info", "review", "promote", promoResult.message);

          // 2. Merge sprint branch to main in production repo
          try {
            await mergeSprintDirect(existingResult.slug, targetBranch);
          } catch (mergeErr: any) {
            log("error", "review", "merge", `Merge failed: ${mergeErr.message}`);
            await mmPipelineUpdate(task.project_name, `Merge failed for sprint: ${mergeErr.message}. Resolve conflicts and retry.`, "x");
            return `:warning: Sprint approved but merge failed: ${mergeErr.message}`;
          }

          // 3. Mark sprint as completed
          await pgQuery(`UPDATE pipeline_sprints SET status = 'completed', completed_at = NOW() WHERE id = $1`, [sprintRow.id]);

          // Update project total actual_hours
          await pgQuery(
            `UPDATE pipeline_projects SET actual_hours = (SELECT COALESCE(SUM(actual_hours), 0) FROM pipeline_sprints WHERE project_id = $1), updated_at = NOW() WHERE id = $1`,
            [task.project_id]
          );

          await pgQuery(
            `INSERT INTO pipeline_events (project_id, event_type, details) VALUES ($1, $2, $3)`,
            [task.project_id, "sprint_completed", JSON.stringify({ sprint_number: sprintRow.sprint_number, branch: sandboxBranch })]
          );

          // Check if all sprints are completed -> project is done
          const remainingSprints = await pgQuery(
            `SELECT COUNT(*) as count FROM pipeline_sprints WHERE project_id = $1 AND status != 'completed'`,
            [task.project_id]
          );
          if (parseInt(remainingSprints.rows[0].count) === 0) {
            await mmQueueUpdate(task.project_name, "completed", "All sprints done!");
          }

        } catch (promoteErr: any) {
          log("error", "review", "promote", `Code promotion failed: ${promoteErr.message}`);
          await mmPipelineUpdate(task.project_name, `Promotion failed: ${promoteErr.message}`, "x");
          return `:warning: Sprint approved but promotion failed: ${promoteErr.message}`;
        }
      }
    }

    await pgQuery(
      `UPDATE agent_tasks SET status = 'completed', completed_at = NOW(),
       result = $1 WHERE id = $2`,
      [JSON.stringify({
        ...existingResult,
        approved: true,
        reviewed_by: reviewerName,
        reviewed_at: new Date().toISOString(),
      }), taskId]
    );

    if (existingResult.mm_post_id) {
      await mmUpdatePost(
        existingResult.mm_post_id,
        `### :white_check_mark: APPROVED: ${existingResult.title || "Review"}\n` +
        `**Project:** ${task.project_name} (\`${task.slug}\`)\n` +
        `**Approved by:** @${reviewerName}\n` +
        `**Task ID:** \`${taskId}\``
      );
    }

    await mmPipelineUpdate(
      task.project_name,
      `Review #${taskId} approved by @${reviewerName}: ${existingResult.title || ""}`,
      "white_check_mark"
    );

    log("info", "review", "approve", `Task ${taskId} approved by ${reviewerName}`, { slug: task.slug });
    return `:white_check_mark: Review #${taskId} approved! (${existingResult.title || task.prompt})`;

  } else if (action === "reject") {
    if (task.status !== "pending_review") {
      return `Task #${taskId} is not pending review (current status: ${task.status}).`;
    }
    if (!reason) {
      return "Please provide a rejection reason: \`/pipeline reject <task-id> <reason>\`";
    }

    await pgQuery(
      `UPDATE agent_tasks SET status = 'failed', completed_at = NOW(),
       result = $1 WHERE id = $2`,
      [JSON.stringify({
        ...existingResult,
        approved: false,
        reviewed_by: reviewerName,
        reviewed_at: new Date().toISOString(),
        rejection_reason: reason,
      }), taskId]
    );

    if (existingResult.mm_post_id) {
      await mmUpdatePost(
        existingResult.mm_post_id,
        `### :x: REJECTED: ${existingResult.title || "Review"}\n` +
        `**Project:** ${task.project_name} (\`${task.slug}\`)\n` +
        `**Rejected by:** @${reviewerName}\n` +
        `**Reason:** ${reason}\n` +
        `**Task ID:** \`${taskId}\``
      );
    }

    await mmPipelineUpdate(
      task.project_name,
      `Review #${taskId} rejected by @${reviewerName}: ${reason}`,
      "x"
    );

    log("info", "review", "reject", `Task ${taskId} rejected by ${reviewerName}: ${reason}`, { slug: task.slug });
    await mmTodo(`Fix rejection: ${reason} — \`/pipeline retry ${taskId}\``, task.project_name, "action-needed");
    return `:x: Review #${taskId} rejected. Reason: ${reason}`;

  } else if (action === "retry") {
    // Retry a rejected/failed review with feedback
    if (task.status !== "failed") {
      return `Can only retry failed/rejected reviews. Task #${taskId} status: ${task.status}`;
    }

    const reviewType = existingResult.review_type;
    const rejectionReason = existingResult.rejection_reason || reason || "No specific feedback";
    const feedbackMsg = reason ? `${rejectionReason}\n\nAdditional notes: ${reason}` : rejectionReason;

    if (reviewType === "sprint" && existingResult.slug) {
      const projData = (await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [existingResult.slug])).rows[0];
      if (!projData) return `Project ${existingResult.slug} not found.`;

      const sprint = task.sprint_id
        ? (await pgQuery(`SELECT * FROM pipeline_sprints WHERE id = $1`, [task.sprint_id])).rows[0]
        : null;

      if (sprint) {
        // Reset sprint to active and re-run with feedback
        await pgQuery(`UPDATE pipeline_sprints SET status = 'active' WHERE id = $1`, [sprint.id]);
        // Reset the review task
        await pgQuery(`UPDATE agent_tasks SET status = 'queued' WHERE id = $1`, [taskId]);

        // Fire-and-forget re-run
        runSprintExecution(projData, sprint.sprint_number, feedbackMsg).catch(async (err) => {
          log("error", "review", "retry", `Retry failed for sprint ${sprint.sprint_number}: ${err.message}`);
          await mmError("review", "retry", `Sprint retry failed: ${err.message}`, { slug: existingResult.slug });
        });

        await mmPipelineUpdate(task.project_name, `Retrying sprint ${sprint.sprint_number} with feedback from review`, "arrows_counterclockwise");
        return `:arrows_counterclockwise: Retrying sprint ${sprint.sprint_number} with feedback. New coding session starting...`;
      }
    }

    return `Retry not supported for review type: ${reviewType}. Only sprint reviews can be retried.`;

  } else {
    return `Unknown action: \`${action}\`. Available: \`approve\`, \`reject\`, \`retry\`, \`list\`.\n` +
      `Usage: \`/pipeline approve <task-id>\` or \`/pipeline reject <task-id> <reason>\` or \`/pipeline retry <task-id> [notes]\` or \`/pipeline list\``;
  }
}
