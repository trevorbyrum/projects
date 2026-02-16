# Homelab MCP Gateway

> **Read this file completely before making any changes.**

## What This Is

Node.js/Express MCP server over streamable HTTP.
Playwright base image. traefik_proxy network. Unraid server.
Public URL: https://your-domain.com

---

## CRITICAL RULES

### 1. NEVER modify infrastructure outside this project
- Do NOT replace/delete/recreate other Docker containers
- Do NOT touch Unraid apps or other services
- Scope is ONLY /opt/homelab-mcp-gateway/
- **Ask the user before touching other containers**

### 2. NEVER modify Traefik labels
- Cloudflare terminates SSL, forwards to Traefik on port 80 (HTTP)
- Do NOT add entrypoints=https â the entrypoint is **http**
- Do NOT add tls=true or tls.certresolver
- Only 3 labels needed:
  traefik.enable=true
  traefik.http.routers.mcp-gateway.rule=Host(your-domain.com)
  traefik.http.services.mcp-gateway.loadbalancer.server.port=3500

### 3. ALL env vars live in .env
- /opt/homelab-mcp-gateway/.env is the **single source of truth**
- Never add environment: block to docker-compose.yml
- Never hardcode secrets in TypeScript source files
- Container started with --env-file /opt/homelab-mcp-gateway/.env

### 4. Deploy via docker build + docker run
- **Unraid does NOT have docker compose** â it is not installed
- docker-compose.yml exists as reference/documentation only
- Deploy commands:
  cd /opt/homelab-mcp-gateway

**WARNING: Never omit the -l Traefik labels from docker run! Without them, Traefik
cannot route traffic and the gateway becomes unreachable via your-domain.com.
The -p 3500:3500 flag alone is NOT sufficient — Traefik labels are REQUIRED.**
  docker build --no-cache -t homelab-mcp-gateway .
  docker stop homelab-mcp-gateway && docker rm homelab-mcp-gateway
  docker run -d --name homelab-mcp-gateway --network traefik_proxy
    --restart unless-stopped --env-file .env
    -l traefik.enable=true
    -l traefik.http.routers.mcp-gateway.rule=Host(your-domain.com)
    -l traefik.http.services.mcp-gateway.loadbalancer.server.port=3500
    homelab-mcp-gateway

### 5. Ask the user before modifying config files
- .env, docker-compose.yml, Dockerfile, external-mcp.json, package.json
- These files affect the running service and require a rebuild

### 6. Fixed values - do NOT change
- Container name: homelab-mcp-gateway
- Port: 3500
- Network: traefik_proxy
- Public URL: https://your-domain.com

---

## Architecture

Client (Claude Code) --HTTPS--> Cloudflare --HTTP--> Traefik --HTTP--> Gateway:3500
Gateway connects to services on traefik_proxy Docker network.

### Transport
- MCP over streamable HTTP (not SSE, not stdio)
- patch-sdk.cjs patches MCP SDK to accept */* Accept headers
- Sessions managed in-memory (Map of session ID to transport)

### Tool Pattern
Every module exposes {service}_list and {service}_call tools.
_list returns available sub-tools. _call executes them.

### Auto-Enrichment
All writes to Qdrant and Neo4j auto-inject `recorded_at` (ISO 8601 timestamp).
New Neo4j nodes also get an empty `observations: []` array.

---

<!-- AUTO:FILE_MAP_START -->
## File Map

| File | Purpose | Env Vars |
|------|---------|----------|
| src/index.ts | Express server, MCP sessions, tool registration | PORT |
| src/tools/n8n.ts | List all available n8n workflow automation tools and their parameters | N8N_API_KEY, N8N_API_URL |
| src/tools/memory.ts | List all available memory/Qdrant tools and their parameters | (none) |
| src/tools/graph.ts | List all available Neo4j knowledge graph tools | NEO4J_PASSWORD, NEO4J_URL, NEO4J_USER |
| src/tools/gateway.ts | List all available gateway utility tools | N8N_API_KEY, N8N_API_URL, NEO4J_URL, NEO4J_USER, NODE_ENV, QDRANT_URL |
| src/tools/postgres.ts | List all available PostgreSQL database tools and their parameters | (none) |
| src/tools/pgvector.ts | List all available pgvector tools for vector/embedding operations | (none) |
| src/tools/docker.ts | List all available Docker tools and their parameters | DOCKER_HOST |
| src/tools/vault.ts | List all available HashiCorp Vault secrets tools | VAULT_ADDR, VAULT_MOUNT, VAULT_TOKEN, VAULT_UNSEAL_KEY |
| src/tools/openrouter.ts | List all available OpenRouter AI tools for calling other LLMs | PUBLIC_DOMAIN |
| src/tools/github.ts | List all available GitHub tools and their parameters | GITHUB_TOKEN |
| src/tools/playwright.ts | List all available browser automation tools and their parameters | (none) |
| src/tools/monitoring.ts | List all available Prometheus monitoring tools | PROMETHEUS_URL, UPTIME_KUMA_API_PASS, UPTIME_KUMA_API_URL, UPTIME_KUMA_API_USER |
| src/tools/rabbitmq.ts | List all available RabbitMQ message queue tools | RABBITMQ_PASS, RABBITMQ_URL, RABBITMQ_USER |
| src/tools/external.ts | external tools | EXTERNAL_MCP_CONFIG |
| src/tools/dify.ts | List all available Dify AI platform tools. | DIFY_API_URL, DIFY_EMAIL, DIFY_PASSWORD |
| src/tools/openhands.ts | List all available OpenHands AI coding agent tools. | OPENHANDS_API_KEY, OPENHANDS_URL |
| src/tools/traefik.ts | List all available Traefik reverse proxy tools. | TRAEFIK_API_URL |
| src/tools/redis.ts | List all available Redis tools. | REDIS_HOST, REDIS_PASSWORD, REDIS_PORT |
| src/tools/mongodb.ts | List all available MongoDB tools. | MONGODB_URL |
| src/tools/recipes.ts | List all available container recipe tools. | DOCKER_HOST, GITLAB_TOKEN, GITLAB_URL |
| src/tools/blueprints.ts | List all available agent blueprint tools. | N8N_API_KEY, N8N_API_URL, REDIS_HOST, REDIS_PASSWORD, REDIS_PORT |
| src/tools/projects.ts | List all available Project Pipeline tools. | DIFY_AGENT_DISCOVERY_KEY, DIFY_AGENT_LIGHTRAG_KEY, DIFY_AGENT_PROMPT_AUDIT_KEY, DIFY_AGENT_SCAFFOLDING_KEY, DIFY_API_BASE, DIFY_AUTO_GUARDRAILS_KEY, DIFY_AUTO_INTEGRATION_KEY, DIFY_AUTO_TOOLS_KEY, DIFY_AUTO_TRIGGERS_KEY, DIFY_AUTO_WORKFLOW_KEY, DIFY_KEY_ARCHITECTURE, DIFY_KEY_ARCHITECT_DESIGN, DIFY_KEY_ARCHITECT_REVISE, DIFY_KEY_BEST_PRACTICES, DIFY_KEY_CODE_REVIEWER, DIFY_KEY_CONTAINERS, DIFY_KEY_COSTS, DIFY_KEY_DEPENDENCIES, DIFY_KEY_FILE_STRUCTURE, DIFY_KEY_FOCUSED_RESEARCH, DIFY_KEY_INTEGRATION, DIFY_KEY_LIBRARIES, DIFY_KEY_OPEN_SOURCE_SCAN, DIFY_KEY_PM_GENERATE_SOW, DIFY_KEY_PM_GENERATE_TASKS, DIFY_KEY_PRIOR_ART, DIFY_KEY_SECURITY, DIFY_KEY_SECURITY_REVIEW, DIFY_KEY_TOOLS, DIFY_KEY_UI_UX_RESEARCH, DIFY_LAUNCH_DISTRIBUTION_KEY, DIFY_LAUNCH_LANDING_KEY, DIFY_LAUNCH_MARKETPLACE_KEY, DIFY_LAUNCH_PRICING_KEY, DIFY_MARKET_COMPETITORS_KEY, DIFY_MARKET_DEMAND_KEY, DIFY_MARKET_DIFFERENTIATION_KEY, DIFY_MARKET_PRICING_KEY, DIFY_MARKET_STRATEGY_REPORT_KEY, DIFY_MARKET_TAM_KEY, DIFY_MARKET_TIMING_KEY, DIFY_OVERWATCH_CLASSIFY_KEY, DIFY_STRATEGY_BRAND_KEY, DIFY_STRATEGY_CAMPAIGNS_KEY, DIFY_STRATEGY_CHANNELS_KEY, DIFY_STRATEGY_CONTENT_KEY, DIFY_STRATEGY_GTM_KEY, DIFY_STRATEGY_SOCIAL_KEY, GITLAB_PROJECTS_GROUP_ID, N8N_WEBHOOK_BASE, N8N_WH_DEVTEAM_ORCHESTRATOR, N8N_WH_GITLAB_SYNC, N8N_WH_RESEARCH_PIPELINE, N8N_WH_RESEARCH_RESUME, OPENHANDS_SANDBOX_REPO |
| src/tools/figma.ts | List all available Figma design tools | FIGMA_API_KEY |
| src/tools/workspaces.ts | List all available Workspace orchestration tools. | FIGMA_API_KEY, GITHUB_TOKEN, GITLAB_GROUP, GITLAB_REGISTRY_HOST, GITLAB_TOKEN, GITLAB_URL, OPENHANDS_API_KEY, OPENHANDS_SANDBOX_REPO, OPENHANDS_URL, PUBLIC_DOMAIN |
| src/tools/preferences.ts | List all available preference management tools and their parameters | (none) |
| src/tools/persona.ts | List all available persona/mini-me tools. | DIFY_API_BASE, DIFY_PERSONA_DIGEST_KEY, DIFY_PERSONA_GENERATE_KEY |
| src/tools/agentforge.ts | List all available AgentForge tools. | DIFY_API_URL, DIFY_EMAIL, DIFY_PASSWORD, NEO4J_PASSWORD, NEO4J_URL, NEO4J_USER |
| src/tools/war-room.ts | List available War Room tools. | DIFY_API_BASE, DIFY_ARCHITECT_WARROOM_KEY, DIFY_PM_WARROOM_KEY, DIFY_SECURITY_WARROOM_KEY |
| src/tools/gitlab.ts | List all available GitLab tools and their parameters | (none) |
| src/tools/rag-generator.ts | List knowledge builder tools | ALPHA_VANTAGE_API_KEY, CORE_API_KEY, FIRECRAWL_API_KEY, FRED_API_KEY, GITHUB_TOKEN, GOVINFO_API_KEY, GUARDIAN_API_KEY, KB_CURATOR_MODEL, KB_EMBEDDING_MODEL, KB_EMBED_BATCH_SIZE, KB_EVAL_MODEL, KB_INGEST_CONCURRENCY, KB_LOG_DIR, KB_QUEUE_MAX_CONCURRENT, KB_QUEUE_POLL_MS, KB_RESEARCH_MODEL, NEWSAPI_API_KEY, PUBMED_API_KEY, ROLE, SEMANTIC_SCHOLAR_API_KEY |
| src/tools/mm-slash.ts | mm-slash tools | (none) |
| src/tools/nextcloud.ts | List all available Nextcloud tools and their parameters | NEXTCLOUD_APP_PASSWORD, NEXTCLOUD_PUBLIC_URL, NEXTCLOUD_URL, NEXTCLOUD_USER |
| src/tools/mm-notify.ts | Shared Mattermost notification helper | MATTERMOST_URL, MATTERMOST_BOT_TOKEN |
| src/tools/pdf-renderer.ts | PDF generation via Playwright (HTML to PDF) | MATTERMOST_URL, MATTERMOST_BOT_TOKEN |
| src/utils/embeddings.ts | Text embedding utils (all-MiniLM-L6-v2) | (none) |
| src/templates/sow.html | SoW PDF HTML template | - |
| src/templates/sow.css | SoW PDF stylesheet | - |

<!-- AUTO:FILE_MAP_END -->
---

## Docker Network Container Names

Container names are CASE-SENSITIVE on Docker networks.

| Service | Container | Internal URL |
|---------|-----------|-------------|
| Qdrant | Qdrant | http://Qdrant:6333 |
| Neo4j | Neo4j | bolt://Neo4j:7687 / http://Neo4j:7474 |
| PostgreSQL | pgvector-18 | postgresql://pgvector-18:5432 |
| n8n | (public URL) | https://your-domain.com |
| Vault | Vault | http://Vault:8200 |
| Docker API | docker-socket-proxy | http://docker-socket-proxy:2375 |
| Prometheus | Prometheus | http://Prometheus:9090 |
| Grafana | Grafana | http://Grafana:3030 (host port 3030) |
| Alertmanager | Alertmanager | http://Alertmanager:9093 |
| RabbitMQ | RabbitMQ | amqp://RabbitMQ:5672 / http://RabbitMQ:15672 (mgmt) / http://RabbitMQ:15692 (metrics) |
| Uptime-Kuma | uptime-kuma | http://uptime-kuma:3001 |
| Uptime-Kuma API | Uptime-Kuma-API | http://Uptime-Kuma-API:8000 |
| Dify API | dify-api | http://dify-api:5001 |
| Dify Web | dify-web | http://dify-web:3000 |
| Dify Plugin Daemon | dify-plugin-daemon | http://dify-plugin-daemon:5002 |
| Dify PostgreSQL | dify_postgres17 | postgresql://dify_postgres17:5432 |
| OpenHands | openhands | http://openhands:3000 |
| Traefik | traefik | http://traefik:8080 (API) |
| Redis | Redis | redis://Redis:6379 |
| MongoDB | MongoDB | mongodb://MongoDB:27017 |

---

## How to Add a New Tool

1. Create src/tools/yourservice.ts following _list/_call pattern
2. Add import + registerYourServiceTools(server) in src/index.ts
3. Add new env vars to .env
4. Rebuild and deploy (see Critical Rules section)
5. **Update this CLAUDE.md** with new file + env vars

See CONTRIBUTING.md for full template.

---

## Known Issues

- Vault tools fail until user initializes Vault GUI (VAULT_TOKEN empty)
- Neo4j reinstalled; credentials: neo4j/password
- external.ts proxies to servers in external-mcp.json (currently context7)
- MCP SDK needs patch (patch-sdk.cjs) for */* Accept headers

---

## Session Handoff

1. Update this CLAUDE.md when making structural changes
2. Store context in Qdrant (memory_call -> store) for decision history
3. Keep CONTRIBUTING.md updated for major additions

**Do NOT assume previous sessions left things working.** Verify:
  docker exec homelab-mcp-gateway env | sort
  curl -s https://your-domain.com/health
  docker logs homelab-mcp-gateway --tail=20
