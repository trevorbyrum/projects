# Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                          Internet                                 │
│                                                                   │
│  Claude Code / claude.ai / Claude Mobile                         │
│         │                                                         │
│         ▼ HTTPS                                                   │
│    Cloudflare (SSL termination)                                  │
│         │                                                         │
│         ▼ HTTP                                                    │
│    Traefik (reverse proxy)                                       │
│         │                                                         │
│         ▼ HTTP :3500                                              │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  MCP Gateway Container                       │ │
│  │                                                              │ │
│  │  Express Server (src/index.ts)                              │ │
│  │    ├── POST /  → MCP request handler                        │ │
│  │    ├── GET  /  → MCP SSE endpoint (session resume)          │ │
│  │    ├── DELETE / → Session cleanup                            │ │
│  │    └── GET /health → Health check                           │ │
│  │                                                              │ │
│  │  Session Manager (in-memory Map)                            │ │
│  │    └── sessionId → StreamableHTTPServerTransport             │ │
│  │                                                              │ │
│  │  MCP Server (per session)                                   │ │
│  │    └── 46 registered tools (2 per module × 23 modules)      │ │
│  │                                                              │ │
│  │  Tool Modules (src/tools/*.ts)                              │ │
│  │    ├── gateway.ts    ├── docker.ts     ├── redis.ts         │ │
│  │    ├── n8n.ts        ├── vault.ts      ├── mongodb.ts       │ │
│  │    ├── memory.ts     ├── openrouter.ts ├── rabbitmq.ts      │ │
│  │    ├── graph.ts      ├── github.ts     ├── traefik.ts       │ │
│  │    ├── postgres.ts   ├── playwright.ts ├── uptimekuma.ts    │ │
│  │    ├── pgvector.ts   ├── external.ts   ├── prometheus.ts    │ │
│  │    ├── dify.ts       ├── recipes.ts    ├── projects.ts      │ │
│  │    ├── openhands.ts  └── blueprints.ts                      │ │
│  │                                                              │ │
│  │  Utilities                                                   │ │
│  │    └── embeddings.ts (local Xenova/all-MiniLM-L6-v2)       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│         │                                                         │
│         ▼ Docker network (traefik_proxy)                         │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Qdrant  Neo4j  PostgreSQL  n8n  Vault  Redis  MongoDB     │ │
│  │  Docker-Proxy  Dify  OpenHands  Traefik  RabbitMQ  ...     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## MCP Transport: Streamable HTTP

The gateway uses MCP's **streamable HTTP transport**, not the older SSE or stdio transports.

### Request Flow

1. Client sends a POST to `/` with an MCP JSON-RPC request
2. If no `mcp-session-id` header, a new session is created
3. The request is routed to the MCP server instance for that session
4. Response is returned over the same HTTP connection
5. Session ID is returned in the `mcp-session-id` response header

### Why Not SSE?

SSE (Server-Sent Events) requires a persistent connection. Streamable HTTP is connectionless — each request/response is independent. This is simpler to proxy through Cloudflare and Traefik, and works better with Claude.ai's MCP connector.

### The SDK Patch

The official MCP SDK validates the `Accept` header and rejects requests that don't specify `application/json` or `text/event-stream`. Claude.ai sends `*/*`. The `patch-sdk.cjs` script monkey-patches the SDK at container startup to accept `*/*`.

This is a necessary workaround until the SDK is updated upstream.

## The _list / _call Pattern

### Problem

MCP has no built-in tool namespacing. Registering 150+ tools directly means every LLM request includes all 150+ tool definitions in the system prompt, consuming thousands of tokens.

### Solution

Each module registers exactly 2 tools:

```
{service}_list  → Returns JSON describing all available sub-tools
{service}_call  → Executes a named sub-tool with parameters
```

The LLM first calls `_list` to discover what's available, then calls `_call` with the specific sub-tool name and parameters. This is a two-step process but uses far less context.

### Module Structure

Every tool module follows this pattern:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const tools: Record<string, { description: string; schema: any; handler: Function }> = {
  sub_tool_name: {
    description: "What this sub-tool does",
    schema: { param1: { type: "string", description: "..." } },
    handler: async (params: any) => { /* implementation */ }
  }
};

export function registerServiceTools(server: McpServer) {
  server.tool("service_list", "List available service tools", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify(
      Object.entries(tools).map(([name, t]) => ({
        name, description: t.description, parameters: t.schema
      }))
    )}]
  }));

  server.tool("service_call", "Call a service tool", {
    tool: z.string(),
    params: z.record(z.any()).optional()
  }, async ({ tool, params }) => {
    const t = tools[tool];
    if (!t) return { content: [{ type: "text", text: `Unknown tool: ${tool}` }] };
    return t.handler(params || {});
  });
}
```

## Session Management

Sessions are stored in a `Map<string, StreamableHTTPServerTransport>`:

- **Creation**: New session on first request without a session ID
- **Lookup**: Subsequent requests include `mcp-session-id` header
- **Cleanup**: Sessions removed on DELETE request or when transport closes
- **No persistence**: All sessions lost on container restart

Each session gets its own `McpServer` instance with all 46 tools registered. Sessions are isolated — one client's requests don't affect another's.

## Auto-Enrichment

The `memory.ts` and `graph.ts` modules automatically enrich data on write:

- **Qdrant (memory)**: Every stored vector gets a `recorded_at` field with the current ISO 8601 timestamp
- **Neo4j (graph)**: Every new node gets `recorded_at` and an empty `observations: []` array

This ensures all knowledge has temporal context without requiring clients to provide timestamps.

## External MCP Proxying

The `external.ts` module reads `external-mcp.json` and creates proxy tools for each listed MCP server. It:

1. Connects to the external server via streamable HTTP
2. Discovers its tools via `tools/list`
3. Registers `{name}_list` and `{name}_call` tools that proxy to the external server

This lets the gateway aggregate tools from multiple MCP servers behind a single endpoint.

## Blueprint Automation

Blueprints orchestrate multi-step infrastructure provisioning:

```
Blueprint Definition (Vault)
    ↓
blueprint_call → deploy
    ↓
┌──────────────────────────┐
│  For each provision step: │
│  1. Call n8n webhook      │
│  2. n8n runs workflow     │
│  3. Track in Redis        │
│  4. Report progress       │
└──────────────────────────┘
    ↓
Fully provisioned agent/service
```

Each step is handled by a dedicated n8n workflow (see `n8n-workflows/`). Progress is tracked in Redis with TTL-based expiry.
