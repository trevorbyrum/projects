import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

// Import tool modules
import { registerN8nTools } from "./tools/n8n.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerGatewayTools } from "./tools/gateway.js";
import { registerPostgresTools } from "./tools/postgres.js";
import { registerPgvectorTools } from "./tools/pgvector.js";
import { registerDockerTools } from "./tools/docker.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerOpenrouterTools } from "./tools/openrouter.js";
import { registerGithubTools } from "./tools/github.js";
import { registerPlaywrightTools } from "./tools/playwright.js";
import { registerPrometheusTools } from "./tools/prometheus.js";
import { registerUptimeKumaTools } from "./tools/uptimekuma.js";
import { registerRabbitmqTools } from "./tools/rabbitmq.js";
import { registerExternalTools } from "./tools/external.js";
import { registerDifyTools } from "./tools/dify.js";
import { registerOpenhandsTools } from "./tools/openhands.js";
import { registerTraefikTools } from "./tools/traefik.js";
import { registerRedisTools } from "./tools/redis.js";
import { registerMongodbTools } from "./tools/mongodb.js";
import { registerRecipeTools } from "./tools/recipes.js";
import { registerBlueprintTools } from "./tools/blueprints.js";
import { registerProjectTools, handleReviewAction } from "./tools/projects.js";
import { registerFigmaTools } from "./tools/figma.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerPreferenceTools } from "./tools/preferences.js";
import { registerPersonaTools } from "./tools/persona.js";
import { registerAgentforgeTools } from "./tools/agentforge.js";
import { registerWarRoomTools } from "./tools/war-room.js";

const PORT = parseInt(process.env.PORT || "3500");

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "Homelab MCP Gateway",
    version: "1.0.0",
  });

  // Internal homelab tools
  registerGatewayTools(server);
  registerN8nTools(server);
  registerMemoryTools(server);
  registerGraphTools(server);
  registerPostgresTools(server);
  registerPgvectorTools(server);
  registerDockerTools(server);
  registerVaultTools(server);
  registerOpenrouterTools(server);
  registerGithubTools(server);
  registerPlaywrightTools(server);

  registerPrometheusTools(server);
  registerUptimeKumaTools(server);
  registerRabbitmqTools(server);
  registerDifyTools(server);
  registerOpenhandsTools(server);
  registerTraefikTools(server);
  registerRedisTools(server);
  registerMongodbTools(server);
  registerRecipeTools(server);
  registerBlueprintTools(server);
  registerProjectTools(server);
  registerFigmaTools(server);
  registerWorkspaceTools(server);
  registerPreferenceTools(server);
  registerPersonaTools(server);
  registerAgentforgeTools(server);
  registerWarRoomTools(server);

  // External MCP proxies (loaded from config)
  registerExternalTools(server);

  return server;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

function setCorsHeaders(res: express.Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ── Mattermost Slash Command Webhook ──────────────────────────
app.post("/webhook/mattermost", async (req, res) => {
  try {
    // Mattermost sends slash command data as form-urlencoded
    const { command, text, user_name, channel_id, token } = req.body;

    // Validate Mattermost slash command token if configured
    const MM_SLASH_TOKEN = process.env.MM_SLASH_COMMAND_TOKEN || "";
    if (MM_SLASH_TOKEN && token !== MM_SLASH_TOKEN) {
      return res.status(401).json({ text: "Unauthorized" });
    }

    if (command === "/pipeline") {
      const parts = (text || "").trim().split(/\s+/);
      const action = parts[0] || "help";
      const taskId = parts[1] || "";
      const reason = parts.slice(2).join(" ");

      const result = await handleReviewAction(action, taskId, reason, user_name || "unknown");
      return res.json({ response_type: "in_channel", text: result });
    }

    res.json({ text: "Unknown command. Use `/pipeline approve|reject|retry|list`." });
  } catch (e: any) {
    console.error("[webhook/mattermost] Error:", e.message);
    res.json({ text: `Error: ${e.message}` });
  }
});

// ── Health Check ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "homelab-mcp-gateway", version: "1.0.0", sessions: sessions.size, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.all("/", async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.log(`GET SSE stream (session: ${sessionId || "none"})`);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (sessionId) res.setHeader("mcp-session-id", sessionId);
    res.write(": connected\n\n");
    req.on("close", () => console.log("GET SSE stream closed"));
    return;
  }

  console.log(`MCP ${req.method} request, session: ${req.headers["mcp-session-id"] || "new"}`);

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId)!.transport;
  } else if (!sessionId && req.method === "POST") {
    const server = createMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID().replace(/-/g, ""),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { transport, server });
        console.log(`New session created: ${newSessionId}`);
      },
    });
    await server.connect(transport);
    transport.onclose = () => {
      const sid = (transport as any).sessionId;
      if (sid) {
        sessions.delete(sid);
        console.log(`Session closed: ${sid}`);
      }
    };
  } else if (sessionId && !sessions.has(sessionId)) {
    // Auto-recover: stale session (e.g. after container restart)
    console.log(`Session ${sessionId} not found — auto-recovering`);
    const server = createMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId!,
    });
    await server.connect(transport);
    transport.onclose = () => {
      const sid = (transport as any).sessionId;
      if (sid) {
        sessions.delete(sid);
        console.log(`Session closed: ${sid}`);
      }
    };

    // Force-initialize the REAL transport (WebStandardStreamableHTTPServerTransport)
    // StreamableHTTPServerTransport is just a Node.js wrapper — _initialized lives on _webStandardTransport
    const webTransport = (transport as any)._webStandardTransport;
    webTransport._initialized = true;
    webTransport.sessionId = sessionId;

    sessions.set(sessionId, { transport, server });
    console.log(`Session auto-recovered: ${sessionId}`);
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

app.all("/.well-known/*", (req, res) => {
  console.log(`Blocked OAuth discovery: ${req.method} ${req.url}`);
  res.status(404).type("text/plain").send("Not found");
});

app.use((req, res) => res.status(404).type("text/plain").send("Not found"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP Gateway running on port ${PORT}`);
});

