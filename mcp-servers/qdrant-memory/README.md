# Qdrant Memory MCP Server

A local vector database MCP server for semantic memory storage and retrieval. Uses embedded Qdrant (no Docker) and local embeddings (no API keys needed).

## Features

- **Semantic search** - Find memories by meaning, not just keywords
- **Local embeddings** - Uses BAAI/bge-small-en-v1.5 (no external API)
- **Embedded Qdrant** - No Docker or external services required
- **Passive collection** - Hooks automatically capture notable information

## Tools

| Tool | Description |
|------|-------------|
| `store_memory` | Store text with tags and metadata |
| `search_memory` | Semantic search across memories |
| `list_memories` | Browse stored items |
| `delete_memory` | Remove specific memories |
| `memory_stats` | Check storage stats |

## Installation

```bash
# Create virtual environment
python3.10+ -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

## Configuration

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "qdrant-memory": {
      "command": "/path/to/venv/bin/python",
      "args": ["/path/to/server.py"]
    }
  }
}
```

## Passive Collection

The `passive_collector.py` script can be used as a Claude Code hook to automatically capture notable information from your workflow.

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/venv/bin/python /path/to/passive_collector.py",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Data Storage

Data is stored locally at `~/.claude-mcp-servers/qdrant-memory/data/qdrant.db`
