# Velixar MCP Server

MCP server that gives AI assistants persistent memory via Velixar.

## Setup

1. Get an API key from https://velixarai.com/settings/api-keys

2. Install:
```bash
cd /Users/velixarai/velixar-mcp-server
npm install
```

3. Configure Kiro CLI (`~/.kiro/settings/mcp.json`):
```json
{
  "mcpServers": {
    "velixar": {
      "command": "node",
      "args": ["/Users/velixarai/velixar-mcp-server/src/index.js"],
      "env": {
        "VELIXAR_API_KEY": "vlx_your_key_here",
        "VELIXAR_USER_ID": "kiro_session"
      }
    }
  }
}
```

4. Restart Kiro CLI

## Tools

| Tool | Description |
|------|-------------|
| `velixar_store` | Store a memory |
| `velixar_search` | Search memories |
| `velixar_delete` | Delete a memory |

## Usage

Once configured, the AI can:
- Remember facts across sessions
- Store user preferences
- Build context over time
