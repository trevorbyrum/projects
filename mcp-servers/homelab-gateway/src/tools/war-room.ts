/**
 * War Room Orchestration — AI agent trio debates research + draft SoW
 * before finalization. PM Facilitator, Architect, Security Expert.
 * Uses Mattermost threaded channels for transparent discussion.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mmPostToChannel, mmCreateChannel, mmGetTeamId, mmPipelineUpdate, mmDeliverablePdf } from "./mm-notify.js";
import { renderSowPdf } from "./pdf-renderer.js";
import { pgQuery } from "../utils/postgres.js";
import { readResearchDoc, getRepoForModule } from "../utils/research-docs.js";
import { trackDify } from "../utils/langfuse.js";




const DIFY_API_BASE = process.env.DIFY_API_BASE || "http://dify-api:5001";

// Dify workflow keys for war room agents (to be created in Dify)
const WARROOM_DIFY_KEYS: Record<string, string> = {
  "pm-warroom-facilitate":     process.env.DIFY_PM_WARROOM_KEY || "",
  "architect-warroom-respond": process.env.DIFY_ARCHITECT_WARROOM_KEY || "",
  "security-warroom-respond":  process.env.DIFY_SECURITY_WARROOM_KEY || "",
};

// Agent identity overrides for Mattermost bot posts
const AGENT_PROPS = {
  pm: { override_username: "PM Facilitator" },
  architect: { override_username: "Architect" },
  security: { override_username: "Security Expert" },
  system: { override_username: "War Room" },
};



function log(level: "info" | "warn" | "error", op: string, msg: string, meta?: Record<string, any>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [war-room] [${op}]`;
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  if (level === "error") console.error(`${prefix} ${msg}${metaStr}`);
  else if (level === "warn") console.warn(`${prefix} ${msg}${metaStr}`);
  else console.log(`${prefix} ${msg}${metaStr}`);
}

// ── Dify Workflow Caller ────────────────────────────────────

async function callWarroomDify(workflow: string, inputs: Record<string, string>): Promise<any> {
  const lfStart = Date.now();
  const apiKey = WARROOM_DIFY_KEYS[workflow];
  if (!apiKey) throw new Error(`No Dify API key for war room workflow: ${workflow}. Set env var.`);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 5 min
  try {
    const res = await fetch(`${DIFY_API_BASE}/v1/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ inputs, response_mode: "blocking", user: "war-room" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Dify ${workflow} HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const result = await res.json();
    if (result?.data?.status !== "succeeded") {
      throw new Error(`Dify ${workflow} failed: ${result?.data?.error || "unknown"}`);
    }
    trackDify({
      workflow,
      inputs,
      output: result.data.outputs,
      tokens: result.data.total_tokens,
      cost: result.data.total_price,
      elapsed_ms: Date.now() - lfStart,
      status: result.data.status,
      tags: ["dify", "war-room"],
    });
    return result.data.outputs?.result || result.data.outputs;
  } finally {
    clearTimeout(timeout);
  }
}

// ── War Room State Machine ──────────────────────────────────

type WarRoomState = "setup" | "agenda_generated" | "discussing" | "escalated" | "completed";

interface AgendaTopic {
  topic: string;
  context: string;
  priority: "high" | "medium" | "low";
}

async function runWarRoom(sessionId: number): Promise<void> {
  const session = (await pgQuery(`SELECT * FROM war_room_sessions WHERE id = $1`, [sessionId])).rows[0];
  if (!session) throw new Error(`War room session ${sessionId} not found`);

  const project = (await pgQuery(`SELECT * FROM pipeline_projects WHERE id = $1`, [session.project_id])).rows[0];
  if (!project) throw new Error(`Project ${session.project_id} not found`);

  // Get research summary — prefer file-based summary, fall back to DB
  let researchSummary = "";
  try {
    const summaryDoc = await readResearchDoc(project.slug, getRepoForModule("tech-research"), "tech-research", "_summary");
    if (summaryDoc) researchSummary = summaryDoc.content;
  } catch { /* fall through to DB */ }

  if (!researchSummary) {
    const research = await pgQuery(
      `SELECT section, findings, concerns, recommendations FROM pipeline_research WHERE project_id = $1 AND status = 'complete'`,
      [project.id]
    );
    researchSummary = research.rows.map((r: any) => {
      const findings = typeof r.findings === "string" ? r.findings : JSON.stringify(r.findings);
      return `## ${r.section}\n${findings}\nConcerns: ${(r.concerns || []).join(", ")}\nRecommendations: ${(r.recommendations || []).join(", ")}`;
    }).join("\n\n");
  }

  const sowDraft = project.scope_of_work ? JSON.stringify(project.scope_of_work) : "No SoW draft yet";

  // Step 1: Generate agenda
  log("info", "agenda", `Generating agenda for ${project.slug}`);
  await updateState(sessionId, "agenda_generated");

  let agenda: AgendaTopic[];
  try {
    const agendaRaw = await callWarroomDify("pm-warroom-facilitate", {
      project_name: project.name,
      research_summary: researchSummary.slice(0, 8000),
      sow_draft: sowDraft.slice(0, 8000),
      action: "generate_agenda",
      topic: "",
      agent_responses: "",
    });
    agenda = typeof agendaRaw === "string" ? JSON.parse(agendaRaw) : agendaRaw;
    if (!Array.isArray(agenda)) agenda = (agenda as any).topics || (agenda as any).agenda || [];
  } catch (e: any) {
    log("error", "agenda", `Agenda generation failed: ${e.message}`);
    agenda = [
      { topic: "Architecture feasibility", context: "Review proposed architecture decisions", priority: "high" },
      { topic: "Security posture", context: "Evaluate security approach and risks", priority: "high" },
      { topic: "Estimate accuracy", context: "Review sprint estimates and complexity ratings", priority: "medium" },
      { topic: "Technical debt risks", context: "Identify potential shortcuts or technical debt", priority: "medium" },
      { topic: "Missing requirements", context: "Check for gaps in the SoW", priority: "medium" },
    ];
  }

  await pgQuery(`UPDATE war_room_sessions SET agenda = $1 WHERE id = $2`, [JSON.stringify(agenda), sessionId]);

  // Post agenda to channel
  await mmPostToChannel(session.channel_id,
    `### War Room Agenda — ${project.name}\n\n` +
    agenda.map((t: AgendaTopic, i: number) => `${i + 1}. **[${t.priority.toUpperCase()}]** ${t.topic}\n   _${t.context}_`).join("\n") +
    `\n\n---\n_${agenda.length} topics to discuss. Starting now..._`,
    undefined, AGENT_PROPS.system
  );

  // Step 2: Discuss each topic
  await updateState(sessionId, "discussing");
  const decisions: any[] = [];
  const escalations: any[] = [];

  for (let topicIdx = 0; topicIdx < agenda.length; topicIdx++) {
    const topic = agenda[topicIdx];
    await pgQuery(`UPDATE war_room_sessions SET current_topic_index = $1 WHERE id = $2`, [topicIdx, sessionId]);

    log("info", "topic", `Topic ${topicIdx + 1}/${agenda.length}: ${topic.topic}`, { slug: project.slug });

    // Post topic as thread root
    const topicPost = await mmPostToChannel(session.channel_id,
      `### Topic ${topicIdx + 1}: ${topic.topic}\n**Priority:** ${topic.priority}\n**Context:** ${topic.context}`,
      undefined, AGENT_PROPS.system
    );
    const threadId = topicPost?.id;

    let consensusReached = false;
    let round = 0;
    const MAX_ROUNDS = 2;
    let priorResponses = "";

    while (!consensusReached && round < MAX_ROUNDS) {
      round++;

      // Architect responds
      let architectResponse = "";
      try {
        architectResponse = await callWarroomDify("architect-warroom-respond", {
          project_name: project.name,
          topic: topic.topic,
          context: `${topic.context}\n\nResearch summary:\n${researchSummary.slice(0, 4000)}`,
          prior_responses: priorResponses,
        });
        if (typeof architectResponse === "object") architectResponse = JSON.stringify(architectResponse);
      } catch (e: any) {
        architectResponse = `[Architect agent error: ${e.message}]`;
      }
      await mmPostToChannel(session.channel_id,
        `**Round ${round}:**\n${architectResponse}`,
        threadId || undefined, AGENT_PROPS.architect
      );

      // Security responds
      let securityResponse = "";
      try {
        securityResponse = await callWarroomDify("security-warroom-respond", {
          project_name: project.name,
          topic: topic.topic,
          context: `${topic.context}\n\nResearch summary:\n${researchSummary.slice(0, 4000)}`,
          prior_responses: `Architect: ${architectResponse}\n${priorResponses}`,
        });
        if (typeof securityResponse === "object") securityResponse = JSON.stringify(securityResponse);
      } catch (e: any) {
        securityResponse = `[Security agent error: ${e.message}]`;
      }
      await mmPostToChannel(session.channel_id,
        `**Round ${round}:**\n${securityResponse}`,
        threadId || undefined, AGENT_PROPS.security
      );

      // PM synthesizes
      let pmSynthesis: any;
      try {
        const rawSynthesis = await callWarroomDify("pm-warroom-facilitate", {
          project_name: project.name,
          research_summary: researchSummary.slice(0, 4000),
          sow_draft: sowDraft.slice(0, 4000),
          action: round < MAX_ROUNDS ? "synthesize" : "synthesize",
          topic: topic.topic,
          agent_responses: `Architect: ${architectResponse}\n\nSecurity: ${securityResponse}`,
        });
        pmSynthesis = typeof rawSynthesis === "string" ? JSON.parse(rawSynthesis) : rawSynthesis;
      } catch (e: any) {
        pmSynthesis = { consensus: false, decision: `PM synthesis failed: ${e.message}`, action_items: [] };
      }

      const consensus = pmSynthesis.consensus === true || pmSynthesis.consensus === "true";
      const decision = pmSynthesis.decision || pmSynthesis.summary || String(pmSynthesis);
      const actionItems = pmSynthesis.action_items || [];

      await mmPostToChannel(session.channel_id,
        `**Round ${round}:**\n${decision}` +
        (actionItems.length > 0 ? `\n\n**Action items:**\n${actionItems.map((a: string) => `- ${a}`).join("\n")}` : "") +
        (consensus ? "\n\n:white_check_mark: **Consensus reached**" : round < MAX_ROUNDS ? "\n\n:arrows_counterclockwise: _Continuing discussion..._" : ""),
        threadId || undefined, AGENT_PROPS.pm
      );

      if (consensus) {
        consensusReached = true;
        decisions.push({ topic: topic.topic, decision, action_items: actionItems, rounds: round });
      } else {
        priorResponses += `\nRound ${round} - Architect: ${architectResponse}\nSecurity: ${securityResponse}\nPM: ${decision}`;
      }
    }

    // If no consensus after MAX_ROUNDS, escalate
    if (!consensusReached) {
      escalations.push({ topic: topic.topic, context: priorResponses, rounds: MAX_ROUNDS });
      decisions.push({ topic: topic.topic, decision: "ESCALATED — requires human review", escalated: true, rounds: MAX_ROUNDS });
      await mmPostToChannel(session.channel_id,
        `:warning: **Escalated to human review:** ${topic.topic}\n_No consensus after ${MAX_ROUNDS} rounds. Please review the thread above and provide direction._`,
        threadId || undefined, AGENT_PROPS.system
      );
    }
  }

  // Update session
  await pgQuery(
    `UPDATE war_room_sessions SET decisions = $1, escalations = $2 WHERE id = $3`,
    [JSON.stringify(decisions), JSON.stringify(escalations), sessionId]
  );

  // If there are escalations, pause for human input
  if (escalations.length > 0) {
    await updateState(sessionId, "escalated");
    await mmPostToChannel(session.channel_id,
      `### :pause_button: War Room Paused\n${escalations.length} topic(s) escalated for human review.\n` +
      `Use \`resume_war_room\` after resolving escalations to generate the revised SoW.`,
      undefined, AGENT_PROPS.system
    );
    await mmPipelineUpdate(project.name, `War room paused: ${escalations.length} escalation(s) need human review`, "warning");
    log("info", "escalation", `War room ${sessionId} paused with ${escalations.length} escalations`, { slug: project.slug });
    return;
  }

  // All topics resolved — generate revised SoW
  await finalizeWarRoom(sessionId);
}

async function finalizeWarRoom(sessionId: number): Promise<void> {
  const session = (await pgQuery(`SELECT * FROM war_room_sessions WHERE id = $1`, [sessionId])).rows[0];
  const project = (await pgQuery(`SELECT * FROM pipeline_projects WHERE id = $1`, [session.project_id])).rows[0];

  const decisions = session.decisions || [];
  const decisionsSummary = decisions.map((d: any, i: number) =>
    `${i + 1}. ${d.topic}: ${d.decision}${d.action_items?.length ? ` (Actions: ${d.action_items.join("; ")})` : ""}`
  ).join("\n");

  await mmPostToChannel(session.channel_id,
    `### Generating Revised SoW\nIncorporating ${decisions.length} decisions from war room deliberation...`,
    undefined, AGENT_PROPS.pm
  );

  // Call PM to generate revised SoW
  let revisedSow: any;
  try {
    const sowRaw = await callWarroomDify("pm-warroom-facilitate", {
      project_name: project.name,
      research_summary: "",
      sow_draft: project.scope_of_work ? JSON.stringify(project.scope_of_work) : "",
      action: "revise_sow",
      topic: "",
      agent_responses: decisionsSummary,
    });
    revisedSow = typeof sowRaw === "string" ? JSON.parse(sowRaw) : sowRaw;
  } catch (e: any) {
    log("error", "finalize", `Revised SoW generation failed: ${e.message}`);
    revisedSow = null;
  }

  if (revisedSow) {
    await pgQuery(`UPDATE war_room_sessions SET revised_sow = $1 WHERE id = $2`, [JSON.stringify(revisedSow), sessionId]);
    // Store revised SoW on project
    await pgQuery(`UPDATE pipeline_projects SET scope_of_work = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(revisedSow), project.id]);

    // Generate and distribute revised SoW PDF
    try {
      const pdfBuffer = await renderSowPdf({
        project_name: project.name,
        project_slug: project.slug,
        scope_of_work: revisedSow,
        priority: project.priority,
      });
      const isoDate = new Date().toISOString().split("T")[0];
      await mmDeliverablePdf(
        { name: project.name, slug: project.slug },
        `SoW-${project.slug}-revised-${isoDate}`,
        pdfBuffer,
        `Revised Statement of Work for **${project.name}** (War Room)`
      );
    } catch (pdfErr: any) {
      log("warn", "finalize", `Revised SoW PDF generation failed (non-blocking): ${pdfErr.message}`);
    }
  }

  await updateState(sessionId, "completed");
  await pgQuery(`UPDATE war_room_sessions SET completed_at = NOW() WHERE id = $1`, [sessionId]);

  const summary = `:white_check_mark: **War Room Complete**\n` +
    `**Decisions:** ${decisions.filter((d: any) => !d.escalated).length}\n` +
    `**Escalated:** ${decisions.filter((d: any) => d.escalated).length}\n` +
    `**Revised SoW:** ${revisedSow ? "Generated and stored" : "Failed — using original"}\n\n` +
    `The revised SoW has been submitted for HitL review.`;

  await mmPostToChannel(session.channel_id, summary, undefined, AGENT_PROPS.system);
  await mmPipelineUpdate(project.name, "War room completed. Revised SoW ready for review.", "white_check_mark");
  log("info", "finalize", `War room ${sessionId} completed for ${project.slug}`, {
    decisions: decisions.length, escalations: (session.escalations || []).length,
  });
}

async function updateState(sessionId: number, state: WarRoomState): Promise<void> {
  await pgQuery(`UPDATE war_room_sessions SET state = $1 WHERE id = $2`, [state, sessionId]);
}

// ── Sub-tools ───────────────────────────────────────────────

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  start_war_room: {
    description: "Start a war room session for a project. Creates a Mattermost channel, generates agenda from research + SoW, and runs the debate flow.",
    params: {
      slug: "Project slug (required)",
    },
    handler: async (p) => {
      if (!p.slug) throw new Error("slug is required");

      const proj = await pgQuery(`SELECT * FROM pipeline_projects WHERE slug = $1`, [p.slug]);
      if (proj.rowCount === 0) throw new Error(`Project '${p.slug}' not found`);
      const project = proj.rows[0];

      // Check for existing active war room
      const existing = await pgQuery(
        `SELECT id, state FROM war_room_sessions WHERE project_id = $1 AND state NOT IN ('completed')`,
        [project.id]
      );
      if (existing.rowCount > 0) {
        return { error: `Active war room already exists (id: ${existing.rows[0].id}, state: ${existing.rows[0].state}). Use resume_war_room or wait for completion.` };
      }

      // Create Mattermost channel
      const teamId = await mmGetTeamId();
      if (!teamId) throw new Error("Could not get Mattermost team ID");

      const channelName = `warroom-${p.slug}`.slice(0, 64);
      const channel = await mmCreateChannel(teamId, channelName, `War Room: ${project.name}`,
        `AI agent deliberation for ${project.name}`);
      if (!channel) throw new Error("Failed to create Mattermost channel");

      // Create session record
      const session = await pgQuery(
        `INSERT INTO war_room_sessions (project_id, channel_id, channel_name, state)
         VALUES ($1, $2, $3, 'setup') RETURNING *`,
        [project.id, channel.id, channelName]
      );
      const sessionId = session.rows[0].id;

      await mmPostToChannel(channel.id,
        `### War Room Initiated — ${project.name}\n` +
        `**Session ID:** ${sessionId}\n` +
        `**Agents:** PM Facilitator, Architect, Security Expert\n\n` +
        `Generating debate agenda from research findings and draft SoW...`,
        undefined, AGENT_PROPS.system
      );

      // Run war room in background
      runWarRoom(sessionId).catch(async (err) => {
        log("error", "run", `War room ${sessionId} crashed: ${err.message}`, { slug: p.slug });
        await updateState(sessionId, "escalated");
        await mmPostToChannel(channel.id,
          `:x: **War room error:** ${err.message}\nSession paused. Use \`resume_war_room\` to retry.`,
          undefined, AGENT_PROPS.system
        );
      });

      return {
        session_id: sessionId,
        channel_id: channel.id,
        channel_name: channelName,
        status: "started",
        message: "War room launched in background. Check the Mattermost channel for progress.",
      };
    },
  },

  get_war_room_status: {
    description: "Get the current state of a war room session: agenda, decisions, escalations.",
    params: {
      session_id: "(optional) War room session ID. If omitted, finds the latest for the given slug.",
      slug: "(optional) Project slug to find the latest session for.",
    },
    handler: async (p) => {
      let session;
      if (p.session_id) {
        const result = await pgQuery(`SELECT ws.*, pp.slug, pp.name as project_name FROM war_room_sessions ws JOIN pipeline_projects pp ON pp.id = ws.project_id WHERE ws.id = $1`, [p.session_id]);
        session = result.rows[0];
      } else if (p.slug) {
        const result = await pgQuery(
          `SELECT ws.*, pp.slug, pp.name as project_name FROM war_room_sessions ws JOIN pipeline_projects pp ON pp.id = ws.project_id WHERE pp.slug = $1 ORDER BY ws.created_at DESC LIMIT 1`,
          [p.slug]
        );
        session = result.rows[0];
      } else {
        throw new Error("Provide either session_id or slug");
      }

      if (!session) throw new Error("No war room session found");

      return {
        session_id: session.id,
        project: session.project_name,
        slug: session.slug,
        state: session.state,
        channel: session.channel_name,
        current_topic: session.current_topic_index,
        total_topics: (session.agenda || []).length,
        decisions: (session.decisions || []).length,
        escalations: (session.escalations || []).length,
        agenda: session.agenda,
        decisions_detail: session.decisions,
        escalations_detail: session.escalations,
        created_at: session.created_at,
        completed_at: session.completed_at,
      };
    },
  },

  resume_war_room: {
    description: "Resume a paused/escalated war room after human resolves escalations. Finalizes the session and generates revised SoW.",
    params: {
      session_id: "War room session ID (required)",
    },
    handler: async (p) => {
      if (!p.session_id) throw new Error("session_id is required");

      const result = await pgQuery(`SELECT * FROM war_room_sessions WHERE id = $1`, [p.session_id]);
      if (result.rowCount === 0) throw new Error(`Session ${p.session_id} not found`);
      const session = result.rows[0];

      if (session.state === "completed") {
        return { error: "Session already completed" };
      }

      // Finalize in background
      finalizeWarRoom(session.id).catch(async (err) => {
        log("error", "resume", `Finalize failed: ${err.message}`);
        await mmPostToChannel(session.channel_id, `:x: Finalization error: ${err.message}`, undefined, AGENT_PROPS.system);
      });

      return { session_id: session.id, status: "resuming", message: "Generating revised SoW from war room decisions..." };
    },
  },

  list_war_rooms: {
    description: "List all war room sessions, optionally filtered by state.",
    params: {
      state: "(optional) Filter: setup|agenda_generated|discussing|escalated|completed",
      slug: "(optional) Filter by project slug",
    },
    handler: async (p) => {
      let sql = `SELECT ws.id, ws.state, ws.channel_name, ws.current_topic_index, ws.created_at, ws.completed_at,
                   pp.slug, pp.name as project_name,
                   jsonb_array_length(COALESCE(ws.agenda, '[]'::jsonb)) as topic_count,
                   jsonb_array_length(COALESCE(ws.decisions, '[]'::jsonb)) as decision_count,
                   jsonb_array_length(COALESCE(ws.escalations, '[]'::jsonb)) as escalation_count
                 FROM war_room_sessions ws
                 JOIN pipeline_projects pp ON pp.id = ws.project_id WHERE 1=1`;
      const params: any[] = [];
      let idx = 1;
      if (p.state) { sql += ` AND ws.state = $${idx++}`; params.push(p.state); }
      if (p.slug) { sql += ` AND pp.slug = $${idx++}`; params.push(p.slug); }
      sql += ` ORDER BY ws.created_at DESC LIMIT 20`;

      const result = await pgQuery(sql, params);
      return { sessions: result.rows, count: result.rowCount };
    },
  },
};

// ── Registration ────────────────────────────────────────────


// Exported for use by projects.ts auto-pipeline
export async function startAndRunWarRoom(projectId: number): Promise<{ sessionId: number; revisedSow: any }> {
  const project = (await pgQuery(`SELECT * FROM pipeline_projects WHERE id = $1`, [projectId])).rows[0];
  if (!project) throw new Error(`Project ${projectId} not found`);

  const existing = await pgQuery(
    `SELECT id, state FROM war_room_sessions WHERE project_id = $1 AND state NOT IN ('completed')`,
    [project.id]
  );
  if (existing.rowCount > 0) {
    throw new Error(`Active war room exists (id: ${existing.rows[0].id}, state: ${existing.rows[0].state})`);
  }

  const teamId = await mmGetTeamId();
  if (!teamId) throw new Error('Could not get Mattermost team ID');

  const channelName = `warroom-${project.slug}`.slice(0, 64);
  const channel = await mmCreateChannel(teamId, channelName, `War Room: ${project.name}`,
    `AI agent deliberation for ${project.name}`);
  if (!channel) throw new Error('Failed to create Mattermost channel');

  const session = await pgQuery(
    `INSERT INTO war_room_sessions (project_id, channel_id, channel_name, state)
     VALUES ($1, $2, $3, 'setup') RETURNING *`,
    [project.id, channel.id, channelName]
  );
  const sessionId = session.rows[0].id;

  await mmPostToChannel(channel.id,
    `### War Room Initiated — ${project.name}
` +
    `**Session ID:** ${sessionId}
` +
    `**Agents:** PM Facilitator, Architect, Security Expert

` +
    `Generating debate agenda...`,
    undefined, AGENT_PROPS.system
  );

  // Run synchronously — blocks until all topics debated and SoW revised
  await runWarRoom(sessionId);

  const result = (await pgQuery(`SELECT * FROM war_room_sessions WHERE id = $1`, [sessionId])).rows[0];
  return { sessionId, revisedSow: result.revised_sow };
}

export function registerWarRoomTools(server: McpServer) {
  server.tool(
    "warroom_list",
    "List available War Room tools. War rooms are AI agent debate sessions (PM, Architect, Security) " +
    "that review research and draft SoW before finalization. Tools: start_war_room, get_war_room_status, " +
    "resume_war_room, list_war_rooms.",
    {},
    async () => {
      const toolList = Object.entries(tools).map(([name, def]) => ({
        tool: name, description: def.description, params: def.params,
      }));
      return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
    }
  );

  server.tool(
    "warroom_call",
    "Execute a War Room tool. Use warroom_list to see available tools.",
    {
      tool: z.string().describe("Tool name from warroom_list"),
      params: z.record(z.any()).optional().describe("Tool parameters"),
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
        log("error", tool, `Tool failed: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}

