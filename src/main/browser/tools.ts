import { Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import {
  createTab,
  switchTab,
  closeTab,
  getActivePage,
  getActiveTabId,
  listTabs,
  executeInBrowserView,
  navigate as managerNavigate,
  waitForLoad,
} from './manager';
import { dismissPopups } from './popup-dismissal';
import {
  search as apiSearch,
  SearchResult,
  setPlaywrightSearchFallback,
  searchNews,
  searchShopping,
  searchPlaces,
  searchImages,
} from '../search/backends';
import type { ConsensusResult } from '../search/backends';
import { store } from '../store';
import { DEFAULT_MODEL } from '../../shared/models';
import { getPlaywrightPool, PageOperation, PageResult } from './pool';
import { createLogger, perfLog } from '../logger';
import { compressPageContent } from '../content/compressor';
import {
  storePage,
  getPage,
  getPageByUrl,
  getPageSection,
  getPageReference,
  isCacheAvailable,
  CACHE_MAX_AGE,
} from '../cache/search-cache';

const toolsLog = createLogger('browser-tools');

export interface BrowserToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const BROWSER_TOOL_DEFINITIONS: BrowserToolDefinition[] = [
  {
    name: 'browser_search',
    description:
      'Search Google and return top results with title, URL, and snippet. Snippets often directly answer factual questions.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL and return title + a structured page snapshot.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_read_page',
    description: 'Read the current page and return a structured text snapshot.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element. Provide EITHER ref (text/accessible name), OR x+y coordinates (from a screenshot), OR selector (CSS selector). For icon-only buttons or elements without text, take a browser_screenshot first, then click using x,y coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Visible text / accessible name of the element to click',
        },
        x: {
          type: 'number',
          description: 'X coordinate in pixels (from screenshot). Use with y.',
        },
        y: {
          type: 'number',
          description: 'Y coordinate in pixels (from screenshot). Use with x.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to click (e.g. "button[aria-label=Menu]", "[data-testid=sidebar-toggle]")',
        },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input (by ref) or currently focused element.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        ref: { type: 'string', description: 'Optional input label/placeholder/name' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current page up or down by a number of pixels.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Scroll amount in pixels. Defaults to 600.' },
      },
    },
  },
  {
    name: 'browser_tab',
    description:
      'Manage tabs. Actions: new (optional url), list, switch (tabId), close (tabId).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['new', 'list', 'switch', 'close'] },
        tabId: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the active page. Returns the actual image so you can SEE the page. Use this when you need to identify elements visually — especially icon-only buttons, narrow sidebars, or elements that browser_read_page cannot describe. After viewing the screenshot, use browser_click with x/y coordinates to click specific elements.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_news',
    description:
      'Search recent news articles. Returns headlines, sources, dates, and snippets. Use for questions about current events, recent developments, or "what happened with X."',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'News search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_shopping',
    description:
      'Search for products with prices and ratings. Use for questions like "how much does X cost", "best X under $Y", "compare prices of X." Returns product name, price, store, and rating.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_places',
    description:
      'Search for local businesses, restaurants, stores. Returns name, address, rating, hours, phone. Use for "where is X", "when does X close", "restaurants near Y."',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Place or business search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_images',
    description:
      'Search for images. Returns image URLs and titles. Use when the user asks to see what something looks like, find pictures of X, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Image search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_batch',
    description:
      'Execute operations on multiple web pages in parallel. Use this for any task that involves visiting more than one URL. Supports extraction, screenshots, PDF generation, and network interception.',
    input_schema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              actions: {
                type: 'array',
                items: { type: 'string', enum: ['extract', 'screenshot', 'pdf', 'intercept_network'] },
              },
              extract_schema: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
              wait_for: { type: 'string' },
              evaluate: { type: 'string' },
              full_page: { type: 'boolean' },
            },
            required: ['url', 'actions'],
          },
        },
        parallel: { type: 'boolean', description: 'Run operations in parallel. Defaults to true.' },
      },
      required: ['operations'],
    },
  },
  {
    name: 'browser_read_tabs',
    description:
      'Read content from multiple open browser tabs at once without switching. If tab_ids is omitted, reads all open tabs.',
    input_schema: {
      type: 'object',
      properties: {
        tab_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract structured data from a page using a schema and return JSON.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tab_id: { type: 'string' },
        schema: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['schema'],
    },
  },
  {
    name: 'browser_visual_extract',
    description:
      'Screenshot a page and extract visible text using vision OCR. Use when DOM extraction returns minimal text. Higher token cost due image input.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tab_id: { type: 'string' },
        full_page: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_search_rich',
    description:
      'Search and extract structured entity data (company/person/product/topic) from top sources.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        entity_type: { type: 'string' },
        extract: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  },
  {
    name: 'cache_read',
    description:
      'Retrieve the full cached content of a previously fetched web page by its cache ID. Use this when you need detailed information from a page you\'ve already visited. The page content has been cleaned and compressed for efficient reading.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: {
          type: 'string',
          description: 'The cache ID (e.g., \'abc123\' from a [cached:abc123] reference)',
        },
        section: {
          type: 'string',
          description: 'Optional: request only a specific section by keyword (e.g., \'pricing\', \'features\'). Returns the most relevant ~5000 chars instead of the full page.',
        },
      },
      required: ['page_id'],
    },
  },
];

function withProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return 'about:blank';
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('about:') ||
    trimmed.startsWith('file://')
  ) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function getActiveOrCreatePage(): Page | null {
  return getActivePage();
}

const MAX_BATCH_URLS = 10;
const MAX_BATCH_CONCURRENCY = 5;
const MAX_EXTRACT_CHARS = 16_000; // ~4000 tokens heuristic

function getSelectedModel(): string {
  return (store.get('selectedModel') as string) || DEFAULT_MODEL;
}

function getAnthropicApiKey(): string {
  return ((store.get('anthropicApiKey') as string) || '').trim();
}

function clampText(text: string, maxChars = MAX_EXTRACT_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      // Continue.
    }
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    // Continue.
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  try {
    const parsed = JSON.parse(objectMatch[0]);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function llmExtract(pageData: Record<string, unknown>, schema: Record<string, string>): Promise<Record<string, unknown>> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return {
      _error: 'Missing Anthropic API key for extraction.',
      _raw: pageData,
    };
  }

  const client = new Anthropic({ apiKey });
  const model = getSelectedModel();
  toolsLog.info(`[API Request] model=${model} | endpoint=llmExtract`);
  const schemaJson = JSON.stringify(schema, null, 2);
  const pageJson = clampText(JSON.stringify(pageData, null, 2));

  const response = await client.messages.create({
    model,
    max_tokens: 700,
    messages: [
      {
        role: 'user',
        content:
          `Extract data into JSON using this schema (field -> requirement):\n${schemaJson}\n\n` +
          `Source page data:\n${pageJson}\n\n` +
          'Return only a valid JSON object with exactly the schema keys. Use null for unknown values.',
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const parsed = parseJsonObject(text);
  if (parsed) return parsed;

  return {
    _error: 'Failed to parse extraction JSON.',
    _raw_response: clampText(text, 4_000),
    _raw: pageData,
  };
}

async function llmVisionExtractText(screenshotBase64: string): Promise<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return 'Missing Anthropic API key for visual extraction.';

  const client = new Anthropic({ apiKey });
  const model = getSelectedModel();
  toolsLog.info(`[API Request] model=${model} | endpoint=llmVisionExtractText`);

  const response = await client.messages.create({
    model,
    max_tokens: 2_000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshotBase64,
            },
          },
          {
            type: 'text',
            text: 'Extract all visible text from this screenshot. Preserve reading order and structure. Return plain text.',
          },
        ],
      },
    ],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function llmExtractFromText(
  sourceText: string,
  schema: Record<string, string>,
  extraInstructions?: string,
): Promise<Record<string, unknown>> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return {
      _error: 'Missing Anthropic API key for extraction.',
      _raw_text: clampText(sourceText),
    };
  }

  const client = new Anthropic({ apiKey });
  const model = getSelectedModel();
  toolsLog.info(`[API Request] model=${model} | endpoint=llmExtractFromText`);

  const response = await client.messages.create({
    model,
    max_tokens: 900,
    messages: [
      {
        role: 'user',
        content:
          `Extract JSON using this schema (field -> requirement):\n${JSON.stringify(schema, null, 2)}\n\n` +
          `${extraInstructions ? `${extraInstructions}\n\n` : ''}` +
          `Source text:\n${clampText(sourceText)}\n\n` +
          'Return only one valid JSON object. Use null for unknown fields.',
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const parsed = parseJsonObject(text);
  if (parsed) return parsed;

  return {
    _error: 'Failed to parse extraction JSON.',
    _raw_response: clampText(text, 4_000),
  };
}

function getTabUrlById(tabId: string): string | null {
  const tab = listTabs().find((t) => t.id === tabId);
  return tab?.url || null;
}

function domExtractJs(maxLen = 8_000): string {
  return `(() => {
    const main = document.querySelector('main, article, [role="main"]') || document.body;
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map((a) => ({
      text: (a.textContent || '').trim(),
      href: a.href
    }));
    return {
      title: document.title || '',
      url: location.href,
      content: (main.textContent || '').trim().substring(0, ${maxLen}),
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => (h.textContent || '').trim()).filter(Boolean),
      links,
    };
  })()`;
}

export async function executeTool(name: string, input: any): Promise<string> {
  const t0 = performance.now();
  let result: string;
  switch (name) {
    case 'browser_search':
      result = await toolSearch(String(input?.query || '')); break;
    case 'browser_navigate':
      result = await toolNavigate(String(input?.url || '')); break;
    case 'browser_read_page':
      result = await toolReadPage(); break;
    case 'browser_click':
      result = await toolClick(String(input?.ref || ''), input?.x, input?.y, input?.selector); break;
    case 'browser_type':
      result = await toolType(String(input?.text || ''), input?.ref, Boolean(input?.pressEnter)); break;
    case 'browser_scroll':
      result = await toolScroll(input?.direction, input?.amount); break;
    case 'browser_tab':
      result = await toolTab(String(input?.action || ''), input?.tabId, input?.url); break;
    case 'browser_screenshot':
      result = await toolScreenshot(); break;
    case 'browser_news':
      result = await toolNews(String(input?.query || '')); break;
    case 'browser_shopping':
      result = await toolShopping(String(input?.query || '')); break;
    case 'browser_places':
      result = await toolPlaces(String(input?.query || '')); break;
    case 'browser_images':
      result = await toolImages(String(input?.query || '')); break;
    case 'browser_batch':
      result = await toolBatch(input); break;
    case 'browser_read_tabs':
      result = await toolReadTabs(input?.tab_ids); break;
    case 'browser_extract':
      result = await toolExtract(input?.url, input?.tab_id, input?.schema); break;
    case 'browser_visual_extract':
      result = await toolVisualExtract(input?.url, input?.tab_id, input?.full_page); break;
    case 'browser_search_rich':
      result = await toolSearchRich(String(input?.query || ''), input?.entity_type, input?.extract); break;
    case 'cache_read':
      result = toolCacheRead(String(input?.page_id || ''), input?.section); break;
    default:
      result = `Unknown tool: ${name}`;
  }
  const ms = performance.now() - t0;
  perfLog('browser-tool', name, ms, { chars: result.length });
  return result;
}

// Register Playwright Google scraping as last-resort fallback for search API.
// Called once after Playwright is initialized.
export function registerPlaywrightSearchFallback(): void {
  setPlaywrightSearchFallback(async (query: string): Promise<SearchResult[]> => {
    // Navigate via BrowserView first, then read via Playwright.
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await managerNavigate(searchUrl);
    await waitForLoad(3000);

    const page = getActivePage();
    if (!page) throw new Error('Playwright not connected — cannot scrape search results');
    await dismissPopups(page);

    return page.evaluate(() => {
      const items: Array<{ title: string; url: string; snippet: string }> = [];
      const candidates = document.querySelectorAll('div.g, div[data-sokoban-container], [data-hveid]');
      for (const element of candidates) {
        const titleEl = element.querySelector('h3');
        const linkEl = element.querySelector('a[href]');
        if (!titleEl || !linkEl) continue;
        const url = linkEl.getAttribute('href') || '';
        if (!url || !/^https?:\/\//i.test(url)) continue;
        const snippetEl = element.querySelector('.VwiC3b, .IsZvec, [data-sncf], .lEBKkf');
        items.push({
          title: (titleEl.textContent || '').trim(),
          url,
          snippet: (snippetEl?.textContent || '').trim(),
        });
        if (items.length >= 10) break;
      }
      return items;
    });
  });
}

async function toolSearch(query: string): Promise<string> {
  if (!query.trim()) return 'Missing query.';

  // Keep BrowserView in sync with search activity so the browser panel reflects
  // what the agent is doing, even when result ranking comes from API backends.
  const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  try {
    await managerNavigate(serpUrl);
    await waitForLoad(2000);
  } catch {
    // Best effort only — search results can still be returned from API backends.
  }

  const response: ConsensusResult = await apiSearch(query);

  const primaryFiltered = response.results.filter((r) => r.title);
  const secondaryFiltered = (response.secondaryResults || []).filter((r) => r.title);
  const filtered = primaryFiltered.length > 0 ? primaryFiltered : secondaryFiltered;

  if (filtered.length === 0) {
    return `No results found for "${query}".`;
  }

  let output = '';

  // Lead with consensus answer if found
  if (response.consensus && response.confidence === 'high') {
    output += `[DIRECT ANSWER — high confidence, confirmed by ${response.source}]\n`;
    output += `${response.consensus}\n\n`;
    output += `You can respond with this answer directly. Only visit a page if the user needs more detail.\n\n`;
  } else if (response.consensus && response.confidence === 'medium') {
    output += `[LIKELY ANSWER — medium confidence]\n`;
    output += `${response.consensus}\n\n`;
  }

  output += `Search results for "${query}" (via ${response.source}):\n\n`;
  for (const [index, result] of filtered.slice(0, 5).entries()) {
    output += `${index + 1}. ${result.title}\n   ${result.url}\n`;
    if (result.snippet) {
      const snippet = result.snippet.length > 150 ? result.snippet.slice(0, 150) + '...' : result.snippet;
      output += `   ${snippet}\n`;
    }
    output += '\n';
  }

  // Add unique secondary results
  const supplementalPool = primaryFiltered.length > 0 ? secondaryFiltered : primaryFiltered;
  if (supplementalPool.length > 0) {
    const primaryUrls = new Set(filtered.map((r) => r.url));
    const uniqueSecondary = supplementalPool
      .filter((r) => !primaryUrls.has(r.url))
      .slice(0, 3);

    if (uniqueSecondary.length > 0) {
      output += `Additional sources:\n`;
      for (const r of uniqueSecondary) {
        output += `  • ${r.title} — ${r.url}\n`;
        if (r.snippet) output += `    ${r.snippet}\n`;
      }
    }
  }

  return output.trim();
}

async function toolNavigate(url: string): Promise<string> {
  if (!url.trim()) return 'Missing URL.';
  const targetUrl = withProtocol(url);

  // Navigate via BrowserView (always works).
  const result = await managerNavigate(targetUrl);
  if (!result.success) {
    return `Failed to navigate to ${targetUrl}: ${result.error || 'unknown error'}`;
  }

  // Wait for BrowserView to finish loading (event-driven, up to 3s timeout).
  await waitForLoad(3000);

  // Try to read the page via Playwright if available.
  const page = getActivePage();
  if (page) {
    await dismissPopups(page);
    return getPageSnapshot(page);
  }

  // Fallback: just report we navigated.
  return `Navigated to ${targetUrl}. (Page reading unavailable — Playwright not connected.)`;
}

async function toolReadPage(): Promise<string> {
  const page = getActivePage();
  if (!page) return 'No active page.';
  return getPageSnapshot(page);
}

async function tryClickRef(page: Page, ref: string): Promise<boolean> {
  const locators = [
    page.getByRole('button', { name: ref, exact: false }).first(),
    page.getByRole('link', { name: ref, exact: false }).first(),
    page.getByRole('menuitem', { name: ref, exact: false }).first(),
    page.getByText(ref, { exact: false }).first(),
  ];

  for (const locator of locators) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      await locator.click({ timeout: 4000 });
      return true;
    } catch {
      // Try the next semantic locator.
    }
  }
  return false;
}

function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com';
  } catch {
    return false;
  }
}

async function tryClickLocators(locators: Array<ReturnType<Page['locator']> | ReturnType<Page['getByRole']>>): Promise<boolean> {
  for (const locator of locators) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 1500 });
      await locator.click({ timeout: 3000 });
      return true;
    } catch {
      // Try the next fallback locator.
    }
  }
  return false;
}

async function tryTwitterClickFallback(page: Page, ref: string): Promise<boolean> {
  const normalized = ref.trim().toLowerCase();

  // Open/focus composer from the home timeline in a resilient way.
  if (normalized.includes('what') || normalized.includes('happening') || normalized === 'compose') {
    return tryClickLocators([
      page.locator('[data-testid="tweetTextarea_0"]').first(),
      page.locator('[data-testid="SideNav_NewTweet_Button"]').first(),
      page.locator('[role="textbox"][contenteditable="true"]').first(),
      page.getByRole('textbox', { name: /post text/i }).first(),
      page.getByRole('textbox').first(),
    ]);
  }

  // Submit post across timeline/modal variants.
  if (normalized === 'post' || normalized === 'tweet') {
    return tryClickLocators([
      page.locator('[data-testid="tweetButtonInline"]').first(),
      page.locator('[data-testid="tweetButton"]').first(),
      page.getByRole('button', { name: /^post$/i }).first(),
      page.getByRole('button', { name: /^tweet$/i }).first(),
    ]);
  }

  // Reply button variants.
  if (normalized === 'reply') {
    return tryClickLocators([
      page.locator('[data-testid="tweetButton"]').first(),
      page.getByRole('button', { name: /^reply$/i }).first(),
    ]);
  }

  return false;
}

async function focusTwitterComposer(page: Page): Promise<boolean> {
  return tryClickLocators([
    page.locator('[data-testid="tweetTextarea_0"]').first(),
    page.locator('[role="textbox"][contenteditable="true"]').first(),
    page.getByRole('textbox', { name: /post text/i }).first(),
    page.getByRole('textbox').first(),
  ]);
}

async function toolClick(ref: string, x?: unknown, y?: unknown, selector?: unknown): Promise<string> {
  const page = getActivePage();
  if (!page) return 'No active page.';

  let clicked = false;
  let clickLabel = '';

  // Strategy 1: Coordinate-based click (from screenshot)
  if (typeof x === 'number' && typeof y === 'number') {
    try {
      await page.mouse.click(x, y);
      clicked = true;
      clickLabel = `coordinates (${x}, ${y})`;
    } catch (err: any) {
      return `Failed to click at (${x}, ${y}): ${err?.message || 'unknown error'}`;
    }
  }

  // Strategy 2: CSS selector click
  if (!clicked && typeof selector === 'string' && selector.trim()) {
    try {
      const locator = page.locator(selector.trim()).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      await locator.click({ timeout: 4000 });
      clicked = true;
      clickLabel = `selector "${selector}"`;
    } catch {
      // Fall through to text-based matching
    }
  }

  // Strategy 3: Text/accessible name click (original behavior)
  if (!clicked && ref.trim()) {
    clicked = await tryClickRef(page, ref);
    if (!clicked && isTwitterUrl(page.url())) {
      clicked = await tryTwitterClickFallback(page, ref);
    }
    clickLabel = `"${ref}"`;
  }

  if (!clicked) {
    const hint = ref.trim()
      ? `Could not click "${ref}". Try browser_screenshot to see the page, then click with x/y coordinates.`
      : 'No click target specified. Provide ref (text), x+y (coordinates), or selector (CSS).';
    return hint;
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
  await dismissPopups(page);
  const title = await page.title().catch(() => '');
  return `Clicked ${clickLabel}. Page: ${title} — ${page.url()}`;
}

async function toolType(text: string, ref: unknown, pressEnter: boolean): Promise<string> {
  if (!text) return 'Missing text.';
  const page = getActivePage();
  if (!page) return 'No active page.';

  try {
    if (typeof ref === 'string' && ref.trim()) {
      const key = ref.trim();
      const locators = [
        page.getByRole('textbox', { name: key, exact: false }).first(),
        page.getByPlaceholder(key).first(),
        page.locator(`[name="${key}"]`).first(),
        page.locator(`[aria-label="${key}"]`).first(),
      ];

      let filled = false;
      for (const locator of locators) {
        try {
          await locator.fill(text, { timeout: 4000 });
          if (pressEnter) {
            await locator.press('Enter', { timeout: 2000 }).catch(() => null);
          }
          filled = true;
          break;
        } catch {
          // Try the next locator.
        }
      }

      if (!filled && isTwitterUrl(page.url())) {
        const focused = await focusTwitterComposer(page);
        if (focused) {
          await page.keyboard.type(text, { delay: 8 });
          if (pressEnter) {
            await page.keyboard.press('Enter');
          }
          filled = true;
        }
      }

      if (!filled) {
        return `Could not find input "${key}".`;
      }
    } else {
      if (isTwitterUrl(page.url())) {
        await focusTwitterComposer(page).catch(() => false);
      }
      await page.keyboard.type(text, { delay: 8 });
      if (pressEnter) {
        await page.keyboard.press('Enter');
      }
    }
  } catch (error: any) {
    return `Failed to type: ${error?.message || 'unknown error'}`;
  }

  return `Typed "${text}"${pressEnter ? ' and pressed Enter' : ''}.`;
}

async function toolScroll(directionInput: unknown, amountInput: unknown): Promise<string> {
  const page = getActivePage();
  if (!page) return 'No active page.';

  const direction = String(directionInput || 'down').toLowerCase() === 'up' ? 'up' : 'down';
  const parsedAmount = Number(amountInput);
  const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? Math.floor(parsedAmount) : 600;
  const deltaY = direction === 'up' ? -amount : amount;

  try {
    await page.mouse.wheel(0, deltaY);
    return `Scrolled ${direction} by ${amount}px.`;
  } catch (error: any) {
    return `Failed to scroll: ${error?.message || 'unknown error'}`;
  }
}

async function toolTab(action: string, tabId?: string, url?: string): Promise<string> {
  switch (action) {
    case 'new': {
      const id = await createTab(url ? withProtocol(url) : 'about:blank');
      return `Opened tab ${id}${url ? ` at ${url}` : ''}.`;
    }
    case 'list': {
      const tabs = listTabs();
      if (tabs.length === 0) return 'No tabs open.';
      const lines = tabs.map((tab) => {
        const marker = tab.active ? '*' : '-';
        const title = tab.title || 'Untitled';
        const url = tab.url || 'about:blank';
        return `${marker} ${tab.id}: ${title} (${url})`;
      });
      return `Open tabs:\n${lines.join('\n')}`;
    }
    case 'switch': {
      if (!tabId) return 'Missing tabId for switch.';
      await switchTab(tabId);
      return `Switched to ${tabId}.`;
    }
    case 'close': {
      if (!tabId) return 'Missing tabId for close.';
      await closeTab(tabId);
      return `Closed ${tabId}.`;
    }
    default:
      return `Unknown tab action: ${action}`;
  }
}

async function toolScreenshot(): Promise<string> {
  const page = getActivePage();
  if (!page) return 'No active page.';
  const buffer = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
  const base64 = buffer.toString('base64');
  const url = page.url() || 'about:blank';
  const title = await page.title().catch(() => '');
  // Return structured image result — tool-loop detects the prefix and builds
  // a multi-part tool_result with an image content block so the LLM can see the page.
  return JSON.stringify({
    __clawdia_image_result__: true,
    image_base64: base64,
    media_type: 'image/jpeg',
    text: `Screenshot of "${title}" — ${url}\nViewport size: ${page.viewportSize()?.width ?? '?'}x${page.viewportSize()?.height ?? '?'}px. Use coordinates (x, y) from this image with browser_click to click elements.`,
  });
}

// Blocklist for domains that shouldn't appear in visual tabs during batch research
const VISUAL_TAB_BLOCKLIST = new Set([
  // Social media (login walls, privacy concerns)
  'facebook.com', 'www.facebook.com',
  'instagram.com', 'www.instagram.com',
  'tiktok.com', 'www.tiktok.com',
  'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
  'linkedin.com', 'www.linkedin.com',
  'snapchat.com', 'www.snapchat.com',
  // Auth/login pages
  'accounts.google.com',
  'login.microsoftonline.com',
  'auth0.com',
  // Ad-heavy / clickbait
  'buzzfeed.com', 'www.buzzfeed.com',
  // Banking / sensitive
  'paypal.com', 'www.paypal.com',
  'chase.com', 'www.chase.com',
  'bankofamerica.com', 'www.bankofamerica.com',
]);

function shouldShowVisualTab(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Check exact match and parent domain
    if (VISUAL_TAB_BLOCKLIST.has(hostname)) return false;
    // Check if it's a subdomain of a blocked domain
    for (const blocked of VISUAL_TAB_BLOCKLIST) {
      if (hostname.endsWith('.' + blocked)) return false;
    }
    // Block obvious auth/login URLs
    const path = new URL(url).pathname.toLowerCase();
    if (path.includes('/login') || path.includes('/signin') || path.includes('/auth')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Generate a sources collage HTML page from extracted fragments
function generateSourcesCollageHtml(results: PageResult[]): string {
  const successResults = results.filter(r => r.status === 'success' && r.fragments && r.fragments.length > 0);
  if (successResults.length === 0) return '';

  const sourceCards = successResults.map(result => {
    const hostname = (() => {
      try { return new URL(result.url).hostname.replace('www.', ''); } catch { return result.url; }
    })();
    
    const favicon = result.favicon || `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
    const title = result.title || hostname;
    
    const fragmentsHtml = (result.fragments || []).map(frag => {
      // Wrap each fragment type appropriately
      switch (frag.type) {
        case 'headline':
          return `<div class="fragment fragment-headline">${escapeHtml(frag.text)}</div>`;
        case 'paragraph':
          return `<div class="fragment fragment-paragraph">${escapeHtml(frag.text)}</div>`;
        case 'quote':
          return `<blockquote class="fragment fragment-quote">${escapeHtml(frag.text)}</blockquote>`;
        case 'list':
          // Parse list items from text
          const items = frag.text.split(/\n/).filter(Boolean).slice(0, 5);
          return `<ul class="fragment fragment-list">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
        default:
          return `<div class="fragment">${escapeHtml(frag.text)}</div>`;
      }
    }).join('');

    return `
      <div class="source-card" data-url="${escapeHtml(result.url)}" onclick="(function(el){var url=el.getAttribute('data-url');if(url){window.location.href=url;}})(this)">
        <div class="source-header">
          <img class="favicon" src="${escapeHtml(favicon)}" onerror="this.style.display='none'" />
          <span class="hostname">${escapeHtml(hostname)}</span>
          <span class="open-link">Open →</span>
        </div>
        <div class="source-title">${escapeHtml(title)}</div>
        <div class="fragments">
          ${fragmentsHtml}
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sources · Clawdia Research</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(145deg, #0f1419 0%, #1a1f2e 100%);
      min-height: 100vh;
      color: #e7e9ea;
      padding: 24px;
    }
    
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    
    .header-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #00d4aa 0%, #00a884 100%);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    
    .header-title {
      font-size: 20px;
      font-weight: 600;
      color: #fff;
    }
    
    .header-count {
      font-size: 14px;
      color: #71767b;
      margin-left: auto;
    }
    
    .sources-grid {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    
    .source-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 16px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .source-card:hover {
      background: rgba(255,255,255,0.06);
      border-color: rgba(0,212,170,0.3);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    
    .source-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    
    .favicon {
      width: 16px;
      height: 16px;
      border-radius: 4px;
    }
    
    .hostname {
      font-size: 12px;
      color: #71767b;
      font-weight: 500;
    }
    
    .open-link {
      margin-left: auto;
      font-size: 12px;
      color: #00d4aa;
      opacity: 0;
      transition: opacity 0.2s;
    }
    
    .source-card:hover .open-link {
      opacity: 1;
    }
    
    .source-title {
      font-size: 15px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 12px;
      line-height: 1.4;
    }
    
    .fragments {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    
    .fragment {
      font-size: 14px;
      line-height: 1.5;
      color: #c4c9cc;
    }
    
    .fragment-headline {
      font-size: 15px;
      font-weight: 600;
      color: #e7e9ea;
      padding-left: 10px;
      border-left: 3px solid #00d4aa;
    }
    
    .fragment-paragraph {
      color: #a0a5a8;
    }
    
    .fragment-quote {
      font-style: italic;
      padding: 10px 14px;
      background: rgba(0,212,170,0.08);
      border-left: 3px solid #00d4aa;
      border-radius: 0 6px 6px 0;
    }
    
    .fragment-list {
      list-style: none;
      padding-left: 0;
    }
    
    .fragment-list li {
      position: relative;
      padding-left: 16px;
      margin-bottom: 4px;
    }
    
    .fragment-list li::before {
      content: '•';
      position: absolute;
      left: 0;
      color: #00d4aa;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .source-card {
      animation: fadeIn 0.3s ease forwards;
    }
    
    .source-card:nth-child(1) { animation-delay: 0.05s; }
    .source-card:nth-child(2) { animation-delay: 0.1s; }
    .source-card:nth-child(3) { animation-delay: 0.15s; }
    .source-card:nth-child(4) { animation-delay: 0.2s; }
    .source-card:nth-child(5) { animation-delay: 0.25s; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-icon">📑</div>
    <div class="header-title">Research Sources</div>
    <div class="header-count">${successResults.length} sources</div>
  </div>
  <div class="sources-grid">
    ${sourceCards}
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function toolBatch(input: any): Promise<string> {
  const rawOps = Array.isArray(input?.operations) ? input.operations : [];
  if (rawOps.length === 0) return 'Missing operations (expected 1-10).';
  if (rawOps.length > MAX_BATCH_URLS) return `Too many operations: ${rawOps.length}. Maximum is ${MAX_BATCH_URLS}.`;

  const operations: PageOperation[] = rawOps.map((op: any) => ({
    url: withProtocol(String(op?.url || '')),
    actions: Array.isArray(op?.actions)
      ? op.actions.filter((a: unknown) => typeof a === 'string')
      : [],
    extract_schema: op?.extract_schema && typeof op.extract_schema === 'object'
      ? op.extract_schema as Record<string, string>
      : undefined,
    wait_for: typeof op?.wait_for === 'string' ? op.wait_for : undefined,
    evaluate: typeof op?.evaluate === 'string' ? op.evaluate : undefined,
    full_page: typeof op?.full_page === 'boolean' ? op.full_page : undefined,
  }));

  if (operations.some((op) => !op.url || op.url === 'about:blank')) {
    return 'Each operation must include a valid url.';
  }

  // Navigate the visible BrowserView to the first URL immediately so the user
  // sees activity right away, before headless extraction starts.
  const firstVisibleUrl = operations.map(op => op.url).find(shouldShowVisualTab);
  if (firstVisibleUrl) {
    try {
      await managerNavigate(firstVisibleUrl);
      // Don't wait for full load — just kick off the navigation so the user sees it.
    } catch { /* best effort */ }
  }

  // Open additional visual tabs for remaining URLs (fire-and-forget)
  const visualTabIds: string[] = [];
  const urlsForVisualTabs = operations
    .map(op => op.url)
    .filter(shouldShowVisualTab)
    .filter(url => url !== firstVisibleUrl) // skip the one already shown
    .slice(0, 4); // Max 4 more (5 total with the first)

  // Open visual tabs asynchronously (don't block headless extraction)
  const visualTabPromise = (async () => {
    for (const url of urlsForVisualTabs) {
      try {
        const tabId = await createTab(url);
        visualTabIds.push(tabId);
        await new Promise(r => setTimeout(r, 150));
      } catch { /* visual tabs are UX-only */ }
    }
  })();

  // Execute headless extraction in parallel (the real work)
  const parallel = input?.parallel !== false;
  const pool = getPlaywrightPool({ maxConcurrency: MAX_BATCH_CONCURRENCY });
  const results = await pool.execute(operations, {
    parallel,
    extractor: llmExtract,
  });

  // Wait for visual tabs to finish opening (they should be done by now)
  await visualTabPromise;

  // Highlight extracted content in visual tabs and scroll to relevant sections
  // Map URLs to their extracted content for highlighting
  const urlToContent = new Map<string, string[]>();
  for (const result of results) {
    if (result.status === 'success' && result.extracted) {
      const highlights: string[] = [];
      // Collect extracted values that are strings (titles, headlines, etc.)
      for (const value of Object.values(result.extracted)) {
        if (typeof value === 'string' && value.length > 10 && value.length < 500) {
          highlights.push(value);
        }
      }
      if (highlights.length > 0) {
        urlToContent.set(result.url, highlights);
      }
    }
  }

  // Apply smart highlighting to the active visual tab
  // Highlights key content: headlines, article paragraphs, important elements
  if (visualTabIds.length > 0) {
    // Wait a moment for page to render
    await new Promise(r => setTimeout(r, 800));
    
    const highlightScript = `
      (function() {
        // Skip if already highlighted
        if (document.querySelector('.clawdia-highlight')) return 0;
        
        // Add highlight styles
        const style = document.createElement('style');
        style.textContent = \`
          .clawdia-highlight {
            background: linear-gradient(120deg, rgba(255, 220, 100, 0.4) 0%, rgba(255, 200, 50, 0.3) 100%) !important;
            border-radius: 3px;
            padding: 2px 6px;
            margin: -2px -6px;
            box-shadow: 0 2px 8px rgba(255, 200, 50, 0.2);
            transition: all 0.3s ease;
            display: inline;
          }
          .clawdia-highlight:hover {
            background: linear-gradient(120deg, rgba(255, 220, 100, 0.6) 0%, rgba(255, 200, 50, 0.5) 100%) !important;
            box-shadow: 0 2px 12px rgba(255, 200, 50, 0.4);
          }
          .clawdia-highlight-block {
            border-left: 4px solid rgba(255, 180, 50, 0.8) !important;
            padding-left: 12px !important;
            background: linear-gradient(90deg, rgba(255, 220, 100, 0.15) 0%, transparent 100%) !important;
            margin: 8px 0;
          }
        \`;
        document.head.appendChild(style);
        
        let highlighted = 0;
        let firstHighlight = null;
        
        // 1. Highlight main headline (h1)
        const h1 = document.querySelector('h1');
        if (h1 && h1.textContent.trim().length > 10) {
          h1.classList.add('clawdia-highlight');
          firstHighlight = h1;
          highlighted++;
        }
        
        // 2. Highlight article/main content headlines (h2, h3)
        const subheadings = document.querySelectorAll('article h2, main h2, article h3, main h3, [role="main"] h2');
        for (let i = 0; i < Math.min(subheadings.length, 3); i++) {
          const h = subheadings[i];
          if (h.textContent.trim().length > 10) {
            h.classList.add('clawdia-highlight');
            if (!firstHighlight) firstHighlight = h;
            highlighted++;
          }
        }
        
        // 3. Highlight lead paragraph or first substantial paragraph
        const articleSelectors = [
          'article > p:first-of-type',
          'main > p:first-of-type', 
          '[role="main"] > p:first-of-type',
          '.article-body > p:first-of-type',
          '.post-content > p:first-of-type',
          '.entry-content > p:first-of-type',
          '.story-body > p:first-of-type'
        ];
        
        for (const selector of articleSelectors) {
          const p = document.querySelector(selector);
          if (p && p.textContent.trim().length > 80) {
            p.classList.add('clawdia-highlight-block');
            if (!firstHighlight) firstHighlight = p;
            highlighted++;
            break;
          }
        }
        
        // 4. For news sites / lists: highlight top story items
        const storyItems = document.querySelectorAll(
          '.storylink, .titleline > a, .story-title, .post-title, .article-title, ' +
          '[data-testid="headline"], .headline a, .news-title'
        );
        for (let i = 0; i < Math.min(storyItems.length, 5); i++) {
          const item = storyItems[i];
          if (item.textContent.trim().length > 15) {
            item.classList.add('clawdia-highlight');
            if (!firstHighlight) firstHighlight = item;
            highlighted++;
          }
        }
        
        // 5. Scroll to first highlighted element
        if (firstHighlight) {
          setTimeout(() => {
            firstHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
        
        return highlighted;
      })();
    `;
    
    try {
      await executeInBrowserView(highlightScript);
    } catch {
      // Non-critical - highlighting is UX enhancement only
    }
  }

  // Create Sources Collage tab from extracted fragments
  let collageTabId: string | null = null;
  const collageHtml = generateSourcesCollageHtml(results);
  if (collageHtml) {
    try {
      // Create a data URL for the collage
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(collageHtml)}`;
      collageTabId = await createTab(dataUrl);
      // Switch to the collage tab so user sees it immediately
      await switchTab(collageTabId);
    } catch {
      // Non-critical - collage is UX enhancement
    }
  }

  // Auto-close stale visual tabs after delay (keep collage tab)
  const STALE_TAB_CLOSE_DELAY_MS = 30_000; // 30 seconds
  if (visualTabIds.length > 0) {
    setTimeout(async () => {
      // Close all visual tabs except collage (which is more useful)
      for (const tabId of visualTabIds) {
        try {
          await closeTab(tabId);
        } catch {
          // Tab may have been manually closed already
        }
      }
    }, STALE_TAB_CLOSE_DELAY_MS);
  }

  // Store successful pages in SQLite cache and build compact references.
  // The LLM receives short summaries — it can use cache_read for full content.
  // Falls back to inline content when cache is unavailable.
  const cacheAvailable = isCacheAvailable();
  const cachedReferences: string[] = [];
  const inlineResults: string[] = [];
  const failedUrls: string[] = [];

  for (const r of results) {
    if (r.status === 'success' && r.content) {
      if (cacheAvailable) {
        try {
          const summary = (r.fragments || [])
            .filter((f) => f.type === 'paragraph' || f.type === 'headline')
            .map((f) => f.text)
            .join(' ')
            .slice(0, 300)
            .trim();

          const pageId = storePage(r.url, r.title || '', r.content, {
            summary,
            contentLength: r.content.length * 3, // approximate original
            compressedLength: r.content.length,
            contentType: 'article',
          });

          cachedReferences.push(getPageReference(pageId));
        } catch (err: any) {
          toolsLog.warn(`[browser_batch] Cache store failed for ${r.url}: ${err?.message}`);
          inlineResults.push(`## ${r.title || r.url}\n${r.content.slice(0, 6_000)}`);
        }
      } else {
        // Cache unavailable — return compressed content inline
        inlineResults.push(`## ${r.title || r.url}\n${r.content.slice(0, 6_000)}`);
      }
    } else {
      failedUrls.push(`${r.url}: ${r.error || 'unknown error'}`);
    }
  }

  const lines: string[] = [];

  if (cachedReferences.length > 0) {
    lines.push(`Fetched and cached ${cachedReferences.length} page(s):`);
    for (const ref of cachedReferences) {
      lines.push(ref);
    }
    lines.push('');
    lines.push('Use cache_read tool with the page ID to retrieve full content for any of these.');
  }

  if (inlineResults.length > 0) {
    lines.push(`Fetched ${inlineResults.length} page(s) (inline — cache unavailable):\n`);
    lines.push(inlineResults.join('\n\n---\n\n'));
  }

  if (failedUrls.length > 0) {
    lines.push('');
    lines.push(`Failed (${failedUrls.length}):`);
    for (const f of failedUrls) {
      lines.push(`  - ${f}`);
    }
  }

  return lines.join('\n');
}

async function toolReadTabs(tabIdsInput?: unknown): Promise<string> {
  const tabs = listTabs();
  if (tabs.length === 0) return 'No tabs open.';

  const requestedIds = Array.isArray(tabIdsInput)
    ? tabIdsInput.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : tabs.map((t) => t.id);

  const targets = tabs.filter((tab) => requestedIds.includes(tab.id));
  if (targets.length === 0) return 'No matching tabs found.';

  const activeTabId = getActiveTabId();
  const resultsByTabId: Record<string, unknown> = {};

  const activeTask = activeTabId && targets.some((tab) => tab.id === activeTabId)
    ? executeInBrowserView(domExtractJs(30_000)).then((data: any) => {
        if (data && typeof data.content === 'string') {
          data.content = compressPageContent(data.content, { maxChars: 8_000 }).text;
        }
        return data;
      })
    : Promise.resolve(null);

  const nonActiveTargets = targets.filter((tab) => tab.id !== activeTabId && !!tab.url && tab.url !== 'about:blank');
  const pool = getPlaywrightPool({ maxConcurrency: MAX_BATCH_CONCURRENCY });
  const nonActiveResultsPromise = nonActiveTargets.length > 0
    ? pool.execute(
      nonActiveTargets.map((tab) => ({ url: withProtocol(tab.url), actions: ['extract'] })),
      { parallel: true }
    )
    : Promise.resolve([] as PageResult[]);

  const [activeSettled, nonActiveSettled] = await Promise.allSettled([
    activeTask,
    nonActiveResultsPromise,
  ]);

  if (activeTabId && targets.some((tab) => tab.id === activeTabId)) {
    if (activeSettled.status === 'fulfilled' && activeSettled.value) {
      resultsByTabId[activeTabId] = {
        tab_id: activeTabId,
        status: 'success',
        ...(activeSettled.value as Record<string, unknown>),
      };
    } else {
      resultsByTabId[activeTabId] = {
        tab_id: activeTabId,
        status: 'error',
        error: 'Failed to read active tab via BrowserView.',
      };
    }
  }

  const nonActiveResults = nonActiveSettled.status === 'fulfilled' ? nonActiveSettled.value : [];
  const byUrlQueue = new Map<string, PageResult[]>();
  for (const result of nonActiveResults) {
    const list = byUrlQueue.get(result.url) || [];
    list.push(result);
    byUrlQueue.set(result.url, list);
  }

  for (const tab of nonActiveTargets) {
    const tabUrl = withProtocol(tab.url);
    const bucket = byUrlQueue.get(tabUrl) || [];
    const result = bucket.shift();
    byUrlQueue.set(tabUrl, bucket);
    if (!result) {
      resultsByTabId[tab.id] = {
        tab_id: tab.id,
        url: tabUrl,
        status: 'error',
        error: 'No extraction result available.',
      };
      continue;
    }
    resultsByTabId[tab.id] = { tab_id: tab.id, ...result };
  }

  for (const tab of targets) {
    if (resultsByTabId[tab.id]) continue;
    resultsByTabId[tab.id] = {
      tab_id: tab.id,
      url: tab.url,
      status: 'error',
      error: 'Tab has no readable URL.',
    };
  }

  const values = Object.values(resultsByTabId) as Array<{ status?: string }>;
  const payload = {
    results: resultsByTabId,
    succeeded: values.filter((v) => v.status === 'success').length,
    failed: values.filter((v) => v.status === 'error').length,
  };
  return JSON.stringify(payload, null, 2);
}

async function toolExtract(urlInput: unknown, tabIdInput: unknown, schemaInput: unknown): Promise<string> {
  const schema = schemaInput && typeof schemaInput === 'object'
    ? schemaInput as Record<string, string>
    : null;
  if (!schema || Object.keys(schema).length === 0) return 'Missing schema.';

  const activeTabId = getActiveTabId();
  const tabId = typeof tabIdInput === 'string' ? tabIdInput : null;
  const url = typeof urlInput === 'string' && urlInput.trim() ? withProtocol(urlInput) : null;

  try {
    if (!url && (!tabId || tabId === activeTabId)) {
      const rawPageData = await executeInBrowserView<Record<string, unknown>>(domExtractJs(16_000));
      // Compress the content field before LLM extraction
      if (rawPageData && typeof (rawPageData as any).content === 'string') {
        (rawPageData as any).content = compressPageContent((rawPageData as any).content, { maxChars: 4_000 }).text;
      }
      const pageData = rawPageData;
      if (!pageData) return 'Failed to read page content for extraction.';
      const extracted = await llmExtract(pageData, schema);
      const result = {
        status: extracted._error ? 'error' : 'success',
        tab_id: activeTabId,
        url: (pageData.url as string) || null,
        extracted,
        ...(extracted._error ? { error: String(extracted._error) } : {}),
      };
      return JSON.stringify(result, null, 2);
    }

    const targetUrl = url || (tabId ? getTabUrlById(tabId) : null);
    if (!targetUrl) return 'Unable to resolve target URL for extraction.';

    const pool = getPlaywrightPool({ maxConcurrency: MAX_BATCH_CONCURRENCY });
    const [result] = await pool.execute(
      [{ url: withProtocol(targetUrl), actions: ['extract'], extract_schema: schema }],
      { parallel: true, extractor: llmExtract }
    );

    if (result.status === 'success') {
      return JSON.stringify(result, null, 2);
    }

    return JSON.stringify({
      ...result,
      fallback_note: 'Extraction failed; returning raw page content is unavailable for this target.',
    }, null, 2);
  } catch (error: any) {
    return `Extraction failed: ${error?.message || 'unknown error'}`;
  }
}

async function toolVisualExtract(urlInput: unknown, tabIdInput: unknown, fullPageInput: unknown): Promise<string> {
  const fullPage = Boolean(fullPageInput);
  const activePage = getActivePage();
  const activeTabId = getActiveTabId();
  const tabId = typeof tabIdInput === 'string' ? tabIdInput : null;
  const inputUrl = typeof urlInput === 'string' && urlInput.trim().length > 0 ? withProtocol(urlInput) : null;

  try {
    let screenshotBase64 = '';
    let sourceUrl = inputUrl || null;

    if (!inputUrl && (!tabId || tabId === activeTabId) && activePage) {
      const screenshot = await activePage.screenshot({ type: 'png', fullPage });
      screenshotBase64 = screenshot.toString('base64');
      sourceUrl = activePage.url() || sourceUrl;
    } else {
      const targetUrl = inputUrl || (tabId ? getTabUrlById(tabId) : null);
      if (!targetUrl) return 'Unable to resolve target URL for visual extraction.';

      const pool = getPlaywrightPool({ maxConcurrency: MAX_BATCH_CONCURRENCY });
      const [result] = await pool.execute(
        [{ url: withProtocol(targetUrl), actions: ['screenshot'], full_page: fullPage }],
        { parallel: true }
      );

      if (result.status !== 'success' || !result.screenshot_base64) {
        return JSON.stringify(result, null, 2);
      }

      screenshotBase64 = result.screenshot_base64;
      sourceUrl = result.url;
    }

    const extractedText = await llmVisionExtractText(screenshotBase64);
    return JSON.stringify({
      status: 'success',
      url: sourceUrl,
      full_page: fullPage,
      extracted_text: extractedText,
      // screenshot_base64 omitted — too large for context window
    }, null, 2);
  } catch (error: any) {
    return `Visual extraction failed: ${error?.message || 'unknown error'}`;
  }
}

function getDefaultEntitySchema(entityType: string): Record<string, string> {
  switch (entityType) {
    case 'person':
      return {
        name: 'Full name',
        summary: 'Short description of who this person is',
        current_role: 'Current role/title',
        organization: 'Current organization',
        notable_work: 'Most notable work/achievement',
      };
    case 'product':
      return {
        name: 'Product name',
        company: 'Company that makes the product',
        category: 'Product category',
        price: 'Current typical price',
        key_features: 'Top features',
      };
    case 'topic':
      return {
        name: 'Topic name',
        summary: 'Summary of the topic',
        key_points: 'Major points/facts',
        recent_developments: 'Recent developments',
      };
    default:
      return {
        name: 'Company name',
        summary: 'What the company does',
        founded: 'Founding year/date',
        headquarters: 'Headquarters location',
        ceo: 'Current CEO',
        products: 'Main products/services',
      };
  }
}

async function toolSearchRich(query: string, entityTypeInput: unknown, extractInput: unknown): Promise<string> {
  if (!query.trim()) return 'Missing query.';

  // Visual sync: show Google search in the browser panel.
  const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  try { await managerNavigate(serpUrl); await waitForLoad(2000); } catch { /* best effort */ }

  const entityType = typeof entityTypeInput === 'string' && entityTypeInput.trim()
    ? entityTypeInput.trim().toLowerCase()
    : 'company';

  const searchResponse = await apiSearch(query);
  const topResults = searchResponse.results
    .filter((r) => r.url && r.title)
    .slice(0, 5);

  if (topResults.length === 0) {
    return JSON.stringify({
      query,
      entity_type: entityType,
      error: 'No search results found.',
    }, null, 2);
  }

  const pool = getPlaywrightPool({ maxConcurrency: MAX_BATCH_CONCURRENCY });
  const topUrls = topResults.slice(0, 3).map((r) => withProtocol(r.url));
  const fetched = await pool.execute(
    topUrls.map((url) => ({ url, actions: ['extract'] })),
    { parallel: true }
  );

  const requestedFields = Array.isArray(extractInput)
    ? extractInput.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
  const defaultSchema = getDefaultEntitySchema(entityType);
  const schema = requestedFields.length > 0
    ? Object.fromEntries(requestedFields.map((f) => [f, `Extract ${f} from sources.`]))
    : defaultSchema;

  const corpusParts: string[] = [];
  for (const result of fetched) {
    if (result.status !== 'success') continue;
    const compressedContent = compressPageContent(result.content || '', { maxChars: 4_000 }).text;
    corpusParts.push(
      `URL: ${result.url}\nTitle: ${result.title || ''}\nContent:\n${compressedContent}`
    );
  }
  const corpus = corpusParts.join('\n\n---\n\n');

  const entity = await llmExtractFromText(
    corpus || topResults.map((r) => `${r.title}\n${r.snippet}\n${r.url}`).join('\n\n'),
    schema,
    `Entity type: ${entityType}. Query: ${query}. Use only provided source material.`,
  );

  return JSON.stringify({
    query,
    entity_type: entityType,
    sources: topResults.map((r) => r.url),
    entity,
  }, null, 2);
}

async function getPageSnapshot(page: Page): Promise<string> {
  const title = await page.title().catch(() => '');
  const url = page.url() || 'about:blank';

  let content = '';
  try {
    const ariaSnapshot = await page.locator('body').ariaSnapshot({ timeout: 1500 });
    if (ariaSnapshot && ariaSnapshot.trim()) {
      const compressed = compressPageContent(ariaSnapshot, { maxChars: 6_000 });
      content = compressed.text;
    }
  } catch {
    // Fallback to text extraction if ARIA snapshot is unavailable or timed out.
  }

  if (!content) {
    const rawText = await page.evaluate(() => {
      const main = document.querySelector('article, main, [role="main"]') || document.body;
      return (main?.textContent || '').trim().substring(0, 30_000);
    });
    const compressed = compressPageContent(rawText, { maxChars: 6_000 });
    content = compressed.text;
  }

  // Store in cache for later retrieval via cache_read
  if (url && url !== 'about:blank') {
    try {
      storePage(url, title, content, {
        contentType: 'article',
        compressedLength: content.length,
      });
    } catch {
      // Cache storage is best-effort
    }
  }

  return `Page: ${title}\nURL: ${url}\n\n${content}`;
}

// --- Specialized search tool implementations ---

async function toolNews(query: string): Promise<string> {
  if (!query.trim()) return 'Missing query.';

  // Visual sync: show Google News in the browser panel.
  const newsUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=nws`;
  try { await managerNavigate(newsUrl); await waitForLoad(2000); } catch { /* best effort */ }

  const results = await searchNews(query);

  if (results.length === 0) {
    return `No recent news found for "${query}". Try browser_search for general web results.`;
  }

  let output = `Recent news for "${query}":\n\n`;
  results.forEach((r, i) => {
    output += `${i + 1}. ${r.title}\n`;
    output += `   ${r.source}${r.date ? ' · ' + r.date : ''}\n`;
    output += `   ${r.snippet}\n`;
    output += `   ${r.url}\n\n`;
  });

  return output;
}

async function toolShopping(query: string): Promise<string> {
  if (!query.trim()) return 'Missing query.';

  // Visual sync: show Google Shopping in the browser panel.
  const shopUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`;
  try { await managerNavigate(shopUrl); await waitForLoad(2000); } catch { /* best effort */ }

  const results = await searchShopping(query);

  if (results.length === 0) {
    return `No shopping results found for "${query}". Try browser_search for general web results.`;
  }

  let output = `Products for "${query}":\n\n`;
  results.forEach((r, i) => {
    output += `${i + 1}. ${r.title}\n`;
    output += `   ${r.price} — ${r.source}\n`;
    if (r.rating) output += `   ${r.rating}\n`;
    output += `   ${r.url}\n\n`;
  });

  return output;
}

async function toolPlaces(query: string): Promise<string> {
  if (!query.trim()) return 'Missing query.';

  // Visual sync: show Google Maps results in the browser panel.
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  try { await managerNavigate(mapsUrl); await waitForLoad(2000); } catch { /* best effort */ }

  const results = await searchPlaces(query);

  if (results.length === 0) {
    return `No places found for "${query}". Try browser_search for general web results.`;
  }

  let output = `Places for "${query}":\n\n`;
  results.forEach((r, i) => {
    output += `${i + 1}. ${r.title}\n`;
    output += `   ${r.address}\n`;
    if (r.rating) output += `   ${r.rating}\n`;
    if (r.hours) output += `   Hours: ${r.hours}\n`;
    if (r.phone) output += `   Phone: ${r.phone}\n`;
    output += '\n';
  });

  return output;
}

async function toolImages(query: string): Promise<string> {
  if (!query.trim()) return 'Missing query.';

  // Visual sync: show Google Images in the browser panel.
  const imgUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch`;
  try { await managerNavigate(imgUrl); await waitForLoad(2000); } catch { /* best effort */ }

  const results = await searchImages(query);

  if (results.length === 0) {
    return `No images found for "${query}".`;
  }

  let output = `Images for "${query}":\n\n`;
  results.forEach((r, i) => {
    output += `${i + 1}. ${r.title}\n`;
    output += `   Image: ${r.imageUrl}\n`;
    output += `   Source: ${r.url}\n\n`;
  });

  return output;
}

// --- Cache read tool ---

function toolCacheRead(pageId: string, sectionInput: unknown): string {
  if (!pageId.trim()) return 'Missing page_id.';

  if (!isCacheAvailable()) {
    return `Cache is not available. The page content was returned inline in the previous tool result. Re-read the earlier browser_batch or browser_navigate result for this page's content.`;
  }

  const section = typeof sectionInput === 'string' && sectionInput.trim() ? sectionInput.trim() : null;

  if (section) {
    const content = getPageSection(pageId, section);
    if (!content) return `Page [cached:${pageId}] not found in cache.`;
    return `Content from [cached:${pageId}] (section: "${section}"):\n\n${content}`;
  }

  const page = getPage(pageId);
  if (!page) return `Page [cached:${pageId}] not found in cache.`;

  return `Content from [cached:${pageId}] "${page.title}" (${page.url}):\n\n${page.content}`;
}
