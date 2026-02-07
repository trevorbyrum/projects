# Homelab MCP Gateway - Claude Code Plugin

This plugin connects Claude Code CLI to your self-hosted Homelab MCP Gateway, giving you access to all your homelab tools directly from the terminal.

## Available Tools

Once connected, you'll have access to:

| Category | Tools |
|----------|-------|
| **Docker** | `docker_list_containers`, `docker_inspect_container`, `docker_logs`, `docker_start`, `docker_stop`, `docker_restart`, `docker_exec`, `docker_list_images`, `docker_pull_image`, `docker_run`, `docker_remove_container`, `docker_list_networks`, `docker_info` |
| **PostgreSQL** | `pg_query`, `pg_execute`, `pg_list_tables`, `pg_describe_table`, `pg_list_indexes` |
| **pgvector** | `vector_create_table`, `vector_create_index`, `vector_insert`, `vector_search`, `vector_get`, `vector_delete`, `vector_count` |
| **Memory (Qdrant)** | `memory_store`, `memory_search`, `memory_list`, `memory_get`, `memory_update`, `memory_delete`, `memory_stats` |
| **Graph (Neo4j)** | `graph_query`, `graph_create_node`, `graph_create_relationship`, `graph_find_nodes`, `graph_get_neighbors`, `graph_delete_node` |
| **n8n** | `n8n_list_workflows`, `n8n_execute_workflow`, `n8n_get_workflow`, `n8n_get_executions` |
| **Vault** | `vault_store_secret`, `vault_get_secret`, `vault_list_secrets`, `vault_delete_secret` |
| **OpenRouter** | `openrouter_list_models`, `openrouter_chat`, `openrouter_second_opinion`, `openrouter_compare`, `openrouter_credits` |
| **Gateway** | `gateway_info`, `gateway_health` |

## Installation

### Option 1: Copy Plugin Directory

Copy this entire `homelab-claude-code-plugin` directory to your Claude Code plugins folder:

```bash
cp -r homelab-claude-code-plugin ~/.claude/plugins/homelab-gateway
```

### Option 2: Manual Setup

1. Create the plugin directory:
```bash
mkdir -p ~/.claude/plugins/homelab-gateway
```

2. Create `.mcp.json` with your gateway URL:
```json
{
  "homelab": {
    "type": "http",
    "url": "https://your-mcp-gateway-domain.com/"
  }
}
```

3. Create `plugin.json`:
```json
{
  "name": "homelab-gateway",
  "version": "1.0.0",
  "description": "Homelab MCP Gateway - Docker, PostgreSQL, Qdrant, Neo4j, n8n, Vault, OpenRouter"
}
```

## Configuration

Edit `~/.claude/plugins/homelab-gateway/.mcp.json` and update the URL to point to your gateway:

```json
{
  "homelab": {
    "type": "http",
    "url": "https://mcp.your-domain.com/"
  }
}
```

## Usage

After installation, restart Claude Code. The homelab tools will be available automatically.

### Example Commands

```
# List running Docker containers
> Use docker_list_containers to show me what's running

# Search semantic memory
> Search my memories for "kubernetes deployment"

# Get a second opinion from GPT-4
> Use openrouter_second_opinion to ask GPT-4 about this code

# Query PostgreSQL
> Run pg_query to show all tables in the database

# Execute an n8n workflow
> Trigger my backup workflow using n8n_execute_workflow
```

## Requirements

- Claude Code CLI installed
- Homelab MCP Gateway running and accessible via HTTPS
- Gateway must have Cloudflare Bot Fight Mode disabled (or bypassed)
- Traefik middleware to strip `WWW-Authenticate` header

## Troubleshooting

### Tools not appearing
- Restart Claude Code after adding the plugin
- Check that the URL in `.mcp.json` is correct and accessible
- Verify the gateway is running: `curl https://your-domain.com/health`

### Connection errors
- Ensure your gateway is on HTTPS with valid certificate
- Check that Cloudflare Bot Fight Mode is disabled for the MCP route
- Verify the `strip-www-auth` middleware is configured in Traefik

### Authentication issues
- The gateway uses authless MCP (no OAuth)
- If you see 401 errors, check your Traefik middleware configuration

## Related

- [Homelab MCP Gateway](../homelab-gateway/) - The server-side gateway code
- [CONTRIBUTING.md](../homelab-gateway/CONTRIBUTING.md) - How to add new tools to the gateway
