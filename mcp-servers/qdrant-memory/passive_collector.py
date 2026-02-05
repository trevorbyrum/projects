#!/usr/bin/env python3
"""
Passive memory collector hook script.
Analyzes tool use context and stores notable information to Qdrant.
"""

import json
import sys
import hashlib
from datetime import datetime
from pathlib import Path

# Add the server directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct
from fastembed import TextEmbedding

# Configuration
DATA_DIR = Path.home() / ".claude-mcp-servers" / "qdrant-memory" / "data"
COLLECTION_NAME = "memories"
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"

# Keywords that suggest something worth remembering
NOTABLE_PATTERNS = [
    "prefer", "always", "never", "convention", "pattern", "architecture",
    "decision", "important", "remember", "note", "config", "setup",
    "environment", "credential", "endpoint", "api", "secret", "key",
    "structure", "layout", "organization", "workflow", "process"
]


def is_notable(content: str) -> bool:
    """Check if content contains notable patterns worth storing."""
    content_lower = content.lower()
    return any(pattern in content_lower for pattern in NOTABLE_PATTERNS)


def extract_notable_info(hook_input: dict) -> str | None:
    """Extract notable information from hook input."""
    tool_name = hook_input.get("tool_name", "")
    tool_input = hook_input.get("tool_input", {})
    tool_response = hook_input.get("tool_response", {})

    # For Write/Edit, check if the file path or content is notable
    if tool_name in ["Write", "Edit"]:
        file_path = tool_input.get("file_path", "")
        content = tool_input.get("content", "") or tool_input.get("new_string", "")

        # Config files are always notable
        if any(cfg in file_path.lower() for cfg in [
            "config", ".env", "settings", "package.json", "tsconfig",
            "dockerfile", "docker-compose", ".claude", "makefile"
        ]):
            return f"Project config: {file_path} was modified"

        # Check content for notable patterns
        if content and is_notable(content):
            # Extract a meaningful snippet
            lines = content.split('\n')[:5]
            snippet = '\n'.join(lines)
            return f"Notable change in {file_path}:\n{snippet[:500]}"

    # For Bash, check for environment/setup commands
    elif tool_name == "Bash":
        command = tool_input.get("command", "")

        # Setup/config commands
        if any(cmd in command.lower() for cmd in [
            "export", "npm init", "pip install", "brew install",
            "git config", "docker", "kubectl", "aws configure"
        ]):
            return f"Environment setup: {command[:200]}"

    return None


def store_memory(content: str, tags: list[str], source: str):
    """Store a memory in Qdrant."""
    client = QdrantClient(path=str(DATA_DIR / "qdrant.db"))

    # Generate embedding
    model = TextEmbedding(model_name=EMBEDDING_MODEL)
    embeddings = list(model.embed([content]))
    embedding = embeddings[0].tolist()

    # Generate ID
    memory_id = hashlib.md5((content + str(datetime.now().timestamp())).encode()).hexdigest()

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
    return memory_id


def main():
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)  # No valid input, exit silently

    # Extract notable information
    notable_info = extract_notable_info(hook_input)

    if notable_info:
        try:
            # Determine tags based on content
            tags = ["auto-captured"]
            tool_name = hook_input.get("tool_name", "").lower()
            if tool_name in ["write", "edit"]:
                tags.append("code-change")
            elif tool_name == "bash":
                tags.append("environment")

            # Store the memory
            memory_id = store_memory(
                content=notable_info,
                tags=tags,
                source="passive-hook"
            )

            # Output for verbose mode
            print(json.dumps({
                "suppressOutput": True,  # Don't clutter the output
            }))
        except Exception as e:
            # Silently fail - don't interrupt the workflow
            pass

    sys.exit(0)


if __name__ == "__main__":
    main()
