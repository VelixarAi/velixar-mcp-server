# Velixar MCP Server

[![npm](https://img.shields.io/npm/v/velixar-mcp-server)](https://www.npmjs.com/package/velixar-mcp-server)
[![License](https://img.shields.io/github/license/VelixarAi/velixar-mcp-server)](LICENSE)

MCP server that gives any AI assistant persistent, workspace-scoped memory via [Velixar](https://velixarai.com). Works with any [Model Context Protocol](https://modelcontextprotocol.io)-compatible client — Claude Desktop, Kiro, Cursor, Windsurf, Continue, or any MCP-enabled tool.

## What It Does

Your AI assistant forgets everything between sessions. This server fixes that. It connects to Velixar's memory API and exposes tools that let your assistant store, search, list, update, and delete memories that persist across conversations — scoped to your workspace so projects never bleed into each other.

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

## Workspace Isolation

Memories are scoped to workspaces — your personal project memories never bleed into work, and vice versa. The server resolves your workspace automatically:

| Priority | Source | How |
|----------|--------|-----|
| 1 | `VELIXAR_WORKSPACE_ID` env var | Explicit — set in your MCP config |
| 2 | `.velixar.json` in project root | File — add `{ "workspace_id": "my-project" }` |
| 3 | Git root directory name | Automatic — inferred from `git rev-parse --show-toplevel` |

**Recommended:** For most users, the git root inference (priority 3) works automatically. If you need explicit control:

```json
{
  "mcpServers": {
    "velixar": {
      "command": "velixar-mcp-server",
      "env": {
        "VELIXAR_API_KEY": "vlx_your_key_here",
        "VELIXAR_WORKSPACE_ID": "my-project"
      }
    }
  }
}
```

Or create `.velixar.json` in your project root:
```json
{
  "workspace_id": "my-project"
}
```

Use `velixar_debug` to verify which workspace is active and how it was resolved.

## Tools

### Memory CRUD

| Tool | Description |
|------|-------------|
| `velixar_store` | Store a memory with optional tags, tier, and memory type |
| `velixar_search` | Semantic search across memories, filterable by `memory_type` |
| `velixar_list` | Browse memories with pagination, filterable by `memory_type` |
| `velixar_update` | Edit an existing memory's content or tags |
| `velixar_delete` | Delete a memory by ID |

### System

| Tool | Description |
|------|-------------|
| `velixar_health` | Backend connectivity, workspace, latency |
| `velixar_debug` | Cache state, API timings, workspace source |
| `velixar_capabilities` | Enabled features, tool list, security mode |

### Cognitive (coming soon)

| Tool | Description |
|------|-------------|
| `velixar_context` | Synthesized workspace brief — orientation in one call |
| `velixar_identity` | User profile, preferences, expertise, goals |
| `velixar_graph_traverse` | Walk entity relationships — "what connects to X?" |
| `velixar_contradictions` | Surface conflicting beliefs or facts |
| `velixar_timeline` | How a topic or belief evolved over time |
| `velixar_distill` | Extract durable memories from session content |
| `velixar_inspect` | Deep inspection of a specific memory with provenance |
| `velixar_patterns` | Recurring problem/solution motifs |

## Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `semantic` | Durable facts, preferences, decisions | "User prefers Rust over Go" |
| `episodic` | Event-specific, session-bound | "Debugged the auth timeout issue on March 15" |

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
| `VELIXAR_WORKSPACE_ID` | No | Explicit workspace scope (overrides auto-detection) |
| `VELIXAR_API_URL` | No | Custom API endpoint |
| `VELIXAR_USER_ID` | No | User ID for memory scoping (default: `mcp-user`) |
| `VELIXAR_DEBUG` | No | Set to `true` for verbose API logging |

## Response Format

All tools return structured `VelixarResponse<T>` envelopes:

```json
{
  "status": "ok",
  "data": { "items": [...], "count": 5 },
  "meta": {
    "workspace_id": "my-project",
    "confidence": 1,
    "staleness": "fresh",
    "data_absent": false
  }
}
```

## Example

Once configured, your AI assistant can:

```
You: Remember that our production database is on us-east-1 and staging is us-west-2
Assistant: ✓ Stored memory

You: Which region is our staging database in?
Assistant: Based on my memory, your staging database is in us-west-2.
```

Memories persist across sessions, restarts, and even different machines — as long as they use the same API key and workspace.

## Related

- [velixar (JavaScript SDK)](https://github.com/VelixarAi/velixar-js) — Use Velixar directly in Node.js/TypeScript
- [velixar (Python SDK)](https://github.com/VelixarAi/velixar-python) — Python client with LangChain/LlamaIndex integrations
- [velixarai.com](https://velixarai.com) — Dashboard, API keys, and docs

## License

MIT
