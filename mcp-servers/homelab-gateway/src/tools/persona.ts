import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";
import { getEmbedding } from "../utils/embeddings.js";
import { searchPreferences } from "./preferences.js";
import { notify, notifyError } from "../utils/notify.js";

const { Pool } = pg;

// --- Config ---

const POSTGRES_HOST = process.env.POSTGRES_HOST || "pgvector-18";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || "5432");
const POSTGRES_USER = process.env.POSTGRES_USER || "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "";
const POSTGRES_DB = process.env.POSTGRES_DB || "";
const QDRANT_URL = process.env.QDRANT_URL || "http://Qdrant:6333";
const DIFY_API_BASE = process.env.DIFY_API_BASE || "http://dify-api:5001";
const DIFY_PERSONA_GENERATE_KEY = process.env.DIFY_PERSONA_GENERATE_KEY || "";
const DIFY_PERSONA_DIGEST_KEY = process.env.DIFY_PERSONA_DIGEST_KEY || "";

const PERSONA_COLLECTION = "persona-profile";
const VECTOR_SIZE = 384; // all-MiniLM-L6-v2

const CATEGORIES = [
  "technical_philosophy", "communication_style", "decision_making",
  "design_aesthetics", "work_productivity", "personality_values",
  "opinions_hot_takes", "creative_problem_solving", "interpersonal_leadership",
  "life_philosophy", "cognitive_patterns", "voice_and_tone",
] as const;

const CATEGORY_TARGETS: Record<string, number> = {
  technical_philosophy: 60, communication_style: 60, decision_making: 50,
  design_aesthetics: 40, work_productivity: 40, personality_values: 50,
  opinions_hot_takes: 50, creative_problem_solving: 40, interpersonal_leadership: 40,
  life_philosophy: 40, cognitive_patterns: 35, voice_and_tone: 55,
};

// --- PG Pool ---

let pool: pg.Pool | null = null;
let autoGenerateInProgress = false;

function getPool(): pg.Pool {
  if (!pool) {
    if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
      throw new Error("PostgreSQL not configured - check POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB");
    }
    pool = new Pool({
      host: POSTGRES_HOST, port: POSTGRES_PORT,
      user: POSTGRES_USER, password: POSTGRES_PASSWORD,
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

// --- Logging ---

function log(level: "info" | "warn" | "error", module: string, op: string, msg: string, meta?: Record<string, any>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [persona/${module}] [${op}]`;
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  if (level === "error") console.error(`${prefix} ${msg}${metaStr}`);
  else if (level === "warn") console.warn(`${prefix} ${msg}${metaStr}`);
  else console.log(`${prefix} ${msg}${metaStr}`);
}

const ntfyNotify = notify;

async function ntfyError(module: string, op: string, error: string, meta?: Record<string, any>) {
  log("error", module, op, error, meta);
  await notifyError(module, op, error, meta);
}

// --- Qdrant helpers ---

async function qdrantFetch(endpoint: string, options: RequestInit = {}) {
  const url = `${QDRANT_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Qdrant API error: ${JSON.stringify(data)}`);
  return data;
}

async function ensureCollection() {
  try {
    await qdrantFetch(`/collections/${PERSONA_COLLECTION}`);
  } catch {
    await qdrantFetch(`/collections/${PERSONA_COLLECTION}`, {
      method: "PUT",
      body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: "Cosine" } }),
    });
  }
}

// --- Dify caller ---

async function callDify(apiKey: string, inputs: Record<string, string>, workflowName?: string): Promise<any> {
  const startTime = Date.now();
  const label = workflowName || "persona-workflow";
  log("info", "dify", "call", `Calling workflow: ${label}`, { input_keys: Object.keys(inputs) });

  try {
    const res = await fetch(`${DIFY_API_BASE}/v1/workflows/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ inputs, response_mode: "blocking", user: "mcp-gateway" }),
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
      status: result?.data?.status, tokens: result?.data?.total_tokens, elapsed_ms: elapsed,
    });
    return result;
  } catch (e: any) {
    if (!e.message.includes("Dify workflow")) {
      const elapsed = Date.now() - startTime;
      await ntfyError("dify", label, `Workflow call failed: ${e.message}`, { elapsed_ms: elapsed });
    }
    throw e;
  }
}

// --- Preference cross-write ---

async function storeDevPreference(pref: { domain: string; topic: string; context: string; preference: string; tags?: string[] }): Promise<void> {
  try {
    const embeddingText = [pref.domain, pref.topic, pref.context, pref.preference].filter(Boolean).join(" ");
    const embedding = await getEmbedding(embeddingText);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await qdrantFetch(`/collections/dev-preferences/points`, {
      method: "PUT",
      body: JSON.stringify({
        points: [{
          id, vector: embedding,
          payload: {
            domain: pref.domain, topic: pref.topic, context: pref.context,
            preference: pref.preference, confidence: "high", source: "persona-digest",
            tags: pref.tags || [], created_at: now, updated_at: now,
          },
        }],
      }),
    });
    log("info", "crosswrite", "dev-pref", `Stored dev preference: ${pref.topic}`);
  } catch (e: any) {
    log("warn", "crosswrite", "dev-pref", `Failed to cross-write preference: ${e.message}`);
  }
}

// --- Digest pipeline ---

async function digestResponse(responseId: number): Promise<void> {
  const startTime = Date.now();
  log("info", "digest", "start", `Digesting response ${responseId}`);

  try {
    // Fetch question + response
    const resp = await pgQuery(
      `SELECT r.*, q.question, q.category, q.depth, q.question_technique, q.source_instrument, q.target_ocean_dims
       FROM persona_responses r JOIN persona_questions q ON r.question_id = q.id
       WHERE r.id = $1`, [responseId]
    );
    if (resp.rowCount === 0) throw new Error(`Response ${responseId} not found`);
    const row = resp.rows[0];

    // Fetch existing observations for contradiction detection
    const existing = await pgQuery(
      `SELECT observation, trait_type, confidence FROM persona_observations WHERE category = $1 ORDER BY created_at DESC LIMIT 20`,
      [row.category]
    );

    // Call Dify digest workflow
    const difyResult = await callDify(DIFY_PERSONA_DIGEST_KEY, {
      question: row.question,
      category: row.category,
      depth: row.depth,
      question_technique: row.question_technique || "direct",
      source_instrument: row.source_instrument || "",
      target_ocean_dims: JSON.stringify(row.target_ocean_dims || []),
      answer: row.answer_raw,
      existing_observations: JSON.stringify(existing.rows),
    }, "persona-digest-response");

    // Parse Dify output
    const outputText = difyResult?.data?.outputs?.result || difyResult?.data?.outputs?.text || "";
    let parsed: any;
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = outputText.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[1].trim() : outputText.trim());
    } catch (parseErr: any) {
      log("warn", "digest", "parse", `Failed to parse Dify output for response ${responseId}: ${parseErr.message}`);
      await ntfyError("digest", "parse", `Failed to parse digest output for response ${responseId}`, {
        error: parseErr.message, output_preview: outputText.slice(0, 300),
      });
      return;
    }

    // Insert training pairs
    const trainingPairs = parsed.training_pairs || [];
    for (const pair of trainingPairs) {
      await pgQuery(
        `INSERT INTO persona_training_pairs (response_id, format, instruction, input, output, conversations, category, quality_score, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [responseId, pair.format || "alpaca", pair.instruction || null, pair.input || null,
         pair.output, pair.conversations ? JSON.stringify(pair.conversations) : null,
         row.category, pair.quality_score || 5, pair.tags || []]
      );
    }

    // Insert observations
    const observations = parsed.observations || [];
    for (const obs of observations) {
      await pgQuery(
        `INSERT INTO persona_observations (response_id, category, trait_type, observation, confidence, evidence, ocean_dims, schwartz_values, comm_pattern, question_technique)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [responseId, row.category, obs.trait_type || "preference", obs.observation,
         obs.confidence || 0.7, obs.evidence || null,
         obs.ocean_dims ? JSON.stringify(obs.ocean_dims) : null,
         obs.schwartz_values || null, obs.comm_pattern || null,
         row.question_technique || "direct"]
      );
    }

    // Store profile entries in Qdrant
    await ensureCollection();
    const profileEntries = parsed.profile_entries || [];
    for (const entry of profileEntries) {
      const text = typeof entry === "string" ? entry : entry.content || entry.text || JSON.stringify(entry);
      const embedding = await getEmbedding(text);
      await qdrantFetch(`/collections/${PERSONA_COLLECTION}/points`, {
        method: "PUT",
        body: JSON.stringify({
          points: [{
            id: crypto.randomUUID(), vector: embedding,
            payload: {
              type: entry.type || "observation", category: row.category,
              content: text, evidence: entry.evidence || row.answer_raw.slice(0, 200),
              confidence: entry.confidence || 0.7,
              source_question_id: row.question_id, source_response_id: responseId,
              tags: entry.tags || [], created_at: new Date().toISOString(),
            },
          }],
        }),
      });
    }

    // Cross-write dev preferences
    const devPrefs = parsed.dev_preferences || [];
    for (const dp of devPrefs) {
      await storeDevPreference({
        domain: dp.domain || "general", topic: dp.topic || row.category,
        context: dp.context || row.question, preference: dp.preference || dp.text || dp.content,
        tags: dp.tags,
      });
    }

    // Mark response as digested (do this before non-critical follow-up inserts)
    await pgQuery(`UPDATE persona_responses SET digested = true WHERE id = $1`, [responseId]);

    // Update coverage
    await recalculateCoverage(row.category);

    // Update dimensional tracking
    await updateDimensions(parsed);

    // Insert follow-up questions (non-critical — don't let failures block digestion)
    const followUps = parsed.follow_ups || [];
    const validDepths = ["quick", "explain", "scenario"];
    const validModes = ["voice", "text", "media"];
    for (const fu of followUps) {
      try {
        const depth = validDepths.includes(fu.depth) ? fu.depth : "explain";
        const mode = validModes.includes(fu.mode) ? fu.mode : "voice";
        await pgQuery(
          `INSERT INTO persona_questions (batch_id, category, question, context, mode, depth, question_technique, priority)
           VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)`,
          [row.category, fu.question, fu.context || "Follow-up from digestion",
           mode, depth, fu.technique || "laddering", 8]
        );
      } catch (fuErr: any) {
        log("warn", "digest", "follow-up", `Failed to insert follow-up: ${fuErr.message}`);
      }
    }

    // Log event
    await pgQuery(
      `INSERT INTO persona_events (event_type, details) VALUES ($1, $2)`,
      ["response_digested", JSON.stringify({
        response_id: responseId, category: row.category,
        training_pairs: trainingPairs.length, observations: observations.length,
        profile_entries: profileEntries.length, dev_preferences: devPrefs.length,
        follow_ups: followUps.length, elapsed_ms: Date.now() - startTime,
      })]
    );

    log("info", "digest", "complete", `Response ${responseId} digested`, {
      training_pairs: trainingPairs.length, observations: observations.length,
      profile_entries: profileEntries.length, elapsed_ms: Date.now() - startTime,
    });
  } catch (e: any) {
    await ntfyError("digest", "response", `Digestion failed for response ${responseId}: ${e.message}`, {
      response_id: responseId, elapsed_ms: Date.now() - startTime,
    });
  }
}

async function recalculateCoverage(category: string): Promise<void> {
  try {
    const [asked, answered, depths, obsCount, pairCount] = await Promise.all([
      pgQuery(`SELECT COUNT(*) as cnt FROM persona_questions WHERE category = $1 AND status IN ('asked', 'answered')`, [category]),
      pgQuery(`SELECT COUNT(*) as cnt FROM persona_questions WHERE category = $1 AND status = 'answered'`, [category]),
      pgQuery(
        `SELECT depth, COUNT(*) as cnt FROM persona_questions WHERE category = $1 AND status = 'answered' GROUP BY depth`,
        [category]
      ),
      pgQuery(`SELECT COUNT(*) as cnt FROM persona_observations WHERE category = $1`, [category]),
      pgQuery(`SELECT COUNT(*) as cnt FROM persona_training_pairs WHERE category = $1`, [category]),
    ]);

    const answeredCount = parseInt(answered.rows[0]?.cnt || "0");
    const target = CATEGORY_TARGETS[category] || 40;
    const depthMap: Record<string, number> = {};
    for (const d of depths.rows) depthMap[d.depth] = parseInt(d.cnt);
    const dQuick = depthMap["quick"] || 0;
    const dExplain = depthMap["explain"] || 0;
    const dScenario = depthMap["scenario"] || 0;
    const totalDepth = dQuick + dExplain + dScenario;

    // Depth variety: how close to ideal 30/40/30 distribution
    let depthVariety = 0;
    if (totalDepth > 0) {
      const idealQ = 0.3, idealE = 0.4, idealS = 0.3;
      const actualQ = dQuick / totalDepth, actualE = dExplain / totalDepth, actualS = dScenario / totalDepth;
      depthVariety = 1 - (Math.abs(idealQ - actualQ) + Math.abs(idealE - actualE) + Math.abs(idealS - actualS)) / 2;
    }

    const obsTarget = target * 2; // expect ~2 observations per question
    const recency = 1.0; // TODO: decay based on last_question_at

    const coverageScore = 0.3 * Math.min(1, answeredCount / target) +
      0.2 * depthVariety +
      0.3 * Math.min(1, parseInt(obsCount.rows[0]?.cnt || "0") / obsTarget) +
      0.2 * recency;

    await pgQuery(
      `UPDATE persona_coverage SET
         questions_asked = $1, questions_answered = $2,
         depth_quick = $3, depth_explain = $4, depth_scenario = $5,
         observation_count = $6, training_pair_count = $7,
         coverage_score = $8, last_question_at = NOW(), updated_at = NOW()
       WHERE category = $9`,
      [parseInt(asked.rows[0]?.cnt || "0"), answeredCount,
       dQuick, dExplain, dScenario,
       parseInt(obsCount.rows[0]?.cnt || "0"), parseInt(pairCount.rows[0]?.cnt || "0"),
       coverageScore, category]
    );
  } catch (e: any) {
    log("warn", "coverage", "recalculate", `Failed to update coverage for ${category}: ${e.message}`);
  }
}

async function updateDimensions(parsed: any): Promise<void> {
  try {
    // Update OCEAN dimensions from observations
    const observations = parsed.observations || [];
    for (const obs of observations) {
      if (obs.ocean_dims && typeof obs.ocean_dims === "object") {
        for (const [dim, _score] of Object.entries(obs.ocean_dims)) {
          await pgQuery(
            `UPDATE persona_dimensions SET
               observation_count = observation_count + 1,
               avg_confidence = (avg_confidence * observation_count + $1) / (observation_count + 1),
               last_updated = NOW()
             WHERE dimension_type = 'ocean' AND dimension_name = $2`,
            [obs.confidence || 0.7, dim]
          );
        }
      }
      // Update Schwartz values
      if (obs.schwartz_values && Array.isArray(obs.schwartz_values)) {
        for (const val of obs.schwartz_values) {
          await pgQuery(
            `UPDATE persona_dimensions SET
               observation_count = observation_count + 1,
               avg_confidence = (avg_confidence * observation_count + $1) / (observation_count + 1),
               last_updated = NOW()
             WHERE dimension_type = 'schwartz' AND dimension_name = $2`,
            [obs.confidence || 0.7, val]
          );
        }
      }
    }

    // Recalculate coverage scores for dimensions
    const totalObs = await pgQuery(`SELECT COUNT(*) as cnt FROM persona_observations`);
    const total = parseInt(totalObs.rows[0]?.cnt || "1");
    await pgQuery(
      `UPDATE persona_dimensions SET coverage_score = LEAST(1.0, observation_count::real / GREATEST(1, $1::real * 0.1))
       WHERE dimension_type IN ('ocean', 'schwartz')`,
      [total]
    );
  } catch (e: any) {
    log("warn", "dimensions", "update", `Failed to update dimensions: ${e.message}`);
  }
}

// --- Auto-generate ---

async function checkAndAutoGenerate(): Promise<void> {
  if (autoGenerateInProgress) return;
  if (!DIFY_PERSONA_GENERATE_KEY) return;

  try {
    const result = await pgQuery(
      `SELECT COUNT(*) as cnt FROM persona_questions WHERE status = 'pending'`
    );
    const pendingCount = parseInt(result.rows[0].cnt);
    if (pendingCount > 5) return;

    autoGenerateInProgress = true;
    log("info", "auto-generate", "trigger", `Pending questions at ${pendingCount} — auto-generating batch`);

    await pgQuery(
      `INSERT INTO persona_events (event_type, details) VALUES ($1, $2)`,
      ["auto_generate_triggered", JSON.stringify({ pending_count: pendingCount, threshold: 5 })]
    );

    await tools.generate_batch.handler({ force: "true" });
    log("info", "auto-generate", "complete", "Auto-generation completed");
  } catch (e: any) {
    log("error", "auto-generate", "failed", `Auto-generation failed: ${e.message}`);
    await ntfyError("auto-generate", "trigger", `Auto-generation failed: ${e.message}`);
  } finally {
    autoGenerateInProgress = false;
  }
}

// --- Sub-tools ---

const tools: Record<string, {
  description: string;
  params: Record<string, string>;
  handler: (p: Record<string, any>) => Promise<any>;
}> = {

  get_question: {
    description: "Get the next unanswered question from the active batch. Optionally filter by mode (voice/text/media) and category.",
    params: {
      mode: "(optional) Filter by mode: voice, text, or media. Default: any",
      category: "(optional) Filter by category",
    },
    handler: async (p) => {
      // Check for active batch
      const batch = await pgQuery(
        `SELECT * FROM persona_batches WHERE status = 'active' ORDER BY batch_number DESC LIMIT 1`
      );
      if (batch.rowCount === 0) {
        return { error: "No active batch. Call generate_batch to create one." };
      }

      let sql = `SELECT * FROM persona_questions WHERE batch_id = $1 AND status = 'pending'`;
      const params: any[] = [batch.rows[0].id];
      let idx = 2;

      if (p.mode) { sql += ` AND mode = $${idx++}`; params.push(p.mode); }
      if (p.category) { sql += ` AND category = $${idx++}`; params.push(p.category); }

      // Also check follow-up questions (batch_id IS NULL)
      sql += ` UNION ALL SELECT * FROM persona_questions WHERE batch_id IS NULL AND status = 'pending'`;
      if (p.mode) { sql += ` AND mode = $${idx++}`; params.push(p.mode); }
      if (p.category) { sql += ` AND category = $${idx++}`; params.push(p.category); }

      sql += ` ORDER BY RANDOM() LIMIT 1`;

      const result = await pgQuery(sql, params);
      if (result.rowCount === 0) {
        const remaining = await pgQuery(
          `SELECT COUNT(*) as cnt FROM persona_questions WHERE batch_id = $1 AND status = 'pending'`,
          [batch.rows[0].id]
        );
        if (parseInt(remaining.rows[0].cnt) === 0) {
          return { message: "All questions in this batch are answered! Call generate_batch for more.", batch_number: batch.rows[0].batch_number };
        }
        return { message: `No ${p.mode || ""} questions available. Try a different mode.`, remaining: parseInt(remaining.rows[0].cnt) };
      }

      const q = result.rows[0];
      // Mark as asked
      await pgQuery(`UPDATE persona_questions SET status = 'asked', asked_at = NOW() WHERE id = $1`, [q.id]);

      // Fire-and-forget auto-generation check
      checkAndAutoGenerate().catch((e) =>
        log("error", "auto-generate", "background", `Auto-gen check failed: ${e.message}`)
      );

      return {
        question_id: q.id,
        question: q.question,
        category: q.category,
        mode: q.mode,
        depth: q.depth,
        context: q.context,
        media_url: q.media_url,
      };
    },
  },

  submit_answer: {
    description: "Submit an answer to a question. Triggers background digestion into training pairs, observations, and profile entries.",
    params: {
      question_id: "ID of the question being answered",
      answer: "The answer text",
      answer_mode: "(optional) How the answer was given: voice or text. Default: voice",
    },
    handler: async (p) => {
      const qId = parseInt(p.question_id);
      const answerMode = p.answer_mode || "voice";
      const wordCount = p.answer.split(/\s+/).filter(Boolean).length;

      // Insert response
      const resp = await pgQuery(
        `INSERT INTO persona_responses (question_id, answer_raw, answer_mode, word_count)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [qId, p.answer, answerMode, wordCount]
      );
      const responseId = resp.rows[0].id;

      // Update question status
      await pgQuery(`UPDATE persona_questions SET status = 'answered', answered_at = NOW() WHERE id = $1`, [qId]);

      // Update batch counter
      await pgQuery(
        `UPDATE persona_batches SET answered = answered + 1 WHERE id = (SELECT batch_id FROM persona_questions WHERE id = $1)`,
        [qId]
      );

      // Check if batch is complete
      const batchCheck = await pgQuery(
        `SELECT b.* FROM persona_batches b JOIN persona_questions q ON q.batch_id = b.id
         WHERE q.id = $1`, [qId]
      );
      if (batchCheck.rowCount > 0) {
        const b = batchCheck.rows[0];
        const pending = await pgQuery(
          `SELECT COUNT(*) as cnt FROM persona_questions WHERE batch_id = $1 AND status IN ('pending', 'asked')`,
          [b.id]
        );
        if (parseInt(pending.rows[0].cnt) === 0) {
          await pgQuery(
            `UPDATE persona_batches SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [b.id]
          );
          await ntfyNotify(`Batch #${b.batch_number} complete! Ready for next batch.`, "Persona", 3, ["checkered_flag"]);
        }
      }

      // Log event
      await pgQuery(
        `INSERT INTO persona_events (event_type, details) VALUES ($1, $2)`,
        ["answer_submitted", JSON.stringify({ question_id: qId, response_id: responseId, word_count: wordCount, mode: answerMode })]
      );

      // Fire-and-forget digestion
      if (DIFY_PERSONA_DIGEST_KEY) {
        digestResponse(responseId).catch((e) =>
          log("error", "digest", "background", `Background digestion failed for response ${responseId}: ${e.message}`)
        );
      } else {
        log("warn", "digest", "skip", `Skipping digestion — DIFY_PERSONA_DIGEST_KEY not configured`);
      }

      // Fire-and-forget auto-generation check
      checkAndAutoGenerate().catch((e) =>
        log("error", "auto-generate", "background", `Auto-gen check failed: ${e.message}`)
      );

      return { status: "recorded", response_id: responseId, word_count: wordCount, digestion: DIFY_PERSONA_DIGEST_KEY ? "started" : "skipped" };
    },
  },

  skip_question: {
    description: "Skip a question that doesn't apply in the current context.",
    params: {
      question_id: "ID of the question to skip",
      reason: "(optional) Why it was skipped",
    },
    handler: async (p) => {
      const qId = parseInt(p.question_id);
      await pgQuery(`UPDATE persona_questions SET status = 'skipped' WHERE id = $1`, [qId]);

      // Check if batch is complete
      const batchCheck = await pgQuery(
        `SELECT b.* FROM persona_batches b JOIN persona_questions q ON q.batch_id = b.id WHERE q.id = $1`, [qId]
      );
      if (batchCheck.rowCount > 0) {
        const b = batchCheck.rows[0];
        const pending = await pgQuery(
          `SELECT COUNT(*) as cnt FROM persona_questions WHERE batch_id = $1 AND status IN ('pending', 'asked')`,
          [b.id]
        );
        if (parseInt(pending.rows[0].cnt) === 0) {
          await pgQuery(`UPDATE persona_batches SET status = 'completed', completed_at = NOW() WHERE id = $1`, [b.id]);
        }
      }

      await pgQuery(
        `INSERT INTO persona_events (event_type, details) VALUES ($1, $2)`,
        ["question_skipped", JSON.stringify({ question_id: qId, reason: p.reason || null })]
      );

      // Fire-and-forget auto-generation check
      checkAndAutoGenerate().catch((e) =>
        log("error", "auto-generate", "background", `Auto-gen check failed: ${e.message}`)
      );

      return { status: "skipped", question_id: qId };
    },
  },

  get_batch_status: {
    description: "Get current batch progress: questions answered, breakdown by category and mode.",
    params: {},
    handler: async () => {
      const batch = await pgQuery(`SELECT * FROM persona_batches WHERE status = 'active' ORDER BY batch_number DESC LIMIT 1`);
      if (batch.rowCount === 0) return { message: "No active batch", suggestion: "Call generate_batch to create one" };

      const b = batch.rows[0];
      const [byCategory, byMode, byStatus] = await Promise.all([
        pgQuery(`SELECT category, COUNT(*) as cnt FROM persona_questions WHERE batch_id = $1 GROUP BY category ORDER BY category`, [b.id]),
        pgQuery(`SELECT mode, COUNT(*) as cnt FROM persona_questions WHERE batch_id = $1 GROUP BY mode`, [b.id]),
        pgQuery(`SELECT status, COUNT(*) as cnt FROM persona_questions WHERE batch_id = $1 GROUP BY status`, [b.id]),
      ]);

      return {
        batch_number: b.batch_number, status: b.status,
        total: b.total, answered: b.answered,
        progress: `${b.answered}/${b.total}`,
        by_category: byCategory.rows, by_mode: byMode.rows, by_status: byStatus.rows,
      };
    },
  },

  generate_batch: {
    description: "Generate a new batch of 25 questions using Dify. Only works if current batch is complete or none exists. Use force=true to override.",
    params: {
      force: "(optional) Set to true to force generation even if current batch is active",
    },
    handler: async (p) => {
      // Check for active batch
      const active = await pgQuery(`SELECT * FROM persona_batches WHERE status = 'active'`);
      if (active.rowCount > 0 && p.force !== true && p.force !== "true") {
        return { error: `Batch #${active.rows[0].batch_number} is still active (${active.rows[0].answered}/${active.rows[0].total} answered). Complete it first or use force=true.` };
      }

      // Get next batch number
      const maxBatch = await pgQuery(`SELECT COALESCE(MAX(batch_number), 0) as max_num FROM persona_batches`);
      const batchNumber = parseInt(maxBatch.rows[0].max_num) + 1;

      // Gather coverage data
      const [coverage, dimensions, prevQuestions, observations] = await Promise.all([
        pgQuery(`SELECT * FROM persona_coverage ORDER BY coverage_score ASC`),
        pgQuery(`SELECT * FROM persona_dimensions ORDER BY dimension_type, coverage_score ASC`),
        pgQuery(`SELECT question FROM persona_questions ORDER BY id DESC LIMIT 75`),
        pgQuery(`SELECT category, trait_type, observation, confidence FROM persona_observations ORDER BY created_at DESC LIMIT 50`),
      ]);

      // Pick up follow-up questions first
      const followUps = await pgQuery(
        `SELECT * FROM persona_questions WHERE batch_id IS NULL AND status = 'pending' ORDER BY priority DESC LIMIT 10`
      );
      const followUpCount = followUps.rowCount || 0;
      const difySlots = 25 - followUpCount;

      let questions: any[] = followUps.rows.map((fu: any) => ({
        category: fu.category, question: fu.question, context: fu.context,
        mode: fu.mode, depth: fu.depth, question_technique: fu.question_technique,
        priority: fu.priority,
      }));

      if (difySlots > 0 && DIFY_PERSONA_GENERATE_KEY) {
        const oceanScores: Record<string, any> = {};
        const schwartzScores: Record<string, any> = {};
        const techniqueUsage: Record<string, any> = {};
        for (const d of dimensions.rows) {
          if (d.dimension_type === "ocean") oceanScores[d.dimension_name] = { observation_count: d.observation_count, coverage_score: d.coverage_score };
          else if (d.dimension_type === "schwartz") schwartzScores[d.dimension_name] = { observation_count: d.observation_count, coverage_score: d.coverage_score };
          else if (d.dimension_type === "technique") techniqueUsage[d.dimension_name] = { observation_count: d.observation_count };
        }

        const difyResult = await callDify(DIFY_PERSONA_GENERATE_KEY, {
          coverage_data: JSON.stringify(coverage.rows),
          previous_questions: JSON.stringify(prevQuestions.rows.map((r: any) => r.question)),
          observation_summary: JSON.stringify(observations.rows),
          batch_number: String(batchNumber),
          ocean_scores: JSON.stringify(oceanScores),
          schwartz_scores: JSON.stringify(schwartzScores),
          technique_usage: JSON.stringify(techniqueUsage),
          slots: String(difySlots),
        }, "persona-generate-questions");

        // Parse Dify output
        const outputText = difyResult?.data?.outputs?.result || difyResult?.data?.outputs?.text || "";
        try {
          const jsonMatch = outputText.match(/```(?:json)?\s*([\s\S]*?)```/);
          const generated = JSON.parse(jsonMatch ? jsonMatch[1].trim() : outputText.trim());
          if (Array.isArray(generated)) {
            questions = questions.concat(generated.slice(0, difySlots));
          }
        } catch (parseErr: any) {
          await ntfyError("generate", "parse", `Failed to parse generated questions: ${parseErr.message}`, {
            output_preview: outputText.slice(0, 300),
          });
          return { error: "Failed to parse Dify output. Check logs.", batch_number: batchNumber };
        }
      } else if (difySlots > 0 && !DIFY_PERSONA_GENERATE_KEY) {
        return { error: "DIFY_PERSONA_GENERATE_KEY not configured. Cannot generate questions." };
      }

      // Create batch
      const batchResult = await pgQuery(
        `INSERT INTO persona_batches (batch_number, total) VALUES ($1, $2) RETURNING id`,
        [batchNumber, questions.length]
      );
      const batchId = batchResult.rows[0].id;

      // Insert questions
      for (const q of questions) {
        await pgQuery(
          `INSERT INTO persona_questions (batch_id, category, question, context, mode, depth, source_instrument, target_ocean_dims, question_technique, priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [batchId, q.category, q.question, q.context || null,
           q.mode || "voice", q.depth || "quick",
           q.source_instrument || null, q.target_ocean_dims || null,
           q.question_technique || "direct", q.priority || 5]
        );
      }

      // Update follow-up questions to point to this batch
      if (followUpCount > 0) {
        const fuIds = followUps.rows.map((r: any) => r.id);
        await pgQuery(
          `UPDATE persona_questions SET batch_id = $1 WHERE id = ANY($2::int[])`,
          [batchId, fuIds]
        );
      }

      // Log event
      await pgQuery(
        `INSERT INTO persona_events (event_type, details) VALUES ($1, $2)`,
        ["batch_generated", JSON.stringify({ batch_number: batchNumber, total: questions.length, follow_ups_included: followUpCount })]
      );

      await ntfyNotify(`Batch #${batchNumber} ready (${questions.length} questions)`, "Persona", 3, ["brain"]);

      return {
        batch_number: batchNumber, batch_id: batchId,
        total_questions: questions.length, follow_ups_included: followUpCount,
        categories: [...new Set(questions.map((q: any) => q.category))],
      };
    },
  },

  get_coverage: {
    description: "Get gap analysis: coverage scores per category, weakest areas, depth distribution, dimensional coverage.",
    params: {},
    handler: async () => {
      const [coverage, dimensions, totals] = await Promise.all([
        pgQuery(`SELECT * FROM persona_coverage ORDER BY coverage_score ASC`),
        pgQuery(`SELECT * FROM persona_dimensions ORDER BY dimension_type, coverage_score ASC`),
        pgQuery(`SELECT
          (SELECT COUNT(*) FROM persona_questions WHERE status = 'answered') as total_answered,
          (SELECT COUNT(*) FROM persona_training_pairs) as total_pairs,
          (SELECT COUNT(*) FROM persona_observations) as total_observations,
          (SELECT COUNT(*) FROM persona_responses WHERE digested = true) as total_digested`),
      ]);

      const ocean = dimensions.rows.filter((d: any) => d.dimension_type === "ocean");
      const schwartz = dimensions.rows.filter((d: any) => d.dimension_type === "schwartz");
      const techniques = dimensions.rows.filter((d: any) => d.dimension_type === "technique");

      const weakestCategories = coverage.rows.filter((c: any) => c.coverage_score < 0.3).map((c: any) => c.category);
      const weakestOcean = ocean.filter((d: any) => d.observation_count < 5).map((d: any) => d.dimension_name);
      const weakestSchwartz = schwartz.filter((d: any) => d.observation_count < 3).map((d: any) => d.dimension_name);

      return {
        categories: coverage.rows,
        ocean_dimensions: ocean,
        schwartz_values: schwartz,
        technique_usage: techniques,
        totals: totals.rows[0],
        gaps: { weakest_categories: weakestCategories, weakest_ocean: weakestOcean, weakest_schwartz: weakestSchwartz },
      };
    },
  },

  get_profile_summary: {
    description: "Get personality snapshot from Qdrant, grouped by category. Optionally filter by category.",
    params: {
      category: "(optional) Filter by category",
    },
    handler: async (p) => {
      await ensureCollection();
      const body: any = { limit: 100, with_payload: true };
      if (p.category) {
        body.filter = { must: [{ key: "category", match: { value: p.category } }] };
      }

      const result = await qdrantFetch(`/collections/${PERSONA_COLLECTION}/points/scroll`, {
        method: "POST", body: JSON.stringify(body),
      });

      const grouped: Record<string, any[]> = {};
      for (const pt of result.result.points) {
        const cat = pt.payload.category || "uncategorized";
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push({ id: pt.id, type: pt.payload.type, content: pt.payload.content, confidence: pt.payload.confidence });
      }

      return { total: result.result.points.length, by_category: grouped };
    },
  },

  search_profile: {
    description: "Semantic search across the persona profile in Qdrant.",
    params: {
      query: "Search query text",
      limit: "(optional) Max results, default 10",
      type: "(optional) Filter by type: preference, observation, trait, opinion, style, pattern",
    },
    handler: async (p) => {
      await ensureCollection();
      const embedding = await getEmbedding(p.query);
      const filter: any = { must: [] };
      if (p.type) filter.must.push({ key: "type", match: { value: p.type } });

      const body: any = { vector: embedding, limit: parseInt(p.limit || "10"), with_payload: true };
      if (filter.must.length > 0) body.filter = filter;

      const result = await qdrantFetch(`/collections/${PERSONA_COLLECTION}/points/search`, {
        method: "POST", body: JSON.stringify(body),
      });

      return {
        query: p.query,
        results: result.result.map((r: any) => ({ id: r.id, score: r.score, ...r.payload })),
      };
    },
  },

  get_observations: {
    description: "List personality observations from PostgreSQL.",
    params: {
      category: "(optional) Filter by category",
      trait_type: "(optional) Filter by trait_type",
      limit: "(optional) Max results, default 20",
    },
    handler: async (p) => {
      let sql = `SELECT o.*, q.question FROM persona_observations o LEFT JOIN persona_responses r ON o.response_id = r.id LEFT JOIN persona_questions q ON r.question_id = q.id WHERE 1=1`;
      const params: any[] = [];
      let idx = 1;

      if (p.category) { sql += ` AND o.category = $${idx++}`; params.push(p.category); }
      if (p.trait_type) { sql += ` AND o.trait_type = $${idx++}`; params.push(p.trait_type); }
      sql += ` ORDER BY o.created_at DESC LIMIT $${idx}`;
      params.push(parseInt(p.limit || "20"));

      const result = await pgQuery(sql, params);
      return { observations: result.rows, count: result.rowCount };
    },
  },

  get_training_data: {
    description: "Get training pairs in specified format, optionally filtered by category.",
    params: {
      format: "Format: alpaca or sharegpt",
      category: "(optional) Filter by category",
      limit: "(optional) Max results, default 50",
      min_quality: "(optional) Minimum quality score, default 1",
    },
    handler: async (p) => {
      let sql = `SELECT * FROM persona_training_pairs WHERE format = $1`;
      const params: any[] = [p.format];
      let idx = 2;

      if (p.category) { sql += ` AND category = $${idx++}`; params.push(p.category); }
      if (p.min_quality) { sql += ` AND quality_score >= $${idx++}`; params.push(parseInt(p.min_quality)); }
      sql += ` ORDER BY quality_score DESC, id ASC LIMIT $${idx}`;
      params.push(parseInt(p.limit || "50"));

      const result = await pgQuery(sql, params);
      return { format: p.format, pairs: result.rows, count: result.rowCount };
    },
  },

  export_dataset: {
    description: "Full LoRA-ready export as JSON. Formats: alpaca (instruction/input/output) or sharegpt (conversations array).",
    params: {
      format: "Format: alpaca or sharegpt",
      min_quality: "(optional) Minimum quality score, default 3",
    },
    handler: async (p) => {
      const minQ = parseInt(p.min_quality || "3");

      if (p.format === "alpaca") {
        const result = await pgQuery(
          `SELECT instruction, input, output, category, quality_score, tags FROM persona_training_pairs
           WHERE format = 'alpaca' AND quality_score >= $1 ORDER BY quality_score DESC`, [minQ]
        );
        return {
          format: "alpaca", total: result.rowCount,
          dataset: result.rows.map((r: any) => ({
            instruction: r.instruction, input: r.input || "", output: r.output,
          })),
          metadata: { quality_threshold: minQ, exported_at: new Date().toISOString() },
        };
      } else {
        const result = await pgQuery(
          `SELECT conversations, category, quality_score, tags FROM persona_training_pairs
           WHERE format = 'sharegpt' AND quality_score >= $1 AND conversations IS NOT NULL ORDER BY quality_score DESC`, [minQ]
        );
        return {
          format: "sharegpt", total: result.rowCount,
          dataset: result.rows.map((r: any) => ({ conversations: r.conversations })),
          metadata: { quality_threshold: minQ, exported_at: new Date().toISOString() },
        };
      }
    },
  },

  retry_digest: {
    description: "Re-run digestion on a response that failed or needs updating.",
    params: {
      response_id: "Response ID to re-digest",
    },
    handler: async (p) => {
      const responseId = parseInt(p.response_id);
      const check = await pgQuery(`SELECT id FROM persona_responses WHERE id = $1`, [responseId]);
      if (check.rowCount === 0) throw new Error(`Response ${responseId} not found`);

      // Reset digested flag
      await pgQuery(`UPDATE persona_responses SET digested = false WHERE id = $1`, [responseId]);

      // Clear previous digest outputs
      await pgQuery(`DELETE FROM persona_training_pairs WHERE response_id = $1`, [responseId]);
      await pgQuery(`DELETE FROM persona_observations WHERE response_id = $1`, [responseId]);

      // Re-run
      digestResponse(responseId).catch((e) =>
        log("error", "digest", "retry", `Retry digestion failed for response ${responseId}: ${e.message}`)
      );

      return { status: "retrying", response_id: responseId };
    },
  },

  get_stats: {
    description: "Overall statistics dashboard for the persona system.",
    params: {},
    handler: async () => {
      const [batches, questions, responses, pairs, observations, coverage, recentEvents] = await Promise.all([
        pgQuery(`SELECT status, COUNT(*) as cnt FROM persona_batches GROUP BY status`),
        pgQuery(`SELECT status, COUNT(*) as cnt FROM persona_questions GROUP BY status`),
        pgQuery(`SELECT COUNT(*) as total, SUM(CASE WHEN digested THEN 1 ELSE 0 END) as digested, AVG(word_count) as avg_words FROM persona_responses`),
        pgQuery(`SELECT format, COUNT(*) as cnt, AVG(quality_score) as avg_quality FROM persona_training_pairs GROUP BY format`),
        pgQuery(`SELECT trait_type, COUNT(*) as cnt FROM persona_observations GROUP BY trait_type`),
        pgQuery(`SELECT category, coverage_score FROM persona_coverage ORDER BY coverage_score ASC`),
        pgQuery(`SELECT event_type, COUNT(*) as cnt FROM persona_events WHERE timestamp > NOW() - INTERVAL '7 days' GROUP BY event_type`),
      ]);

      const avgCoverage = coverage.rows.length > 0
        ? coverage.rows.reduce((sum: number, r: any) => sum + parseFloat(r.coverage_score || 0), 0) / coverage.rows.length
        : 0;

      return {
        batches: batches.rows,
        questions: questions.rows,
        responses: responses.rows[0],
        training_pairs: pairs.rows,
        observations: observations.rows,
        coverage: { by_category: coverage.rows, average: avgCoverage.toFixed(3) },
        recent_events_7d: recentEvents.rows,
      };
    },
  },
};

// --- Registration ---

const PERSONA_CALL_DESCRIPTION = `Personal model builder for Trevor. Builds a comprehensive AI persona through incremental Q&A sessions.

DRIVING MODE: User says "mini me questions" or "I have time for questions". Call get_question with mode='voice'. Present one question at a time. After answer, call submit_answer. Ask "another?" and repeat. Keep it conversational and quick.

DESKTOP MODE: Can use any mode. For media questions, present the URL/image first, then ask the question. For scenario questions, set the scene before asking.

NEVER present multiple questions at once. Always one at a time.
NEVER skip digestion — every answer must go through submit_answer.
If batch is empty, suggest generate_batch.

Sub-tools: get_question, submit_answer, skip_question, get_batch_status, generate_batch, get_coverage, get_profile_summary, search_profile, get_observations, get_training_data, export_dataset, retry_digest, get_stats`;

export function registerPersonaTools(server: McpServer) {
  server.tool(
    "persona_list",
    "List all available persona/mini-me tools. Builds Trevor's AI persona through incremental Q&A — " +
    "captures personality, opinions, communication style, and decision-making patterns. " +
    "Tools: question flow (get_question/submit_answer/skip_question), batches (get_batch_status/generate_batch), " +
    "analysis (get_coverage/get_profile_summary/search_profile/get_observations), " +
    "training data (get_training_data/export_dataset/retry_digest), dashboard (get_stats).",
    {},
    async () => {
      const toolList = Object.entries(tools).map(([name, def]) => ({
        tool: name, description: def.description, params: def.params,
      }));
      return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
    }
  );

  server.tool(
    "persona_call",
    PERSONA_CALL_DESCRIPTION,
    {
      tool: z.string().describe("Tool name from persona_list"),
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
        const criticalTools = ["submit_answer", "generate_batch", "retry_digest"];
        if (criticalTools.includes(tool)) {
          await ntfyError("call", tool, `Tool ${tool} failed: ${error.message}`, { tool, params: Object.keys(params || {}) });
        }
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
