/**
 * PDF Renderer — Generates professional PDFs from structured data using Playwright.
 * Uses HTML templates + CSS for layout, rendered to PDF via headless Chromium.
 */

import { chromium, Browser } from "playwright";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const MM_URL = process.env.MATTERMOST_URL || "http://mattermost:8065";
const MM_BOT_TOKEN = process.env.MATTERMOST_BOT_TOKEN || "";

// ── Template Loading ────────────────────────────────────────

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");

async function loadTemplate(name: string): Promise<string> {
  return readFile(path.join(TEMPLATE_DIR, name), "utf-8");
}

// ── HTML Escaping ───────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function md2html(text: string): string {
  // Minimal markdown: **bold**, *italic*, `code`, bullet lists, newlines
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n/g, "<br>");
}

// ── SoW PDF Generation ──────────────────────────────────────

interface SowData {
  project_name: string;
  project_slug: string;
  description?: string;
  priority?: number;
  scope_of_work: any; // The SoW JSON object
  estimated_hours?: number;
}

export async function renderSowPdf(data: SowData): Promise<Buffer> {
  const [htmlTemplate, css] = await Promise.all([
    loadTemplate("sow.html"),
    loadTemplate("sow.css"),
  ]);

  const sow = typeof data.scope_of_work === "string"
    ? JSON.parse(data.scope_of_work)
    : data.scope_of_work;

  const generatedDate = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  // Build sections from SoW structure
  const sectionDefs = [
    { key: "executive_summary", title: "Executive Summary" },
    { key: "overview", title: "Project Overview" },
    { key: "objectives", title: "Objectives & Goals" },
    { key: "scope", title: "Scope Definition" },
    { key: "deliverables", title: "Deliverables" },
    { key: "architecture", title: "Technical Architecture" },
    { key: "tech_stack", title: "Technology Stack" },
    { key: "sprints", title: "Implementation Plan" },
    { key: "milestones", title: "Timeline & Milestones" },
    { key: "risks", title: "Risk Assessment" },
    { key: "acceptance_criteria", title: "Acceptance Criteria" },
    { key: "assumptions", title: "Assumptions & Dependencies" },
    { key: "constraints", title: "Constraints" },
    { key: "level_of_effort", title: "Level of Effort" },
  ];

  // Filter to sections that exist in the SoW
  const activeSections = sectionDefs.filter(s => sow[s.key] !== undefined && sow[s.key] !== null);

  // Build TOC
  const tocEntries = activeSections.map((s, i) => (
    `<div class="toc-entry"><span class="toc-num">${i + 1}.</span><span class="toc-title">${esc(s.title)}</span></div>`
  )).join("\n");

  // Build section HTML
  const sectionsHtml = activeSections.map((s, i) => {
    const num = i + 1;
    const content = sow[s.key];
    let bodyHtml = "";

    if (s.key === "executive_summary" && typeof content === "string") {
      bodyHtml = content.split("\n").filter(Boolean).map(p => `<p class="exec-summary">${md2html(esc(p))}</p>`).join("\n");
    } else if (s.key === "objectives" && Array.isArray(content)) {
      bodyHtml = renderObjectivesSection(content);
    } else if (s.key === "scope" && typeof content === "object") {
      bodyHtml = renderScopeSection(content);
    } else if (s.key === "deliverables" && Array.isArray(content)) {
      bodyHtml = renderDeliverablesSection(content);
    } else if (s.key === "sprints" && Array.isArray(content)) {
      bodyHtml = renderSprintSection(content);
    } else if (s.key === "milestones" && Array.isArray(content)) {
      bodyHtml = renderMilestonesSection(content);
    } else if (s.key === "risks" && Array.isArray(content)) {
      bodyHtml = renderRisksTable(content);
    } else if (s.key === "acceptance_criteria" && Array.isArray(content)) {
      bodyHtml = renderAcceptanceCriteriaSection(content);
    } else if (s.key === "level_of_effort" && typeof content === "object") {
      bodyHtml = renderLevelOfEffortSection(content);
    } else if (s.key === "tech_stack" && typeof content === "object" && !Array.isArray(content)) {
      bodyHtml = renderTechStack(content);
    } else if (Array.isArray(content)) {
      bodyHtml = "<ul>" + content.map((item: any) => {
        if (typeof item === "string") return `<li>${md2html(esc(item))}</li>`;
        if (typeof item === "object") return `<li>${md2html(esc(JSON.stringify(item)))}</li>`;
        return `<li>${esc(String(item))}</li>`;
      }).join("\n") + "</ul>";
    } else if (typeof content === "string") {
      bodyHtml = content.split("\n").map(line => `<p>${md2html(esc(line))}</p>`).join("\n");
    } else if (typeof content === "object") {
      bodyHtml = renderObjectAsTable(content);
    } else {
      bodyHtml = `<p>${esc(String(content))}</p>`;
    }

    return `<h2 class="section-title"><span class="section-num">${num}.</span>${esc(s.title)}</h2>\n${bodyHtml}`;
  }).join("\n\n");

  // Calculate sprint count and total hours
  const sprints = Array.isArray(sow.sprints) ? sow.sprints : [];
  const sprintCount = sprints.length;
  const totalHours = data.estimated_hours
    || sow.level_of_effort?.total_hours
    || sprints.reduce((sum: number, s: any) => sum + (s.estimated_hours || 0), 0)
    || "TBD";

  // Assemble final HTML
  let html = htmlTemplate
    .replace("{{CSS}}", css)
    .replace(/\{\{project_name\}\}/g, esc(data.project_name))
    .replace(/\{\{project_slug\}\}/g, esc(data.project_slug))
    .replace(/\{\{generated_date\}\}/g, generatedDate)
    .replace("{{sprint_count}}", String(sprintCount))
    .replace("{{total_hours}}", String(totalHours))
    .replace("{{priority}}", String(data.priority || "N/A"))
    .replace("{{version}}", "1.0")
    .replace("{{toc_entries}}", tocEntries)
    .replace("{{sections_html}}", sectionsHtml);

  // Render via Playwright
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "25mm", left: "18mm", right: "18mm" },
    });
    await page.close();
    return Buffer.from(pdfBuffer);
  } finally {
    if (browser) await browser.close();
  }
}

// ── Section Renderers ───────────────────────────────────────

function renderObjectivesSection(objectives: any[]): string {
  const rows = objectives.map((obj: any) =>
    `<tr><td>${esc(obj.objective || "")}</td><td>${esc(obj.success_metric || "")}</td><td>${esc(obj.target || "")}</td></tr>`
  ).join("\n");
  return `<table>
    <thead><tr><th>Objective</th><th>Success Metric</th><th>Target</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderScopeSection(scope: any): string {
  const inScope = Array.isArray(scope.in_scope) ? scope.in_scope : [];
  const outScope = Array.isArray(scope.out_of_scope) ? scope.out_of_scope : [];
  const inItems = inScope.map((item: string) =>
    `<li><span class="scope-icon scope-in">&#10003;</span> ${esc(item)}</li>`
  ).join("\n");
  const outItems = outScope.map((item: string) =>
    `<li><span class="scope-icon scope-out">&#10007;</span> ${esc(item)}</li>`
  ).join("\n");
  return `<div class="scope-grid">
    <div class="scope-col">
      <h3 class="scope-heading scope-heading-in">In Scope</h3>
      <ul class="scope-list">${inItems}</ul>
    </div>
    <div class="scope-col">
      <h3 class="scope-heading scope-heading-out">Out of Scope</h3>
      <ul class="scope-list">${outItems}</ul>
    </div>
  </div>`;
}

function renderDeliverablesSection(deliverables: any[]): string {
  const rows = deliverables.map((d: any) =>
    `<tr><td><strong>${esc(d.name || "")}</strong></td><td>${esc(d.description || "")}</td><td>${esc(d.acceptance_criteria || "")}</td><td>${d.sprint_delivery || ""}</td></tr>`
  ).join("\n");
  return `<table>
    <thead><tr><th>Deliverable</th><th>Description</th><th>Acceptance Criteria</th><th>Sprint</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderSprintSection(sprints: any[]): string {
  // Summary table at top
  const summaryRows = sprints.map((s: any, idx: number) => {
    const complexity = s.complexity || "medium";
    const badgeClass = `badge-${complexity}`;
    return `<tr>
      <td>${s.sprint_number || idx + 1}</td>
      <td>${esc(s.name || s.title || "")}</td>
      <td>${s.estimated_hours || ""}h</td>
      <td><span class="badge ${badgeClass}">${complexity}</span></td>
    </tr>`;
  }).join("\n");

  const summaryTable = `<table class="sprint-summary-table">
    <thead><tr><th>#</th><th>Sprint Name</th><th>Hours</th><th>Complexity</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>`;

  // Detailed cards
  const cards = sprints.map((sprint: any, idx: number) => {
    const complexity = sprint.complexity || "medium";
    const badgeClass = `badge-${complexity}`;
    const tasks = Array.isArray(sprint.tasks) ? sprint.tasks : [];
    const taskRows = tasks.map((task: any) => {
      const t = typeof task === "string" ? { task, estimated_hours: "", status: "pending" } : task;
      const deps = Array.isArray(t.dependencies) && t.dependencies.length > 0 ? t.dependencies.join(", ") : "";
      return `<tr><td>${esc(t.task || t.name || "")}</td><td>${t.estimated_hours || ""}</td><td>${t.status || "pending"}</td><td>${esc(deps)}</td></tr>`;
    }).join("\n");

    return `<div class="sprint-card">
      <div class="sprint-card-header">
        <h3>Sprint ${sprint.sprint_number || idx + 1}: ${esc(sprint.name || sprint.title || "")}</h3>
        <span class="badge ${badgeClass}">${complexity}</span>
      </div>
      <div class="sprint-card-body">
        ${sprint.description ? `<p>${md2html(esc(sprint.description))}</p>` : ""}
        ${sprint.estimated_hours ? `<p><strong>Estimated:</strong> ${sprint.estimated_hours}h</p>` : ""}
        ${taskRows ? `<table><thead><tr><th>Task</th><th>Hours</th><th>Status</th><th>Dependencies</th></tr></thead><tbody>${taskRows}</tbody></table>` : ""}
      </div>
    </div>`;
  }).join("\n");

  return summaryTable + "\n" + cards;
}

function renderMilestonesSection(milestones: any[]): string {
  const rows = milestones.map((m: any) => {
    const deliverableList = Array.isArray(m.deliverables) ? m.deliverables.join(", ") : String(m.deliverables || "");
    return `<tr><td><strong>${esc(m.name || "")}</strong></td><td>Sprint ${m.sprint || ""}</td><td>${esc(m.criteria || "")}</td><td>${esc(deliverableList)}</td></tr>`;
  }).join("\n");
  return `<table>
    <thead><tr><th>Milestone</th><th>Sprint</th><th>Criteria</th><th>Deliverables</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderRisksTable(risks: any[]): string {
  const rows = risks.map((risk: any) => {
    if (typeof risk === "string") return `<tr><td>${esc(risk)}</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>`;
    const severity = (risk.severity || risk.level || "medium").toLowerCase();
    const severityClass = `risk-${severity}`;
    return `<tr>
      <td>${esc(risk.risk || risk.description || "")}</td>
      <td>${esc(risk.likelihood || "-")}</td>
      <td>${esc(risk.impact || "-")}</td>
      <td class="${severityClass}">${severity.toUpperCase()}</td>
      <td>${esc(risk.mitigation || risk.action || "")}</td>
    </tr>`;
  }).join("\n");

  return `<table>
    <thead><tr><th>Risk</th><th>Likelihood</th><th>Impact</th><th>Severity</th><th>Mitigation</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderAcceptanceCriteriaSection(criteria: any[]): string {
  const rows = criteria.map((c: any) =>
    `<tr><td>${esc(c.criterion || "")}</td><td>${esc(c.measurement || "")}</td><td>${esc(c.target || "")}</td></tr>`
  ).join("\n");
  return `<table>
    <thead><tr><th>Criterion</th><th>Measurement</th><th>Target</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderLevelOfEffortSection(loe: any): string {
  const dist = loe.complexity_distribution || {};
  const distItems = Object.entries(dist).map(([level, count]) => {
    const badgeClass = `badge-${level}`;
    return `<div class="loe-dist-item"><span class="badge ${badgeClass}">${level}</span><span class="loe-dist-count">${count} sprint${Number(count) !== 1 ? "s" : ""}</span></div>`;
  }).join("\n");

  return `<div class="loe-stats-card">
    <div class="loe-stats-grid">
      <div class="loe-stat">
        <div class="loe-stat-value">${loe.total_hours || "TBD"}</div>
        <div class="loe-stat-label">Total Hours</div>
      </div>
      <div class="loe-stat">
        <div class="loe-stat-value">${loe.total_sprints || "TBD"}</div>
        <div class="loe-stat-label">Sprints</div>
      </div>
      <div class="loe-stat">
        <div class="loe-stat-value">${loe.duration_weeks || "TBD"}</div>
        <div class="loe-stat-label">Duration (weeks)</div>
      </div>
    </div>
    ${distItems ? `<div class="loe-distribution"><h3>Complexity Distribution</h3><div class="loe-dist-grid">${distItems}</div></div>` : ""}
  </div>`;
}

function renderTechStack(stack: Record<string, any>): string {
  const rows = Object.entries(stack).map(([category, items]) => {
    const value = Array.isArray(items) ? items.join(", ") : String(items);
    return `<tr><td><strong>${esc(category)}</strong></td><td>${esc(value)}</td></tr>`;
  }).join("\n");

  return `<table>
    <thead><tr><th>Category</th><th>Technologies</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderObjectAsTable(obj: Record<string, any>): string {
  const rows = Object.entries(obj).map(([key, value]) => {
    const displayValue = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `<tr><td><strong>${esc(key)}</strong></td><td>${md2html(esc(displayValue))}</td></tr>`;
  }).join("\n");

  return `<table><tbody>${rows}</tbody></table>`;
}

// ── Mattermost File Upload ──────────────────────────────────

export async function uploadPdfToMattermost(
  channelId: string,
  filename: string,
  pdfBuffer: Buffer,
  message: string
): Promise<any> {
  if (!MM_BOT_TOKEN) {
    console.warn("[pdf-renderer] No MM_BOT_TOKEN, skipping upload");
    return null;
  }

  try {
    // Step 1: Upload file
    const formData = new FormData();
    formData.append("files", new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }), filename);
    formData.append("channel_id", channelId);

    const uploadRes = await fetch(`${MM_URL}/api/v4/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MM_BOT_TOKEN}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      console.error(`[pdf-renderer] File upload failed (${uploadRes.status}): ${body}`);
      return null;
    }

    const uploadData = await uploadRes.json();
    const fileIds = uploadData.file_infos?.map((f: any) => f.id) || [];

    if (fileIds.length === 0) {
      console.error("[pdf-renderer] No file IDs returned from upload");
      return null;
    }

    // Step 2: Create post with file attachment
    const postRes = await fetch(`${MM_URL}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MM_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channelId,
        message,
        file_ids: fileIds,
      }),
    });

    if (!postRes.ok) {
      const body = await postRes.text();
      console.error(`[pdf-renderer] Post with file failed (${postRes.status}): ${body}`);
      return null;
    }

    return await postRes.json();
  } catch (e: any) {
    console.error(`[pdf-renderer] Upload error: ${e.message}`);
    return null;
  }
}
