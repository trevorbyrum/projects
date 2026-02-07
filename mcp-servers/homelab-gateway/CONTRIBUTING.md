# Adding New Tools to the MCP Gateway

This document provides complete instructions for AI agents and developers to add new tools to the homelab MCP gateway.

## Directory Structure

```
/opt/homelab-mcp-gateway/
├── src/
│   ├── index.ts          # Main server - imports and registers all tools
│   └── tools/            # All tool files go here
│       ├── gateway.ts    # System info tools
│       ├── docker.ts     # Docker management
│       ├── postgres.ts   # PostgreSQL queries
│       ├── pgvector.ts   # Vector similarity search
│       ├── vault.ts      # HashiCorp Vault secrets
│       ├── n8n.ts        # n8n workflow automation
│       ├── memory.ts     # Qdrant vector memory
│       ├── graph.ts      # Neo4j graph database
│       ├── openrouter.ts # OpenRouter multi-model API
│       └── [your-tool].ts # <- NEW TOOLS GO HERE
├── .env                  # Environment variables (secrets, API keys)
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Step-by-Step: Adding a New Tool

### 1. Create the Tool File

Create a new file at `/opt/homelab-mcp-gateway/src/tools/[toolname].ts`

**CRITICAL: The file MUST be on the HOST filesystem at `/opt/homelab-mcp-gateway/src/tools/`, NOT inside the container at `/app/src/tools/`. The container's filesystem is ephemeral and gets wiped on rebuild.**

### 2. Tool File Template

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Environment variables - NEVER hardcode secrets
const API_KEY = process.env.YOUR_SERVICE_API_KEY || "";
const SERVICE_URL = process.env.YOUR_SERVICE_URL || "http://service-container:port";

// Helper function for API calls (optional but recommended)
async function serviceRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
  if (!API_KEY) {
    throw new Error("Service not configured - check YOUR_SERVICE_API_KEY env var");
  }
  
  const url = `${SERVICE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Service error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Export a single register function - this is REQUIRED
export function registerYourTools(server: McpServer) {
  
  // Tool 1: Example query tool
  server.tool(
    "your_tool_name",           // Tool name - use snake_case, prefix with service name
    "Description of what this tool does",  // Clear description for the LLM
    {
      // Zod schema for parameters
      param1: z.string().describe("What this parameter is for"),
      param2: z.number().optional().describe("Optional numeric parameter"),
      param3: z.enum(["option1", "option2"]).describe("Constrained options"),
    },
    async ({ param1, param2, param3 }) => {
      try {
        // Your tool logic here
        const result = await serviceRequest("/endpoint", {
          method: "POST",
          body: JSON.stringify({ param1, param2, param3 }),
        });

        // Return successful result
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (error: any) {
        // Return error - ALWAYS handle errors gracefully
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: Another tool in the same file
  server.tool(
    "your_other_tool",
    "Description",
    { /* schema */ },
    async (params) => { /* implementation */ }
  );
}
```

### 3. Update index.ts

Edit `/opt/homelab-mcp-gateway/src/index.ts`:

**Add the import at the top with the other imports:**
```typescript
import { registerYourTools } from "./tools/your-tool.js";  // Note: .js extension!
```

**Add the registration call inside `createMcpServer()` function:**
```typescript
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "Homelab Gateway",
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
  registerYourTools(server);  // <- ADD YOUR REGISTRATION HERE

  return server;
}
```

### 4. Add Environment Variables

Edit `/opt/homelab-mcp-gateway/.env` and add any required secrets:

```bash
# Your Service
YOUR_SERVICE_API_KEY=your-api-key-here
YOUR_SERVICE_URL=http://container-name:port
```

**NEVER put secrets in the TypeScript files. Always use environment variables.**

### 5. Install Dependencies (if needed)

If your tool needs npm packages:

```bash
cd /opt/homelab-mcp-gateway
npm install package-name
```

The package.json will be updated automatically.

### 6. Build and Deploy

```bash
cd /opt/homelab-mcp-gateway

# Rebuild the Docker image
docker build -t homelab-mcp-gateway .

# Stop and remove old container
docker stop homelab-mcp-gateway
docker rm homelab-mcp-gateway

# Start new container with all labels and env
docker run -d \
  --name homelab-mcp-gateway \
  --network traefik_proxy \
  --restart always \
  --env-file /opt/homelab-mcp-gateway/.env \
  -l "traefik.enable=true" \
  -l "traefik.http.routers.mcp-gateway.rule=Host(\`your-domain.com\`)" \
  -l "traefik.http.routers.mcp-gateway.entrypoints=websecure" \
  -l "traefik.http.routers.mcp-gateway.tls.certresolver=letsencrypt" \
  -l "traefik.http.services.mcp-gateway.loadbalancer.server.port=3500" \
  -l "traefik.http.routers.mcp-gateway.middlewares=strip-www-auth@file" \
  homelab-mcp-gateway
```

### 7. Verify Deployment

```bash
# Check container is running
docker ps | grep mcp-gateway

# Check for startup errors
docker logs homelab-mcp-gateway

# Test health endpoint
curl https://your-domain.com/health
```

## Naming Conventions

- **Tool names**: `servicename_action` (e.g., `vault_get_secret`, `docker_list_containers`)
- **File names**: `servicename.ts` (e.g., `vault.ts`, `docker.ts`)
- **Function names**: `registerServicenameTools` (e.g., `registerVaultTools`)
- **Use snake_case for tool names** (what Claude sees)
- **Use camelCase for TypeScript functions**

## Common Patterns

### Connecting to Docker containers on the same network

Services on the `traefik_proxy` network can reach each other by container name:
- `http://qdrant:6333` - Qdrant vector DB
- `http://neo4j:7474` - Neo4j graph DB
- `http://n8n:5678` - n8n automation
- `http://Vault:8200` - HashiCorp Vault
- `http://pgvector-18:5432` - PostgreSQL with pgvector
- `http://docker-socket-proxy:2375` - Docker API

### Error Handling

Always wrap async operations in try/catch and return `isError: true`:

```typescript
try {
  const result = await someOperation();
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
} catch (error: any) {
  return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
}
```

### Zod Schema Types

```typescript
z.string()                        // Required string
z.string().optional()             // Optional string
z.string().default("value")       // String with default
z.number()                        // Required number
z.number().min(1).max(100)        // Number with constraints
z.boolean()                       // Boolean
z.enum(["a", "b", "c"])           // Enum/union
z.array(z.string())               // Array of strings
z.record(z.string())              // Object with string values
z.object({ key: z.string() })     // Nested object
```

Always add `.describe("...")` to parameters so Claude understands what they're for.

## Troubleshooting

### Build fails with TypeScript errors
- Check import paths use `.js` extension (not `.ts`)
- Ensure all exported function names match imports
- Verify Zod schemas are valid

### Container starts but tools don't appear
- Check `docker logs homelab-mcp-gateway` for errors
- Verify the register function is called in index.ts
- Make sure file is in `/opt/homelab-mcp-gateway/src/tools/` (host path, not container)

### Tools appear but fail at runtime
- Check environment variables are set in `.env`
- Verify the target service container is running and on `traefik_proxy` network
- Test connectivity: `docker exec homelab-mcp-gateway wget -qO- http://service:port/health`

## Quick Reference

| Step | Command/Location |
|------|------------------|
| Create tool file | `/opt/homelab-mcp-gateway/src/tools/[name].ts` |
| Add import | `src/index.ts` - top of file |
| Register tools | `src/index.ts` - inside `createMcpServer()` |
| Add secrets | `/opt/homelab-mcp-gateway/.env` |
| Install packages | `cd /opt/homelab-mcp-gateway && npm install [pkg]` |
| Build | `docker build -t homelab-mcp-gateway .` |
| Deploy | `docker stop/rm/run` commands above |
| Check logs | `docker logs homelab-mcp-gateway` |
