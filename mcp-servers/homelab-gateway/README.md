# Homelab MCP Gateway

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io/) gateway that gives AI assistants (Claude, etc.) unified access to your entire homelab infrastructure over streamable HTTP.

One container. 26 tool modules. 210+ sub-tools. Two MCP tools per module.

## Overview

The gateway sits behind Traefik and exposes every homelab service through a consistent `_list` / `_call` pattern. Instead of registering 150+ individual MCP tools (which overwhelms LLM context windows), each service module exposes exactly two tools — one to discover available operations, one to execute them.

```
Client (Claude Code / claude.ai)
       ↓ HTTPS
   Cloudflare
       ↓ HTTP
    Traefik
       ↓ HTTP
  Gateway :3500
       ↓
┌──────────────────────────────────────────────────────┐
│                  Docker Network                       │
├──────────────────────────────────────────────────────┤
│  Qdrant   Neo4j   PostgreSQL   n8n    Vault   Redis  │
│  Docker   Dify   OpenHands   MongoDB  RabbitMQ  ...  │
└──────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Clone
git clone https://github.com/trevorbyrum/projects.git
cd projects/mcp-servers/homelab-gateway

# 2. Configure
cp .env.example .env
# Edit .env with your service URLs, credentials, and API keys

# 3. Build
docker build --no-cache -t homelab-mcp-gateway .

# 4. Run (with Traefik labels — required for routing)
docker run -d \
  --name homelab-mcp-gateway \
  --network traefik_proxy \
  --restart unless-stopped \
  --env-file .env \
  -l traefik.enable=true \
  -l 'traefik.http.routers.mcp-gateway.rule=Host(`mcp.your-domain.com`)' \
  -l traefik.http.services.mcp-gateway.loadbalancer.server.port=3500 \
  homelab-mcp-gateway

# 5. Verify
curl -s http://localhost:3500/health
```

> **Unraid note:** Unraid does not have docker-compose installed. The `docker-compose.yml` in this repo is for reference/documentation only. Use `docker build` + `docker run` as shown above.

## The _list / _call Pattern

Every tool module exposes exactly **2 MCP tools**:

| Tool | Purpose |
|------|---------|
| `{service}_list` | Returns available sub-tools with their JSON schemas |
| `{service}_call` | Executes a sub-tool by name with parameters |

This matters because LLMs have limited context windows. Registering 210+ tools individually would consume most of the available context just listing tool definitions. With the `_list`/`_call` pattern, the LLM sees only 52 tools (2 per module), and can discover sub-tools on demand.

```json
// Discover what memory tools are available
{ "tool": "memory_list" }

// Execute a specific sub-tool
{
  "tool": "memory_call",
  "params": {
    "tool": "store",
    "params": { "content": "Important note", "category": "notes" }
  }
}
```

## Tool Modules

| Module | MCP Tools | Sub-tools | Description |
|--------|-----------|-----------|-------------|
| `gateway` | `gateway_list`, `gateway_call` | 4 | Health checks, status, session info |
| `n8n` | `n8n_list`, `n8n_call` | 10 | Workflow automation (list, get, activate, execute, etc.) |
| `memory` | `memory_list`, `memory_call` | 7 | Qdrant vector memory (store, search, list, delete) |
| `graph` | `graph_list`, `graph_call` | 8 | Neo4j knowledge graph (query, create nodes/edges, observations) |
| `pg` | `pg_list`, `pg_call` | 5 | PostgreSQL queries and schema inspection |
| `vector` | `vector_list`, `vector_call` | 7 | pgvector similarity search and embedding management |
| `docker` | `docker_list`, `docker_call` | 14 | Container lifecycle, logs, stats, networks, images |
| `vault` | `vault_list`, `vault_call` | 4 | HashiCorp Vault secret read/write/list/delete |
| `ai` | `ai_list`, `ai_call` | 5 | OpenRouter LLM API (chat, models, embeddings) |
| `github` | `github_list`, `github_call` | 14 | Repos, issues, PRs, commits, search |
| `browser` | `browser_list`, `browser_call` | 13 | Playwright headless browser automation |
| `prometheus` | `prometheus_list`, `prometheus_call` | 3 | PromQL queries, targets, alerts |
| `uptime` | `uptime_list`, `uptime_call` | 4 | Uptime Kuma monitor status and management |
| `rabbitmq` | `rabbitmq_list`, `rabbitmq_call` | 6 | Queue/exchange management, message publishing |
| `dify` | `dify_list`, `dify_call` | 20+ | Dify AI platform (apps, models, tools, knowledge bases, workflows) |
| `openhands` | `openhands_list`, `openhands_call` | 10+ | OpenHands coding agent (conversations, agent control, files) |
| `traefik` | `traefik_list`, `traefik_call` | 5 | Reverse proxy inspection (routers, services, middleware) |
| `redis` | `redis_list`, `redis_call` | 8 | Key operations, info, keyspace, pub/sub, slowlog |
| `mongodb` | `mongodb_list`, `mongodb_call` | 10+ | Databases, collections, documents, indexes, aggregation |
| `recipe` | `recipe_list`, `recipe_call` | 6 | Container recipe templates (store, deploy, redeploy, teardown) |
| `blueprint` | `blueprint_list`, `blueprint_call` | 8+ | Blueprint automation system (modular agent framework) |
| `external` | `context7_list`, `context7_call` | varies | External MCP server proxies (configured in `external-mcp.json`) |
| `projects` | `project_list`, `project_call` | 30+ | Project pipeline (research, architecture, security review, dev-team workflows, sprints) |
| `figma` | `figma_list`, `figma_call` | 15 | Figma design files (read files, components, styles, images, comments) |
| `workspace` | `workspace_list`, `workspace_call` | 8 | Workspace orchestration (GitLab repos, OpenHands coding, Figma visual QA) |
| `preferences` | `pref_list_tools`, `pref_call` | 6 | Semantic dev preference storage (Qdrant-backed, used by research pipeline) |

## Architecture

### Transport

MCP over **streamable HTTP** — not SSE, not stdio. The gateway runs an Express server that:

1. Accepts MCP requests at the root endpoint
2. Creates a session per client (stored in-memory)
3. Routes tool calls to the appropriate module
4. Returns responses over the same HTTP connection

The `patch-sdk.cjs` script patches the MCP SDK to accept `*/*` Accept headers, which is required for compatibility with Claude.ai's MCP connector.

### Session Management

Sessions are stored in an **in-memory Map** keyed by session ID. This means:

- Restarting the container invalidates all active sessions
- Clients must reconnect after a container restart
- No persistent session state across deploys

### Auto-Enrichment

All writes to Qdrant and Neo4j automatically inject:
- `recorded_at`: ISO 8601 timestamp
- Neo4j nodes also get an empty `observations: []` array

## Adding a New Tool

1. Create `src/tools/yourservice.ts` following the `_list`/`_call` pattern
2. Export a `registerYourServiceTools(server: McpServer)` function
3. Import and call it in `src/index.ts`
4. Add required env vars to `.env` and `.env.example`
5. Rebuild and deploy

See [CONTRIBUTING.md](CONTRIBUTING.md) for a full template and detailed instructions.

## Adding an External MCP Server

The `external.ts` module proxies requests to other MCP servers defined in `external-mcp.json`:

```json
{
  "servers": [
    {
      "name": "context7",
      "url": "https://mcp.context7.com/mcp"
    }
  ]
}
```

Each external server gets its own `_list`/`_call` tool pair registered automatically.

## Container Dependencies

The gateway integrates with these services on the Docker network. You don't need all of them — modules gracefully handle missing services.

| Service | Purpose | Default Internal URL |
|---------|---------|---------------------|
| Qdrant | Vector memory | `http://Qdrant:6333` |
| Neo4j | Knowledge graph | `bolt://neo4j:7687` |
| PostgreSQL/pgvector | Relational DB + vectors | `postgresql://pgvector:5432` |
| n8n | Workflow automation | `http://n8n:5678` |
| HashiCorp Vault | Secrets management | `http://Vault:8200` |
| Docker Socket Proxy | Container management | `http://docker-socket-proxy:2375` |
| Dify | AI application platform | `http://dify-api:5001` |
| OpenHands | AI coding agent | `http://openhands:3000` |
| Traefik | Reverse proxy | `http://traefik:8080` |
| Redis | Cache/broker | `redis://Redis:6379` |
| MongoDB | Document database | `mongodb://MongoDB:27017` |
| RabbitMQ | Message queue | `http://RabbitMQ:15672` |
| Uptime Kuma API | Monitoring | `http://Uptime-Kuma-API:8000` |
| Prometheus | Metrics | `http://prometheus:9090` |
| ntfy | Push notifications | `http://ntfy:80` |
| GitLab CE | Self-hosted Git for workspace repos | `http://gitlab-ce:80` |
| Figma API | Design file access (external) | `https://api.figma.com` |

## Blueprint Automation System

Blueprints are a modular agent framework for automating multi-step infrastructure tasks. A blueprint defines a sequence of steps (provisions) that create, configure, and wire together services.

- **Blueprint definitions** are stored in Vault and describe what to build
- **n8n workflows** (`n8n-workflows/`) handle individual provisioning steps
- **The `blueprint` tool module** orchestrates execution, tracking progress in Redis

Workflow files in `n8n-workflows/`:

| File | Purpose |
|------|---------|
| `01-provision-pg-table.json` | Create PostgreSQL tables |
| `02-provision-dify-app.json` | Create Dify AI applications |
| `03-provision-dify-knowledge.json` | Create Dify knowledge bases |
| `04-provision-n8n-workflow.json` | Create n8n workflows |
| `05-store-secret.json` | Store secrets in Vault |
| `06-register-in-graph.json` | Register components in Neo4j |
| `07-log-to-memory.json` | Log events to vector memory |
| `08-health-check.json` | Verify component health |
| `09-teardown-component.json` | Remove components cleanly |
| `10-blueprint-deployer.json` | Orchestrate full blueprint deployment |
| `11-blueprint-teardown.json` | Orchestrate full blueprint teardown |
| `12-guardrail-check.json` | Pre-deploy validation |
| `13-agent-health-report.json` | Agent system health reporting |

## Recipes

The recipe system stores container deployment templates in Vault and manages their lifecycle:

- `store` — Save a recipe template to Vault
- `deploy` — Pull and run a container from a recipe
- `redeploy` — Stop, remove, and recreate from recipe
- `teardown` — Stop and remove a deployed recipe
- `list` — List all stored recipes
- `import` — Import recipe templates from files

See `examples/recipes/` for illustrative recipe templates.

## Dev-Team Automation

The project pipeline (`projects.ts`) manages the full development lifecycle from idea to completion:

- **Research** — 13 AI-powered sections via Dify workflows, with preference-aware context injection
- **Architecture** — Automated design generation and revision via dev-team Dify workflows
- **Security Review** — Automated security assessment before planning
- **Planning** — Sprint generation with task prompts
- **Building** — Agent task management with OpenHands integration

Supporting modules:
- **`workspaces.ts`** — GitLab repo creation, OpenHands coding sessions, Figma screenshot capture, visual QA
- **`preferences.ts`** — Semantic dev preference storage (Qdrant), automatically queried during research

Async features: fire-and-forget Dify workflows with job polling, ntfy push notifications for all pipeline events, structured logging.

## Workspace Orchestration

The workspace module (`workspaces.ts`) manages the coding environment for projects:

1. **Create workspace** — Provisions a GitLab repo from recipe templates
2. **Coding sessions** — Launches OpenHands agents for sprint tasks
3. **Visual QA** — Captures Figma screenshots, compares against implementation
4. **Merge & deploy** — Merges sprint branches, triggers recipe-based deployment

## Configuration

See [`.env.example`](.env.example) for all environment variables with descriptions.

## What NOT to Change

- **`patch-sdk.cjs`** — Required for browser client compatibility. The MCP SDK rejects `*/*` Accept headers without this patch.
- **The `_list`/`_call` pattern** — LLM tooling depends on this exact interface. Changing tool names breaks all connected clients.
- **Session management approach** — In-memory sessions are intentional. Adding persistence would complicate the architecture without clear benefit.
- **CORS headers** — Required for browser-based MCP clients (Claude.ai).
- **Traefik label format** — Cloudflare terminates SSL and forwards HTTP to Traefik. Do not add `tls=true` or `entrypoints=https`.

## Deployment Notes

- **Unraid**: No docker-compose. Use `docker build` + `docker run` with `--env-file`.
- **Traefik + Cloudflare**: SSL terminates at Cloudflare. Traefik entrypoint is HTTP only. Never add TLS labels.
- **Container restart = session invalidation**: All MCP clients must reconnect after a deploy.
- **Traefik labels are required**: Without them, the gateway is unreachable via the public URL even if the container is running.

## Customization Guide

### What You MUST Change
- **`.env`** — Copy `.env.example` to `.env` and fill in ALL values marked `your-*`
- **Traefik Host rule** — Replace `mcp.your-domain.com` with your actual domain in the `docker run` command
- **`CLAUDE.md`** — Replace `your-domain.com` with your actual domain throughout

### What You SHOULD Customize
- **`projects.ts` — `DIFY_SECTION_KEYS`** — Replace placeholder keys with your Dify workflow API keys
- **`projects.ts` — `DIFY_DEVTEAM_KEYS`** — Replace placeholder keys with your dev-team Dify app keys
- **`projects.ts` — `N8N_WEBHOOK_IDS`** — Fill in your n8n workflow webhook IDs
- **`workspaces.ts` — GitLab group ID** — Default is `34`, change to your GitLab group/namespace ID
- **Container names** — Docker network container names are case-sensitive; match your actual names
- **`external-mcp.json`** — Add/remove external MCP servers as needed

### What You Should NOT Change
- **`patch-sdk.cjs`** — Required for browser client compatibility
- **The `_list` / `_call` tool pattern** — LLM tooling depends on this interface
- **Port 3500** — Hardcoded in multiple places
- **Session management** — In-memory sessions are intentional
- **CORS headers** — Required for browser-based MCP clients
- **Traefik label format** — HTTP only (Cloudflare terminates SSL)

## License

MIT
