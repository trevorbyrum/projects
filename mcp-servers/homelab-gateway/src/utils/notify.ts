// Shared Mattermost notification utility
// Replaces per-module ntfy implementations

const MATTERMOST_WEBHOOK_URL = process.env.MATTERMOST_WEBHOOK_URL || "";

const PRIORITY_EMOJI: Record<number, string> = {
  5: "\u{1F534}", // red circle - critical
  4: "\u{1F7E0}", // orange circle - high
  3: "\u{1F7E1}", // yellow circle - normal
  2: "\u{1F535}", // blue circle - low
  1: "\u26AA",    // white circle - minimal
};

export async function notify(message: string, title?: string, priority?: number, tags?: string[]): Promise<void> {
  if (!MATTERMOST_WEBHOOK_URL) return;

  try {
    const emoji = PRIORITY_EMOJI[priority || 3] || "";
    const tagStr = tags?.length ? ` \`${tags.join("` `")}\`` : "";
    const titleLine = title ? `**${emoji} ${title}**${tagStr}\n` : (emoji ? `${emoji} ` : "");
    const text = `${titleLine}${message}`;

    await fetch(MATTERMOST_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e: any) {
    console.error("Mattermost notification failed:", e.message);
  }
}

export async function notifyError(module: string, op: string, error: string, meta?: Record<string, any>): Promise<void> {
  const details = meta ? "\n```json\n" + JSON.stringify(meta, null, 2) + "\n```" : "";
  await notify(`\`[${module}/${op}]\` ${error}${details}`, `${module} Error`, 5, ["error"]);
}
