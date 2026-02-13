# Clawdia

Clawdia is a local-first AI execution platform that can control the browser, terminal, files, and multi-step workflows on your machine.

It is designed around two core principles:
- Full capability on the user's OS (browser, shell, files, processes, MCP tools).
- Optional control model: fully autonomous execution or human-in-the-loop approvals.

![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

## What Clawdia Does

- Runs browser automation with Playwright.
- Executes local commands and file operations.
- Performs multi-step coding and research tasks.
- Orchestrates MCP servers and tool capabilities.
- Produces auditable execution events.

## Autonomy Model

Clawdia supports three operator modes:
- `unrestricted`: executes directly with no per-action prompts.
- `guided`: approval on higher-risk actions.
- `safe`: stricter approval boundaries.

This lets users choose between maximum speed and tighter supervision per workflow.

## Security Model

Clawdia keeps capability high while enforcing runtime boundaries:
- Container-first execution path for command tooling (with controlled fallback).
- Policy engine for allow/rewrite/deny decisions on risky commands.
- Checkpoint and rollback hooks for mutating file operations.
- Evented audit trail for capability, install, policy, and runtime health actions.

## Architecture

- `src/main/`: Electron runtime, tool loop, browser manager, local tools.
- `src/main/capabilities/`: capability registry, policy, install orchestration, checkpoints, container executor, MCP runtime manager.
- `src/renderer/`: chat UI, activity feed, settings.
- `src/shared/`: IPC contracts and shared types.

## Quick Start

```bash
git clone https://github.com/chillysbabybackribs/Clawdia.git
cd Clawdia
npm install
npm run dev
```

## Required Setup

1. Launch the app.
2. Add your Anthropic API key in Settings.
3. Select your default model.

## License

MIT (`LICENSE`).
