/**
 * Shared Mattermost notification helper.
 * Posts messages to specific channels via the n8n-bot token.
 * Import into any module that needs to send Mattermost notifications.
 */

const MM_URL = process.env.MATTERMOST_URL || "http://mattermost:8065";
const MM_BOT_TOKEN = process.env.MATTERMOST_BOT_TOKEN || "";

// Channel IDs — mapped by purpose
export const MM_CHANNELS = {
  "pipeline-updates": "your-channel-id-pipeline-updates",
  "human-review": "your-channel-id-human-review",
  "alerts": "your-channel-id-alerts",
  "dev-logs": "your-channel-id-dev-logs",
  "deliverables": "your-channel-id-deliverables",
  "to-do": "your-channel-id-to-do",
  "queue": "your-channel-id-queue",
} as const;

export type MMChannel = keyof typeof MM_CHANNELS;

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
 * Supports long content with optional collapse.
 */
export async function mmDeliverable(project: string, title: string, content: string, contentType?: "sow" | "research" | "other"): Promise<void> {
  const typeLabel = contentType === "sow" ? ":page_facing_up: Scope of Work"
    : contentType === "research" ? ":mag: Research Results"
      : ":package: Deliverable";
  // Mattermost max post size is ~16383 chars. Truncate if needed.
  const maxContent = 14000;
  const truncated = content.length > maxContent
    ? content.slice(0, maxContent) + "\n\n---\n*[Truncated — full content stored in project artifacts]*"
    : content;
  await mmPost("deliverables", `### ${typeLabel}: ${title}\n**Project:** ${project}\n\n${truncated}`);
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
export async function mmPostToChannel(channelId: string, message: string, rootId?: string): Promise<any | null> {
  if (!MM_BOT_TOKEN) return null;
  try {
    const body: any = { channel_id: channelId, message };
    if (rootId) body.root_id = rootId;
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
