# Velixar MCP Server — Host Compatibility

## Verified Hosts

| Host | Tools | Resources | Prompts | Notes |
|------|-------|-----------|---------|-------|
| Kiro CLI | ✅ | ✅ | ✅ | Primary development host |
| Claude Desktop | ✅ | ✅ | ✅ | Full MCP support |
| Cursor | ✅ | ⚠️ | ❌ | Tools work. Resources not auto-injected — use velixar_context instead. Prompts not supported. |
| Windsurf | ✅ | ⚠️ | ❌ | Same as Cursor — tools-only mode works well. |
| Continue.dev | ✅ | ✅ | ✅ | Full MCP support |
| Custom hosts | ✅ | Varies | Varies | Depends on MCP SDK version |

## JetBrains Plugin Feasibility

JetBrains IDEs (IntelliJ, PyCharm, WebStorm, etc.) do not natively support MCP as of 2026-Q1.
Options for JetBrains integration:

1. **JetBrains AI Assistant plugin** — Does not support custom MCP servers yet. Monitor for MCP support.
2. **Continue.dev JetBrains plugin** — Supports MCP servers. This is the recommended path.
3. **Custom plugin** — Feasible but high effort. Would need to implement MCP client in Kotlin/Java.

**Recommendation:** Use Continue.dev's JetBrains plugin for MCP support. Defer custom plugin until JetBrains adds native MCP support.

## Graceful Degradation

When a host doesn't support resources or prompts, Velixar degrades gracefully:

- **No resources support:** Tools still work. Context, identity, and constitution are available via `velixar_context`, `velixar_identity`, and `velixar_capabilities` tools instead.
- **No prompts support:** Workflow prompts are not available, but all tools work independently. Users can manually follow the workflow patterns described in tool descriptions.
- **No tools support:** Not a valid MCP host. Velixar requires tool support.

## Workspace Detection

Works across all hosts:
1. `VELIXAR_WORKSPACE_ID` env var (highest priority)
2. `.velixar.json` in project root
3. Git root directory name
4. Falls back to API key workspace binding

## Configuration

All hosts use the same MCP server configuration:

```json
{
  "mcpServers": {
    "velixar": {
      "command": "node",
      "args": ["/path/to/velixar-mcp-server/dist/server.js"],
      "env": { "VELIXAR_API_KEY": "vlx_..." }
    }
  }
}
```
