type BrowserPoolType = any;

export interface SerpResult {
  url: string;
  title: string;
  snippet: string;
}

const GOOGLE_SEARCH_URL = (query: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=5`;

export class BrowserFacade {
  constructor(private pool: BrowserPoolType) {}

  async searchGoogle(query: string): Promise<SerpResult[]> {
    const view = await this.pool.acquireDiscovery();
    try {
      await view.view.webContents.loadURL(GOOGLE_SEARCH_URL(query));
      const results = await view.view.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('div.g')).map((item) => {
          const anchor = item.querySelector('a');
          const titleEl = item.querySelector('h3');
          const snippetEl = item.querySelector('.VwiC3b');
          if (!anchor || !titleEl) return null;
          return {
            url: anchor.href,
            title: titleEl.innerText || anchor.href,
            snippet: (snippetEl && snippetEl.innerText) || '',
          };
        }).filter(Boolean).slice(0, 4);
      `);
      return results || [];
    } finally {
      this.pool.release(view.view.webContents);
    }
  }

  async fetchPageText(url: string): Promise<string> {
    const view = await this.pool.acquireEvidence();
    try {
      await view.view.webContents.loadURL(url);
      const text = await view.view.webContents.executeJavaScript(
        'document.body ? document.body.innerText : document.documentElement.innerText'
      );
      return text || '';
    } finally {
      this.pool.release(view.view.webContents);
    }
  }
}
