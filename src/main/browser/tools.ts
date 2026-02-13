import { Page } from 'playwright';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicClient } from '../llm/client';
import {
  createTab,
  switchTab,
  closeTab,
  getActivePage,
  getActiveTabId,
  listTabs,
  executeInBrowserView,
  captureBrowserViewScreenshot,
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
import { detectAccountOnPage } from '../accounts/detector';
import { findAccount, addAccount, touchAccount } from '../accounts/account-store';
import { siteKnowledge } from '../learning';
import { resolveAuthenticatedUrl } from '../tasks/service-urls';

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
      'Search Google and return top results with title, URL, and snippet. Snippets often directly answer factual questions. For time-sensitive queries (pricing, docs, APIs, news), include the current year in the query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Include current year for time-sensitive topics.' },
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
    description:
      'Read a page and return a structured text snapshot. Default reads the current visible page (best for follow-up clicking/typing). Optional url performs a direct URL read; use this for analysis/extraction, not immediate click refs.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to read directly' },
      },
    },
  },
  {
    name: 'browser_action_map',
    description:
      'Return an accessibility-first map of actionable UI elements (role, label/name, stable_id, selector, bounding box). Use this before complex clicking/typing on dense dashboards.',
    input_schema: {
      type: 'object',
      properties: {
        max_items: {
          type: 'number',
          description: 'Maximum number of elements to return. Default 80, max 200.',
        },
      },
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
  {
    name: 'browser_detect_account',
    description: 'Detect the logged-in user account on the current page and save it to the account registry. Use this when you want to confirm which account is active on the current site.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_interact',
    description: 'Execute a sequence of browser actions in one call. Prefer this over separate browser_click/browser_type/browser_scroll calls for 2+ sequential actions. Use url to combine navigation with interaction.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Optional: navigate to this URL before executing steps',
        },
        steps: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'type', 'scroll', 'wait', 'screenshot', 'read'] },
              ref: { type: 'string', description: 'Text/accessible name for click, or input label for type' },
              text: { type: 'string', description: 'Text to type (for type action)' },
              x: { type: 'number', description: 'X coordinate (for click)' },
              y: { type: 'number', description: 'Y coordinate (for click)' },
              selector: { type: 'string', description: 'CSS selector (for click)' },
              enter: { type: 'boolean', description: 'Press Enter after typing' },
              dir: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
              amount: { type: 'number', description: 'Scroll pixels' },
              ms: { type: 'number', description: 'Wait duration in ms (max 3000)' },
            },
            required: ['action'],
          },
        },
        stopOnError: {
          type: 'boolean',
          description: 'Stop after first failure. Default: false.',
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields at once by label or selector, and optionally submit. More reliable than sequential click+type for forms.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Input label, placeholder, or name attribute' },
              selector: { type: 'string', description: 'CSS selector fallback' },
              value: { type: 'string', description: 'Value to fill. For selects, option text or value.' },
              type: { type: 'string', enum: ['text', 'select', 'checkbox', 'radio', 'textarea'], description: 'Input type hint. Default: text.' },
            },
            required: ['value'],
          },
        },
        submit: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Button label to click after filling' },
            selector: { type: 'string', description: 'CSS selector for submit button' },
          },
          description: 'Optional: click this element after filling all fields',
        },
      },
      required: ['fields'],
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

/**
 * Module-level override page for headless/isolated tool execution.
 * When set, all browser tools use this page instead of the interactive BrowserView page.
 * Set via executeTool(name, input, overridePage) and cleared after execution.
 */
let _overridePage: Page | null = null;

/**
 * Returns the current page for tool execution.
 * If an override page is set (headless/isolated context), returns that.
 * Otherwise falls back to the interactive BrowserView page.
 */
function getActiveOrCreatePage(): Page | null {
  return _overridePage ?? getActivePage();
}

const MAX_BATCH_URLS = 10;
const MAX_BATCH_CONCURRENCY = 5;
const MAX_EXTRACT_CHARS = 16_000; // ~4000 tokens heuristic
const VISION_RESULT_CACHE_TTL_MS = 8 * 60_000;
const VISION_RESULT_CACHE_MAX_ENTRIES = 220;
const ROI_ESCALATION_MIN_TEXT = 260;
const DOMAIN_VISION_POLICY_KEY = 'browserVisionPolicyV1';

interface DomainVisionPolicy {
  domStrongMinChars: number;
  domStructuredMinChars: number;
  remoteDomMinChars: number;
  roiSuccesses: number;
  roiFailures: number;
  preferFullPageUntil: number;
  updatedAt: number;
}

interface VisionCacheEntry {
  fingerprint: string;
  extractedText: string;
  createdAt: number;
  mode: 'roi' | 'full';
}

const DEFAULT_DOMAIN_VISION_POLICY: DomainVisionPolicy = {
  domStrongMinChars: 1400,
  domStructuredMinChars: 900,
  remoteDomMinChars: 1200,
  roiSuccesses: 0,
  roiFailures: 0,
  preferFullPageUntil: 0,
  updatedAt: 0,
};

const visionResultCache = new Map<string, VisionCacheEntry>();
let domainVisionPolicyCache: Record<string, DomainVisionPolicy> | null = null;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashToken(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

function getDomainFromUrl(url: string | null): string {
  if (!url) return 'local';
  try {
    return normalizeDomain(new URL(withProtocol(url)).hostname || 'local');
  } catch {
    return 'local';
  }
}

function loadDomainVisionPolicyCache(): Record<string, DomainVisionPolicy> {
  if (domainVisionPolicyCache) return domainVisionPolicyCache;
  const raw = store.get(DOMAIN_VISION_POLICY_KEY);
  if (raw && typeof raw === 'object') {
    domainVisionPolicyCache = raw as Record<string, DomainVisionPolicy>;
  } else {
    domainVisionPolicyCache = {};
  }
  return domainVisionPolicyCache;
}

function saveDomainVisionPolicyCache(): void {
  if (!domainVisionPolicyCache) return;
  store.set(DOMAIN_VISION_POLICY_KEY, domainVisionPolicyCache);
}

function getDomainVisionPolicy(url: string | null): DomainVisionPolicy {
  const domain = getDomainFromUrl(url);
  const map = loadDomainVisionPolicyCache();
  const policy = map[domain];
  if (!policy) {
    return { ...DEFAULT_DOMAIN_VISION_POLICY };
  }
  return {
    ...DEFAULT_DOMAIN_VISION_POLICY,
    ...policy,
  };
}

function updateDomainVisionPolicy(url: string | null, updater: (policy: DomainVisionPolicy) => DomainVisionPolicy): DomainVisionPolicy {
  const domain = getDomainFromUrl(url);
  const map = loadDomainVisionPolicyCache();
  const current = getDomainVisionPolicy(url);
  const next = updater(current);
  map[domain] = {
    ...DEFAULT_DOMAIN_VISION_POLICY,
    ...next,
    updatedAt: Date.now(),
  };
  saveDomainVisionPolicyCache();
  return map[domain];
}

function makeVisionCacheKey(url: string | null, mode: 'roi' | 'full'): string {
  const normalizedUrl = url ? withProtocol(url) : 'active-page';
  return `${mode}:${normalizedUrl}`;
}

function evictExpiredVisionCache(): void {
  const now = Date.now();
  for (const [key, entry] of visionResultCache.entries()) {
    if (now - entry.createdAt > VISION_RESULT_CACHE_TTL_MS) {
      visionResultCache.delete(key);
    }
  }
  while (visionResultCache.size > VISION_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = visionResultCache.keys().next().value;
    if (!oldest) break;
    visionResultCache.delete(oldest);
  }
}

function readVisionCache(url: string | null, mode: 'roi' | 'full', fingerprint: string): VisionCacheEntry | null {
  evictExpiredVisionCache();
  const key = makeVisionCacheKey(url, mode);
  const cached = visionResultCache.get(key);
  if (!cached) return null;
  if (cached.fingerprint !== fingerprint) return null;
  return cached;
}

function writeVisionCache(url: string | null, mode: 'roi' | 'full', fingerprint: string, extractedText: string): void {
  evictExpiredVisionCache();
  const key = makeVisionCacheKey(url, mode);
  visionResultCache.set(key, {
    fingerprint,
    extractedText,
    createdAt: Date.now(),
    mode,
  });
}

function buildDomFingerprint(url: string | null, probe: DomVisionProbe, fullPage: boolean, policy: DomainVisionPolicy): string {
  const payload = [
    url || 'active-page',
    fullPage ? 'full' : 'roi',
    probe.mainTextLength,
    probe.headingCount,
    probe.inputCount,
    probe.buttonCount,
    probe.linkCount,
    policy.domStrongMinChars,
    policy.domStructuredMinChars,
    probe.text.slice(0, 2000),
  ].join('|');
  return hashToken(payload);
}

function buildImageFingerprint(url: string | null, images: VisionImageInput[], fullPage: boolean, policy: DomainVisionPolicy): string {
  const imageSignature = images
    .map((img) => `${img.label}:${img.base64.length}:${img.base64.slice(0, 96)}:${img.base64.slice(-96)}`)
    .join('|');
  const payload = [
    url || 'active-page',
    fullPage ? 'full' : 'roi',
    policy.preferFullPageUntil,
    imageSignature,
  ].join('|');
  return hashToken(payload);
}

function shouldPreferFullPage(policy: DomainVisionPolicy): boolean {
  return policy.preferFullPageUntil > Date.now();
}

function updateVisionDomainOutcome(url: string | null, mode: 'roi' | 'full', textLength: number): DomainVisionPolicy {
  return updateDomainVisionPolicy(url, (policy) => {
    const next = { ...policy };
    const roiSuccess = mode === 'roi' && textLength >= ROI_ESCALATION_MIN_TEXT;
    const roiFailure = mode === 'roi' && textLength < ROI_ESCALATION_MIN_TEXT;

    if (roiSuccess) next.roiSuccesses += 1;
    if (roiFailure) next.roiFailures += 1;

    if (roiFailure && next.roiFailures >= 2 && next.roiFailures > next.roiSuccesses) {
      next.preferFullPageUntil = Date.now() + (15 * 60_000);
    } else if (roiSuccess && next.roiSuccesses >= Math.max(3, next.roiFailures * 2)) {
      next.preferFullPageUntil = 0;
    }

    const bias = next.roiFailures - next.roiSuccesses;
    next.domStrongMinChars = clampNumber(1400 + (bias * 120), 1000, 2400);
    next.domStructuredMinChars = clampNumber(900 + (bias * 90), 700, 1900);
    next.remoteDomMinChars = clampNumber(1200 + (bias * 100), 900, 2200);
    return next;
  });
}

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

function getSharedClient(): AnthropicClient | null {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return null;
  const model = getSelectedModel();
  return new AnthropicClient(apiKey, model);
}

async function llmExtract(pageData: Record<string, unknown>, schema: Record<string, string>): Promise<Record<string, unknown>> {
  const client = getSharedClient();
  if (!client) {
    return {
      _error: 'Missing Anthropic API key for extraction.',
      _raw: pageData,
    };
  }

  const schemaJson = JSON.stringify(schema, null, 2);
  const pageJson = clampText(JSON.stringify(pageData, null, 2));

  const { text } = await client.complete([
    {
      role: 'user',
      content:
        `Extract data into JSON using this schema (field -> requirement):\n${schemaJson}\n\n` +
        `Source page data:\n${pageJson}\n\n` +
        'Return only a valid JSON object with exactly the schema keys. Use null for unknown values.',
    },
  ], { maxTokens: 700 });

  const parsed = parseJsonObject(text);
  if (parsed) return parsed;

  return {
    _error: 'Failed to parse extraction JSON.',
    _raw_response: clampText(text, 4_000),
    _raw: pageData,
  };
}

type VisionMediaType = 'image/png' | 'image/jpeg';

interface VisionImageInput {
  label: string;
  base64: string;
  mediaType: VisionMediaType;
}

interface DomVisionProbe {
  text: string;
  mainTextLength: number;
  headingCount: number;
  inputCount: number;
  buttonCount: number;
  linkCount: number;
}

interface RoiRegion {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function isDomProbeSufficient(probe: DomVisionProbe, policy: DomainVisionPolicy): boolean {
  const hasStrongContent = probe.mainTextLength >= policy.domStrongMinChars;
  const hasStructuredContent = probe.mainTextLength >= policy.domStructuredMinChars && probe.headingCount >= 3;
  const heavyInteractiveUi = probe.inputCount >= 6 || probe.buttonCount >= 18;
  return (hasStrongContent || hasStructuredContent) && !heavyInteractiveUi;
}

async function buildDomVisionProbe(page: Page): Promise<DomVisionProbe> {
  const raw = await page.evaluate(() => {
    const main = document.querySelector('main, article, [role="main"]') || document.body;
    const mainText = (main.textContent || '').trim();
    const headingCount = main.querySelectorAll('h1,h2,h3').length;
    const inputCount = document.querySelectorAll('input, textarea, select').length;
    const buttonCount = document.querySelectorAll('button, [role="button"]').length;
    const linkCount = document.querySelectorAll('a[href]').length;
    return { mainText, headingCount, inputCount, buttonCount, linkCount };
  });

  const compressed = compressPageContent(raw.mainText || '', { maxChars: 5_500 }).text;
  return {
    text: compressed,
    mainTextLength: raw.mainText?.length || 0,
    headingCount: raw.headingCount || 0,
    inputCount: raw.inputCount || 0,
    buttonCount: raw.buttonCount || 0,
    linkCount: raw.linkCount || 0,
  };
}

async function detectRoiRegions(page: Page): Promise<RoiRegion[]> {
  const regions = await page.evaluate(() => {
    type Region = { label: string; x: number; y: number; width: number; height: number };

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);

    const rectToRegion = (label: string, rect: DOMRect | null): Region | null => {
      if (!rect) return null;
      const x = clamp(Math.floor(rect.left), 0, vw - 1);
      const y = clamp(Math.floor(rect.top), 0, vh - 1);
      const maxWidth = vw - x;
      const maxHeight = vh - y;
      const width = clamp(Math.floor(rect.width), 120, maxWidth);
      const height = clamp(Math.floor(rect.height), 120, maxHeight);
      if (width < 120 || height < 120) return null;
      return { label, x, y, width, height };
    };

    const list: Region[] = [];
    const seen = new Set<string>();
    const pushUnique = (region: Region | null) => {
      if (!region) return;
      const key = `${region.x}:${region.y}:${region.width}:${region.height}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(region);
    };

    const main = document.querySelector('main, article, [role="main"]') as HTMLElement | null;
    const form = document.querySelector('form, [role="form"], input, textarea, select') as HTMLElement | null;
    const nav = document.querySelector('nav, [role="navigation"], aside') as HTMLElement | null;

    pushUnique(rectToRegion('main-content', main?.getBoundingClientRect() || null));
    pushUnique(rectToRegion('form-area', form?.closest('form')?.getBoundingClientRect() || form?.getBoundingClientRect() || null));
    pushUnique(rectToRegion('navigation', nav?.getBoundingClientRect() || null));

    pushUnique({ label: 'viewport-overview', x: 0, y: 0, width: vw, height: Math.min(vh, 900) });
    return list.slice(0, 3);
  });

  return regions;
}

async function captureVisionInputs(page: Page, fullPage: boolean): Promise<VisionImageInput[]> {
  if (fullPage) {
    const full = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true });
    return [{ label: 'full-page', base64: full.toString('base64'), mediaType: 'image/jpeg' }];
  }

  const regions = await detectRoiRegions(page);
  const images: VisionImageInput[] = [];

  for (const region of regions) {
    try {
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: 55,
        clip: {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        },
      });
      images.push({
        label: region.label,
        base64: buffer.toString('base64'),
        mediaType: 'image/jpeg',
      });
    } catch {
      // Best-effort region capture; continue with others.
    }
  }

  if (images.length === 0) {
    const fallback = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
    images.push({ label: 'viewport-fallback', base64: fallback.toString('base64'), mediaType: 'image/jpeg' });
  }

  return images;
}

async function llmVisionExtractText(images: VisionImageInput[]): Promise<string> {
  const client = getSharedClient();
  if (!client) return 'Missing Anthropic API key for visual extraction.';

  const valid = images.filter((img) => img.base64 && img.base64.length > 0);
  if (valid.length === 0) return 'No image content available for visual extraction.';

  const content: any[] = [
    {
      type: 'text',
      text: `You will receive ${valid.length} screenshot region(s) from a web page. Merge them into one coherent reading order.`,
    },
  ];

  for (const [index, image] of valid.entries()) {
    content.push({ type: 'text', text: `Region ${index + 1}: ${image.label}` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.base64,
      },
    });
  }

  content.push({
    type: 'text',
    text: 'Extract visible text for action planning. Preserve headings, labels, and buttons. Return plain text only.',
  });

  const { text } = await client.complete([
    {
      role: 'user',
      content,
    },
  ], { maxTokens: 1_600 });

  return text.trim();
}

function normalizedTextLength(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

async function resolveVisionExtraction(
  sourceUrl: string | null,
  mode: 'roi' | 'full',
  images: VisionImageInput[],
  policy: DomainVisionPolicy,
): Promise<{ text: string; cacheHit: boolean; fingerprint: string }> {
  const fingerprint = buildImageFingerprint(sourceUrl, images, mode === 'full', policy);
  const cached = readVisionCache(sourceUrl, mode, fingerprint);
  if (cached) {
    return {
      text: cached.extractedText,
      cacheHit: true,
      fingerprint,
    };
  }

  const text = await llmVisionExtractText(images);
  writeVisionCache(sourceUrl, mode, fingerprint, text);
  return {
    text,
    cacheHit: false,
    fingerprint,
  };
}

async function llmExtractFromText(
  sourceText: string,
  schema: Record<string, string>,
  extraInstructions?: string,
): Promise<Record<string, unknown>> {
  const client = getSharedClient();
  if (!client) {
    return {
      _error: 'Missing Anthropic API key for extraction.',
      _raw_text: clampText(sourceText),
    };
  }

  const { text } = await client.complete([
    {
      role: 'user',
      content:
        `Extract JSON using this schema (field -> requirement):\n${JSON.stringify(schema, null, 2)}\n\n` +
        `${extraInstructions ? `${extraInstructions}\n\n` : ''}` +
        `Source text:\n${clampText(sourceText)}\n\n` +
        'Return only one valid JSON object. Use null for unknown fields.',
    },
  ], { maxTokens: 900 });

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

async function getBrowserViewSnapshot(maxLen = 30_000): Promise<string | null> {
  const pageData = await executeInBrowserView<Record<string, unknown>>(domExtractJs(maxLen));
  if (!pageData) return null;

  const title = typeof pageData.title === 'string' ? pageData.title : '';
  const url = typeof pageData.url === 'string' && pageData.url ? pageData.url : 'about:blank';
  const rawContent = typeof pageData.content === 'string' ? pageData.content : '';
  const content = compressPageContent(rawContent, { maxChars: 6_000 }).text;

  if (!title && !content) return null;

  if (url && url !== 'about:blank') {
    try {
      storePage(url, title, content, {
        contentType: 'article',
        compressedLength: content.length,
      });
    } catch {
      // Cache storage is best-effort.
    }
  }

  return `${title} (${url})\n\n${content}`;
}

async function getBrowserViewMeta(): Promise<{ title: string; url: string; width: number; height: number } | null> {
  const meta = await executeInBrowserView<Record<string, unknown>>(`(() => ({
    title: document.title || '',
    url: location.href || 'about:blank',
    width: window.innerWidth || 0,
    height: window.innerHeight || 0
  }))()`);
  if (!meta) return null;
  return {
    title: typeof meta.title === 'string' ? meta.title : '',
    url: typeof meta.url === 'string' ? meta.url : 'about:blank',
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
  };
}

async function toolClickInBrowserView(ref: string, x?: unknown, y?: unknown, selector?: unknown): Promise<string> {
  const payload = {
    ref: typeof ref === 'string' ? ref.trim() : '',
    selector: typeof selector === 'string' ? selector.trim() : '',
    x: typeof x === 'number' ? x : null,
    y: typeof y === 'number' ? y : null,
  };

  const result = await executeInBrowserView<Record<string, unknown>>(`(() => {
    const p = ${JSON.stringify(payload)};
    const clickEl = (el) => {
      if (!el) return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
      try { el.click(); } catch {}
      try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch {}
      return true;
    };
    const textOf = (el) => {
      const own = (el.innerText || el.textContent || '').trim();
      const aria = (el.getAttribute?.('aria-label') || '').trim();
      const value = (el.value || '').trim();
      return (own || aria || value || '').toLowerCase();
    };
    const targetUrl = location.href || 'about:blank';
    const targetTitle = document.title || '';

    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const el = document.elementFromPoint(p.x, p.y);
      if (!el) return { ok: false, message: 'No element found at the provided coordinates.' };
      clickEl(el);
      return { ok: true, label: 'coordinates (' + p.x + ', ' + p.y + ')', url: targetUrl, title: targetTitle };
    }

    if (p.selector) {
      const el = document.querySelector(p.selector);
      if (!el) return { ok: false, message: 'No element matched selector "' + p.selector + '".' };
      clickEl(el);
      return { ok: true, label: 'selector "' + p.selector + '"', url: targetUrl, title: targetTitle };
    }

    if (p.ref) {
      const needle = String(p.ref).toLowerCase();
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], summary'));
      const match = candidates.find((el) => textOf(el).includes(needle));
      if (!match) return { ok: false, message: 'Could not find element matching "' + p.ref + '".' };
      clickEl(match);
      return { ok: true, label: '"' + p.ref + '"', url: targetUrl, title: targetTitle };
    }

    return { ok: false, message: 'No click target specified. Provide ref, selector, or x+y coordinates.' };
  })()`);

  if (!result) return 'No active page.';
  if (result.ok) {
    return `Clicked ${String(result.label || 'target')}. → ${String(result.title || '')} (${String(result.url || 'about:blank')})`;
  }
  return String(result.message || 'Failed to click target.');
}

async function toolTypeInBrowserView(text: string, ref: unknown, pressEnter: boolean): Promise<string> {
  const payload = {
    text,
    ref: typeof ref === 'string' ? ref.trim() : '',
    pressEnter: Boolean(pressEnter),
  };

  const result = await executeInBrowserView<Record<string, unknown>>(`(() => {
    const p = ${JSON.stringify(payload)};
    const needle = (p.ref || '').toLowerCase();

    const isEditable = (el) => {
      if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable === true;
    };

    const findByLabel = () => {
      if (!needle) return null;
      const labels = Array.from(document.querySelectorAll('label'));
      for (const label of labels) {
        const text = (label.textContent || '').trim().toLowerCase();
        if (!text.includes(needle)) continue;
        const forId = label.getAttribute('for');
        if (forId) {
          const byId = document.getElementById(forId);
          if (isEditable(byId)) return byId;
        }
        const nested = label.querySelector('input, textarea');
        if (isEditable(nested)) return nested;
      }
      return null;
    };

    const findByAttrs = () => {
      if (!needle) return null;
      const candidates = Array.from(document.querySelectorAll('input, textarea'));
      return candidates.find((el) => {
        const attrs = [
          el.getAttribute('name') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('placeholder') || '',
          el.id || '',
        ].join(' ').toLowerCase();
        return attrs.includes(needle);
      }) || null;
    };

    let target = findByLabel() || findByAttrs();
    if (!target) target = document.activeElement;
    if (!isEditable(target)) {
      return { ok: false, message: p.ref ? 'Could not find input "' + p.ref + '".' : 'No focused editable input found.' };
    }

    target.focus?.();

    if (target.isContentEditable) {
      target.textContent = p.text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      target.value = p.text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (p.pressEnter) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      if (target.form && typeof target.form.requestSubmit === 'function') {
        target.form.requestSubmit();
      }
    }

    const label = p.ref || target.getAttribute?.('name') || target.getAttribute?.('aria-label') || target.id || 'focused element';
    return { ok: true, label };
  })()`);

  if (!result) return 'No active page.';
  if (!result.ok) return String(result.message || 'Failed to type into target input.');
  return `Typed "${text}"${pressEnter ? ' +Enter' : ''} into ${String(result.label || 'focused element')}.`;
}

async function runBrowserViewBatchOperation(op: PageOperation): Promise<PageResult> {
  const startedAt = Date.now();
  const unsupportedActions = op.actions.filter((action) => action === 'pdf' || action === 'intercept_network');
  const supportedActions = op.actions.filter((action) => action !== 'pdf' && action !== 'intercept_network');

  if (supportedActions.length === 0) {
    return {
      url: op.url,
      status: 'error',
      error: `BrowserView fallback does not support: ${unsupportedActions.join(', ')}`,
      time_ms: Date.now() - startedAt,
    };
  }

  try {
    await managerNavigate(withProtocol(op.url));
    await waitForLoad(12_000).catch(() => undefined);

    const pageData = await executeInBrowserView<Record<string, unknown>>(domExtractJs(16_000));
    if (!pageData) {
      return {
        url: op.url,
        status: 'error',
        error: 'Failed to read page via BrowserView.',
        time_ms: Date.now() - startedAt,
      };
    }

    const url = typeof pageData.url === 'string' && pageData.url ? pageData.url : withProtocol(op.url);
    const title = typeof pageData.title === 'string' ? pageData.title : '';
    const rawContent = typeof pageData.content === 'string' ? pageData.content : '';
    const content = compressPageContent(rawContent, { maxChars: 6_000 }).text;

    const result: PageResult = {
      url,
      status: 'success',
      title,
      time_ms: 0,
    };

    if (supportedActions.includes('extract')) {
      result.content = content;
      if (op.extract_schema && Object.keys(op.extract_schema).length > 0) {
        const extracted = await llmExtract(
          {
            ...pageData,
            content: compressPageContent(rawContent, { maxChars: 4_000 }).text,
          },
          op.extract_schema,
        );
        result.extracted = extracted;
      }
    }

    if (supportedActions.includes('screenshot')) {
      const screenshot = await captureBrowserViewScreenshot(60);
      if (screenshot) {
        result.screenshot_base64 = screenshot.toString('base64');
      }
    }

    if (op.evaluate) {
      result.evaluated = await executeInBrowserView(op.evaluate);
    }

    if (unsupportedActions.length > 0) {
      result.evaluated = {
        ...(result.evaluated && typeof result.evaluated === 'object' ? result.evaluated as Record<string, unknown> : {}),
        warning: `Skipped unsupported actions in BrowserView fallback: ${unsupportedActions.join(', ')}`,
      };
    }

    result.time_ms = Date.now() - startedAt;
    return result;
  } catch (error: any) {
    return {
      url: withProtocol(op.url),
      status: 'error',
      error: `BrowserView fallback failed: ${error?.message || 'unknown error'}`,
      time_ms: Date.now() - startedAt,
    };
  }
}

async function runBrowserViewBatchFallback(operations: PageOperation[]): Promise<PageResult[]> {
  const results: PageResult[] = [];
  for (const op of operations) {
    results.push(await runBrowserViewBatchOperation(op));
  }
  return results;
}

function formatBrowserViewBatchFallback(results: PageResult[]): string {
  const succeeded = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'error').length;
  return JSON.stringify(
    {
      status: failed === 0 ? 'success' : succeeded > 0 ? 'partial' : 'error',
      mode: 'browserview_fallback',
      note: 'Playwright unavailable; executed batch operations sequentially in BrowserView.',
      succeeded,
      failed,
      results,
    },
    null,
    2,
  );
}

async function toolActionMap(maxItemsInput: unknown): Promise<string> {
  const page = getActiveOrCreatePage();
  if (!page) {
    const maxItems = clampNumber(Number(maxItemsInput) || 80, 10, 200);
    const elements = await executeInBrowserView<Array<Record<string, unknown>>>(`(() => {
      const roleFromTag = (el) => {
        const explicitRole = (el.getAttribute('role') || '').trim();
        if (explicitRole) return explicitRole;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'input') return 'textbox';
        return tag;
      };
      const textFor = (el) => {
        const aria = (el.getAttribute('aria-label') || '').trim();
        const title = (el.getAttribute('title') || '').trim();
        const value = ('value' in el ? String(el.value || '').trim() : '');
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
        return aria || title || value || text;
      };
      const all = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=\"button\"],[role=\"link\"],[role=\"textbox\"],summary'));
      const out = [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) continue;
        const name = textFor(el);
        out.push({
          stable_id: 'bv-' + i,
          role: roleFromTag(el),
          name: name,
          selector: '',
          text: name,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          in_viewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        });
      }
      return out.slice(0, ${maxItems});
    })()`);
    const meta = await getBrowserViewMeta();
    if (!elements) return 'No active page.';
    return JSON.stringify({
      status: 'success',
      url: meta?.url || null,
      count: elements.length,
      elements,
      note: 'BrowserView fallback map (Playwright unavailable).',
    }, null, 2);
  }

  const maxItems = clampNumber(Number(maxItemsInput) || 80, 10, 200);
  const elements = await page.evaluate((limit) => {
    type ActionEntry = {
      stable_id: string;
      role: string;
      name: string;
      selector: string;
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      in_viewport: boolean;
      disabled: boolean;
    };

    const roleFromTag = (el: Element): string => {
      const explicitRole = (el.getAttribute('role') || '').trim();
      if (explicitRole) return explicitRole;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = ((el as HTMLInputElement).type || '').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      return 'generic';
    };

    const readLabelledBy = (el: Element): string => {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      if (ids.length === 0) return '';
      const labels: string[] = [];
      for (const id of ids) {
        const node = document.getElementById(id);
        const text = (node?.textContent || '').trim();
        if (text) labels.push(text);
      }
      return labels.join(' ').trim();
    };

    const nameFor = (el: Element): string => {
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria) return aria;
      const labelledBy = readLabelledBy(el);
      if (labelledBy) return labelledBy;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        if (placeholder) return placeholder;
        const labelNode = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
        const labelText = (labelNode?.textContent || '').trim();
        if (labelText) return labelText;
        const value = ('value' in el ? String((el as any).value || '').trim() : '');
        if (value) return value;
      }
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const selectorFor = (el: Element): string => {
      const id = (el.id || '').trim();
      if (id) return `#${CSS.escape(id)}`;
      const testId = (el.getAttribute('data-testid') || el.getAttribute('data-test') || '').trim();
      if (testId) return `[data-testid="${testId}"]`;
      const name = (el.getAttribute('name') || '').trim();
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const role = (el.getAttribute('role') || '').trim();
      if (role) return `${el.tagName.toLowerCase()}[role="${role}"]`;
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && depth < 4 && node !== document.body) {
        const parentEl: Element | null = node.parentElement;
        const tag = node.tagName.toLowerCase();
        if (!parentEl) {
          parts.unshift(tag);
          break;
        }
        const nodeTag = node.tagName;
        const siblings = Array.from(parentEl.children).filter((c: Element) => c.tagName === nodeTag);
        const index = siblings.indexOf(node) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(1, index)})`);
        node = parentEl;
        depth += 1;
      }
      return parts.join(' > ');
    };

    const stableIdFor = (el: Element, role: string, name: string, selector: string): string => {
      const text = `${role}|${name}|${selector}`;
      let hash = 0;
      for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
      }
      return `am_${Math.abs(hash).toString(36)}`;
    };

    const candidates = Array.from(
      document.querySelectorAll(
        'button, a[href], input, textarea, select, [role], [tabindex]:not([tabindex="-1"])',
      ),
    );

    const seen = new Set<string>();
    const results: ActionEntry[] = [];
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const role = roleFromTag(el);
      const name = nameFor(el);
      const selector = selectorFor(el);
      const stableId = stableIdFor(el, role, name, selector);
      const key = `${stableId}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const inViewport =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight;

      results.push({
        stable_id: stableId,
        role,
        name,
        selector,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        in_viewport: inViewport,
        disabled: Boolean((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'),
      });
    }

    results.sort((a, b) => {
      if (a.in_viewport !== b.in_viewport) return a.in_viewport ? -1 : 1;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });

    return results.slice(0, limit);
  }, maxItems);

  const currentUrl = page.url() || null;
  return JSON.stringify({
    status: 'success',
    url: currentUrl,
    count: elements.length,
    elements,
  }, null, 2);
}

/**
 * Execute a browser tool.
 *
 * @param name Tool name (e.g. 'browser_navigate')
 * @param input Tool input parameters
 * @param overridePage Optional isolated Playwright Page for headless tasks.
 *   When provided, all page-dependent tools use this instead of the interactive BrowserView page.
 *   When omitted, falls back to getActivePage() (existing interactive behavior).
 */
/** Produce an actionable hint from a navigation error so the LLM can adapt. */
function diagnoseNavError(error: string | undefined, url: string): string {
  if (!error) return '';
  const e = error.toLowerCase();
  if (e.includes('timeout') || e.includes('timed out'))
    return '[Hint: Page load timed out. Try again or use browser_search to find a working URL.]';
  if (e.includes('err_name_not_resolved') || e.includes('could not resolve'))
    return '[Hint: Domain not found. Check the URL spelling or search for the correct domain.]';
  if (e.includes('err_connection_refused'))
    return '[Hint: Connection refused. The server may be down or the port is wrong.]';
  if (e.includes('err_cert') || e.includes('ssl'))
    return '[Hint: SSL/certificate error. Try http:// instead of https:// or verify the domain.]';
  if (e.includes('404') || e.includes('not found'))
    return '[Hint: Page not found (404). The URL may be incorrect — use browser_search to find the right page.]';
  if (e.includes('403') || e.includes('forbidden'))
    return '[Hint: Access forbidden. You may need to log in first or the page blocks automated access.]';
  if (e.includes('net::err_'))
    return `[Hint: Network error. Verify the URL "${url}" is correct and the site is reachable.]`;
  return '';
}

export async function executeTool(name: string, input: any, overridePage?: Page | null): Promise<string> {
  // Set module-level override so getActiveOrCreatePage() returns the isolated page
  _overridePage = overridePage ?? null;
  const t0 = performance.now();
  let result: string;
  try {
    switch (name) {
      case 'browser_search':
        result = await toolSearch(String(input?.query || '')); break;
      case 'browser_navigate':
        result = await toolNavigate(String(input?.url || '')); break;
      case 'browser_read_page':
        result = await toolReadPage(input?.url); break;
      case 'browser_action_map':
        result = await toolActionMap(input?.max_items); break;
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
      case 'browser_detect_account':
        result = await toolDetectAccount(); break;
      case 'browser_interact':
        result = await toolInteract(input?.url, input?.steps, Boolean(input?.stopOnError)); break;
      case 'browser_fill_form':
        result = await toolFillForm(input?.fields || [], input?.submit); break;
      default:
        result = `Unknown tool: ${name}`;
    }
  } finally {
    // Always clear the override after execution to prevent leaking into interactive calls
    _overridePage = null;
  }
  const ms = performance.now() - t0;
  perfLog('browser-tool', name, ms, { chars: result.length });
  return result;
}

// Register Playwright Google scraping as last-resort fallback for search API.
// Called once after Playwright is initialized.
export function registerPlaywrightSearchFallback(): void {
  setPlaywrightSearchFallback(async (query: string): Promise<SearchResult[]> => {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    // Use isolated page directly if available; otherwise navigate via BrowserView.
    const page = _overridePage ?? getActiveOrCreatePage();
    if (_overridePage) {
      await _overridePage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    } else {
      await managerNavigate(searchUrl);
      await waitForLoad(3000);
    }

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

  // Fire-and-forget visual sync — show SERP in browser panel without blocking.
  // Skip for isolated contexts (headless tasks) — they don't own the BrowserView.
  if (!_overridePage) {
    const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    void managerNavigate(serpUrl).catch(() => {});
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

  output += `"${query}" results (${response.source}):\n\n`;
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
  let targetUrl = withProtocol(url);

  // Isolated context path: navigate the isolated page directly, skip BrowserView
  if (_overridePage) {
    // Resolve authenticated URLs for headless tasks (e.g., gmail.com → mail.google.com/mail/u/0/#inbox)
    const resolved = resolveAuthenticatedUrl(targetUrl);
    if (resolved !== targetUrl) {
      toolsLog.info(`[Navigate] Resolved ${targetUrl} → ${resolved} (authenticated URL)`);
      targetUrl = resolved;
    }

    try {
      await _overridePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    } catch (err: any) {
      return `Failed to navigate to ${targetUrl}: ${err?.message || 'unknown error'}. ${diagnoseNavError(err?.message, targetUrl)}`;
    }
    await dismissPopups(_overridePage);
    return getPageSnapshot(_overridePage);
  }

  // Interactive path: navigate via BrowserView (always works).
  const result = await managerNavigate(targetUrl);
  if (!result.success) {
    return `Failed to navigate to ${targetUrl}: ${result.error || 'unknown error'}. ${diagnoseNavError(result.error, targetUrl)}`;
  }

  // Wait for BrowserView to finish loading (event-driven, up to 3s timeout).
  await waitForLoad(3000);

  // Try to read the page via Playwright if available.
  const page = getActiveOrCreatePage();
  if (page) {
    await dismissPopups(page);
    return getPageSnapshot(page);
  }

  // BrowserView fallback when Playwright is unavailable.
  const browserViewSnapshot = await getBrowserViewSnapshot(30_000);
  if (browserViewSnapshot) return browserViewSnapshot;
  return `Navigated to ${targetUrl}. (Page reading unavailable.)`;
}

async function toolReadPage(url?: unknown): Promise<string> {
  const requestedUrl = typeof url === 'string' ? url.trim() : '';
  if (requestedUrl) {
    const targetUrl = withProtocol(requestedUrl);

    // Isolated/headless context: navigate the isolated page directly.
    if (_overridePage) {
      try {
        await _overridePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      } catch (err: any) {
        return `Failed to read ${targetUrl}: ${err?.message || 'unknown error'}. ${diagnoseNavError(err?.message, targetUrl)}`;
      }
      await dismissPopups(_overridePage);
      const snapshot = await getPageSnapshot(_overridePage);
      return `[Headless URL read]\n${snapshot}\n\n[Note] This snapshot is optimized for analysis. Before clicking/typing on this URL, run browser_navigate + browser_read_page (without url) on the visible browser tab.`;
    }

    // Interactive context: explicit URL means "navigate then read".
    const navResult = await managerNavigate(targetUrl);
    if (!navResult.success) {
      return `Failed to read ${targetUrl}: ${navResult.error || 'unknown error'}. ${diagnoseNavError(navResult.error, targetUrl)}`;
    }
    await waitForLoad(3000);
  }

  const page = getActiveOrCreatePage();
  if (!page) {
    const browserViewSnapshot = await getBrowserViewSnapshot(30_000);
    return browserViewSnapshot || 'No active page.';
  }
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
  const page = getActiveOrCreatePage();
  if (!page) return toolClickInBrowserView(ref, x, y, selector);

  let clicked = false;
  let clickLabel = '';
  let usedMethod = '';
  let usedSelector: string | undefined;
  let usedCoordinates: string | undefined;
  const targetRef = typeof ref === 'string' ? ref.trim() : '';

  let hostname = '';
  try {
    hostname = new URL(page.url()).hostname.replace('www.', '');
  } catch {
    hostname = '';
  }

  // If we know a working approach for this action, try it first.
  if (siteKnowledge && targetRef && !selector && typeof x !== 'number' && typeof y !== 'number' && hostname) {
    const known = siteKnowledge.getKnownApproach(hostname, 'click', targetRef);
    if (known) {
      if (known.working_method === 'selector' && known.working_selector) {
        selector = known.working_selector;
        console.log(`[Learning] Using learned selector for "${targetRef}" on ${hostname}: ${selector}`);
      } else if (known.working_method === 'coordinates' && known.working_coordinates) {
        const [cx, cy] = known.working_coordinates.split(',').map(Number);
        if (Number.isFinite(cx) && Number.isFinite(cy)) {
          x = cx;
          y = cy;
          console.log(`[Learning] Using learned coordinates for "${targetRef}" on ${hostname}: ${x},${y}`);
        }
      }
    }
  }

  // Strategy 1: Coordinate-based click (from screenshot)
  if (typeof x === 'number' && typeof y === 'number') {
    try {
      await page.mouse.click(x, y);
      clicked = true;
      clickLabel = `coordinates (${x}, ${y})`;
      usedMethod = 'coordinates';
      usedCoordinates = `${x},${y}`;
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
      usedMethod = 'selector';
      usedSelector = selector.trim();
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
    if (clicked) {
      usedMethod = 'ref';
    }
  }

  if (!clicked) {
    if (ref.trim()) {
      // Auto-screenshot to save a round trip — LLM can click by coordinates directly
      try {
        const screenshot = await toolScreenshot();
        const parsed = JSON.parse(screenshot);
        if (hostname && siteKnowledge) {
          siteKnowledge.recordOutcome({
            hostname,
            action: 'click',
            targetRef: targetRef,
            success: false,
            method: typeof selector === 'string' && selector.trim() ? 'selector' : 'ref',
          });
        }
        return JSON.stringify({
          __clawdia_image_result__: true,
          image_base64: parsed.image_base64,
          media_type: 'image/jpeg',
          text: `Could not click "${ref}". Here is the current page — use x,y coordinates to click the element.`,
        });
      } catch {
        if (hostname && siteKnowledge) {
          siteKnowledge.recordOutcome({
            hostname,
            action: 'click',
            targetRef: targetRef,
            success: false,
            method: typeof selector === 'string' && selector.trim() ? 'selector' : 'ref',
          });
        }
        return `Could not click "${ref}". Try browser_screenshot to see the page, then click with x/y coordinates.`;
      }
    }
    if (hostname && siteKnowledge) {
      siteKnowledge.recordOutcome({
        hostname,
        action: 'click',
        targetRef: targetRef || (typeof selector === 'string' ? selector : ''),
        success: false,
        method: typeof selector === 'string' && selector.trim() ? 'selector' : 'unknown',
      });
    }
    return 'No click target specified. Provide ref (text), x+y (coordinates), or selector (CSS).';
  }

  // Event-driven stabilization — wait for any SPA navigation the click might trigger.
  // Do NOT call dismissPopups here: clicks are in-page interactions, not navigations.
  await page.waitForLoadState('domcontentloaded', { timeout: 800 }).catch(() => null);
  const title = await page.title().catch(() => '');

  if (hostname && siteKnowledge) {
    const attemptedMethod =
      usedMethod ||
      (typeof x === 'number' && typeof y === 'number'
        ? 'coordinates'
        : typeof selector === 'string' && selector.trim()
        ? 'selector'
        : targetRef
        ? 'ref'
        : 'unknown');
    siteKnowledge.recordOutcome({
      hostname,
      action: 'click',
      targetRef: targetRef || (typeof selector === 'string' ? selector : ''),
      success: true,
      method: attemptedMethod,
      selector: usedSelector,
      coordinates: usedCoordinates,
    });
  }

  return `Clicked ${clickLabel}. → ${title} (${page.url()})`;
}

async function toolType(text: string, ref: unknown, pressEnter: boolean): Promise<string> {
  if (!text) return 'Missing text.';
  const page = getActiveOrCreatePage();
  if (!page) return toolTypeInBrowserView(text, ref, pressEnter);

  let hostname = '';
  try {
    hostname = new URL(page.url()).hostname.replace('www.', '');
  } catch {
    hostname = '';
  }

  let usedMethod = '';
  let usedSelector: string | undefined;
  const targetRef = typeof ref === 'string' ? ref.trim() : '';

  try {
    if (typeof ref === 'string' && ref.trim()) {
      const key = ref.trim();
      const locators: Array<{ locator: any; method: string }> = [
        { locator: page.getByRole('textbox', { name: key, exact: false }).first(), method: 'role' },
        { locator: page.getByPlaceholder(key).first(), method: 'placeholder' },
        { locator: page.locator(`[name="${key}"]`).first(), method: 'name' },
        { locator: page.locator(`[aria-label="${key}"]`).first(), method: 'aria-label' },
      ];

      if (hostname && siteKnowledge) {
        const known = siteKnowledge.getKnownApproach(hostname, 'type', key);
        if (known?.working_method === 'selector' && known.working_selector) {
          locators.unshift({
            locator: page.locator(known.working_selector).first(),
            method: 'selector',
          });
          console.log(`[Learning] Using learned selector for input "${key}" on ${hostname}: ${known.working_selector}`);
        }
      }

      let filled = false;
      for (const { locator, method } of locators) {
        try {
          await locator.fill(text, { timeout: 4000 });
          if (pressEnter) {
            await locator.press('Enter', { timeout: 2000 }).catch(() => null);
          }
          filled = true;
          usedMethod = method;
          usedSelector = method === 'selector' ? locator.toString?.() : undefined;
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
          usedMethod = 'twitter-composer';
        }
      }

      if (!filled) {
        if (hostname && siteKnowledge) {
          siteKnowledge.recordOutcome({
            hostname,
            action: 'type',
            targetRef: key,
            success: false,
            method: usedMethod || 'ref',
          });
        }
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
      usedMethod = 'keyboard';
    }
  } catch (error: any) {
    return `Failed to type: ${error?.message || 'unknown error'}`;
  }

  if (hostname && siteKnowledge) {
    siteKnowledge.recordOutcome({
      hostname,
      action: 'type',
      targetRef: targetRef || '[focused]',
      success: true,
      method: usedMethod || 'ref',
      selector: usedSelector,
    });
  }

  return `Typed "${text}"${pressEnter ? ' +Enter' : ''}.`;
}

async function toolScroll(directionInput: unknown, amountInput: unknown): Promise<string> {
  const page = getActiveOrCreatePage();
  if (!page) {
    const direction = String(directionInput || 'down').toLowerCase() === 'up' ? 'up' : 'down';
    const parsedAmount = Number(amountInput);
    const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? Math.floor(parsedAmount) : 600;
    const deltaY = direction === 'up' ? -amount : amount;
    const result = await executeInBrowserView<Record<string, unknown>>(`(() => {
      window.scrollBy(0, ${deltaY});
      return { y: window.scrollY || 0 };
    })()`);
    if (!result) return 'No active page.';
    return `Scrolled ${direction} ${amount}px.`;
  }

  const direction = String(directionInput || 'down').toLowerCase() === 'up' ? 'up' : 'down';
  const parsedAmount = Number(amountInput);
  const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? Math.floor(parsedAmount) : 600;
  const deltaY = direction === 'up' ? -amount : amount;

  try {
    await page.mouse.wheel(0, deltaY);
    return `Scrolled ${direction} ${amount}px.`;
  } catch (error: any) {
    return `Failed to scroll: ${error?.message || 'unknown error'}`;
  }
}

async function toolTab(action: string, tabId?: string, url?: string): Promise<string> {
  // Tab management is a BrowserView concept — not available in isolated contexts.
  if (_overridePage) return 'Tab management is not available in headless mode.';

  switch (action) {
    case 'new': {
      const id = await createTab(url ? withProtocol(url) : 'about:blank');
      return `Tab ${id}${url ? ` → ${url}` : ''}`;
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
      return `Switched → ${tabId}.`;
    }
    case 'close': {
      if (!tabId) return 'Missing tabId for close.';
      await closeTab(tabId);
      return `Closed ${tabId}`;
    }
    default:
      return `Unknown tab action: ${action}`;
  }
}

async function toolScreenshot(): Promise<string> {
  const page = getActiveOrCreatePage();
  if (page) {
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

  const [buffer, meta] = await Promise.all([
    captureBrowserViewScreenshot(60),
    getBrowserViewMeta(),
  ]);
  if (!buffer) return 'No active page.';

  const base64 = buffer.toString('base64');
  const url = meta?.url || 'about:blank';
  const title = meta?.title || '';
  const width = meta?.width || '?';
  const height = meta?.height || '?';
  return JSON.stringify({
    __clawdia_image_result__: true,
    image_base64: base64,
    media_type: 'image/jpeg',
    text: `Screenshot of "${title}" — ${url}\nViewport size: ${width}x${height}px. Use coordinates (x, y) from this image with browser_click to click elements.`,
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
    // In unrestricted mode, allow all domains in visual tabs
    const autonomyMode = (store.get('autonomyMode') as string) || 'guided';
    if (autonomyMode === 'unrestricted') return true;

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

  if (!_overridePage && !getActiveOrCreatePage()) {
    const fallbackResults = await runBrowserViewBatchFallback(operations);
    return formatBrowserViewBatchFallback(fallbackResults);
  }

  // Visual sync — skip entirely for isolated contexts (headless tasks).
  let firstVisibleUrl: string | undefined;
  const visualTabIds: string[] = [];
  let visualTabPromise: Promise<void> = Promise.resolve();

  if (!_overridePage) {
    // Navigate the visible BrowserView to the first URL immediately so the user
    // sees activity right away, before headless extraction starts.
    firstVisibleUrl = operations.map(op => op.url).find(shouldShowVisualTab);
    if (firstVisibleUrl) {
      try {
        await managerNavigate(firstVisibleUrl);
      } catch { /* best effort */ }
    }

    // Open additional visual tabs for remaining URLs (fire-and-forget)
    const urlsForVisualTabs = operations
      .map(op => op.url)
      .filter(shouldShowVisualTab)
      .filter(url => url !== firstVisibleUrl)
      .slice(0, 4);

    visualTabPromise = (async () => {
      for (const url of urlsForVisualTabs) {
        try {
          const tabId = await createTab(url);
          visualTabIds.push(tabId);
          await new Promise(r => setTimeout(r, 150));
        } catch { /* visual tabs are UX-only */ }
      }
    })();
  }

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
  // Visual enhancements — skip entirely for isolated contexts (headless tasks).
  if (!_overridePage) {

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

  } // end !_overridePage visual enhancements

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

          if (pageId) {
            cachedReferences.push(getPageReference(pageId));
          } else {
            // storePage returned empty — cache unavailable, fall back to inline
            inlineResults.push(`## ${r.title || r.url}\n${r.content.slice(0, 6_000)}`);
          }
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
  // Tab reading is a BrowserView concept — not available in isolated contexts.
  if (_overridePage) return 'Tab reading is not available in headless mode.';

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
      // In isolated mode, evaluate on the isolated page; otherwise use BrowserView.
      const rawPageData: Record<string, unknown> | null = _overridePage
        ? await _overridePage.evaluate(() => {
            const main = document.querySelector('main, article, [role="main"]') || document.body;
            const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map((a) => ({
              text: (a.textContent || '').trim(),
              href: (a as HTMLAnchorElement).href,
            }));
            return {
              title: document.title || '',
              url: location.href,
              content: (main.textContent || '').trim().substring(0, 16000),
              headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => (h.textContent || '').trim()).filter(Boolean),
              links,
            };
          })
        : await executeInBrowserView<Record<string, unknown>>(domExtractJs(16_000));
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
  const requestedFullPage = Boolean(fullPageInput);
  const activePage = getActiveOrCreatePage();
  const activeTabId = getActiveTabId();
  const tabId = typeof tabIdInput === 'string' ? tabIdInput : null;
  const inputUrl = typeof urlInput === 'string' && urlInput.trim().length > 0 ? withProtocol(urlInput) : null;

  try {
    let sourceUrl = inputUrl || null;

    if (!inputUrl && (!tabId || tabId === activeTabId) && activePage) {
      sourceUrl = activePage.url() || sourceUrl;
      let policy = getDomainVisionPolicy(sourceUrl);
      const domProbe = await buildDomVisionProbe(activePage);
      const domFingerprint = buildDomFingerprint(sourceUrl, domProbe, requestedFullPage, policy);
      const domCacheMode: 'roi' | 'full' = requestedFullPage ? 'full' : 'roi';
      const cachedFromDomFingerprint = readVisionCache(sourceUrl, domCacheMode, domFingerprint);

      if (isDomProbeSufficient(domProbe, policy)) {
        return JSON.stringify({
          status: 'success',
          url: sourceUrl,
          full_page: requestedFullPage,
          method: 'dom_fast_path',
          dom_metrics: {
            main_text_length: domProbe.mainTextLength,
            heading_count: domProbe.headingCount,
            input_count: domProbe.inputCount,
            button_count: domProbe.buttonCount,
            link_count: domProbe.linkCount,
          },
          routing_policy: {
            domain: getDomainFromUrl(sourceUrl),
            dom_strong_min_chars: policy.domStrongMinChars,
            dom_structured_min_chars: policy.domStructuredMinChars,
          },
          extracted_text: domProbe.text,
        }, null, 2);
      }

      if (cachedFromDomFingerprint) {
        const updatedPolicy = updateVisionDomainOutcome(sourceUrl, cachedFromDomFingerprint.mode, normalizedTextLength(cachedFromDomFingerprint.extractedText));
        return JSON.stringify({
          status: 'success',
          url: sourceUrl,
          full_page: cachedFromDomFingerprint.mode === 'full',
          method: 'vision_cache_hit_dom',
          cache_hit: true,
          routing_policy: {
            domain: getDomainFromUrl(sourceUrl),
            dom_strong_min_chars: updatedPolicy.domStrongMinChars,
            dom_structured_min_chars: updatedPolicy.domStructuredMinChars,
            prefer_full_page: shouldPreferFullPage(updatedPolicy),
          },
          extracted_text: cachedFromDomFingerprint.extractedText,
        }, null, 2);
      }

      const initialMode: 'roi' | 'full' = (requestedFullPage || shouldPreferFullPage(policy)) ? 'full' : 'roi';
      const initialImages = await captureVisionInputs(activePage, initialMode === 'full');
      const initialResult = await resolveVisionExtraction(sourceUrl, initialMode, initialImages, policy);

      let finalMode: 'roi' | 'full' = initialMode;
      let finalImages = initialImages;
      let finalText = initialResult.text;
      let cacheHit = initialResult.cacheHit;
      let escalationTriggered = false;

      if (initialMode === 'roi' && normalizedTextLength(initialResult.text) < ROI_ESCALATION_MIN_TEXT) {
        escalationTriggered = true;
        const fullImages = await captureVisionInputs(activePage, true);
        const fullResult = await resolveVisionExtraction(sourceUrl, 'full', fullImages, policy);
        if (normalizedTextLength(fullResult.text) >= normalizedTextLength(initialResult.text)) {
          finalMode = 'full';
          finalImages = fullImages;
          finalText = fullResult.text;
        }
        cacheHit = cacheHit || fullResult.cacheHit;
      }

      writeVisionCache(sourceUrl, finalMode, domFingerprint, finalText);
      const updatedPolicy = updateVisionDomainOutcome(sourceUrl, finalMode, normalizedTextLength(finalText));
      return JSON.stringify({
        status: 'success',
        url: sourceUrl,
        full_page: finalMode === 'full',
        method: finalMode === 'full' ? 'vision_full_page' : 'vision_roi',
        cache_hit: cacheHit,
        escalation_triggered: escalationTriggered,
        image_regions: finalImages.map((img) => img.label),
        routing_policy: {
          domain: getDomainFromUrl(sourceUrl),
          dom_strong_min_chars: updatedPolicy.domStrongMinChars,
          dom_structured_min_chars: updatedPolicy.domStructuredMinChars,
          prefer_full_page: shouldPreferFullPage(updatedPolicy),
          roi_failures: updatedPolicy.roiFailures,
          roi_successes: updatedPolicy.roiSuccesses,
        },
        extracted_text: finalText,
      }, null, 2);
    } else {
      const targetUrl = inputUrl || (tabId ? getTabUrlById(tabId) : null);
      if (!targetUrl) return 'Unable to resolve target URL for visual extraction.';

      let policy = getDomainVisionPolicy(targetUrl);
      const firstPassFullPage = requestedFullPage || shouldPreferFullPage(policy);
      const pool = getPlaywrightPool({ maxConcurrency: MAX_BATCH_CONCURRENCY });
      const [result] = await pool.execute(
        [{ url: withProtocol(targetUrl), actions: ['extract', 'screenshot'], full_page: firstPassFullPage }],
        { parallel: true }
      );

      if (result.status !== 'success' || !result.screenshot_base64) {
        return JSON.stringify(result, null, 2);
      }

      sourceUrl = result.url;
      policy = getDomainVisionPolicy(sourceUrl);

      const contentText = typeof result.content === 'string' ? result.content.trim() : '';
      if (contentText.length >= policy.remoteDomMinChars) {
        return JSON.stringify({
          status: 'success',
          url: sourceUrl,
          full_page: firstPassFullPage,
          method: 'dom_fast_path_remote',
          routing_policy: {
            domain: getDomainFromUrl(sourceUrl),
            remote_dom_min_chars: policy.remoteDomMinChars,
          },
          extracted_text: contentText,
        }, null, 2);
      }

      const initialMode: 'roi' | 'full' = firstPassFullPage ? 'full' : 'roi';
      const initialImages: VisionImageInput[] = [
        {
          label: 'remote-page',
          base64: result.screenshot_base64,
          mediaType: 'image/png',
        },
      ];

      const initialResult = await resolveVisionExtraction(sourceUrl, initialMode, initialImages, policy);
      let finalMode: 'roi' | 'full' = initialMode;
      let finalImages = initialImages;
      let finalText = initialResult.text;
      let cacheHit = initialResult.cacheHit;
      let escalationTriggered = false;

      if (initialMode === 'roi' && normalizedTextLength(initialResult.text) < ROI_ESCALATION_MIN_TEXT && !requestedFullPage) {
        escalationTriggered = true;
        const [fullResultPage] = await pool.execute(
          [{ url: withProtocol(targetUrl), actions: ['screenshot'], full_page: true }],
          { parallel: true },
        );
        if (fullResultPage.status === 'success' && fullResultPage.screenshot_base64) {
          const fullImages: VisionImageInput[] = [
            {
              label: 'remote-full-page',
              base64: fullResultPage.screenshot_base64,
              mediaType: 'image/png',
            },
          ];
          const fullResult = await resolveVisionExtraction(sourceUrl, 'full', fullImages, policy);
          if (normalizedTextLength(fullResult.text) >= normalizedTextLength(initialResult.text)) {
            finalMode = 'full';
            finalImages = fullImages;
            finalText = fullResult.text;
          }
          cacheHit = cacheHit || fullResult.cacheHit;
        }
      }

      const updatedPolicy = updateVisionDomainOutcome(sourceUrl, finalMode, normalizedTextLength(finalText));
      return JSON.stringify({
        status: 'success',
        url: sourceUrl,
        full_page: finalMode === 'full',
        method: finalMode === 'full' ? 'vision_full_page_remote' : 'vision_roi_remote',
        cache_hit: cacheHit,
        escalation_triggered: escalationTriggered,
        image_regions: finalImages.map((img) => img.label),
        routing_policy: {
          domain: getDomainFromUrl(sourceUrl),
          remote_dom_min_chars: updatedPolicy.remoteDomMinChars,
          prefer_full_page: shouldPreferFullPage(updatedPolicy),
          roi_failures: updatedPolicy.roiFailures,
          roi_successes: updatedPolicy.roiSuccesses,
        },
        extracted_text: finalText,
      }, null, 2);
    }
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

  // Fire-and-forget visual sync — skip for isolated contexts (headless tasks).
  if (!_overridePage) {
    const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    void managerNavigate(serpUrl).catch(() => {});
  }

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

  // Classify page type: content pages get direct text extraction (less noise),
  // interactive pages get ARIA snapshot (preserves element roles for clicking).
  const pageType = await page.evaluate(() => {
    const main = document.querySelector('article, main, [role="main"]');
    const inputs = document.querySelectorAll('input, select, textarea').length;
    const buttons = document.querySelectorAll('button, [role="button"]').length;
    const contentLen = main?.textContent?.trim().length || 0;
    if (contentLen > 3000 && inputs < 5 && buttons < 10) return 'content';
    return 'interactive';
  }).catch(() => 'interactive' as const);

  let content = '';

  if (pageType === 'content') {
    // Content pages: direct text extraction is more token-efficient than ARIA
    const rawText = await page.evaluate(() => {
      const main = document.querySelector('article, main, [role="main"]') || document.body;
      return (main?.textContent || '').trim().substring(0, 30_000);
    });
    content = compressPageContent(rawText, { maxChars: 6_000 }).text;
  } else {
    // Interactive pages: ARIA snapshot preserves roles/labels for element targeting
    try {
      const ariaSnapshot = await page.locator('body').ariaSnapshot({ timeout: 1500 });
      if (ariaSnapshot && ariaSnapshot.trim()) {
        content = compressPageContent(ariaSnapshot, { maxChars: 6_000 }).text;
      }
    } catch {
      // Fallback to text extraction if ARIA snapshot is unavailable or timed out.
    }

    if (!content) {
      const rawText = await page.evaluate(() => {
        const main = document.querySelector('article, main, [role="main"]') || document.body;
        return (main?.textContent || '').trim().substring(0, 30_000);
      });
      content = compressPageContent(rawText, { maxChars: 6_000 }).text;
    }
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

  return `${title} (${url})\n\n${content}`;
}

// --- Specialized search tool implementations ---

async function toolNews(query: string): Promise<string> {
  if (!query.trim()) return 'Missing query.';

  // Fire-and-forget visual sync — skip for isolated contexts.
  if (!_overridePage) {
    const newsUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=nws`;
    void managerNavigate(newsUrl).catch(() => {});
  }

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

  // Fire-and-forget visual sync — skip for isolated contexts.
  if (!_overridePage) {
    const shopUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`;
    void managerNavigate(shopUrl).catch(() => {});
  }

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

  // Fire-and-forget visual sync — skip for isolated contexts.
  if (!_overridePage) {
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    void managerNavigate(mapsUrl).catch(() => {});
  }

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

  // Fire-and-forget visual sync — skip for isolated contexts.
  if (!_overridePage) {
    const imgUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch`;
    void managerNavigate(imgUrl).catch(() => {});
  }

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

// --- Compound action tools ---

async function toolInteract(
  url: string | undefined,
  steps: Array<{
    action: string;
    ref?: string;
    text?: string;
    x?: number;
    y?: number;
    selector?: string;
    enter?: boolean;
    dir?: string;
    amount?: number;
    ms?: number;
  }>,
  stopOnError = false,
): Promise<string> {
  if (!steps || steps.length === 0) return 'No steps provided.';

  // Optional: navigate before executing steps
  if (url && url.trim()) {
    const targetUrl = withProtocol(url);
    if (_overridePage) {
      try {
        await _overridePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      } catch (err: any) {
        return `Navigation failed: ${err?.message || 'unknown'}`;
      }
    } else {
      const navResult = await managerNavigate(targetUrl);
      if (!navResult.success) return `Navigation failed: ${navResult.error || 'unknown'}`;
      await waitForLoad(3000);
    }
  }

  const page = getActiveOrCreatePage();

  const results: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let result: string;
    try {
      switch (step.action) {
        case 'click':
          result = await toolClick(step.ref || '', step.x, step.y, step.selector);
          break;
        case 'type':
          result = await toolType(step.text || '', step.ref, Boolean(step.enter));
          break;
        case 'scroll':
          result = await toolScroll(step.dir, step.amount);
          break;
        case 'wait': {
          const ms = Math.min(Number(step.ms) || 500, 3000);
          if (page) await page.waitForTimeout(ms);
          else await new Promise((resolve) => setTimeout(resolve, ms));
          result = `wait:${ms}ms`;
          break;
        }
        case 'screenshot':
          result = await toolScreenshot();
          break;
        case 'read':
          result = page ? await getPageSnapshot(page) : ((await getBrowserViewSnapshot(30_000)) || 'No active page.');
          break;
        default:
          result = `Unknown action: ${step.action}`;
      }
    } catch (err: any) {
      result = `Step ${i + 1} error: ${err?.message || 'unknown'}`;
    }
    results.push(`[${i + 1}] ${result}`);

    // Abort remaining steps if this one failed and stopOnError is true
    if (stopOnError && /could not|failed|error/i.test(result)) {
      const skipped = steps.length - i - 1;
      if (skipped > 0) results.push(`Stopped: step ${i + 1} failed. ${skipped} step(s) skipped.`);
      break;
    }
  }

  const meta = page
    ? {
      title: await page.title().catch(() => ''),
      url: page.url(),
    }
    : await getBrowserViewMeta();
  const title = meta?.title || '';
  const finalUrl = meta?.url || 'about:blank';
  results.push(`→ ${title} (${finalUrl})`);

  return results.join('\n');
}

interface FormField {
  label?: string;
  selector?: string;
  value: string;
  type?: string;
}

interface SubmitTarget {
  ref?: string;
  selector?: string;
}

async function resolveFormLocator(page: Page, field: FormField) {
  const label = field.label?.trim();
  if (label) {
    // Try matching strategies in order of preference
    const strategies = [
      // 1. label[for] association
      () => page.locator(`label:has-text("${label}") + input, label:has-text("${label}") + select, label:has-text("${label}") + textarea`).first(),
      // 2. aria-label
      () => page.locator(`[aria-label="${label}"]`).first(),
      // 3. placeholder
      () => page.locator(`[placeholder="${label}"]`).first(),
      // 4. name attribute
      () => page.locator(`[name="${label}"]`).first(),
      // 5. Playwright getByLabel
      () => page.getByLabel(label).first(),
    ];

    for (const strategy of strategies) {
      const locator = strategy();
      try {
        await locator.waitFor({ timeout: 1500, state: 'attached' });
        return locator;
      } catch {
        // Try next strategy
      }
    }
  }

  // Fallback: CSS selector
  if (field.selector?.trim()) {
    return page.locator(field.selector.trim()).first();
  }

  return null;
}

async function toolFillForm(fields: FormField[], submit?: SubmitTarget): Promise<string> {
  const page = getActiveOrCreatePage();
  if (!page) return 'No active page.';

  const results: string[] = [];
  for (const field of fields) {
    const locator = await resolveFormLocator(page, field);
    const fieldLabel = field.label || field.selector || '(unknown)';
    if (!locator) {
      results.push(`${fieldLabel}: FAILED — no matching element`);
      continue;
    }
    try {
      const inputType = (field.type || 'text').toLowerCase();
      switch (inputType) {
        case 'select':
          await locator.selectOption(field.value, { timeout: 3000 });
          break;
        case 'checkbox':
        case 'radio':
          if (field.value === 'true' || field.value === '1' || field.value === 'yes') {
            await locator.check({ timeout: 3000 });
          } else {
            await locator.uncheck({ timeout: 3000 });
          }
          break;
        default:
          await locator.fill(field.value, { timeout: 3000 });
      }
      results.push(`${fieldLabel}: ok`);
    } catch (e: any) {
      results.push(`${fieldLabel}: FAILED — ${e?.message || 'unknown'}`);
    }
  }

  if (submit) {
    try {
      if (submit.selector) {
        await page.locator(submit.selector).first().click({ timeout: 4000 });
      } else if (submit.ref) {
        const clicked = await tryClickRef(page, submit.ref);
        if (!clicked) {
          results.push(`Submit "${submit.ref}": FAILED — button not found`);
        }
      }
      if (!results[results.length - 1]?.includes('FAILED')) {
        results.push(`Submitted via "${submit.ref || submit.selector}".`);
      }
    } catch (e: any) {
      results.push(`Submit: FAILED — ${e?.message || 'unknown'}`);
    }
  }

  return results.join('\n');
}

// --- Account detection tool ---

async function toolDetectAccount(): Promise<string> {
  const page = getActiveOrCreatePage();
  if (!page) return 'No active page.';

  const url = page.url();
  if (!url || url === 'about:blank') return 'No URL loaded.';

  const detected = await detectAccountOnPage(url);
  if (!detected) return `No account detected on ${url}. This site may not be supported or no user is logged in.`;

  const existing = findAccount(detected.domain, detected.username);
  if (existing) {
    touchAccount(existing.id);
    return `Account already registered: ${detected.platform} — ${detected.username} (${detected.domain})`;
  }

  const account = addAccount({
    domain: detected.domain,
    platform: detected.platform,
    username: detected.username,
    profileUrl: detected.profileUrl,
    isManual: false,
  });

  return `Account detected and saved: ${account.platform} — ${account.username} (${account.domain})`;
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
