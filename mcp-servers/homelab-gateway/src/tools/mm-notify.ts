/**
 * Shared Mattermost notification helper.
 * Posts messages to specific channels via the n8n-bot token.
 * Import into any module that needs to send Mattermost notifications.
 */

import { ensureTodoSchema } from "./mm-slash.js";
import { pgQuery } from "../utils/postgres.js";
import { ncUploadFile, ncEnsureFolder, ncPublicUrl } from "./nextcloud.js";
import { uploadPdfToMattermost } from "./pdf-renderer.js";

const MM_URL = process.env.MATTERMOST_URL || "http://mattermost:8065";
const MM_BOT_TOKEN = process.env.MATTERMOST_BOT_TOKEN || "";

// Channel IDs — loaded from environment variables
export const MM_CHANNELS: Record<string, string> = {
  "pipeline-updates": process.env.MM_CHANNEL_PIPELINE_UPDATES || "",
  "human-review": process.env.MM_CHANNEL_HUMAN_REVIEW || "",
  "alerts": process.env.MM_CHANNEL_ALERTS || "",
  "dev-logs": process.env.MM_CHANNEL_DEV_LOGS || "",
  "deliverables": process.env.MM_CHANNEL_DELIVERABLES || "",
  "to-do": process.env.MM_CHANNEL_TODO || "",
  "queue": process.env.MM_CHANNEL_QUEUE || "",
};

export type MMChannel = "pipeline-updates" | "human-review" | "alerts" | "dev-logs" | "deliverables" | "to-do" | "queue";

/**
 * Post a message to a Mattermost channel via the bot.
 * Silently fails (logs error) so it never breaks the calling workflow.
 */
export async function mmPost(channel: MMChannel, message: string, props?: Record<string, any>): Promise<void> {
  if (!MM_BOT_TOKEN) return;
  try {
    const body: any = {
      channel_id: MM_CHANNELS[channel],
      message,
    };
    if (props) body.props = props;
    const res = await fetch(`${MM_URL}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MM_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[mm-notify] Post to ${channel} failed (${res.status}): ${await res.text()}`);
    }
  } catch (e: any) {
    console.error(`[mm-notify] Post to ${channel} error: ${e.message}`);
  }
}

/**
 * Post an error alert to the alerts channel with red formatting.
 */
export async function mmAlert(module: string, op: string, error: string, meta?: Record<string, any>): Promise<void> {
  const metaStr = meta ? "\n```json\n" + JSON.stringify(meta, null, 2) + "\n```" : "";
  await mmPost("alerts", `#### :rotating_light: Error in \`${module}.${op}\`\n${error}${metaStr}`);
}

/**
 * Post a pipeline update (stage change, research progress, etc.)
 */
export async function mmPipelineUpdate(project: string, message: string, emoji?: string): Promise<void> {
  const icon = emoji ? `:${emoji}: ` : "";
  await mmPost("pipeline-updates", `${icon}**${project}** — ${message}`);
}

/**
 * Post a deliverable (SoW, research output, etc.) to the deliverables channel.
 * Uploads to Nextcloud when a project slug is provided.
 */
export async function mmDeliverable(
  project: string | { name: string; slug: string },
  title: string,
  content: string,
  contentType?: "sow" | "research" | "other"
): Promise<void> {
  const projectName = typeof project === "string" ? project : project.name;
  const slug = typeof project === "object" ? project.slug : null;
  const typeLabel = contentType === "sow" ? ":page_facing_up: Scope of Work"
    : contentType === "research" ? ":mag: Research Results"
      : ":package: Deliverable";

  // Upload to Nextcloud when slug is available
  let ncLink = "";
  if (slug) {
    const folderPath = `/Deliverables/${slug}`;
    const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    const isoDate = new Date().toISOString().split("T")[0];
    const filename = `${safeName}-${isoDate}.md`;
    const ok = await ncEnsureFolder(folderPath);
    if (ok) {
      const result = await ncUploadFile(`${folderPath}/${filename}`, content, "text/markdown");
      if (result.success) {
        ncLink = `\n:file_folder: [View in Nextcloud](${ncPublicUrl(folderPath)})`;
      } else {
        console.error(`[mm-notify] Nextcloud upload failed: ${result.error}`);
      }
    }
  }

  // Mattermost max post size is ~16383 chars. Truncate if needed.
  const maxContent = 14000;
  const truncated = content.length > maxContent
    ? content.slice(0, maxContent) + "\n\n---\n*[Truncated \u2014 full content stored in Nextcloud]*"
    : content;
  await mmPost("deliverables", `### ${typeLabel}: ${title}\n**Project:** ${projectName}${ncLink}\n\n${truncated}`);
}

/**
 * Upload a PDF to Nextcloud and post to Mattermost #deliverables with file attachment.
 */
export async function mmDeliverablePdf(
  project: { name: string; slug: string },
  title: string,
  pdfBuffer: Buffer,
  message?: string
): Promise<void> {
  const folderPath = `/Deliverables/${project.slug}`;
  const filename = `${title}.pdf`;
  let ncLink = "";

  // Upload to Nextcloud
  const ok = await ncEnsureFolder(folderPath);
  if (ok) {
    const result = await ncUploadFile(`${folderPath}/${filename}`, pdfBuffer, "application/pdf");
    if (result.success) {
      ncLink = ` | [View in Nextcloud](${ncPublicUrl(folderPath)})`;
    } else {
      console.error(`[mm-notify] Nextcloud PDF upload failed: ${result.error}`);
    }
  }

  // Post to Mattermost with file attachment
  const channelId = MM_CHANNELS["deliverables"];
  const msg = (message || `PDF deliverable: **${title}**`) +
    `\n**Project:** ${project.name}${ncLink}`;
  if (channelId) {
    await uploadPdfToMattermost(channelId, filename, pdfBuffer, msg);
  } else {
    await mmPost("deliverables", msg);
  }
}

/**
 * Post a message and return the full post object (includes id, channel_id).
 * Used by HitL flow to track the review message.
 */
export async function mmPostWithId(channel: MMChannel, message: string, props?: Record<string, any>): Promise<any | null> {
  if (!MM_BOT_TOKEN) return null;
  try {
    const body: any = {
      channel_id: MM_CHANNELS[channel],
      message,
    };
    if (props) body.props = props;
    const res = await fetch(`${MM_URL}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MM_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[mm-notify] PostWithId to ${channel} failed (${res.status}): ${await res.text()}`);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    console.error(`[mm-notify] PostWithId to ${channel} error: ${e.message}`);
    return null;
  }
}

/**
 * Update (patch) an existing Mattermost post message.
 */
export async function mmUpdatePost(postId: string, message: string): Promise<void> {
  if (!MM_BOT_TOKEN) return;
  try {
    const res = await fetch(`${MM_URL}/api/v4/posts/${postId}/patch`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${MM_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`[mm-notify] Update post ${postId} failed (${res.status}): ${await res.text()}`);
    }
  } catch (e: any) {
    console.error(`[mm-notify] Update post ${postId} error: ${e.message}`);
  }
}



/**
 * Post a message to a specific Mattermost channel by ID (not by name).
 * Used by war-room for dynamically created channels.
 */
export async function mmPostToChannel(channelId: string, message: string, rootId?: string, props?: Record<string, any>): Promise<any | null> {
  if (!MM_BOT_TOKEN) return null;
  try {
    const body: any = { channel_id: channelId, message };
    if (rootId) body.root_id = rootId;
    if (props) body.props = props;
    const res = await fetch(`${MM_URL}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MM_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[mm-notify] PostToChannel ${channelId} failed (${res.status}): ${await res.text()}`);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    console.error(`[mm-notify] PostToChannel ${channelId} error: ${e.message}`);
    return null;
  }
}

/**
 * Get the Mattermost team ID (assumes a single team).
 */
export async function mmGetTeamId(): Promise<string> {
  if (!MM_BOT_TOKEN) throw new Error("MATTERMOST_BOT_TOKEN not configured");
  const res = await fetch(`${MM_URL}/api/v4/teams`, {
    headers: { Authorization: `Bearer ${MM_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to get teams: ${res.status}`);
  const teams = await res.json();
  if (!teams.length) throw new Error("No Mattermost teams found");
  return teams[0].id;
}

/**
 * Create a new Mattermost channel.
 */
export async function mmCreateChannel(
  teamId: string,
  name: string,
  displayName: string,
  purpose?: string
): Promise<any> {
  if (!MM_BOT_TOKEN) throw new Error("MATTERMOST_BOT_TOKEN not configured");
  const res = await fetch(`${MM_URL}/api/v4/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MM_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      team_id: teamId,
      name,
      display_name: displayName,
      purpose: purpose || "",
      type: "O", // public channel
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create channel '${name}': ${res.status} ${body}`);
  }
  return await res.json();
}

/**
 * Post a to-do item. Context should be brief (a few words).
 * Priority: blocking (red), action-needed (orange), info (blue)
 */
export async function mmTodo(
  item: string,
  context?: string,
  priority?: "blocking" | "action-needed" | "info"
): Promise<void> {
  const icon = priority === "blocking" ? ":red_circle:"
    : priority === "action-needed" ? ":large_orange_circle:"
    : ":large_blue_circle:";
  const ctxStr = context ? ` — *${context}*` : "";
  await mmPost("to-do", `${icon} ${item}${ctxStr}`);

  // Dual-write to DB for /todo slash command
  try {
    await ensureTodoSchema();
    await pgQuery(
      `INSERT INTO mm_todo_items (item, context, priority, source, project_name)
       VALUES ($1, $2, $3, 'system', $4)`,
      [item, context || null, priority || "info", context || null]
    );
  } catch (e: any) {
    console.error("[mm-notify] Todo DB write failed:", e.message);
  }
}

/**
 * Post a queue update. Shows project queue state changes.
 */
export async function mmQueueUpdate(
  project: string,
  action: "added" | "stage-changed" | "completed" | "archived" | "removed",
  details?: string
): Promise<void> {
  const icons: Record<string, string> = {
    "added": ":new:",
    "stage-changed": ":arrow_right:",
    "completed": ":white_check_mark:",
    "archived": ":file_cabinet:",
    "removed": ":wastebasket:",
  };
  const icon = icons[action] || ":pushpin:";
  const detailStr = details ? ` — ${details}` : "";
  await mmPost("queue", `${icon} **${project}** ${action}${detailStr}`);
}


// ── Shared notification helpers ─────────────────────────────────────
// Import these instead of defining local copies in each module.

export async function mmNotify(message: string, title?: string, _priority?: number, tags?: string[]): Promise<void> {
  const emoji = tags?.length ? `:${tags[0]}: ` : "";
  const titleStr = title ? `**${emoji}${title}**\n` : "";
  await mmPost("dev-logs", `${titleStr}${message}`);
}

export async function mmError(module: string, op: string, error: string, meta?: Record<string, any>): Promise<void> {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [ERROR] [${module}] [${op}] ${error}${meta ? " " + JSON.stringify(meta) : ""}`);
  await mmAlert(module, op, error, meta);
}

export async function mmWarn(module: string, op: string, message: string, meta?: Record<string, any>): Promise<void> {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] [WARN] [${module}] [${op}] ${message}${meta ? " " + JSON.stringify(meta) : ""}`);
  const metaStr = meta ? "\n```json\n" + JSON.stringify(meta, null, 2) + "\n```" : "";
  await mmPost("alerts", `#### :warning: Warning in \`${module}.${op}\`\n${message}${metaStr}`);
}

// ── Structured logger factory ───────────────────────────────────────

export function createLogger(module: string) {
  return function log(level: "info" | "warn" | "error", op: string, msg: string, meta?: Record<string, any>) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${module}] [${op}]`;
    const metaStr = meta ? " " + JSON.stringify(meta) : "";
    if (level === "error") console.error(`${prefix} ${msg}${metaStr}`);
    else if (level === "warn") console.warn(`${prefix} ${msg}${metaStr}`);
    else console.log(`${prefix} ${msg}${metaStr}`);
  };
}
