# Homelab MCP Gateway

A self-hosted MCP (Model Context Protocol) server that exposes your homelab services to Claude.ai **without OAuth authentication**.

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
// patch-sdk.cjs - see file for full implementation
// Patches the SDK to accept */* Accept header from Claude.ai
```

## Adding Your Own Tools

Tools are registered in `src/tools/`. See `src/tools/example.ts` for the format:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMyTools(server: McpServer) {
  server.tool(
    "tool_name",
    "Description of what this tool does",
    {
      param1: z.string().describe("Parameter description"),
      param2: z.number().optional().describe("Optional parameter"),
    },
    async ({ param1, param2 }) => {
      // Your tool logic here
      const result = { /* ... */ };
      
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
```

Then import and register in `src/index.ts`:

```typescript
import { registerMyTools } from "./tools/my-tools.js";

// In createMcpServer():
registerMyTools(server);
```

## Environment Variables

Create a `.env` file with your service configurations. See `.env.example` for the format.

**Never commit your `.env` file or hardcode secrets in source files.**

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

## License

MIT
