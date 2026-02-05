#!/usr/bin/env python3
"""
Qdrant Memory MCP Server
A local vector database for semantic memory storage and retrieval.
Uses embedded Qdrant (no Docker) and local embeddings (no API keys).
"""

import json
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue
from fastembed import TextEmbedding

# Configuration
DATA_DIR = Path.home() / ".claude-mcp-servers" / "qdrant-memory" / "data"
COLLECTION_NAME = "memories"
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"  # Fast, good quality, 384 dims
EMBEDDING_DIM = 384

# Initialize
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Lazy initialization for embedding model and client
_embedding_model = None
_qdrant_client = None


def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        _embedding_model = TextEmbedding(model_name=EMBEDDING_MODEL)
    return _embedding_model


def get_qdrant_client():
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = QdrantClient(path=str(DATA_DIR / "qdrant.db"))
        # Ensure collection exists
        collections = _qdrant_client.get_collections().collections
        if not any(c.name == COLLECTION_NAME for c in collections):
            _qdrant_client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
            )
    return _qdrant_client


def embed_text(text: str) -> list[float]:
    """Generate embedding for text."""
    model = get_embedding_model()
    embeddings = list(model.embed([text]))
    return embeddings[0].tolist()


def generate_id(content: str) -> str:
    """Generate a unique ID from content."""
    return hashlib.md5(content.encode()).hexdigest()


# MCP Server
server = Server("qdrant-memory")


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="store_memory",
            description="Store a piece of information in long-term memory. Use this to remember facts, context, code snippets, user preferences, or anything worth recalling later. Memories are searchable by semantic similarity.",
            inputSchema={
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The content to remember. Can be any text: facts, code, conversations, notes."
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional tags for categorization (e.g., ['code', 'python'], ['preference', 'user'])"
                    },
                    "source": {
                        "type": "string",
                        "description": "Optional source identifier (e.g., 'conversation', 'file:/path', 'url:...')"
                    }
                },
                "required": ["content"]
            }
        ),
        Tool(
            name="search_memory",
            description="Search memories by semantic similarity. Returns memories most relevant to your query. Use this to recall information, find related context, or check if something was discussed before.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for. Can be a question, topic, or concept."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 5)",
                        "default": 5
                    },
                    "tag": {
                        "type": "string",
                        "description": "Optional: filter by tag"
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="list_memories",
            description="List recent memories, optionally filtered by tag. Use this to browse what's been stored.",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 10)",
                        "default": 10
                    },
                    "tag": {
                        "type": "string",
                        "description": "Optional: filter by tag"
                    }
                }
            }
        ),
        Tool(
            name="delete_memory",
            description="Delete a specific memory by its ID.",
            inputSchema={
                "type": "object",
                "properties": {
                    "memory_id": {
                        "type": "string",
                        "description": "The ID of the memory to delete"
                    }
                },
                "required": ["memory_id"]
            }
        ),
        Tool(
            name="memory_stats",
            description="Get statistics about stored memories.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if name == "store_memory":
            return await store_memory(arguments)
        elif name == "search_memory":
            return await search_memory(arguments)
        elif name == "list_memories":
            return await list_memories(arguments)
        elif name == "delete_memory":
            return await delete_memory(arguments)
        elif name == "memory_stats":
            return await memory_stats(arguments)
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {str(e)}")]


async def store_memory(args: dict) -> list[TextContent]:
    content = args["content"]
    tags = args.get("tags", [])
    source = args.get("source", "manual")

    client = get_qdrant_client()
    embedding = embed_text(content)

    memory_id = generate_id(content + str(datetime.now().timestamp()))

    point = PointStruct(
        id=memory_id,
        vector=embedding,
        payload={
            "content": content,
            "tags": tags,
            "source": source,
            "created_at": datetime.now().isoformat(),
        }
    )

    client.upsert(collection_name=COLLECTION_NAME, points=[point])

    return [TextContent(
        type="text",
        text=f"Stored memory with ID: {memory_id}\nTags: {tags}\nContent preview: {content[:100]}..."
    )]


async def search_memory(args: dict) -> list[TextContent]:
    query = args["query"]
    limit = args.get("limit", 5)
    tag_filter = args.get("tag")

    client = get_qdrant_client()
    query_embedding = embed_text(query)

    search_filter = None
    if tag_filter:
        search_filter = Filter(
            must=[FieldCondition(key="tags", match=MatchValue(value=tag_filter))]
        )

    results = client.search(
        collection_name=COLLECTION_NAME,
        query_vector=query_embedding,
        limit=limit,
        query_filter=search_filter,
    )

    if not results:
        return [TextContent(type="text", text="No memories found matching your query.")]

    output = f"Found {len(results)} relevant memories:\n\n"
    for i, result in enumerate(results, 1):
        payload = result.payload
        output += f"--- Memory {i} (score: {result.score:.3f}) ---\n"
        output += f"ID: {result.id}\n"
        output += f"Tags: {payload.get('tags', [])}\n"
        output += f"Source: {payload.get('source', 'unknown')}\n"
        output += f"Created: {payload.get('created_at', 'unknown')}\n"
        output += f"Content:\n{payload.get('content', '')}\n\n"

    return [TextContent(type="text", text=output)]


async def list_memories(args: dict) -> list[TextContent]:
    limit = args.get("limit", 10)
    tag_filter = args.get("tag")

    client = get_qdrant_client()

    scroll_filter = None
    if tag_filter:
        scroll_filter = Filter(
            must=[FieldCondition(key="tags", match=MatchValue(value=tag_filter))]
        )

    results, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        limit=limit,
        with_payload=True,
        with_vectors=False,
        scroll_filter=scroll_filter,
    )

    if not results:
        return [TextContent(type="text", text="No memories stored yet.")]

    output = f"Listing {len(results)} memories:\n\n"
    for i, point in enumerate(results, 1):
        payload = point.payload
        content_preview = payload.get('content', '')[:150]
        output += f"{i}. [{point.id}]\n"
        output += f"   Tags: {payload.get('tags', [])}\n"
        output += f"   Created: {payload.get('created_at', 'unknown')}\n"
        output += f"   Preview: {content_preview}...\n\n"

    return [TextContent(type="text", text=output)]


async def delete_memory(args: dict) -> list[TextContent]:
    memory_id = args["memory_id"]

    client = get_qdrant_client()
    client.delete(
        collection_name=COLLECTION_NAME,
        points_selector=[memory_id],
    )

    return [TextContent(type="text", text=f"Deleted memory: {memory_id}")]


async def memory_stats(args: dict) -> list[TextContent]:
    client = get_qdrant_client()

    collection_info = client.get_collection(COLLECTION_NAME)

    output = f"Memory Statistics:\n"
    output += f"- Total memories: {collection_info.points_count}\n"
    output += f"- Vector dimension: {EMBEDDING_DIM}\n"
    output += f"- Embedding model: {EMBEDDING_MODEL}\n"
    output += f"- Storage path: {DATA_DIR / 'qdrant.db'}\n"

    return [TextContent(type="text", text=output)]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
