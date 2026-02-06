import { Page } from 'playwright';
import {
  createTab,
  switchTab,
  closeTab,
  getActivePage,
  getActiveTabId,
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
    description: 'Click an element by descriptive visible text or accessible name.',
    input_schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Visible text / accessible name of the element to click',
        },
      },
      required: ['ref'],
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
    description: 'Take a screenshot of the active page and return metadata.',
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
];

function withProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return 'about:blank';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('about:')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function getActiveOrCreatePage(): Page | null {
  return getActivePage();
}

export async function executeTool(name: string, input: any): Promise<string> {
  switch (name) {
    case 'browser_search':
      return toolSearch(String(input?.query || ''));
    case 'browser_navigate':
      return toolNavigate(String(input?.url || ''));
    case 'browser_read_page':
      return toolReadPage();
    case 'browser_click':
      return toolClick(String(input?.ref || ''));
    case 'browser_type':
      return toolType(String(input?.text || ''), input?.ref, Boolean(input?.pressEnter));
    case 'browser_tab':
      return toolTab(String(input?.action || ''), input?.tabId, input?.url);
    case 'browser_screenshot':
      return toolScreenshot();
    case 'browser_news':
      return toolNews(String(input?.query || ''));
    case 'browser_shopping':
      return toolShopping(String(input?.query || ''));
    case 'browser_places':
      return toolPlaces(String(input?.query || ''));
    case 'browser_images':
      return toolImages(String(input?.query || ''));
    default:
      return `Unknown tool: ${name}`;
  }
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

async function toolClick(ref: string): Promise<string> {
  if (!ref.trim()) return 'Missing ref.';
  const page = getActivePage();
  if (!page) return 'No active page.';

  const clicked = await tryClickRef(page, ref);
  if (!clicked) {
    return `Could not click "${ref}". Use browser_read_page to inspect the current page.`;
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
  await dismissPopups(page);
  const title = await page.title().catch(() => '');
  return `Clicked "${ref}". Page: ${title} — ${page.url()}`;
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

      if (!filled) {
        return `Could not find input "${key}".`;
      }
    } else {
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

async function toolTab(action: string, tabId?: string, url?: string): Promise<string> {
  switch (action) {
    case 'new': {
      const id = await createTab(url ? withProtocol(url) : 'about:blank');
      return `Opened tab ${id}${url ? ` at ${url}` : ''}.`;
    }
    case 'list': {
      const activeId = getActiveTabId();
      const page = getActivePage();
      if (!activeId) return 'No tabs open.';
      const title = page ? await page.title().catch(() => '') : '';
      const pageUrl = page ? page.url() : '';
      return `Open tabs:\n* ${activeId}: ${title || 'Untitled'} (${pageUrl || 'about:blank'})`;
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
  const buffer = await page.screenshot({ fullPage: false });
  return `Captured screenshot (${buffer.byteLength} bytes) for ${page.url() || 'about:blank'}.`;
}

async function getPageSnapshot(page: Page): Promise<string> {
  const title = await page.title().catch(() => '');
  const url = page.url() || 'about:blank';

  try {
    const ariaSnapshot = await page.locator('body').ariaSnapshot({ timeout: 3000 });
    if (ariaSnapshot && ariaSnapshot.trim()) {
      return `Page: ${title}\nURL: ${url}\n\n${ariaSnapshot.slice(0, 6000)}`;
    }
  } catch {
    // Fallback to text extraction if ARIA snapshot is unavailable.
  }

  const text = await page.evaluate(() => {
    const main = document.querySelector('article, main, [role="main"]') || document.body;
    return (main?.textContent || '').replace(/\s+/g, ' ').trim();
  });

  return `Page: ${title}\nURL: ${url}\n\n${text.slice(0, 6000)}`;
}

// --- Specialized search tool implementations ---

async function toolNews(query: string): Promise<string> {
  if (!query.trim()) return 'Missing query.';
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
