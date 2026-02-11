# Homelab MCP Gateway

> **Read this file completely before making any changes.**

## What This Is

Node.js/Express MCP server over streamable HTTP.
Playwright base image. traefik_proxy network. Unraid server.
Public URL: https://mcp.your-domain.com

---

## CRITICAL RULES

### 1. NEVER modify infrastructure outside this project
- Do NOT replace/delete/recreate other Docker containers
- Do NOT touch Unraid apps or other services
- Scope is ONLY /opt/homelab-mcp-gateway/
- **Ask the user before touching other containers**

### 2. NEVER modify Traefik labels
- Cloudflare terminates SSL, forwards to Traefik on port 80 (HTTP)
- Do NOT add entrypoints=https -- the entrypoint is **http**
- Do NOT add tls=true or tls.certresolver
- Only 3 labels needed:
  traefik.enable=true
  traefik.http.routers.mcp-gateway.rule=Host(mcp.your-domain.com)
  traefik.http.services.mcp-gateway.loadbalancer.server.port=3500

### 3. ALL env vars live in .env
- /opt/homelab-mcp-gateway/.env is the **single source of truth**
- Never add environment: block to docker-compose.yml
- Never hardcode secrets in TypeScript source files
- Container started with --env-file /opt/homelab-mcp-gateway/.env

### 4. Deploy via docker build + docker run
- **Unraid does NOT have docker compose** -- it is not installed
- docker-compose.yml exists as reference/documentation only
- Deploy commands:
  cd /opt/homelab-mcp-gateway

**WARNING: Never omit the -l Traefik labels from docker run! Without them, Traefik
cannot route traffic and the gateway becomes unreachable via mcp.your-domain.com.
The -p 3500:3500 flag alone is NOT sufficient -- Traefik labels are REQUIRED.**
  docker build --no-cache -t homelab-mcp-gateway .
  docker stop homelab-mcp-gateway && docker rm homelab-mcp-gateway
  docker run -d --name homelab-mcp-gateway --network traefik_proxy
    --restart unless-stopped --env-file .env
    -l traefik.enable=true
    -l traefik.http.routers.mcp-gateway.rule=Host(mcp.your-domain.com)
    -l traefik.http.services.mcp-gateway.loadbalancer.server.port=3500
    homelab-mcp-gateway

### 5. Ask the user before modifying config files
- .env, docker-compose.yml, Dockerfile, external-mcp.json, package.json
- These files affect the running service and require a rebuild

### 6. Fixed values - do NOT change
- Container name: homelab-mcp-gateway
- Port: 3500
- Network: traefik_proxy
- Public URL: https://mcp.your-domain.com

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

## File Map

| File | Purpose | Env Vars |
|------|---------|----------|
| src/index.ts | Express server, MCP sessions, tool registration | PORT |
| src/tools/gateway.ts | Health checks, status, config | N8N_API_URL, QDRANT_URL, NEO4J_URL |
| src/tools/n8n.ts | n8n workflow management | N8N_API_URL, N8N_API_KEY |
| src/tools/memory.ts | Qdrant vector memory | QDRANT_URL |
| src/tools/graph.ts | Neo4j graph queries + add_observation sub-tool | NEO4J_URL, NEO4J_USER, NEO4J_PASSWORD |
| src/tools/postgres.ts | PostgreSQL queries | POSTGRES_HOST/PORT/USER/PASSWORD/DB |
| src/tools/pgvector.ts | Vector similarity search | POSTGRES_HOST/PORT/USER/PASSWORD/DB |
| src/tools/docker.ts | Docker container management | DOCKER_HOST |
| src/tools/vault.ts | HashiCorp Vault secrets | VAULT_ADDR, VAULT_TOKEN, VAULT_MOUNT |
| src/tools/openrouter.ts | OpenRouter LLM API | OPENROUTER_API_KEY |
| src/tools/github.ts | GitHub API | GITHUB_TOKEN |
| src/tools/playwright.ts | Browser automation | (none) |
| src/tools/external.ts | External MCP proxy | EXTERNAL_MCP_CONFIG |
| src/utils/embeddings.ts | Text embedding utils | (none) |
| src/tools/prometheus.ts | Prometheus monitoring queries | PROMETHEUS_URL |
| src/tools/uptimekuma.ts | Uptime-Kuma monitor management (via REST API wrapper) | UPTIME_KUMA_API_URL, UPTIME_KUMA_API_USER, UPTIME_KUMA_API_PASS |
| src/tools/rabbitmq.ts | RabbitMQ queue/exchange management | RABBITMQ_URL, RABBITMQ_USER, RABBITMQ_PASS |
| src/tools/dify.ts | Dify AI platform (apps, models, tools, knowledge, workflows) | DIFY_API_URL, DIFY_EMAIL, DIFY_PASSWORD |
| src/tools/openhands.ts | OpenHands AI coding agent (conversations, agent control, secrets) | OPENHANDS_URL, OPENHANDS_API_KEY |
| src/tools/traefik.ts | Traefik reverse proxy inspection (routers, services, middleware, diagnostics) | TRAEFIK_API_URL |
| src/tools/redis.ts | Redis cache/broker (key ops, info, keyspace, pub/sub, slowlog) | REDIS_HOST, REDIS_PORT, REDIS_PASSWORD |
| src/tools/mongodb.ts | MongoDB (databases, collections, documents, indexes, aggregation) | MONGODB_URL |
| src/tools/recipes.ts | Container recipes (store/deploy/redeploy/teardown/import templates) | VAULT_ADDR, VAULT_TOKEN, DOCKER_HOST |
| src/tools/blueprints.ts | Blueprint automation system - modular agent framework | (see blueprints config) |
| src/tools/projects.ts | Project pipeline - 30+ sub-tools for dev-team automation (research, architecture, security review, sprints, agent tasks, Dify workflows) | NTFY_URL, NTFY_TOPIC, NTFY_USER, NTFY_PASSWORD, N8N_WEBHOOK_BASE, DIFY_API_BASE, POSTGRES_* |
| src/tools/figma.ts | Figma design files (read files, components, styles, images, comments) | FIGMA_API_KEY |
| src/tools/workspaces.ts | Workspace orchestration (GitLab repos, OpenHands coding, Figma QA) | GITLAB_TOKEN, GITLAB_URL, OPENHANDS_API_KEY, FIGMA_API_KEY |
| src/tools/preferences.ts | Semantic dev preference storage (Qdrant-backed, research pipeline) | QDRANT_URL |

---

## Docker Network Container Names

Container names are CASE-SENSITIVE on Docker networks.

| Service | Container | Internal URL |
|---------|-----------|-------------|
| Qdrant | Qdrant | http://Qdrant:6333 |
| Neo4j | Neo4j | bolt://Neo4j:7687 / http://Neo4j:7474 |
| PostgreSQL | pgvector-18 | postgresql://pgvector-18:5432 |
| n8n | (public URL) | https://n8n.your-domain.com |
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
| GitLab CE | gitlab-ce | http://gitlab-ce:80 |
| Figma API | (external) | https://api.figma.com |
| ntfy | ntfy | http://ntfy:80 |

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
- Neo4j credentials should be configured in .env (NEO4J_USER / NEO4J_PASSWORD)
- external.ts proxies to servers in external-mcp.json (currently context7)
- MCP SDK needs patch (patch-sdk.cjs) for */* Accept headers

---

## Session Handoff

1. Update this CLAUDE.md when making structural changes
2. Store context in Qdrant (memory_call -> store) for decision history
3. Keep CONTRIBUTING.md updated for major additions

**Do NOT assume previous sessions left things working.** Verify:
  docker exec homelab-mcp-gateway env | sort
  curl -s https://mcp.your-domain.com/health
  docker logs homelab-mcp-gateway --tail=20
