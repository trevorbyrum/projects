# Adding New Tools to the MCP Gateway

## Directory Structure

src/index.ts - Main server, imports and registers all tools
src/tools/*.ts - All tool modules
src/utils/ - Shared utilities
.env - ALL env vars (single source of truth)
docker-compose.yml - Reference config (Unraid has no docker compose)
Dockerfile - Playwright base image
patch-sdk.cjs - MCP SDK Accept-header patch
external-mcp.json - External MCP server config

## Tool File Pattern

Every module exports a register function and exposes _list + _call tools.
See any existing file in src/tools/ for the pattern.

1. Create src/tools/yourservice.ts
2. Export registerYourServiceTools(server: McpServer)
3. Add import + registration call in src/index.ts (.js extension!)
4. Add env vars to .env
5. Update CLAUDE.md with new file and env vars

## Deploy

**Unraid does NOT have docker compose. Use docker build + docker run.**

  cd /opt/homelab-mcp-gateway
  docker build --no-cache -t homelab-mcp-gateway .
  docker stop homelab-mcp-gateway && docker rm homelab-mcp-gateway
  docker run -d --name homelab-mcp-gateway --network traefik_proxy
    --restart unless-stopped
    --env-file /opt/homelab-mcp-gateway/.env
    -l traefik.enable=true
    -l traefik.http.routers.mcp-gateway.rule=Host(your-domain.com)
    -l traefik.http.services.mcp-gateway.loadbalancer.server.port=3500
    homelab-mcp-gateway

## WARNING - Traefik Labels

Cloudflare terminates SSL, forwards to Traefik on port 80 (HTTP).
Do NOT add entrypoints=https, tls=true, or tls.certresolver.
The 3 labels above are all that are needed.

## Network Container Names

| Service | Container | URL |
|---------|-----------|-----|
| Qdrant | Qdrant | http://Qdrant:6333 |
| Neo4j | Neo4j | bolt://Neo4j:7687 |
| PostgreSQL | pgvector-18 | postgresql://pgvector-18:5432 |
| n8n | (public) | https://your-domain.com |
| Vault | Vault | http://Vault:8200 |
| Docker | docker-socket-proxy | http://docker-socket-proxy:2375 |
| Dify API | dify-api | http://dify-api:5001 |
| Dify Web | dify-web | http://dify-web:3000 |
| OpenHands | openhands | http://openhands:3000 |
| Traefik | traefik | http://traefik:8080 (API) |
| Redis | Redis | redis://Redis:6379 |
| MongoDB | MongoDB | mongodb://MongoDB:27017 |
