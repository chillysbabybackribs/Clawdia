# Clawdia

**A local-first AI workspace for browser, code, and task automation.**

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)
![Claude API](https://img.shields.io/badge/Claude-Sonnet_4-cc785c)
![License](https://img.shields.io/badge/License-MIT-green)

![Clawdia](docs/screenshot.png)
*Chat + browser + local system access in one window.*

## What It Does

Clawdia is a desktop app that gives Claude full control of a real browser and your local filesystem. It can search the web using your logged-in sessions, read and write files, execute shell commands, and automate multi-step workflows through natural conversation. Unlike cloud AI assistants, everything runs locally on your machine with your active browser sessions and cookies. No data leaves your computer except API calls directly to Anthropic.

## Features

| Feature | Details |
|---------|---------|
| Browser Automation | 11 Playwright tools — search, navigate, click, type, scroll, screenshots, multi-tab |
| Local Environment | 6 unrestricted tools — shell exec, file read/write/edit, directory tree, process manager |
| Session Sharing | AI accesses your logged-in accounts — GitHub, Gmail, whatever you're signed into |
| Live Preview | HTML streaming directly into the browser panel as the LLM generates it |
| Self-Modification | The app can edit its own source code through conversation |
| Arcade Mode | Tetris, Pac-Man, and Asteroids in the empty chat panel because why not |

## Requirements

- Node.js 18+
- npm
- An Anthropic API key ([get one here](https://console.anthropic.com))
- Linux, macOS, or Windows (for packaged binaries)

## Install

Download from the latest GitHub Release:

https://github.com/chillysbabybackribs/Clawdia/releases/latest

### Linux

- `Clawdia-<version>.AppImage` (portable)
- `clawdia_<version>_amd64.deb` (Debian/Ubuntu installer)

```bash
chmod +x Clawdia-<version>.AppImage
./Clawdia-<version>.AppImage
```

### macOS

- `Clawdia-<version>.dmg` (drag to Applications)

### Windows

- `Clawdia Setup <version>.exe` (installer)
- `Clawdia <version>.exe` (portable, no install)

## Build From Source

```bash
git clone https://github.com/chillysbabybackribs/Clawdia.git
cd Clawdia
npm install
npm run dev
```

On first launch, Clawdia will ask for your Anthropic API key. It's stored locally on your machine and never transmitted anywhere except directly to the Anthropic API.

## How It Works

Electron hosts a split-panel window. The left panel is the chat interface; the right panel is a Playwright-controlled Chromium browser connected via CDP. When you ask Clawdia to do something, Claude decides which combination of browser and local tools to use, executes them, and streams the results back.

## Architecture

```
┌─────────────────────────────────────────┐
│              Electron Shell             │
├──────────────────┬──────────────────────┤
│   Chat Panel     │   Browser Panel      │
│   (React + CSS)  │   (Playwright/CDP)   │
├──────────────────┴──────────────────────┤
│            Main Process                 │
│   ┌──────────┐  ┌───────────────────┐   │
│   │ LLM API  │  │ Tool Executor     │   │
│   │ (Claude) │  │ 11 browser tools  │   │
│   │          │  │  6 local tools    │   │
│   └──────────┘  └───────────────────┘   │
└─────────────────────────────────────────┘
```

## Configuration

API key is managed through the in-app settings. No `.env` file needed for end users.

## Tech Stack

`Electron · TypeScript · Vite · Playwright · Claude Sonnet 4`

## License

[MIT](LICENSE)

## Credits

Built with [Claude](https://anthropic.com) by Daniel Parker.
