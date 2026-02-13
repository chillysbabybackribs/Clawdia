# Clawdia

Local-first AI workspace for browser automation, coding workflows, and autonomous task execution.

![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

## What Clawdia Does

Clawdia combines an AI chat loop with real runtime control:
- Browser automation with Playwright and tab/state management
- Local tools (`shell_exec`, file read/write/edit, process tools)
- Document creation and extraction workflows
- Task scheduling/execution with approvals and audit trail
- Capability platform for installs, policy checks, rollback signals, and runtime observability

## Capability Platform (Current)

Recent platform work is now integrated and evented end-to-end:
- Capability lifecycle events (`CAPABILITY_MISSING`, `INSTALL_STARTED`, `INSTALL_VERIFIED`, `POLICY_BLOCKED`, etc.)
- Task evidence summary emission (`TASK_EVIDENCE_SUMMARY`) from tool-loop completion
- MCP runtime health events (`MCP_SERVER_HEALTH`) with restart/circuit-breaker behavior
- MCP server discovery (env, store, and config file)
- Container execution scaffold for `shell_exec` behind `containerExecution` flag, with host fallback

## Architecture

- `src/main/`: Electron main process, tool loop, browser manager, local tools, capabilities
- `src/renderer/`: chat UI, activity feed/pulse, settings
- `src/shared/`: IPC channels and shared types
- `src/main/capabilities/`: registry, policy engine, install orchestrator, checkpointing, MCP runtime, container executor

## Quick Start

```bash
git clone https://github.com/chillysbabybackribs/Clawdia.git
cd Clawdia
npm install
npm run dev
```

Build artifacts:

```bash
npm run build
npm run dist:linux
npm run dist:mac
npm run dist:win
```

## Required Setup

1. Launch app
2. Add Anthropic API key in Settings
3. Select your default model

## Autonomy and Safety Model

Clawdia is designed for low-friction execution and uses runtime boundaries rather than prompt-only gating:
- Policy checks + rewrites for risky commands
- Capability install orchestration with trust-policy modes
- Checkpoint/rollback signaling for mutating operations
- Structured audit events for forensics and debugging

Autonomy modes are configurable in app settings (`safe`, `guided`, `unrestricted`).

## MCP Runtime Configuration

Clawdia discovers MCP servers from three sources (first found by name wins):
1. `CLAWDIA_MCP_SERVERS` (JSON)
2. store key `mcpServers`
3. `mcp-servers.json` in the same app config directory as `config.json` (override with `CLAWDIA_MCP_SERVERS_FILE`)

Example JSON:

```json
[
  {
    "name": "search-agent",
    "command": "node",
    "args": ["/absolute/path/to/server.js"],
    "tools": [
      {
        "name": "search_docs",
        "description": "Search internal docs",
        "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] }
      }
    ]
  }
]
```

## Container Execution (Experimental)

When capability flag `containerExecution` is enabled, `shell_exec` attempts container runtime first:
- Runtime detection order: configured runtime, then Docker, then Podman
- Default image: `node:20-bookworm-slim` (override via `CLAWDIA_CONTAINER_IMAGE`)
- If container runtime is unavailable or command fails, execution falls back to host runtime automatically

Optional env vars:
- `CLAWDIA_CONTAINER_RUNTIME=docker|podman`
- `CLAWDIA_CONTAINER_IMAGE=<image>`

## Development Notes

Useful commands:

```bash
npm test
npx tsc -p tsconfig.main.json --noEmit
npm run smoke:electron
npm run release:check
```

GitHub release packaging is automated by `.github/workflows/release.yml` for tagged versions.

## License

MIT (`LICENSE`).
