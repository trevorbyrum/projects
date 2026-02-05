#!/usr/bin/env python3
"""
Browser-Use MCP Server
Exposes browser automation capabilities via MCP protocol.
Uses local LLM via LM Studio for intelligent browser control.
"""

import asyncio
import os
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from browser_use import Agent, ChatOpenAI

# Configuration - LM Studio runs OpenAI-compatible API on localhost:1234
LM_STUDIO_BASE_URL = os.environ.get("LM_STUDIO_BASE_URL", "http://localhost:1234/v1")

# Global browser session
_browser_session = None


def get_llm():
    """Get local LLM instance via LM Studio."""
    return ChatOpenAI(
        base_url=LM_STUDIO_BASE_URL,
        api_key="lm-studio",  # LM Studio doesn't need a real key
        model="local-model",  # LM Studio uses whatever model is loaded
        temperature=0,
    )


# MCP Server
server = Server("browser-use")


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="browse",
            description="Execute a browser automation task using natural language. The AI agent will navigate websites, click buttons, fill forms, extract data, etc. Use this for any web interaction task.",
            inputSchema={
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "Natural language description of what to do in the browser. Be specific about the goal. Examples: 'Go to github.com and search for browser-use', 'Fill out the contact form on example.com with name John Doe', 'Extract all product prices from amazon.com/deals'"
                    },
                    "max_steps": {
                        "type": "integer",
                        "description": "Maximum number of browser actions to take (default: 25)",
                        "default": 25
                    }
                },
                "required": ["task"]
            }
        ),
        Tool(
            name="browse_extract",
            description="Navigate to a URL and extract specific information. Returns structured data.",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "URL to navigate to"
                    },
                    "extract": {
                        "type": "string",
                        "description": "What information to extract. Examples: 'all links', 'product names and prices', 'article text', 'form fields'"
                    }
                },
                "required": ["url", "extract"]
            }
        ),
        Tool(
            name="browse_status",
            description="Check browser agent status.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if name == "browse":
            return await browse(arguments)
        elif name == "browse_extract":
            return await browse_extract(arguments)
        elif name == "browse_status":
            return await browse_status(arguments)
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
    except Exception as e:
        import traceback
        return [TextContent(type="text", text=f"Error: {str(e)}\n{traceback.format_exc()}")]


async def browse(args: dict) -> list[TextContent]:
    """Execute a browser automation task."""
    task = args["task"]
    max_steps = args.get("max_steps", 25)

    llm = get_llm()

    agent = Agent(
        task=task,
        llm=llm,
    )

    result = await agent.run(max_steps=max_steps)

    # Format result
    output = f"Task: {task}\n"
    output += f"Completed: {result.is_done()}\n"

    if hasattr(result, 'history') and result.history:
        output += f"\nActions taken: {len(result.history)}\n"

    final = result.final_result()
    if final:
        output += f"\nResult: {final}"

    return [TextContent(type="text", text=output)]


async def browse_extract(args: dict) -> list[TextContent]:
    """Navigate and extract data from a page."""
    url = args["url"]
    extract = args["extract"]

    task = f"Go to {url} and extract the following information: {extract}. Return the extracted data in a structured format."

    llm = get_llm()

    agent = Agent(
        task=task,
        llm=llm,
    )

    result = await agent.run(max_steps=15)

    output = f"URL: {url}\n"
    output += f"Extracted: {extract}\n\n"

    final = result.final_result()
    if final:
        output += f"Data:\n{final}"
    else:
        output += "No data extracted"

    return [TextContent(type="text", text=output)]


async def browse_status(args: dict) -> list[TextContent]:
    """Get browser status."""
    return [TextContent(
        type="text",
        text=f"Browser-Use MCP Server\nLM Studio URL: {LM_STUDIO_BASE_URL}\nStatus: Ready"
    )]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
