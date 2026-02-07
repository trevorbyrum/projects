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

const PORT = parseInt(process.env.PORT || "3500");

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "Trevor's Homelab Gateway",
    version: "1.0.0",
  });

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
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    return;
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

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "homelab-mcp-gateway", version: "1.0.0", timestamp: new Date().toISOString(), activeSessions: sessions.size });
});

app.all("/.well-known/*", (req, res) => {
  console.log(`Blocked OAuth discovery: ${req.method} ${req.url}`);
  res.status(404).type("text/plain").send("Not found");
});

app.use((req, res) => res.status(404).type("text/plain").send("Not found"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP Gateway running on port ${PORT}`);
});
