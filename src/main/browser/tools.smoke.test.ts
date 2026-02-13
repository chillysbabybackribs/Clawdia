import { describe, expect, it, vi, beforeEach } from 'vitest';

const storeData = new Map<string, unknown>();

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  perfLog: vi.fn(),
}));

vi.mock('../store', () => ({
  store: {
    get: (key: string) => storeData.get(key),
    set: (key: string, value: unknown) => {
      storeData.set(key, value);
    },
  },
}));

vi.mock('./manager', () => ({
  createTab: vi.fn(),
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  getActivePage: () => null,
  getActiveTabId: () => 'tab-1',
  listTabs: () => [],
  executeInBrowserView: vi.fn(),
  navigate: vi.fn(async () => ({ success: true })),
  waitForLoad: vi.fn(async () => undefined),
}));

vi.mock('./popup-dismissal', () => ({
  dismissPopups: vi.fn(async () => undefined),
}));

vi.mock('../search/backends', () => ({
  search: vi.fn(),
  setPlaywrightSearchFallback: vi.fn(),
  searchNews: vi.fn(),
  searchShopping: vi.fn(),
  searchPlaces: vi.fn(),
  searchImages: vi.fn(),
}));

vi.mock('./pool', () => ({
  getPlaywrightPool: vi.fn(() => ({
    execute: vi.fn(async () => []),
  })),
}));

vi.mock('../cache/search-cache', () => ({
  storePage: vi.fn(),
  getPage: vi.fn(),
  getPageByUrl: vi.fn(),
  getPageSection: vi.fn(),
  getPageReference: vi.fn(() => ''),
  isCacheAvailable: vi.fn(() => false),
  CACHE_MAX_AGE: 0,
}));

vi.mock('../accounts/detector', () => ({
  detectAccountOnPage: vi.fn(),
}));

vi.mock('../accounts/account-store', () => ({
  findAccount: vi.fn(),
  addAccount: vi.fn(),
  touchAccount: vi.fn(),
}));

vi.mock('../learning', () => ({
  siteKnowledge: {},
}));

vi.mock('../tasks/service-urls', () => ({
  resolveAuthenticatedUrl: vi.fn((url: string) => url),
}));

describe('browser tools smoke', () => {
  beforeEach(() => {
    storeData.clear();
  });

  it('runs browser_action_map against isolated page', async () => {
    const { executeTool } = await import('./tools');

    const mockPage: any = {
      url: () => 'https://example.com/dashboard',
      evaluate: vi.fn(async () => ([
        {
          stable_id: 'am_1',
          role: 'button',
          name: 'Save',
          selector: '#save-btn',
          text: 'Save',
          x: 120,
          y: 240,
          width: 88,
          height: 34,
          in_viewport: true,
          disabled: false,
        },
      ])),
    };

    const raw = await executeTool('browser_action_map', { max_items: 10 }, mockPage);
    const parsed = JSON.parse(raw);

    expect(parsed.status).toBe('success');
    expect(parsed.url).toBe('https://example.com/dashboard');
    expect(parsed.count).toBe(1);
    expect(parsed.elements[0].role).toBe('button');
    expect(parsed.elements[0].name).toBe('Save');
  });

  it('uses DOM fast path for browser_visual_extract when content is sufficient', async () => {
    const { executeTool } = await import('./tools');

    const mockPage: any = {
      url: () => 'https://example.com/docs',
      evaluate: vi.fn(async () => ({
        mainText: 'A'.repeat(2200),
        headingCount: 5,
        inputCount: 0,
        buttonCount: 2,
        linkCount: 12,
      })),
      screenshot: vi.fn(async () => Buffer.from('unused')),
    };

    const raw = await executeTool('browser_visual_extract', { full_page: false }, mockPage);
    const parsed = JSON.parse(raw);

    expect(parsed.status).toBe('success');
    expect(parsed.method).toBe('dom_fast_path');
    expect(parsed.extracted_text.length).toBeGreaterThan(500);
  });

  it('escalates ROI to full-page mode when ROI extraction is weak', async () => {
    const { executeTool } = await import('./tools');

    const evaluateQueue: any[] = [
      {
        mainText: 'short',
        headingCount: 1,
        inputCount: 7,
        buttonCount: 20,
        linkCount: 8,
      },
      [
        {
          label: 'main-content',
          x: 0,
          y: 0,
          width: 640,
          height: 360,
        },
      ],
    ];

    const mockPage: any = {
      url: () => 'https://example.com/app',
      evaluate: vi.fn(async () => evaluateQueue.shift()),
      screenshot: vi.fn(async (opts?: any) => {
        if (opts?.fullPage) return Buffer.from('full-screenshot');
        return Buffer.from('roi-screenshot');
      }),
    };

    const raw = await executeTool('browser_visual_extract', { full_page: false }, mockPage);
    const parsed = JSON.parse(raw);

    expect(parsed.status).toBe('success');
    expect(parsed.escalation_triggered).toBe(true);
    expect(parsed.method).toBe('vision_full_page');
    expect(parsed.full_page).toBe(true);
  });
});
