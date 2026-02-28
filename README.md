# Velixar MCP Server

[![npm](https://img.shields.io/npm/v/velixar-mcp-server)](https://www.npmjs.com/package/velixar-mcp-server)
[![License](https://img.shields.io/github/license/VelixarAi/velixar-mcp-server)](LICENSE)

MCP server that gives any AI assistant persistent memory via [Velixar](https://velixarai.com). Works with any [Model Context Protocol](https://modelcontextprotocol.io)-compatible client — Claude Desktop, Kiro, Cursor, Windsurf, Continue, or any MCP-enabled tool.

## What It Does

Your AI assistant forgets everything between sessions. This server fixes that. It connects to Velixar's memory API and exposes 5 tools that let your assistant store, search, list, update, and delete memories that persist across conversations.

## Setup

1. Get an API key at [velixarai.com/settings/api-keys](https://velixarai.com/settings/api-keys)

2. Install:
```bash
npm install -g velixar-mcp-server
```

3. Add to your MCP client config:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "velixar": {
      "command": "velixar-mcp-server",
      "env": {
        "VELIXAR_API_KEY": "vlx_your_key_here"
      }
    }
  }
}
```

**Kiro CLI** (`~/.kiro/settings/mcp.json`):
```json
{
  "mcpServers": {
    "velixar": {
      "command": "velixar-mcp-server",
      "env": {
        "VELIXAR_API_KEY": "vlx_your_key_here"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` in your project):
```json
{
  "mcpServers": {
    "velixar": {
      "command": "velixar-mcp-server",
      "env": {
        "VELIXAR_API_KEY": "vlx_your_key_here"
      }
    }
  }
}
```

4. Restart your AI assistant

## Tools

| Tool | Description |
|------|-------------|
| `velixar_store` | Store a memory with optional tags and tier |
| `velixar_search` | Semantic search across memories |
| `velixar_list` | Browse memories with pagination |
| `velixar_update` | Edit an existing memory |
| `velixar_delete` | Delete a memory by ID |

## Memory Tiers

| Tier | Name | Use Case |
|------|------|----------|
| 0 | Pinned | Critical facts, never expire |
| 1 | Session | Current conversation context |
| 2 | Semantic | Long-term memories (default) |
| 3 | Organization | Shared team knowledge |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VELIXAR_API_KEY` | Yes | Your Velixar API key |
| `VELIXAR_API_URL` | No | Custom API endpoint |
| `VELIXAR_USER_ID` | No | User ID for memory scoping (default: `kiro-cli`) |

## Example

Once configured, your AI assistant can:

```
You: Remember that our production database is on us-east-1 and staging is us-west-2
Assistant: ✓ Stored memory

You: Which region is our staging database in?
Assistant: Based on my memory, your staging database is in us-west-2.
```

Memories persist across sessions, restarts, and even different machines — as long as they use the same API key.

## Related

- [velixar (JavaScript SDK)](https://github.com/VelixarAi/velixar-js) — Use Velixar directly in Node.js/TypeScript
- [velixar (Python SDK)](https://github.com/VelixarAi/velixar-python) — Python client with LangChain/LlamaIndex integrations
- [velixarai.com](https://velixarai.com) — Dashboard, API keys, and docs

## License

MIT
