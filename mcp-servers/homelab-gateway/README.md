# Homelab MCP Gateway

A Model Context Protocol (MCP) gateway for homelab services, providing a unified interface for AI assistants to interact with your infrastructure.

## Features

- **List/Call Pattern**: Reduces 60+ individual tools to 22 (2 per category)
- **Local Embeddings**: Uses Xenova/transformers with all-MiniLM-L6-v2 (384 dimensions, no API key needed)
- **Headless Browser**: Playwright Chromium for web automation
- **Docker Integration**: Full container management via socket proxy

## Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| `gateway` | 2 | Health checks, configuration |
| `n8n` | 10 | Workflow automation |
| `memory` | 7 | Qdrant vector storage |
| `graph` | 8 | Neo4j knowledge graph |
| `pg` | 5 | PostgreSQL database |
| `vector` | 7 | pgvector embeddings |
| `docker` | 14 | Container management |
| `vault` | 4 | HashiCorp Vault secrets |
| `ai` | 5 | OpenRouter LLM access |
| `github` | 14 | GitHub API |
| `browser` | 13 | Playwright automation |

## Usage Pattern

Each category exposes two tools:
- `{category}_list` - Shows available sub-tools and their parameters
- `{category}_call` - Executes a sub-tool with parameters

```json
// List available memory tools
{ "tool": "memory_list" }

// Store a memory
{ 
  "tool": "memory_call", 
  "params": {
    "tool": "store",
    "params": { "content": "Important note", "category": "notes" }
  }
}
```

## Deployment

### Docker

```bash
docker build -t homelab-mcp-gateway .

docker run -d \
  --name homelab-mcp-gateway \
  --network traefik_proxy \
  -e N8N_API_URL=https://n8n.your-domain.com \
  -e N8N_API_KEY=xxx \
  -e QDRANT_URL=http://Qdrant:6333 \
  -e NEO4J_URL=bolt://Neo4j:7687 \
  -e NEO4J_USER=neo4j \
  -e NEO4J_PASSWORD=xxx \
  -l "traefik.enable=true" \
  -l "traefik.http.routers.mcp.rule=Host(\`mcp.your-domain.com\`)" \
  -l "traefik.http.services.mcp.loadbalancer.server.port=3500" \
  homelab-mcp-gateway
```

### Environment Variables

See `.env.example` for all configuration options.

## Architecture

```
Claude.ai / Claude Mobile
       ↓
mcp.your-domain.com
       ↓
Cloudflare Tunnel
       ↓
Traefik
       ↓
MCP Gateway (this container)
       ↓
┌─────────────────────────────────────┐
│         Docker Network              │
├─────────────────────────────────────┤
│ Qdrant   Neo4j   n8n   pgvector   │
│ Vault    Docker Socket Proxy       │
└─────────────────────────────────────┘
```

## SDK Patch

The `patch-sdk.cjs` script fixes Accept header handling in the MCP SDK to work with Claude.ai's connector.

## License

MIT
