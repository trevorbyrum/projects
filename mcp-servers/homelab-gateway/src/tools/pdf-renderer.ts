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

// -- Template Loading ---------------------------------------------------------

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");

async function loadTemplate(name: string): Promise<string> {
  return readFile(path.join(TEMPLATE_DIR, name), "utf-8");
}

// -- HTML Escaping ------------------------------------------------------------

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

// -- SoW PDF Generation -------------------------------------------------------

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
    { key: "overview", title: "Project Overview" },
    { key: "objectives", title: "Objectives" },
    { key: "scope", title: "Scope" },
    { key: "deliverables", title: "Deliverables" },
    { key: "tech_stack", title: "Technology Stack" },
    { key: "architecture", title: "Architecture" },
    { key: "sprints", title: "Sprint Plan" },
    { key: "milestones", title: "Milestones" },
    { key: "risks", title: "Risks & Mitigations" },
    { key: "acceptance_criteria", title: "Acceptance Criteria" },
    { key: "assumptions", title: "Assumptions" },
    { key: "constraints", title: "Constraints" },
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

    if (s.key === "sprints" && Array.isArray(content)) {
      bodyHtml = renderSprintSection(content);
    } else if (s.key === "risks" && Array.isArray(content)) {
      bodyHtml = renderRisksTable(content);
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

// -- Section Renderers --------------------------------------------------------

function renderSprintSection(sprints: any[]): string {
  return sprints.map((sprint: any, idx: number) => {
    const complexity = sprint.complexity || "medium";
    const badgeClass = `badge-${complexity}`;
    const tasks = Array.isArray(sprint.tasks) ? sprint.tasks : [];
    const taskRows = tasks.map((task: any) => {
      const t = typeof task === "string" ? { task, estimated_hours: "" } : task;
      return `<tr><td>${esc(t.task || t.name || "")}</td><td>${t.estimated_hours || ""}</td><td>${t.status || "pending"}</td></tr>`;
    }).join("\n");

    return `<div class="sprint-card">
      <div class="sprint-card-header">
        <h3>Sprint ${sprint.sprint_number || idx + 1}: ${esc(sprint.name || sprint.title || "")}</h3>
        <span class="badge ${badgeClass}">${complexity}</span>
      </div>
      <div class="sprint-card-body">
        ${sprint.description ? `<p>${md2html(esc(sprint.description))}</p>` : ""}
        ${sprint.estimated_hours ? `<p><strong>Estimated:</strong> ${sprint.estimated_hours}h</p>` : ""}
        ${taskRows ? `<table><thead><tr><th>Task</th><th>Hours</th><th>Status</th></tr></thead><tbody>${taskRows}</tbody></table>` : ""}
      </div>
    </div>`;
  }).join("\n");
}

function renderRisksTable(risks: any[]): string {
  const rows = risks.map((risk: any) => {
    if (typeof risk === "string") return `<tr><td>${esc(risk)}</td><td>-</td><td>-</td></tr>`;
    const level = (risk.severity || risk.level || "medium").toLowerCase();
    const levelClass = `risk-${level}`;
    return `<tr>
      <td>${esc(risk.risk || risk.description || "")}</td>
      <td class="${levelClass}">${level.toUpperCase()}</td>
      <td>${esc(risk.mitigation || risk.action || "")}</td>
    </tr>`;
  }).join("\n");

  return `<table>
    <thead><tr><th>Risk</th><th>Severity</th><th>Mitigation</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
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

// -- Mattermost File Upload ---------------------------------------------------

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
