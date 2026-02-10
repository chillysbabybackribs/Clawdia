# Clawdia

**A local-first AI workspace for browser, code, and task automation.**

![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Claude API](https://img.shields.io/badge/Claude-Multi--model-cc785c)
![License](https://img.shields.io/badge/License-MIT-green)

![Clawdia](docs/screenshot.png)ctrl+a# Clawdia

**A local-first AI workspace for browser automation, code analysis, and task automation.**

![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Claude API](https://img.shields.io/badge/Claude-Multi--model-cc785c)
![License](https://img.shields.io/badge/License-MIT-green)

*An AI assistant with full control of your browser, files, and local development environment.*

## What It Is

Clawdia is a desktop AI workspace that combines:
- **Real browser control** — AI automates searches, navigation, form filling, and data extraction
- - **Local filesystem access** — Read, write, and modify files with reversible action plans
  - - **Shell execution** — Run commands, manage processes, and develop software
    - - **Your logged-in sessions** — AI uses your GitHub, Gmail, and other authenticated accounts
      - - **Knowledge vault** — Ingest documents to teach the AI about your code, docs, and projects
        - - **Multi-turn reasoning** — Complex tasks with up to 150 tool calls per conversation
         
          - Everything runs locally. Your code, files, and browser sessions never leave your machine—only API calls go to Anthropic.
         
          - ## Architecture
         
          - ```
            ┌─ Electron Main Process ─────────────────────────┐
            │  • Conversation management                      │
            │  • Tool execution (browser + local)             │
            │  • Knowledge vault (SQLite)                     │
            │  • Learning system (site knowledge, user mem.)  │
            │  • Action plans (reversible file ops)           │
            │  • Browser lifecycle (Playwright)               │
            └─────────────────────────────────────────────────┘
                    ↓                          ↓
                ┌─ Renderer (React) ─┐  ┌─ Playwright Browser ─┐
                │  Chat UI           │  │  Real Chrome/Chromium │
                │  Settings          │  │  CDP remote debug     │
                │  Vault browser     │  │  Tab management       │
                └────────────────────┘  └───────────────────────┘
                    ↑↓ IPC
                ┌─ Claude API ─────────────────────────────────┐
                │  Streaming messages, tool decisions          │
                │  Models: Sonnet 4, Opus 4, Haiku 4          │
                └─────────────────────────────────────────────┘
            ```

            ## Key Features

            | Feature | Details |
            |---------|---------|
            | **Browser Tools** | navigate, search, click, type, scroll, screenshots, form filling, multi-tab control, batch extraction, visual OCR |
            | **Local Tools** | Shell execution, file read/write/edit, directory tree, process management |
            | **Knowledge Vault** | Index documents (TXT, MD, PDF, DOCX) and search during conversations for context |
            | **Learning System** | Persistent user memory and site-specific knowledge (authentication rules, UI patterns, quirks) |
            | **Action Plans** | Create, execute, and undo file operations safely with transaction support |
            | **Session Access** | AI can use your logged-in GitHub, Twitter, Gmail, etc.—no re-authentication needed |
            | **Document Extraction** | Extract content from web pages as markdown, JSON, or structured data |
            | **Document Creation** | Generate DOCX, PDF, XLSX, CSV, HTML, JSON, MD, TXT files |
            | **Live HTML Preview** | Stream HTML directly into a browser panel for instant UI visualization |
            | **Multi-Model Support** | Switch between Claude Sonnet, Opus, and Haiku |
            | **Search Strategy** | Intent classification, search cache, fallback strategies for blocked sites |
            | **Account Tracking** | Detect logged-in accounts across platforms during browsing |
            | **Dashboard** | Suggestion system for optimizing future interactions |

            ## Installation

            ### Prerequisites
            - Node.js 18+
            - - Electron build tools (`electron-rebuild` installed via postinstall)
              - - macOS 10.15+, Windows 7+, or Linux (Ubuntu 16.04+)
               
                - ### Build from Source
               
                - ```bash
                  git clone https://github.com/chillysbabybackribs/Clawdia.git
                  cd Clawdia
                  npm install
                  npm run dev
                  ```

                  For production builds:
                  ```bash
                  npm run build
                  npm run dist          # Creates installer/AppImage
                  npm run dist:linux    # Linux AppImage
                  npm run dist:mac      # macOS DMG
                  npm run dist:win      # Windows EXE
                  ```

                  ## Configuration

                  ### API Key
                  Set your Anthropic API key in **Settings** → **API Key**. Required to use the AI.

                  ### Model Selection
                  Choose your Claude model in **Settings** → **Model**:
                  - `claude-opus-4-20250805` (most capable, 200k context)
                  - - `claude-sonnet-4-20250514` (default, balanced, 200k context)
                    - - `claude-haiku-4-20250307` (fastest, lightweight tasks)
                     
                      - ### Knowledge Vault
                      - 1. Open **Vault** tab in the sidebar
                        2. 2. Click **Ingest** and select documents (TXT, MD, PDF, DOCX)
                           3. 3. The AI will search the vault automatically when relevant
                              4. 4. Vault is local SQLite at `~/.config/Clawdia/clawdia_vault/vault.db`
                                
                                 5. ### Learning System
                                 6. The learning system stores two types of data in `~/.config/Clawdia/config.json`:
                                 7. - **User memory** — Things you tell the AI to remember across conversations
                                    - - **Site knowledge** — Authentication patterns, UI rules, quirks discovered for specific domains
                                     
                                      - You can view and edit site knowledge directly in the UI under **Settings** → **Site Knowledge**.
                                     
                                      - ## Development
                                     
                                      - ### Project Structure
                                      - ```
                                        src/
                                        ├── main/                          # Electron main process
                                        │   ├── llm/                       # LLM + tool execution
                                        │   │   ├── client.ts              # Anthropic SDK wrapper
                                        │   │   ├── tool-loop.ts           # Main tool execution loop (150 calls max)
                                        │   │   ├── conversation.ts        # Conversation history (14 messages max)
                                        │   │   ├── system-prompt.ts       # Dynamic system prompt generation
                                        │   │   ├── intent-router.ts       # Tool class classification
                                        │   │   ├── strategy-cache.ts      # Strategy memoization
                                        │   │   └── thought-generator.ts   # Sequential thinking prompts
                                        │   ├── browser/                   # Playwright integration
                                        │   │   ├── manager.ts             # Browser lifecycle, tab management
                                        │   │   ├── tools.ts               # 15+ browser tools
                                        │   │   └── cdp.ts                 # Chrome DevTools Protocol
                                        │   ├── local/                     # Local system tools
                                        │   │   └── tools.ts               # Shell exec, file I/O, processes
                                        │   ├── vault/                     # Knowledge vault (SQLite)
                                        │   │   ├── db.ts                  # Database initialization
                                        │   │   ├── ingest.ts              # Document chunking & indexing
                                        │   │   └── schema.sql             # DB schema
                                        │   ├── learning/                  # Learning system
                                        │   │   ├── memory.ts              # User memory management
                                        │   │   └── site-knowledge.ts      # Domain-specific learning
                                        │   ├── documents/                 # Document creation & extraction
                                        │   │   ├── creator.ts             # DOCX, PDF, XLSX generation
                                        │   │   └── extractor.ts           # Page content extraction
                                        │   ├── action-plans/              # Reversible file operations
                                        │   │   └── manager.ts             # Transaction-safe file ops
                                        │   └── main.ts                    # App entry point, IPC handlers
                                        ├── renderer/                      # React UI
                                        │   ├── main.ts                    # React root
                                        │   ├── modules/                   # Feature modules
                                        │   │   ├── chat/                  # Chat interface
                                        │   │   ├── vault/                 # Vault UI
                                        │   │   ├── settings/              # Settings panel
                                        │   │   └── browser/               # Browser panel
                                        │   └── styles/                    # Global CSS
                                        └── shared/                        # Shared types & IPC
                                            ├── types.ts                   # Message, Tool, Document types
                                            ├── ipc-channels.ts            # All IPC channel names (invoke + events)
                                            ├── models.ts                  # Model definitions
                                            └── vault-types.ts             # Vault schema types
                                        ```

                                        ### Key IPC Channels (Renderer ↔ Main)

                                        **Chat**
                                        - `chat:send` — Send user message, returns streamed AI response
                                        - - `chat:new` — Create new conversation
                                          - - `chat:list` — Get all conversations
                                            - - `chat:load` — Load conversation by ID
                                              - - `chat:delete` — Delete conversation
                                               
                                                - **Browser**
                                                - - `browser:navigate` — Navigate to URL
                                                  - - `browser:tab:new` → `browser:tab:list` → `browser:tab:switch`
                                                    - - `browser:history:get` / `browser:history:clear`
                                                      - - `browser:clear-all` — Wipe browser data
                                                       
                                                        - **Settings & API**
                                                        - - `settings:get` / `settings:set`
                                                          - - `api-key:get` / `api-key:set` / `api-key:validate`
                                                            - - `model:get` / `model:set`
                                                             
                                                              - **Vault**
                                                              - - `vault:ingest` — Add document to vault
                                                                - - `vault:search` — Search vault (called internally by tool-loop)
                                                                 
                                                                  - **Learning**
                                                                  - - `learning:memory:add` — Remember something
                                                                    - - `learning:site-knowledge:update` — Update domain rules
                                                                     
                                                                      - **Actions**
                                                                      - - `action:create-plan` → `action:add-item` → `action:execute-plan`
                                                                        - - `action:undo-plan`
                                                                         
                                                                          - ### System Prompt
                                                                          - The system prompt is dynamically generated in `src/main/llm/system-prompt.ts`:
                                                                          - - **Static tier**: Base capabilities and rules (~1976 tokens)
                                                                            - - **Dynamic tier**: Context injection—tools available, learned site knowledge, recent errors
                                                                              - - **Strategy hints**: Tool recommendations for the current conversation
                                                                               
                                                                                - The prompt includes 100+ specialized instructions for tool usage, search strategies, form filling, code execution, and more.
                                                                               
                                                                                - ## Tool Capabilities
                                                                               
                                                                                - ### Browser Tools (Playwright-based)
                                                                                - - `browser_navigate(url)` — Go to URL
                                                                                  - - `browser_search(query)` — Google search
                                                                                    - - `browser_search_rich(query, extract)` — Rich search result extraction
                                                                                      - - `browser_click(ref | selector | x,y)` — Click element by text, CSS, or coordinates
                                                                                        - - `browser_type(text, ref)` — Type into input
                                                                                          - - `browser_scroll(direction, amount)` — Scroll page
                                                                                            - - `browser_screenshot()` — Screenshot visible area
                                                                                              - - `browser_batch(operations)` — Parallel page operations
                                                                                                - - `browser_extract(schema, url)` — Extract structured data by schema
                                                                                                  - - `browser_visual_extract(url)` — OCR + structured extraction from visual content
                                                                                                    - - `browser_read_page()` — Get page content as text
                                                                                                      - - `browser_read_tabs()` — Read multiple tabs in parallel
                                                                                                        - - `browser_tab(action, tabId)` — Create, list, switch, close tabs
                                                                                                          - - `browser_places(query)` — Local business search (Google Maps)
                                                                                                            - - `browser_news(query)` — News search
                                                                                                              - - `browser_shopping(query)` — Product search with prices
                                                                                                               
                                                                                                                - ### Local Tools
                                                                                                                - - `shell_exec(command)` — Run bash commands
                                                                                                                  - - `file_read(path, startLine, endLine)` — Read files
                                                                                                                    - - `file_write(path, content, mode)` — Write/append files
                                                                                                                      - - `file_edit(path, old, new)` — Targeted find-and-replace
                                                                                                                        - - `directory_tree(path, depth)` — List directory recursively
                                                                                                                          - - `process_manager(action, query)` — List/find/kill processes
                                                                                                                           
                                                                                                                            - ### Vault & Learning Tools
                                                                                                                            - - `vault_ingest(path)` — Add document to knowledge vault
                                                                                                                              - - `vault_search(query, limit)` — Query vault (called internally)
                                                                                                                               
                                                                                                                                - ### Action Plan Tools
                                                                                                                                - - `action_create_plan(description)` — Create reversible file operation plan
                                                                                                                                  - - `action_add_item(planId, type, payload, order)` — Add operation step
                                                                                                                                    - - `action_execute_plan(planId)` — Execute all steps transactionally
                                                                                                                                      - - `action_undo_plan(planId)` — Rollback all operations
                                                                                                                                       
                                                                                                                                        - ### Document Tools
                                                                                                                                        - - `create_document(filename, format, content, title)` — Generate DOCX/PDF/XLSX/CSV/HTML/JSON/MD/TXT
                                                                                                                                          - - `browser_batch` with `pdf` action — Screenshot pages as PDF
                                                                                                                                           
                                                                                                                                            - ## Data & Storage
                                                                                                                                           
                                                                                                                                            - ### Config Store
                                                                                                                                            - All app settings, API keys, conversation history, and learned site knowledge are encrypted in:
                                                                                                                                            - ```
                                                                                                                                              ~/.config/Clawdia/config.json
                                                                                                                                              ```
                                                                                                                                              
                                                                                                                                              Schema (from `src/main/store.ts`):
                                                                                                                                              ```typescript
                                                                                                                                              {
                                                                                                                                                conversations: Array<{id, title, createdAt, updatedAt, messages}>,
                                                                                                                                                anthropicApiKey: string,
                                                                                                                                                selectedModel: string,
                                                                                                                                                hasCompletedSetup: boolean,
                                                                                                                                                chat_tab_state: {activeTabId, tabs},
                                                                                                                                                browserHistory: Array<{url, title, timestamp}>,
                                                                                                                                                userMemory: Array<{content, createdAt}>,
                                                                                                                                                siteKnowledge: Map<domain, knowledge>
                                                                                                                                              }
                                                                                                                                              ```
                                                                                                                                              
                                                                                                                                              ### Vault Database
                                                                                                                                              Document vault is SQLite at `~/.config/Clawdia/clawdia_vault/vault.db`:
                                                                                                                                              ```
                                                                                                                                              documents (id, name, filePath, format, uploadedAt)
                                                                                                                                              chunks (id, documentId, content, embedding, metadata)
                                                                                                                                              ```
                                                                                                                                              
                                                                                                                                              ### Search Cache
                                                                                                                                              Local search result cache (no API cost for repeat queries):
                                                                                                                                              ```
                                                                                                                                              ~/.config/Clawdia/search-cache.sqlite
                                                                                                                                              ```
                                                                                                                                              
                                                                                                                                              ## System Requirements
                                                                                                                                              
                                                                                                                                              - **OS**: macOS 10.15+, Windows 7+, Linux (Ubuntu 16.04+)
                                                                                                                                              - - **RAM**: 2GB minimum (4GB+ recommended for large vault)
                                                                                                                                                - - **Disk**: 500MB+ for app, plus space for documents in vault
                                                                                                                                                  - - **Network**: Internet required for Claude API, optional for offline browsing
                                                                                                                                                   
                                                                                                                                                    - ## Contributing
                                                                                                                                                   
                                                                                                                                                    - Issues, PRs, and suggestions welcome. Please review the architecture diagram and code organization before submitting changes.
                                                                                                                                                   
                                                                                                                                                    - ## License
                                                                                                                                                   
                                                                                                                                                    - [MIT](LICENSE)
                                                                                                                                                   
                                                                                                                                                    - ## Credits
                                                                                                                                                   
                                                                                                                                                    - Built with [Claude](https://anthropic.com) by Daniel Parker.
                                                                                                                                                   
                                                                                                                                                    - ---
                                                                                                                                                    
                                                                                                                                                    **Last Updated**: February 2026
                                                                                                                                                    
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

`Electron · TypeScript · Vite · Playwright · Claude API (multi-model)`

## License

[MIT](LICENSE)

## Credits

Built with [Claude](https://anthropic.com) by Daniel Parker.
