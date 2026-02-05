# Projects

Personal projects and tools.

## Structure

```
projects/
├── mcp-servers/          # MCP servers for Claude
│   └── qdrant-memory/    # Semantic memory with local vector DB
└── ...
```

## MCP Servers

### qdrant-memory

Local vector database for semantic memory storage and retrieval. Features:
- Embedded Qdrant (no Docker)
- Local embeddings (no API keys)
- Passive collection via hooks

See [mcp-servers/qdrant-memory/README.md](mcp-servers/qdrant-memory/README.md) for details.
