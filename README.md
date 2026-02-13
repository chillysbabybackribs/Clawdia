# Clawdia

Clawdia is a local-first AI operator that can browse the web, run shell commands, edit files, and execute multi-step tasks on your machine.

That level of power is the point, and it is why Clawdia is built with runtime guardrails: policy checks, capability gates, checkpoint/rollback hooks, structured audit telemetry, and container-first command execution.

![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

## What It Can Do

- Drive real browser sessions with Playwright (navigate, click, extract, summarize)
- Execute local tools (`shell_exec`, file read/write/edit, process operations)
- Run autonomous task loops with approvals and evidence summaries
- Discover and orchestrate MCP servers
- Produce auditable execution traces across tool, policy, and runtime events

## Security And Control Model

Current build posture (as of February 13, 2026):

- Capability lifecycle controls (`CAPABILITY_MISSING`, `INSTALL_STARTED`, `INSTALL_VERIFIED`, `POLICY_BLOCKED`, etc.)
- Policy engine for allow/rewrite/deny decisions before risky command execution
- Checkpoint/rollback signals for mutating operations
- MCP health telemetry (`MCP_SERVER_HEALTH`) with restart and circuit-breaker behavior
- Container-first execution scaffold for `shell_exec` via `containerExecution` flag, with host fallback

Autonomy modes are configurable in app settings: `safe`, `guided`, `unrestricted`.

## Capability Platform Roadmap Status

Snapshot: February 13, 2026.

| Phase | Status | Notes |
| --- | --- | --- |
| 0. Baseline/contracts | Implemented | Runtime events and IPC schema are active. |
| 1. Capability registry/resolver | Implemented | Command capability resolution is wired. |
| 2. Policy engine (rewrite-first) | Implemented | Allow/rewrite/deny model is enforced pre-execution. |
| 3. Container execution plane | Partial | `shell_exec` container-first path exists; broader routing remains. |
| 4. Install/download orchestrator | Implemented | Missing tools can auto-install and verify by policy. |
| 5. Checkpoint/rollback | Implemented | Pre-mutation checkpoints and rollback signaling are live. |
| 6. MCP runtime manager | Implemented | Discovery, health checks, restart/circuit-breaker behavior ship. |
| 7. UX + telemetry | In progress | Runtime/flags visibility added in settings; feed surfacing continues. |
| 8. Hardening + rollout | In progress | Security/perf hardening and cohort rollout tuning remain. |

## Architecture

- `src/main/`: Electron main process, router/tool loop, browser manager, local tools, capabilities
- `src/main/capabilities/`: registry, policy engine, install orchestrator, checkpointing, MCP runtime, container executor
- `src/renderer/`: chat UI, activity feed, settings
- `src/shared/`: IPC channels and shared types
- `docs/`: implementation notes, audits, planning docs, testing prompts

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

1. Launch the app.
2. Add your Anthropic API key in Settings.
3. Choose your default model.

## MCP Runtime Configuration

Clawdia discovers MCP servers from three sources (first found by name wins):

1. `CLAWDIA_MCP_SERVERS` (JSON)
2. Store key `mcpServers`
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
        "inputSchema": {
          "type": "object",
          "properties": { "q": { "type": "string" } },
          "required": ["q"]
        }
      }
    ]
  }
]
```

## Container Execution (Experimental)

When `containerExecution` is enabled, `shell_exec` tries a container runtime first:

- Runtime detection order: configured runtime, then Docker, then Podman
- Default image: `node:20-bookworm-slim` (override with `CLAWDIA_CONTAINER_IMAGE`)
- If container runtime is unavailable or the command fails, execution falls back to host runtime

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

Release packaging is automated by `.github/workflows/release.yml` for tagged versions.

## Docs Index

See `docs/README.md` for structured links to audits, planning docs, implementation notes, and testing prompts.

## License

MIT (`LICENSE`).
