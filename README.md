# Velixar MCP Server

[![npm](https://img.shields.io/npm/v/velixar-mcp-server)](https://www.npmjs.com/package/velixar-mcp-server)
[![License](https://img.shields.io/github/license/VelixarAi/velixar-mcp-server)](LICENSE)

The first cognitive memory server for AI assistants. Not a vector database wrapper — a full reasoning layer that gives your AI persistent memory, a knowledge graph, identity awareness, contradiction detection, and belief tracking across every session.

Works with any [Model Context Protocol](https://modelcontextprotocol.io) client: Claude Desktop, Kiro, Cursor, Windsurf, Continue.dev, or custom hosts.

## Why This Exists

Every AI assistant starts from zero every conversation. Velixar fixes that — but not by just storing and retrieving text. The MCP server gives your assistant the ability to:

- **Orient itself** in a workspace with a single call — no manual context assembly
- **Track how beliefs evolve** over time and surface when they contradict
- **Build and traverse a knowledge graph** of entities and relationships it discovers
- **Maintain a persistent identity model** of who you are, what you prefer, and how you work
- **Distill sessions** into durable memories automatically, with deduplication
- **Import and export** your entire memory corpus for backup or migration

25 tools. 5 live resources. 16 workflow prompts. One `npm install`.

## Quick Start

```bash
npm install -g velixar-mcp-server
```

Get an API key at [velixarai.com/settings/api-keys](https://velixarai.com/settings/api-keys), then add to your MCP client:

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

Restart your assistant. Done.

## Tool Surface

### Memory

| Tool | What it does |
|------|-------------|
| `velixar_store` | Store a memory with tags, tier, and type |
| `velixar_search` | Semantic search across all memories |
| `velixar_list` | Browse with pagination and filtering |
| `velixar_update` | Edit content or tags on an existing memory |
| `velixar_delete` | Remove a memory |

### Cognitive

| Tool | What it does |
|------|-------------|
| `velixar_context` | Synthesized workspace briefing — orientation in one call |
| `velixar_identity` | Get, store, or update the user's profile, preferences, and expertise |
| `velixar_contradictions` | Surface conflicting facts or beliefs with resolution guidance |
| `velixar_timeline` | How a topic or belief evolved over time |
| `velixar_patterns` | Recurring problem/solution motifs across your history |
| `velixar_inspect` | Deep inspection of a specific memory with full provenance chain |
| `velixar_graph_traverse` | Walk entity relationships — "what connects to X?" |
| `velixar_distill` | Extract durable memories from session content with deduplication |

### Lifecycle

| Tool | What it does |
|------|-------------|
| `velixar_session_save` | Save a session summary for later recall |
| `velixar_session_recall` | Restore context from a previous session |
| `velixar_batch_store` | Store up to 20 memories in one call |
| `velixar_batch_search` | Run up to 10 search queries simultaneously |
| `velixar_consolidate` | Merge related memories into a single durable memory |
| `velixar_retag` | Bulk update tags across memories |
| `velixar_export` | Export memories as JSON or Markdown, optionally with graph data |
| `velixar_import` | Bulk import from JSON, Markdown, Notion, or Obsidian exports |

### System

| Tool | What it does |
|------|-------------|
| `velixar_health` | Backend connectivity, latency, workspace status |
| `velixar_debug` | Cache state, circuit breaker, API timings |
| `velixar_capabilities` | Feature list, tool inventory, resource URIs |
| `velixar_security` | Get or set content scanning mode |

## Live Resources

Resources are injected into your assistant's context automatically — no tool call needed.

| Resource | What it provides |
|----------|-----------------|
| `velixar://system/constitution` | Behavioral rules and cognitive modes for the assistant |
| `velixar://identity/current` | Your persistent user profile |
| `velixar://memories/recent` | Most recent memories (compact) |
| `velixar://memories/relevant` | Contextually relevant memories based on current activity |
| `velixar://domains/{domain}/shadow_graph` | Knowledge graph view for a specific domain |

## Workflow Prompts

16 built-in prompts that guide multi-step reasoning workflows:

- **Orientation** — recall prior reasoning, build project context, profile an entity, orient-then-narrow
- **Conflict** — resolve contradictions, identify knowledge gaps
- **Continuity** — trace belief evolution, resume sessions, reconstruct decision paths
- **Lifecycle** — distill sessions, consolidate topic memory, retag recent memories
- **Identity** — summarize user identity, detect preference shifts, align response style
- **Enterprise** — evaluate enterprise fit for a domain

## Workspace Isolation

Memories are scoped to workspaces. Your personal project never bleeds into work.

| Priority | Source | How |
|----------|--------|-----|
| 1 | `VELIXAR_WORKSPACE_ID` env var | Explicit |
| 2 | `.velixar.json` in project root | `{ "workspace_id": "my-project" }` |
| 3 | Git root directory name | Automatic |

## Host Compatibility

| Host | Tools | Resources | Prompts |
|------|-------|-----------|---------|
| Kiro CLI | ✅ | ✅ | ✅ |
| Claude Desktop | ✅ | ✅ | ✅ |
| Cursor | ✅ | ⚠️ | — |
| Windsurf | ✅ | ⚠️ | — |
| Continue.dev | ✅ | ✅ | ✅ |

When a host doesn't support resources or prompts, the server degrades gracefully — all tools still work independently.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VELIXAR_API_KEY` | Yes | Your API key (starts with `vlx_`) |
| `VELIXAR_WORKSPACE_ID` | No | Explicit workspace scope |
| `VELIXAR_API_URL` | No | Custom API endpoint |
| `VELIXAR_USER_ID` | No | User ID for memory scoping |
| `VELIXAR_DEBUG` | No | `true` for verbose logging |
| `VELIXAR_LOG_FORMAT` | No | `json` for structured Datadog/CloudWatch logging |
| `VELIXAR_HEALTH_PORT` | No | Port for HTTP health check endpoint |

## Reliability

- Automatic retry with exponential backoff (3 attempts)
- Circuit breaker — opens after sustained failures, auto-recovers
- Cache fallback — serves stale data during outages rather than failing
- Structured logging compatible with Datadog and CloudWatch

## SDKs

Use Velixar directly from code:

- **JavaScript/TypeScript**: `npm install velixar` — [docs](https://docs.velixarai.com/sdks/javascript)
- **Python**: `pip install velixar` — [docs](https://docs.velixarai.com/sdks/python)

## CI/CD Integration

- **GitHub Actions**: [velixar-memory-sync](github-actions/velixar-memory-sync) — distill PR merges into memories
- **GitHub Actions**: [velixar-decision-capture](github-actions/velixar-decision-capture) — store issue resolutions as decisions
- **Webhook**: `POST /webhook/ci` — generic CI event ingestion

## License

MIT
