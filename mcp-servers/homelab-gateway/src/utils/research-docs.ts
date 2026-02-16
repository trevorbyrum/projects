/**
 * Research Document Store — writes research findings as markdown files to GitLab repos.
 * DB becomes an index (status, file_path); files are the persistent content store.
 *
 * Two repos:
 *   - homelab-projects/market-research (market-viability, marketing-strategy, report-compiler, product-launch)
 *   - homelab-projects/dev-research (everything else)
 */

import { gitlabFetch } from "../tools/workspaces.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// ── Repo Routing ──────────────────────────────────────────────

const GITLAB_MARKET_RESEARCH_REPO = process.env.GITLAB_MARKET_RESEARCH_REPO || "homelab-projects/market-research";
const GITLAB_DEV_RESEARCH_REPO = process.env.GITLAB_DEV_RESEARCH_REPO || "homelab-projects/dev-research";

const REPO_ROUTING: Record<string, "market-research" | "dev-research"> = {
  "market-viability": "market-research",
  "marketing-strategy": "market-research",
  "report-compiler": "market-research",
  "product-launch": "market-research",
};

export function getRepoForModule(moduleId: string): string {
  const repoKey = REPO_ROUTING[moduleId] || "dev-research";
  return repoKey === "market-research" ? GITLAB_MARKET_RESEARCH_REPO : GITLAB_DEV_RESEARCH_REPO;
}

function getRepoLabel(moduleId: string): "market-research" | "dev-research" {
  return REPO_ROUTING[moduleId] || "dev-research";
}

// ── Path Helpers ──────────────────────────────────────────────

export function buildFilePath(slug: string, module: string, section: string): string {
  return `${slug}/${module}/${section}.md`;
}

// ── YAML Frontmatter ──────────────────────────────────────────

export interface ResearchDocMeta {
  project: string;
  module: string;
  section: string;
  status?: string;
  confidence?: number;
  generated_at?: string;
  model?: string;
}

export function buildFrontmatter(meta: ResearchDocMeta): string {
  const lines = ["---"];
  lines.push(`project: ${meta.project}`);
  lines.push(`module: ${meta.module}`);
  lines.push(`section: ${meta.section}`);
  if (meta.status) lines.push(`status: ${meta.status}`);
  if (meta.confidence != null) lines.push(`confidence: ${meta.confidence}`);
  lines.push(`generated_at: "${meta.generated_at || new Date().toISOString()}"`);
  if (meta.model) lines.push(`model: ${meta.model}`);
  lines.push("---");
  return lines.join("\n");
}

export function parseFrontmatter(content: string): { meta: Record<string, string>; content: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
      meta[key] = val;
    }
  }
  return { meta, content: match[2].trim() };
}

// ── Logging ───────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", op: string, msg: string, meta?: Record<string, any>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [research-docs] [${op}]`;
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  if (level === "error") console.error(`${prefix} ${msg}${metaStr}`);
  else if (level === "warn") console.warn(`${prefix} ${msg}${metaStr}`);
  else console.log(`${prefix} ${msg}${metaStr}`);
}

// ── Write Operations ──────────────────────────────────────────

/**
 * Write a research document to GitLab. Uses PUT (update) first, falls back to POST (create).
 */
export async function writeResearchDoc(
  slug: string,
  repo: string,
  module: string,
  section: string,
  content: string,
  metadata: Partial<ResearchDocMeta> = {}
): Promise<string> {
  const filePath = buildFilePath(slug, module, section);
  const encodedRepo = encodeURIComponent(repo);
  const encodedPath = encodeURIComponent(filePath);

  const frontmatter = buildFrontmatter({
    project: slug,
    module,
    section,
    ...metadata,
  });
  const fullContent = `${frontmatter}\n\n${content}`;

  try {
    await gitlabFetch(`/api/v4/projects/${encodedRepo}/repository/files/${encodedPath}`, {
      method: "PUT",
      body: JSON.stringify({
        branch: "main",
        content: fullContent,
        commit_message: `Update research: ${slug}/${module}/${section}`,
      }),
    }, { quiet: true });
  } catch {
    try {
      await gitlabFetch(`/api/v4/projects/${encodedRepo}/repository/files/${encodedPath}`, {
        method: "POST",
        body: JSON.stringify({
          branch: "main",
          content: fullContent,
          commit_message: `Add research: ${slug}/${module}/${section}`,
        }),
      });
    } catch (e: any) {
      log("error", "write", `Failed to write ${filePath} to ${repo}: ${e.message}`);
      throw e;
    }
  }

  log("info", "write", `Wrote ${filePath} to ${repo} (${fullContent.length} chars)`);
  return filePath;
}

/**
 * Batch-write multiple research documents in a single commit.
 */
export async function writeResearchDocsBatch(
  slug: string,
  repo: string,
  docs: Array<{ module: string; section: string; content: string; metadata?: Partial<ResearchDocMeta> }>
): Promise<string[]> {
  const encodedRepo = encodeURIComponent(repo);
  const paths: string[] = [];

  const actions: any[] = [];
  for (const doc of docs) {
    const filePath = buildFilePath(slug, doc.module, doc.section);
    const frontmatter = buildFrontmatter({
      project: slug,
      module: doc.module,
      section: doc.section,
      ...doc.metadata,
    });
    const fullContent = `${frontmatter}\n\n${doc.content}`;

    let exists = false;
    try {
      await gitlabFetch(`/api/v4/projects/${encodedRepo}/repository/files/${encodeURIComponent(filePath)}?ref=main`);
      exists = true;
    } catch { /* doesn't exist */ }

    actions.push({
      action: exists ? "update" : "create",
      file_path: filePath,
      content: fullContent,
    });
    paths.push(filePath);
  }

  if (actions.length === 0) return [];

  await gitlabFetch(`/api/v4/projects/${encodedRepo}/repository/commits`, {
    method: "POST",
    body: JSON.stringify({
      branch: "main",
      commit_message: `Batch update research for ${slug} (${actions.length} files)`,
      actions,
    }),
  });

  log("info", "batch-write", `Wrote ${actions.length} files to ${repo} for ${slug}`);
  return paths;
}

// ── Read Operations ───────────────────────────────────────────

/**
 * Read a single research document from GitLab. Returns parsed content + frontmatter.
 */
export async function readResearchDoc(
  slug: string,
  repo: string,
  module: string,
  section: string
): Promise<{ content: string; meta: Record<string, string>; raw: string } | null> {
  const filePath = buildFilePath(slug, module, section);
  const encodedRepo = encodeURIComponent(repo);
  const encodedPath = encodeURIComponent(filePath);

  try {
    const raw = await gitlabFetch(
      `/api/v4/projects/${encodedRepo}/repository/files/${encodedPath}/raw?ref=main`
    );
    const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed = parseFrontmatter(rawStr);
    return { content: parsed.content, meta: parsed.meta, raw: rawStr };
  } catch {
    return null;
  }
}

/**
 * List and read all research docs for a project (optionally filtered by module).
 */
export async function readResearchDocs(
  slug: string,
  repo: string,
  module?: string
): Promise<Array<{ path: string; content: string; meta: Record<string, string> }>> {
  const encodedRepo = encodeURIComponent(repo);
  const treePath = module ? `${slug}/${module}` : slug;

  try {
    const tree = await gitlabFetch(
      `/api/v4/projects/${encodedRepo}/repository/tree?path=${encodeURIComponent(treePath)}&ref=main&recursive=true&per_page=100`
    );

    const results: Array<{ path: string; content: string; meta: Record<string, string> }> = [];
    const mdFiles = (tree as any[]).filter((f: any) => f.type === "blob" && f.name.endsWith(".md"));

    for (const file of mdFiles) {
      try {
        const raw = await gitlabFetch(
          `/api/v4/projects/${encodedRepo}/repository/files/${encodeURIComponent(file.path)}/raw?ref=main`
        );
        const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
        const parsed = parseFrontmatter(rawStr);
        results.push({ path: file.path, content: parsed.content, meta: parsed.meta });
      } catch {
        log("warn", "read-all", `Failed to read ${file.path}`);
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ── Summary Generation ────────────────────────────────────────

/**
 * Generate a module-level summary from individual section findings.
 * Writes to {slug}/{module}/_summary.md
 */
export async function generateModuleSummary(
  slug: string,
  module: string,
  findings: Array<{ section: string; content: string }>
): Promise<string | null> {
  if (!OPENROUTER_API_KEY) {
    log("warn", "summary", "OPENROUTER_API_KEY not set — skipping summary generation");
    return null;
  }

  const combined = findings
    .map(f => `## ${f.section}\n${f.content}`)
    .join("\n\n")
    .slice(0, 30000);

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        messages: [
          {
            role: "system",
            content: "Produce a concise executive summary of these research findings. Output clean markdown, 2-4 pages max. Focus on key decisions, risks, and recommendations. No preamble.",
          },
          {
            role: "user",
            content: `Research findings for the "${module}" module of project "${slug}":\n\n${combined}`,
          },
        ],
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      log("error", "summary", `OpenRouter returned ${response.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const result = await response.json();
    const summaryContent = result.choices?.[0]?.message?.content;
    if (!summaryContent) return null;

    const repo = getRepoForModule(module);
    await writeResearchDoc(slug, repo, module, "_summary", summaryContent, {
      status: "complete",
      model: "anthropic/claude-sonnet-4",
    });

    log("info", "summary", `Generated module summary for ${slug}/${module} (${summaryContent.length} chars)`);
    return summaryContent;
  } catch (e: any) {
    log("error", "summary", `Summary generation failed for ${slug}/${module}: ${e.message}`);
    return null;
  }
}

/**
 * Generate a project-level executive summary from all module summaries.
 * Writes to {slug}/_summary.md
 */
export async function generateProjectSummary(slug: string): Promise<string | null> {
  if (!OPENROUTER_API_KEY) {
    log("warn", "project-summary", "OPENROUTER_API_KEY not set — skipping");
    return null;
  }

  // Read summaries from both repos
  const devDocs = await readResearchDocs(slug, GITLAB_DEV_RESEARCH_REPO);
  const marketDocs = await readResearchDocs(slug, GITLAB_MARKET_RESEARCH_REPO);
  const allDocs = [...devDocs, ...marketDocs];

  const summaries = allDocs.filter(d => d.path.endsWith("_summary.md") && !d.path.endsWith(`${slug}/_summary.md`));
  if (summaries.length === 0) {
    log("warn", "project-summary", `No module summaries found for ${slug}`);
    return null;
  }

  const combined = summaries
    .map(s => `## ${s.meta.module || s.path}\n${s.content}`)
    .join("\n\n")
    .slice(0, 30000);

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        messages: [
          {
            role: "system",
            content: "Produce a concise project executive summary combining these module-level research summaries. Output clean markdown, 2-3 pages max. Cover: project viability, technical approach, key risks, and recommended next steps. No preamble.",
          },
          {
            role: "user",
            content: `Module summaries for project "${slug}":\n\n${combined}`,
          },
        ],
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      log("error", "project-summary", `OpenRouter returned ${response.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const result = await response.json();
    const summaryContent = result.choices?.[0]?.message?.content;
    if (!summaryContent) return null;

    // Write to dev-research (canonical location for project-level summary)
    const encodedRepo = encodeURIComponent(GITLAB_DEV_RESEARCH_REPO);
    const filePath = `${slug}/_summary.md`;
    const encodedPath = encodeURIComponent(filePath);

    const frontmatter = buildFrontmatter({
      project: slug,
      module: "project",
      section: "_summary",
      status: "complete",
      model: "anthropic/claude-sonnet-4",
    });
    const fullContent = `${frontmatter}\n\n${summaryContent}`;

    try {
      await gitlabFetch(`/api/v4/projects/${encodedRepo}/repository/files/${encodedPath}`, {
        method: "PUT",
        body: JSON.stringify({
          branch: "main",
          content: fullContent,
          commit_message: `Update project summary: ${slug}`,
        }),
      });
    } catch {
      await gitlabFetch(`/api/v4/projects/${encodedRepo}/repository/files/${encodedPath}`, {
        method: "POST",
        body: JSON.stringify({
          branch: "main",
          content: fullContent,
          commit_message: `Add project summary: ${slug}`,
        }),
      });
    }

    log("info", "project-summary", `Generated project summary for ${slug} (${summaryContent.length} chars)`);
    return summaryContent;
  } catch (e: any) {
    log("error", "project-summary", `Project summary generation failed for ${slug}: ${e.message}`);
    return null;
  }
}

// ── Helpers for Findings Conversion ───────────────────────────

/**
 * Convert JSON findings (from Dify research output) to readable markdown.
 */
export function findingsToMarkdown(
  section: string,
  findings: any,
  concerns?: string[],
  recommendations?: string[]
): string {
  const lines: string[] = [];
  lines.push(`# ${section.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())} Research\n`);

  if (typeof findings === "string") {
    lines.push(findings);
  } else if (findings?.raw) {
    lines.push(typeof findings.raw === "string" ? findings.raw : JSON.stringify(findings.raw, null, 2));
  } else if (findings) {
    lines.push(JSON.stringify(findings, null, 2));
  }

  if (concerns && concerns.length > 0) {
    lines.push("\n## Concerns\n");
    for (const c of concerns) lines.push(`- ${c}`);
  }

  if (recommendations && recommendations.length > 0) {
    lines.push("\n## Recommendations\n");
    for (const r of recommendations) lines.push(`- ${r}`);
  }

  return lines.join("\n");
}

