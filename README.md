# Projects

Personal projects and tools.

## Structure

```
projects/
├── mcp-servers/          # MCP servers for Claude
│   ├── qdrant-memory/    # Semantic memory with local vector DB
│   └── browser-use/      # Browser automation with local LLM
└── ...
```

## MCP Servers

### qdrant-memory

Local vector database for semantic memory storage and retrieval. Features:
- Embedded Qdrant (no Docker)
- Local embeddings (no API keys)
- Passive collection via hooks

See [mcp-servers/qdrant-memory/README.md](mcp-servers/qdrant-memory/README.md) for details.

### browser-use

Browser automation powered by Browser-Use framework and local LLM. Features:
- Natural language browser control
- Web scraping and data extraction
- Uses LM Studio (no API costs)

See [mcp-servers/browser-use/README.md](mcp-servers/browser-use/README.md) for details.
