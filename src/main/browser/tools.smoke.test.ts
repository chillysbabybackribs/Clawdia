import { describe, expect, it, vi, beforeEach } from 'vitest';

const storeData = new Map<string, unknown>();
const managerMocks = {
  createTab: vi.fn(),
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  getActivePage: vi.fn(() => null),
  getActiveTabId: vi.fn(() => 'tab-1'),
  listTabs: vi.fn(() => []),
  executeInBrowserView: vi.fn(),
  captureBrowserViewScreenshot: vi.fn(async () => Buffer.from('jpeg-bytes')),
  navigate: vi.fn(async () => ({ success: true })),
  waitForLoad: vi.fn(async () => undefined),
};

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

vi.mock('./manager', () => managerMocks);

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
    managerMocks.createTab.mockReset();
    managerMocks.switchTab.mockReset();
    managerMocks.closeTab.mockReset();
    managerMocks.getActivePage.mockReset();
    managerMocks.getActivePage.mockReturnValue(null);
    managerMocks.getActiveTabId.mockReset();
    managerMocks.getActiveTabId.mockReturnValue('tab-1');
    managerMocks.listTabs.mockReset();
    managerMocks.listTabs.mockReturnValue([]);
    managerMocks.executeInBrowserView.mockReset();
    managerMocks.captureBrowserViewScreenshot.mockReset();
    managerMocks.captureBrowserViewScreenshot.mockResolvedValue(Buffer.from('jpeg-bytes'));
    managerMocks.navigate.mockReset();
    managerMocks.navigate.mockResolvedValue({ success: true });
    managerMocks.waitForLoad.mockReset();
    managerMocks.waitForLoad.mockResolvedValue(undefined);
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

  it('falls back browser_batch to BrowserView when Playwright is unavailable', async () => {
    const manager = await import('./manager');
    const executeInBrowserViewMock = manager.executeInBrowserView as unknown as ReturnType<typeof vi.fn>;
    executeInBrowserViewMock.mockResolvedValue({
      title: 'Example',
      url: 'https://example.com',
      content: 'Example content '.repeat(200),
      headings: ['Heading'],
      links: [],
    });

    const { executeTool } = await import('./tools');
    const raw = await executeTool('browser_batch', {
      operations: [{ url: 'https://example.com', actions: ['extract', 'screenshot'] }],
    });
    const parsed = JSON.parse(raw);

    expect(parsed.mode).toBe('browserview_fallback');
    expect(parsed.succeeded).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.results[0].status).toBe('success');
    expect(typeof parsed.results[0].screenshot_base64).toBe('string');
  });

  it('falls back browser_extract to BrowserView for target URLs', async () => {
    const manager = await import('./manager');
    const executeInBrowserViewMock = manager.executeInBrowserView as unknown as ReturnType<typeof vi.fn>;
    executeInBrowserViewMock.mockResolvedValue({
      title: 'Example',
      url: 'https://example.com/docs',
      content: 'Structured content '.repeat(200),
      headings: ['Docs'],
      links: [],
    });

    const { executeTool } = await import('./tools');
    const raw = await executeTool('browser_extract', {
      url: 'https://example.com/docs',
      schema: { summary: 'Short summary' },
    });
    const parsed = JSON.parse(raw);

    expect(parsed.mode).toBe('browserview_fallback');
    expect(parsed.url).toBe('https://example.com/docs');
    expect(typeof parsed.extracted).toBe('object');
  });

  it('falls back browser_read_tabs to BrowserView sequencing when Playwright is unavailable', async () => {
    const manager = await import('./manager');
    const listTabsMock = manager.listTabs as unknown as ReturnType<typeof vi.fn>;
    const getActiveTabIdMock = manager.getActiveTabId as unknown as ReturnType<typeof vi.fn>;
    const switchTabMock = manager.switchTab as unknown as ReturnType<typeof vi.fn>;
    const executeInBrowserViewMock = manager.executeInBrowserView as unknown as ReturnType<typeof vi.fn>;

    let activeTabId = 'tab-1';
    getActiveTabIdMock.mockImplementation(() => activeTabId);
    listTabsMock.mockReturnValue([
      { id: 'tab-1', url: 'https://example.com/home' },
      { id: 'tab-2', url: 'https://example.com/docs' },
    ]);
    switchTabMock.mockImplementation(async (tabId: string) => {
      activeTabId = tabId;
      return true;
    });
    executeInBrowserViewMock.mockImplementation(async () => ({
      title: activeTabId === 'tab-1' ? 'Home' : 'Docs',
      url: activeTabId === 'tab-1' ? 'https://example.com/home' : 'https://example.com/docs',
      content: `${activeTabId} content `.repeat(200),
    }));

    const { executeTool } = await import('./tools');
    const raw = await executeTool('browser_read_tabs', { tab_ids: ['tab-1', 'tab-2'] });
    const parsed = JSON.parse(raw);

    expect(parsed.mode).toBe('browserview_fallback');
    expect(parsed.succeeded).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(parsed.results['tab-1'].status).toBe('success');
    expect(parsed.results['tab-2'].status).toBe('success');
    expect(switchTabMock).toHaveBeenCalledWith('tab-2');
    expect(switchTabMock).toHaveBeenLastCalledWith('tab-1');
  });

  it('falls back browser_visual_extract target URL to BrowserView DOM fast path', async () => {
    const manager = await import('./manager');
    const executeInBrowserViewMock = manager.executeInBrowserView as unknown as ReturnType<typeof vi.fn>;
    executeInBrowserViewMock.mockResolvedValue({
      title: 'Docs',
      url: 'https://example.com/docs',
      content: 'Visual extract content '.repeat(500),
      headings: ['Docs'],
      links: [],
    });

    const { executeTool } = await import('./tools');
    const raw = await executeTool('browser_visual_extract', { url: 'https://example.com/docs' });
    const parsed = JSON.parse(raw);

    expect(parsed.mode).toBe('browserview_fallback');
    expect(parsed.method).toBe('dom_fast_path_browserview');
    expect(parsed.status).toBe('success');
    expect(parsed.url).toBe('https://example.com/docs');
  });
});
