# Browser-Use MCP Server

Browser automation MCP server powered by [Browser-Use](https://github.com/browser-use/browser-use) and local LLM via LM Studio.

## Features

- Natural language browser control
- Web scraping and data extraction
- Form filling and interaction
- Uses local LLM (no API costs)

## Requirements

- Python 3.10+
- LM Studio running with a model loaded
- Recommended model: `qwen/qwen3-coder-30b` (tool use + 262K context)

## Installation

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Configuration

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "/path/to/venv/bin/python",
      "args": ["/path/to/server.py"],
      "env": {
        "LM_STUDIO_BASE_URL": "http://localhost:1234/v1"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `browse` | Execute browser tasks via natural language |
| `browse_extract` | Navigate to URL and extract specific data |
| `browse_status` | Check server status |

## Usage Examples

```
browse: "Go to github.com and search for browser-use"
browse: "Log into example.com with username test@test.com"
browse_extract: url="https://news.ycombinator.com" extract="top 5 story titles"
```

## Model Recommendations

For best results, use a model with:
- Tool/function calling support
- Large context window (DOM parsing needs it)
- Good instruction following

Recommended: Qwen3-Coder-30B, Llama-3.3-70B-Instruct
