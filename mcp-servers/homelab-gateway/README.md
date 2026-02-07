# Homelab MCP Gateway

A self-hosted MCP (Model Context Protocol) server that exposes homelab services to Claude.ai **without OAuth authentication**.

## Features

- **n8n Integration**: List, create, execute, and manage n8n workflows
- **Qdrant Memory**: Semantic memory storage with automatic embeddings (all-MiniLM-L6-v2)
- **Neo4j Graph**: Knowledge graph operations with Cypher query support
- **Gateway Status**: Health checks for all connected services

## The Problem We Solved

Connecting a self-hosted MCP server to Claude.ai's web interface is tricky because Claude.ai will trigger OAuth discovery if certain conditions aren't met. After extensive debugging, we identified **4 critical requirements**:

### 1. Cloudflare Bot Fight Mode Must Be Disabled

Cloudflare's "Super Bot Fight Mode" blocks Claude.ai's MCP client. You must create a security rule to bypass it:

**Cloudflare Dashboard → Security → WAF → Custom Rules**

Create a rule:
- **Name**: `Allow MCP Subdomain`
- **Expression**: `(http.host eq "mcp.yourdomain.com")`
- **Action**: `Skip` → Check all: WAF, Rate Limiting, Bot Fight Mode, etc.

### 2. GET Request Must Return 200 OK

Claude.ai sends a GET request before POST. If it doesn't get 200 OK, it triggers OAuth.

```typescript
// Handle GET request - required for Claude.ai authless
if (req.method === "GET") {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.write(": connected\n\n");
  return;
}
```

### 3. WWW-Authenticate Header Must Be Stripped

If your reverse proxy returns `WWW-Authenticate` headers, Claude.ai interprets this as requiring auth.

**Traefik middleware** (via Docker labels):
```yaml
- "traefik.http.middlewares.mcp-no-auth.headers.customResponseHeaders.WWW-Authenticate="
- "traefik.http.routers.mcp.middlewares=mcp-no-auth"
```

### 4. SDK Accept Header Patch

The MCP SDK rejects `*/*` Accept headers (which Claude.ai sends). Apply this patch after `npm install`:

```javascript
// patch-sdk.cjs
const fs = require('fs');
const FILES = [
  "node_modules/@modelcontextprotocol/sdk/dist/cjs/server/webStandardStreamableHttp.js",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js"
];

for (const FILE of FILES) {
  let content = fs.readFileSync(FILE, 'utf8');
  content = content.replace(
    /if \(!acceptHeader\?\.includes\('application\/json'\) \|\| !acceptHeader\.includes\('text\/event-stream'\)\)/g,
    "if (acceptHeader !== '*/*' && (!acceptHeader?.includes('application/json') || !acceptHeader.includes('text/event-stream')))"
  );
  content = content.replace(
    /if \(!acceptHeader\?\.includes\('text\/event-stream'\)\)/g,
    "if (acceptHeader !== '*/*' && !acceptHeader?.includes('text/event-stream'))"
  );
  fs.writeFileSync(FILE, content);
}
```

## Architecture

```
Claude.ai Web ──► Cloudflare Tunnel ──► Traefik ──► MCP Gateway ──┬──► n8n
                                                                   ├──► Qdrant  
                                                                   └──► Neo4j
```

## Environment Variables

```env
# Server
PORT=3500

# n8n
N8N_API_URL=https://n8n.yourdomain.com
N8N_API_KEY=your-n8n-api-key

# Qdrant
QDRANT_URL=http://qdrant:6333

# Neo4j
NEO4J_URL=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
```

## Deployment

### Docker Build

```bash
docker build -t homelab-mcp-gateway .
```

### Docker Run with Traefik

```bash
docker run -d \
  --name homelab-mcp-gateway \
  --network traefik_proxy \
  --env-file .env \
  -l "traefik.enable=true" \
  -l "traefik.http.routers.mcp.rule=Host(\`mcp.yourdomain.com\`)" \
  -l "traefik.http.routers.mcp.entrypoints=http" \
  -l "traefik.http.services.mcp.loadbalancer.server.port=3500" \
  -l "traefik.http.middlewares.mcp-no-auth.headers.customResponseHeaders.WWW-Authenticate=" \
  -l "traefik.http.routers.mcp.middlewares=mcp-no-auth" \
  homelab-mcp-gateway
```

### With HTTPS (Cloudflare Tunnel recommended)

If using Cloudflare Tunnel, point it to your Traefik instance and the tunnel handles TLS termination.

## Available Tools

### Gateway
- `gateway_status` - Check health of all connected services
- `gateway_config` - Get gateway configuration

### n8n Workflows
- `n8n_list_workflows` - List all workflows
- `n8n_get_workflow` - Get workflow by ID
- `n8n_create_workflow` - Create new workflow
- `n8n_update_workflow` - Update existing workflow
- `n8n_delete_workflow` - Delete workflow
- `n8n_activate_workflow` - Activate workflow
- `n8n_deactivate_workflow` - Deactivate workflow
- `n8n_execute_workflow` - Execute workflow with payload
- `n8n_get_execution` - Get execution details
- `n8n_list_executions` - List execution history

### Qdrant Memory
- `memory_store` - Store content with auto-generated embeddings
- `memory_search` - Semantic search across memories
- `memory_list` - List memories with pagination
- `memory_get` - Get specific memory by ID
- `memory_update` - Update memory content/metadata
- `memory_delete` - Delete memory
- `memory_stats` - Get collection statistics

### Neo4j Graph
- `graph_create_node` - Create node with label and properties
- `graph_create_relationship` - Create relationship between nodes
- `graph_query` - Execute raw Cypher query
- `graph_find_node` - Find nodes by label/properties
- `graph_get_neighbors` - Get connected nodes
- `graph_find_path` - Find shortest path between nodes
- `graph_delete_node` - Delete node and relationships
- `graph_update_node` - Update node properties

## Connecting to Claude.ai

1. Go to Claude.ai Settings → Connectors
2. Add new connector with URL: `https://mcp.yourdomain.com/`
3. It should connect without triggering OAuth

If OAuth is triggered, check:
- Cloudflare security rules are properly configured
- Server responds to GET with 200 OK
- No WWW-Authenticate headers in response

## Troubleshooting

### OAuth Keeps Triggering

1. Check Cloudflare security rules - Bot Fight Mode must be skipped
2. Verify GET returns 200: `curl -I https://mcp.yourdomain.com/`
3. Check for auth headers: `curl -I https://mcp.yourdomain.com/ | grep -i auth`

### Connection Refused

1. Check container is running: `docker ps`
2. Check logs: `docker logs homelab-mcp-gateway`
3. Verify Traefik routing: `curl http://localhost:3500/health`

### Tools Not Showing

1. Verify successful initialize handshake in logs
2. Check that all tool modules are imported in index.ts
3. Ensure services (n8n, Qdrant, Neo4j) are reachable from container

## License

MIT
