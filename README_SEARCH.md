# Clawdia - Search

**An AI research agent with live browser control for automated web research, content extraction, and synthesis.**

Clawdia - Search is a specialized vertical of the Clawdia platform, optimized for:

- 🔍 **Automated web research** — Search, navigate, and extract data from websites in real-time
- 📰 **Content synthesis** — Aggregate and summarize findings across multiple sources
- 🎯 **Source tracking** — Know exactly where the AI found each piece of information
- 📊 **Export capabilities** — Generate research reports, fact sheets, and source lists
- 👁️ **Live visibility** — Watch the AI navigate and make decisions in real-time

## What's Different from Clawdia

Clawdia - Search removes local system capabilities to focus on web research:

- ✅ **Browser tools** (navigate, search, click, extract, screenshot, etc.)
- ✅ **Vault** (knowledge base ingestion for context)
- ❌ **Shell/System access** (use Clawdia - Automator instead)
- ❌ **File system tools** (use Clawdia - Automator instead)
- ❌ **Task scheduling** (use Clawdia - Automator instead)
- ❌ **Document export** (reports generated via browser extraction)

## Use Cases

- **Market research** — Competitive analysis, pricing intelligence, product tracking
- **Journalism** — Fact-checking, source research, news aggregation
- **Investment analysis** — Company research, market trends, financial data
- **Real estate research** — Property searches, market comps, neighborhood analysis
- **Lead generation** — B2B prospect research, contact finding
- **Academic research** — Literature review, source aggregation

## Getting Started

```bash
npm install
npm run dev
```

The Clawdia - Search window will open with full browser and AI capabilities.

## Architecture

- **Electron desktop app** — Runs locally on your machine
- **Playwright browser** — Full control over web navigation and interaction
- **Claude AI backend** — Bring your own API key
- **Conversation memory** — Multi-turn research sessions with full context
- **Tool orchestration** — AI decides when to search, navigate, extract, or synthesize

## System Requirements

- **Node.js 18+**
- **Linux, macOS, or Windows**
- **Playwright dependencies** (automatically installed)
- **Claude API key** (from Anthropic)

## Privacy

All browsing and AI processing happens locally. Your API key stays on your machine. No data is sent to Clawdia servers — this is your personal research assistant.

---

**Clawdia Verticals:**
- 🔍 **Search** — Web research & content extraction
- 🤖 **Automator** — Local file system & OS automation (coming soon)
- ⚖️ **Law** — Legal document analysis & research (coming soon)
- 🏥 **Health** — Healthcare appointment & intake automation (coming soon)

