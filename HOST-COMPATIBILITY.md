# Velixar MCP Server — Host Compatibility

## Verified Hosts

| Host | Tools | Resources | Prompts | Notes |
|------|-------|-----------|---------|-------|
| Kiro CLI | ✅ | ✅ | ✅ | Primary development host |
| Claude Desktop | ✅ | ✅ | ✅ | Full MCP support |
| Cursor | ✅ | ⚠️ | ❌ | Resources may not auto-inject |
| Windsurf | ✅ | ⚠️ | ❌ | Resources may not auto-inject |
| Continue.dev | ✅ | ✅ | ✅ | Full MCP support |
| Custom hosts | ✅ | Varies | Varies | Depends on MCP SDK version |

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
