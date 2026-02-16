# Homelab MCP Gateway

> MCP server for homelab infrastructure management — 32 modules, 393+ sub-tools, one endpoint.

## Overview

Node.js/Express MCP server exposing homelab infrastructure as [Model Context Protocol](https://modelcontextprotocol.io) tools.
Connects Claude (and any MCP client) to Docker, databases, monitoring, CI/CD, and AI services running on an Unraid server.

**Public endpoint**: `https://your-domain.com`

## Architecture

```
Client (Claude Code) ─HTTPS─> Cloudflare ─HTTP─> Traefik ─HTTP─> Gateway:3500
                                                                      │
                                                       Docker services on traefik_proxy
```

- **Transport**: MCP over streamable HTTP (not SSE, not stdio)
- **Tool pattern**: Each module exposes `{prefix}_list` and `{prefix}_call` endpoints
- **Sessions**: In-memory with auto-recovery on container restart
- **Base image**: Playwright (for browser automation + PDF rendering)

## Modules

| Module | Prefix | Sub-tools | Description |
|--------|--------|:---------:|-------------|
| n8n | `n8n` | 13 | List all available n8n workflow automation tools and their parameters |
| memory | `memory` | 7 | List all available memory/Qdrant tools and their parameters |
| graph | `graph` | 9 | List all available Neo4j knowledge graph tools |
| gateway | `gateway` | 5 | List all available gateway utility tools |
| postgres | `pg` | 5 | List all available PostgreSQL database tools and their parameters |
| pgvector | `vector` | 7 | List all available pgvector tools for vector/embedding operations |
| docker | `docker` | 13 | List all available Docker tools and their parameters |
| vault | `vault` | 6 | List all available HashiCorp Vault secrets tools |
| openrouter | `ai` | 5 | List all available OpenRouter AI tools for calling other LLMs |
| github | `github` | 14 | List all available GitHub tools and their parameters |
| playwright | `browser` | 13 | List all available browser automation tools and their parameters |
| monitoring | `prometheus` | dynamic | List all available Prometheus monitoring tools |
| rabbitmq | `rabbitmq` | 8 | List all available RabbitMQ message queue tools |
| external | *dynamic* | dynamic | external tools |
| dify | `dify` | 40 | List all available Dify AI platform tools. |
| openhands | `openhands` | 26 | List all available OpenHands AI coding agent tools. |
| traefik | `traefik` | 13 | List all available Traefik reverse proxy tools. |
| redis | `redis` | 11 | List all available Redis tools. |
| mongodb | `mongodb` | 14 | List all available MongoDB tools. |
| recipes | `recipe` | 10 | List all available container recipe tools. |
| blueprints | `blueprint` | 14 | List all available agent blueprint tools. |
| projects | `project` | 37 | List all available Project Pipeline tools. |
| figma | `figma` | 15 | List all available Figma design tools |
| workspaces | `workspace` | 8 | List all available Workspace orchestration tools. |
| preferences | `pref` | 6 | List all available preference management tools and their parameters |
| persona | `persona` | 13 | List all available persona/mini-me tools. |
| agentforge | `agentforge` | 17 | List all available AgentForge tools. |
| war-room | `warroom` | 4 | List available War Room tools. |
| gitlab | `gitlab` | 25 | List all available GitLab tools and their parameters |
| rag-generator | `rag_generator` | 27 | List knowledge builder tools |
| mm-slash | *dynamic* | dynamic | mm-slash tools |
| nextcloud | `nextcloud` | 8 | List all available Nextcloud tools and their parameters |

## Quick Start

```bash
# Development (watch mode)
npm run dev

# Build TypeScript
npm run build

# Generate docs
npm run docs

# Verify docs are current (CI)
npm run docs:check
```

## Deploy

```bash
docker build --no-cache -t homelab-mcp-gateway .
docker stop homelab-mcp-gateway && docker rm homelab-mcp-gateway
docker run -d --name homelab-mcp-gateway --network traefik_proxy \
  --restart unless-stopped --env-file .env \
  -l traefik.enable=true \
  -l "traefik.http.routers.mcp-gateway.rule=Host(`your-domain.com`)" \
  -l traefik.http.services.mcp-gateway.loadbalancer.server.port=3500 \
  homelab-mcp-gateway
```

## Environment Variables

Copy [`.env.example`](.env.example) to `.env` and fill in values.

**Server**: `NODE_ENV`, `PORT`  
**n8n**: `N8N_API_URL`, `N8N_API_KEY`, `N8N_WEBHOOK_BASE`  
**Qdrant**: `QDRANT_URL`  
**Neo4j**: `NEO4J_URL`, `NEO4J_USER`, `NEO4J_PASSWORD`  
**PostgreSQL / pgvector**: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`  
**Docker**: `DOCKER_HOST`  
**HashiCorp Vault**: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_MOUNT`, `VAULT_UNSEAL_KEY`  
**OpenRouter**: `OPENROUTER_API_KEY`  
**GitHub**: `GITHUB_TOKEN`  
**Uptime Kuma**: `UPTIME_KUMA_API_KEY`  
**Dify**: `DIFY_API_URL`, `DIFY_EMAIL`, `DIFY_PASSWORD`  
**OpenHands**: `OPENHANDS_URL`, `OPENHANDS_API_KEY`  
**Traefik**: `TRAEFIK_API_URL`  
**Redis**: `REDIS_HOST`, `REDIS_PORT`  
**MongoDB**: `MONGODB_URL`  
**Figma**: `FIGMA_API_KEY`  
**GitLab CE**: `GITLAB_TOKEN`, `GITLAB_URL`, `GITLAB_MARKET_RESEARCH_REPO`, `GITLAB_DEV_RESEARCH_REPO`  
**Mattermost**: `MATTERMOST_URL`, `MATTERMOST_TOKEN`, `MATTERMOST_BOT_TOKEN`, `MATTERMOST_WEBHOOK_URL`  
**Mattermost Channel IDs**: `MM_CHANNEL_PIPELINE_UPDATES`, `MM_CHANNEL_HUMAN_REVIEW`, `MM_CHANNEL_ALERTS`, `MM_CHANNEL_DEV_LOGS`, `MM_CHANNEL_DELIVERABLES`, `MM_CHANNEL_TODO`, `MM_CHANNEL_QUEUE`  
**n8n Webhook IDs**: `N8N_WH_GITLAB_SYNC`, `N8N_WH_RESEARCH_PIPELINE`, `N8N_WH_RESEARCH_RESUME`, `N8N_WH_DEVTEAM_ORCHESTRATOR`  
**Dify Research Section Keys**: `DIFY_KEY_LIBRARIES`, `DIFY_KEY_ARCHITECTURE`, `DIFY_KEY_SECURITY`, `DIFY_KEY_DEPENDENCIES`, `DIFY_KEY_FILE_STRUCTURE`, `DIFY_KEY_TOOLS`, `DIFY_KEY_CONTAINERS`, `DIFY_KEY_INTEGRATION`, `DIFY_KEY_COSTS`, `DIFY_KEY_OPEN_SOURCE_SCAN`, `DIFY_KEY_BEST_PRACTICES`, `DIFY_KEY_UI_UX_RESEARCH`, `DIFY_KEY_PRIOR_ART`  
**Dify Dev-Team Workflow Keys**: `DIFY_KEY_ARCHITECT_DESIGN`, `DIFY_KEY_ARCHITECT_REVISE`, `DIFY_KEY_SECURITY_REVIEW`, `DIFY_KEY_PM_GENERATE_SOW`, `DIFY_KEY_PM_GENERATE_TASKS`, `DIFY_KEY_CODE_REVIEWER`, `DIFY_KEY_FOCUSED_RESEARCH`  
**Persona Q&A System (Dify)**: `DIFY_PERSONA_GENERATE_KEY`, `DIFY_PERSONA_DIGEST_KEY`  
**War Room (Dify)**: `DIFY_PM_WARROOM_KEY`, `DIFY_ARCHITECT_WARROOM_KEY`, `DIFY_SECURITY_WARROOM_KEY`  
**Pipeline Sandbox**: `OPENHANDS_SANDBOX_REPO`, `GITLAB_PROJECTS_GROUP_ID`  
**Nextcloud**: `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD`, `NEXTCLOUD_PUBLIC_URL`  

## Documentation

- [Tool Reference](docs/TOOL_REFERENCE.md) — Complete sub-tool listing per module
- [CLAUDE.md](CLAUDE.md) — Architecture guide and session handoff notes
- [CHANGELOG.md](CHANGELOG.md) — Release history

---

*Auto-generated by `scripts/generate-docs.ts` — do not edit module/env tables manually.*
