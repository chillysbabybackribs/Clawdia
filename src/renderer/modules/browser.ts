import type { BrowserTabInfo, ResearchProgress, ResearchSourcePreview } from '../../shared/types';
import {
  ADDRESS_BAR_TRACKING_QUERY_PARAMS,
  ADDRESS_HISTORY_MAX_ITEMS,
  ADDRESS_HISTORY_STORAGE_KEY,
  ADDRESS_HISTORY_VISIBLE_SUGGESTIONS,
  DEFAULT_TAB_URL,
  EMPTY_TAB_TITLE,
  elements,
  appState,
} from './state';
import { escapeHtml } from './markdown';
import { scrollToBottom } from './stream';

const SITE_SHORTCUTS: Record<string, string> = {
  claude: 'https://claude.ai',
  chatgpt: 'https://chatgpt.com',
  gemini: 'https://gemini.google.com',
  perplexity: 'https://perplexity.ai',
  midjourney: 'https://midjourney.com',
  huggingface: 'https://huggingface.co',
  hf: 'https://huggingface.co',
  github: 'https://github.com',
  gh: 'https://github.com',
  gitlab: 'https://gitlab.com',
  stackoverflow: 'https://stackoverflow.com',
  so: 'https://stackoverflow.com',
  npm: 'https://www.npmjs.com',
  mdn: 'https://developer.mozilla.org',
  codepen: 'https://codepen.io',
  replit: 'https://replit.com',
  vercel: 'https://vercel.com',
  netlify: 'https://netlify.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  drive: 'https://drive.google.com',
  docs: 'https://docs.google.com',
  sheets: 'https://sheets.google.com',
  slides: 'https://slides.google.com',
  calendar: 'https://calendar.google.com',
  maps: 'https://maps.google.com',
  youtube: 'https://www.youtube.com',
  yt: 'https://www.youtube.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  reddit: 'https://www.reddit.com',
  linkedin: 'https://www.linkedin.com',
  facebook: 'https://www.facebook.com',
  fb: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com',
  ig: 'https://www.instagram.com',
  threads: 'https://www.threads.net',
  discord: 'https://discord.com',
  slack: 'https://slack.com',
  twitch: 'https://www.twitch.tv',
  amazon: 'https://www.amazon.com',
  ebay: 'https://www.ebay.com',
  walmart: 'https://www.walmart.com',
  target: 'https://www.target.com',
  bestbuy: 'https://www.bestbuy.com',
  homedepot: 'https://www.homedepot.com',
  'home depot': 'https://www.homedepot.com',
  lowes: 'https://www.lowes.com',
  costco: 'https://www.costco.com',
  etsy: 'https://www.etsy.com',
  netflix: 'https://www.netflix.com',
  hulu: 'https://www.hulu.com',
  spotify: 'https://open.spotify.com',
  notion: 'https://www.notion.so',
  figma: 'https://www.figma.com',
  canva: 'https://www.canva.com',
  trello: 'https://trello.com',
  jira: 'https://www.atlassian.com/software/jira',
  hackernews: 'https://news.ycombinator.com',
  hn: 'https://news.ycombinator.com',
  'hacker news': 'https://news.ycombinator.com',
  techcrunch: 'https://techcrunch.com',
  tc: 'https://techcrunch.com',
  producthunt: 'https://www.producthunt.com',
  ph: 'https://www.producthunt.com',
  robinhood: 'https://robinhood.com',
  coinbase: 'https://www.coinbase.com',
  paypal: 'https://www.paypal.com',
  venmo: 'https://venmo.com',
};

export function initBrowser(): void {
  initializeAddressHistory();
  setupBrowserControlListeners();
  setupBrowserListeners();
}

function setupBrowserControlListeners(): void {
  elements.browserMenuBtn.addEventListener('click', toggleBrowserMenu);
  elements.browserMenuBody.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (target?.dataset.action) {
      void handleBrowserMenuAction(target.dataset.action);
    }
  });

  elements.browserToggle.addEventListener('click', () => {
    const isHidden = elements.panelContainer.classList.toggle('hidden');
    elements.panelContainer.classList.toggle('panel-user-hidden', isHidden);
    if (!isHidden) {
      syncBrowserBounds();
    }
  });

  elements.browserGoBtn.addEventListener('click', () => {
    void navigateBrowser();
  });

  elements.browserUrlInput.addEventListener('focus', () => {
    // Select all text on focus for easy overwrite
    elements.browserUrlInput.select();
    refreshAddressSuggestions();
  });
  elements.browserUrlInput.addEventListener('input', () => {
    refreshAddressSuggestions();
  });
  elements.browserUrlInput.addEventListener('paste', () => {
    window.setTimeout(() => refreshAddressSuggestions(), 0);
  });
  elements.browserUrlInput.addEventListener('blur', () => {
    window.setTimeout(() => closeAddressSuggestions(), 120);
  });
  elements.browserUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (elements.browserUrlSuggestions.classList.contains('hidden')) {
        refreshAddressSuggestions();
      }
      shiftHighlightedAddressSuggestion(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (elements.browserUrlSuggestions.classList.contains('hidden')) {
        refreshAddressSuggestions();
      }
      shiftHighlightedAddressSuggestion(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const highlighted = appState.visibleAddressSuggestions[appState.highlightedAddressSuggestionIndex];
      if (highlighted) {
        void navigateBrowser(highlighted);
        return;
      }
      void navigateBrowser();
      return;
    }
    if (e.key === 'Escape') {
      closeAddressSuggestions();
      // Revert URL bar to the current page URL and blur
      setBrowserAddressValue(appState.currentBrowserUrl);
      elements.browserUrlInput.blur();
    }
  });

  elements.browserUrlSuggestions.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  elements.browserUrlSuggestions.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('.browser-url-suggestion') as HTMLButtonElement | null;
    if (!target) return;
    const url = target.dataset.url;
    if (!url) return;
    void navigateBrowser(url);
  });
  elements.browserUrlSuggestions.addEventListener('mousemove', (event) => {
    const target = (event.target as HTMLElement).closest('.browser-url-suggestion') as HTMLButtonElement | null;
    if (!target) return;
    const index = Number(target.dataset.index);
    if (Number.isNaN(index) || index < 0 || index >= appState.visibleAddressSuggestions.length) return;
    setHighlightedAddressSuggestion(index);
  });

  elements.browserBackBtn.addEventListener('click', () => {
    void window.api.browserBack();
  });
  elements.browserForwardBtn.addEventListener('click', () => {
    void window.api.browserForward();
  });
  elements.browserReloadBtn.addEventListener('click', () => {
    void window.api.browserRefresh();
  });

  elements.panelMinBtn?.addEventListener('click', () => {
    void window.api.windowMinimize();
  });
  elements.panelMaxBtn?.addEventListener('click', () => {
    void window.api.windowMaximize();
  });
  elements.panelCloseBtn?.addEventListener('click', () => {
    void window.api.windowClose();
  });

  elements.minBtn?.addEventListener('click', () => {
    void window.api.windowMinimize();
  });
  elements.maxBtn?.addEventListener('click', () => {
    void window.api.windowMaximize();
  });
  elements.closeBtn?.addEventListener('click', () => {
    void window.api.windowClose();
  });

  window.addEventListener('resize', syncBrowserBounds);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncBrowserBounds();
  });
  setInterval(() => {
    if (!elements.panelContainer.classList.contains('hidden') && document.visibilityState === 'visible') {
      syncBrowserBounds();
    }
  }, 5000);

  const browserControlsEl = elements.panelContainer.querySelector('.browser-controls');
  const tabStripEl = elements.panelContainer.querySelector('.tab-strip');
  if (browserControlsEl || tabStripEl) {
    const headerObserver = new ResizeObserver(() => syncBrowserBounds());
    if (browserControlsEl) headerObserver.observe(browserControlsEl);
    if (tabStripEl) headerObserver.observe(tabStripEl);
  }
}

function setupBrowserListeners(): void {
  window.api.onBrowserNavigated((url) => {
    appState.currentBrowserUrl = url;
    setBrowserAddressValue(url);
    addAddressHistoryEntry(url);
  });

  window.api.onBrowserTitle((title) => {
    if (appState.activeSourceId && appState.sourceTabs.has(appState.activeSourceId)) {
      const tab = appState.sourceTabs.get(appState.activeSourceId)!;
      tab.title = title || tab.title;
      renderSourceTabs();
    }
  });

  window.api.onBrowserLoading((loading) => {
    elements.browserReloadBtn.textContent = loading ? '⏹' : '↻';
  });

  window.api.onBrowserError((error) => {
    console.error('[Browser]', error);
  });

  window.api.onTabsUpdated((tabs) => {
    applyTabsUpdate(tabs);
  });
  const apiAny = window.api as any;
  if (typeof apiAny.onBrowserRequestBoundsSync === 'function') {
    apiAny.onBrowserRequestBoundsSync(() => {
      syncBrowserBounds();
    });
  }

  window.api.onResearchProgress((progress) => {
    renderResearchProgress(progress);
  });

  window.api.onLiveHtmlStart(() => {
    if (elements.panelContainer.classList.contains('hidden')) {
      elements.panelContainer.classList.remove('hidden');
      elements.panelContainer.classList.remove('panel-user-hidden');
      syncBrowserBounds();
    }
  });

  window.api.onLiveHtmlEnd(() => {
    // Stream completion handles final UI state.
  });

  void window.api.browserTabList().then((result) => {
    if (result?.success) {
      applyTabsUpdate(result.tabs || []);
    }
  });
}

function applyTabsUpdate(tabs: BrowserTabInfo[]): void {
  const nextTabs = new Map<string, ResearchSourcePreview>();
  let nextActive: string | null = null;

  for (const tab of tabs) {
    const host = !tab.url || tab.url === 'about:blank' ? '' : getHostFromUrl(tab.url);
    nextTabs.set(tab.id, {
      sourceId: tab.id,
      title: tab.title || host || EMPTY_TAB_TITLE,
      host,
      url: tab.url || '',
      sourceKind: 'serp',
      reason: '',
    });
    if (tab.active) {
      nextActive = tab.id;
      if (tab.url) {
        appState.currentBrowserUrl = tab.url;
        setBrowserAddressValue(tab.url);
        addAddressHistoryEntry(tab.url);
      } else {
        appState.currentBrowserUrl = '';
        setBrowserAddressValue('');
      }
    }
  }

  appState.sourceTabs = nextTabs;
  appState.activeSourceId = nextActive;
  renderSourceTabs();
}

function renderResearchProgress(progress: ResearchProgress): void {
  if (!appState.researchContainer) {
    appState.researchContainer = document.createElement('div');
    appState.researchContainer.className = 'research-progress';
    elements.outputEl.appendChild(appState.researchContainer);
    appState.knownActions = new Map();
    scrollToBottom(false);
  }

  if (progress.phase === 'intake') {
    clearResearchTabs();
    appState.activeSourceId = null;
    void ensureLandingTab();
  }

  if (progress.sources && progress.sources.length > 0) {
    handleResearchSources(progress.sources);
  }

  if (progress.activeSourceId) {
    ensureSourceTabForSourceId(progress.activeSourceId);
  } else if (progress.activeSourceUrl) {
    void ensureSourceTabForUrl(progress.activeSourceUrl);
  }

  if (progress.actions) {
    for (const action of progress.actions) {
      appState.knownActions.set(action.id, {
        source: action.source,
        status: action.status,
        preview: action.preview,
        executionStatus: action.executionStatus,
        reason: action.reason,
        producedSources: action.producedSources,
      });
    }
  }

  const label: Record<string, string> = {
    intake: '◇ Planning...',
    executing: '◈ Searching...',
    checkpoint: '◆ Reviewing...',
    synthesizing: '◈ Writing...',
    done: '● Done',
  };

  let html = `<div class="rp-phase">${escapeHtml(label[progress.phase] || progress.message)}</div>`;

  if (progress.gateStatus) {
    const statusClass = progress.gateStatus.ok ? 'rp-gate-ok' : 'rp-gate-blocked';
    const statusText = progress.gateStatus.ok
      ? `Gate satisfied: ${progress.gateStatus.eligibleCount} sources across ${progress.gateStatus.hostCount} hosts`
      : `Gate blocked: ${progress.gateStatus.reasons.join('; ')}`;
    html += `<div class="rp-gate ${statusClass}">
      <span class="rp-gate-label">${escapeHtml(statusText)}</span>
    </div>`;
  }

  if (progress.checkpointNumber) {
    html += `<div class="rp-checkpoint">◆ Checkpoint ${progress.checkpointNumber}</div>`;
  }

  appState.researchContainer.innerHTML = html;
  scrollToBottom(false);

  if (progress.phase === 'done' || progress.phase === 'synthesizing') {
    appState.researchContainer = null;
    appState.knownActions = new Map();
  }
}

function handleResearchSources(sources: ResearchSourcePreview[]): void {
  if (sources.length === 0) return;
  if (!elements.panelContainer.classList.contains('hidden')) {
    return;
  }
  elements.panelContainer.classList.remove('hidden');
  elements.panelContainer.classList.remove('panel-user-hidden');
  syncBrowserBounds();
}

function clearResearchTabs(): void {
  // Tabs are driven by main process state.
}

export async function ensureLandingTab(): Promise<void> {
  const listed = await window.api.browserTabList();
  const tabs = listed?.tabs || [];
  if (tabs.length === 0) {
    await window.api.browserTabNew(DEFAULT_TAB_URL);
    return;
  }
  const active = tabs.find((tab: any) => tab.active) || tabs[0];
  if (active?.url && active.url !== 'about:blank') return;
  await window.api.browserNavigate(DEFAULT_TAB_URL);
}

function handleAddTabClick(): void {
  void window.api.browserTabNew().then(() => {
    setBrowserAddressValue('');
    elements.browserUrlInput.focus();
    elements.browserUrlInput.select();
  });
}

function closeSourceTab(sourceId: string): void {
  void window.api.browserTabClose(sourceId);
}

function getHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getSimpleDomain(host: string): string {
  const domain = host.replace(/^www\./, '');
  const parts = domain.split('.');
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2];
    if (secondLast === 'co' || secondLast === 'com' || secondLast === 'org' || secondLast === 'net') {
      return parts.length > 2 ? parts[parts.length - 3] : parts[0];
    }
    return parts[parts.length - 2];
  }
  return parts[0] || domain;
}

function getFaviconUrl(host: string): string {
  const cleanHost = host.replace(/^www\./, '');
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(cleanHost)}&sz=32`;
}

function ensureSourceTabForSourceId(sourceId: string): void {
  if (!sourceId) return;
  const tab = appState.sourceTabs.get(sourceId);
  if (tab) {
    setActiveSourceTab(sourceId);
  }
}

function renderSourceTabs(): void {
  if (appState.sourceTabs.size === 0) {
    elements.sourceTabsContainer.innerHTML = '';
    elements.sourceTabsContainer.classList.add('hidden');
    return;
  }

  elements.sourceTabsContainer.classList.remove('hidden');
  elements.sourceTabsContainer.innerHTML = '';

  const tabsArray = Array.from(appState.sourceTabs.values());

  for (const tab of tabsArray) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.sourceId = tab.sourceId;
    button.className = `source-tab${tab.sourceId === appState.activeSourceId ? ' active' : ''}`;

    const isEmptyTab = !tab.url && !tab.host;
    if (isEmptyTab) {
      button.innerHTML = `
        <span class="source-tab-favicon-placeholder" style="display:flex;">+</span>
        <span class="source-tab-title">${escapeHtml(EMPTY_TAB_TITLE)}</span>
        <button type="button" class="source-tab-close" title="Close tab">
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="2" y1="2" x2="8" y2="8"/>
            <line x1="8" y1="2" x2="2" y2="8"/>
          </svg>
        </button>
      `;
    } else {
      const fullHost = tab.host || getHostFromUrl(tab.url || '');
      const displayName = getSimpleDomain(fullHost);
      const faviconUrl = getFaviconUrl(fullHost);
      const firstLetter = displayName.charAt(0).toUpperCase();
      button.innerHTML = `
        <img class="source-tab-favicon" src="${escapeHtml(faviconUrl)}" alt="">
        <span class="source-tab-favicon-placeholder" style="display:none;">${firstLetter}</span>
        <span class="source-tab-title">${escapeHtml(displayName)}</span>
        <button type="button" class="source-tab-close" title="Close tab">
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="2" y1="2" x2="8" y2="8"/>
            <line x1="8" y1="2" x2="2" y2="8"/>
          </svg>
        </button>
      `;
      const faviconImg = button.querySelector('.source-tab-favicon') as HTMLImageElement | null;
      if (faviconImg) {
        faviconImg.addEventListener('error', () => {
          faviconImg.style.display = 'none';
          const placeholder = faviconImg.nextElementSibling as HTMLElement | null;
          if (placeholder) placeholder.style.display = 'flex';
        });
      }
    }

    button.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.source-tab-close')) {
        setActiveSourceTab(tab.sourceId);
      }
    });

    const closeBtn = button.querySelector('.source-tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSourceTab(tab.sourceId);
      });
    }

    elements.sourceTabsContainer.appendChild(button);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tab-add-btn';
  addBtn.title = 'New tab';
  addBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <line x1="7" y1="2" x2="7" y2="12"/>
      <line x1="2" y1="7" x2="12" y2="7"/>
    </svg>
  `;
  addBtn.addEventListener('click', handleAddTabClick);
  elements.sourceTabsContainer.appendChild(addBtn);
}

function setActiveSourceTab(sourceId: string): void {
  const tab = appState.sourceTabs.get(sourceId);
  if (!tab) return;

  appState.activeSourceId = sourceId;
  renderSourceTabs();
  void window.api.browserTabSwitch(sourceId);

  if (!tab.url) {
    setBrowserAddressValue('');
    elements.browserUrlInput.focus();
  } else {
    setBrowserAddressValue(tab.url);
  }
}

export async function ensureSourceTabForUrl(url: string): Promise<void> {
  const finalUrl = url.trim();
  const existing = Array.from(appState.sourceTabs.values()).find((source) => source.url === finalUrl);
  if (existing) {
    setActiveSourceTab(existing.sourceId);
    return;
  }

  if (!finalUrl) return;
  await window.api.browserTabNew(finalUrl);
}

export function handleSourceLinkClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement).closest('a.source-link') as HTMLAnchorElement | null;
  if (!target) return;
  event.preventDefault();
  const url = target.dataset.sourceUrl;
  if (!url) return;
  void ensureSourceTabForUrl(url);
}

function renderBrowserMenuRoot(): void {
  elements.browserMenuBody.innerHTML =
    '<button class="browser-menu-item" data-action="history">History</button>' +
    '<button class="browser-menu-item" data-action="clear-data">Clear Data</button>';
}

function renderBrowserMenuClearData(): void {
  elements.browserMenuBody.innerHTML =
    '<button class="browser-menu-item" data-action="clear-history">Clear History</button>' +
    '<button class="browser-menu-item" data-action="clear-cookies">Clear Cookies</button>' +
    '<button class="browser-menu-item browser-menu-item-danger" data-action="clear-all">Clear All Data</button>' +
    '<button class="browser-menu-back" data-action="back">← Back</button>';
}

function renderBrowserMenuConfirm(title: string, message: string, confirmLabel: string, confirmAction: string): void {
  elements.browserMenuBody.innerHTML =
    '<p class="browser-menu-confirm-title">' +
    escapeHtml(title) +
    '</p>' +
    '<p class="browser-menu-confirm-msg">' +
    escapeHtml(message) +
    '</p>' +
    '<button class="browser-menu-item browser-menu-item-danger" data-action="' +
    confirmAction +
    '-yes">' +
    escapeHtml(confirmLabel) +
    '</button>' +
    '<button class="browser-menu-back" data-action="clear-data">← Back</button>';
}

function openBrowserMenu(): void {
  renderBrowserMenuRoot();
  elements.browserMenuDropdown.classList.remove('hidden');
  void window.api.browserSetBounds({ x: 0, y: 0, width: 1, height: 1 });
  elements.browserHiddenQuote.classList.remove('hidden');
}

export function closeBrowserMenu(): void {
  if (!elements.browserMenuDropdown.classList.contains('hidden')) {
    elements.browserMenuDropdown.classList.add('hidden');
    elements.browserHiddenQuote.classList.add('hidden');
    syncBrowserBounds();
  }
}

function toggleBrowserMenu(): void {
  if (elements.browserMenuDropdown.classList.contains('hidden')) {
    openBrowserMenu();
  } else {
    closeBrowserMenu();
  }
}

async function handleBrowserMenuAction(action: string): Promise<void> {
  switch (action) {
    case 'back':
      renderBrowserMenuRoot();
      break;
    case 'clear-data':
      renderBrowserMenuClearData();
      break;
    case 'history':
      closeBrowserMenu();
      await showBrowserHistoryPage();
      break;
    case 'clear-history':
      renderBrowserMenuConfirm(
        'Clear Browser History?',
        'This removes your browsing history from Clawdia. Your login sessions will not be affected.',
        'Clear History',
        'clear-history'
      );
      break;
    case 'clear-history-yes':
      await window.api.browserHistoryClear();
      closeBrowserMenu();
      break;
    case 'clear-cookies':
      renderBrowserMenuConfirm(
        'Clear All Cookies?',
        'This will log you out of all websites. Claude will no longer be able to access your authenticated accounts until you log in again.',
        'Clear Cookies',
        'clear-cookies'
      );
      break;
    case 'clear-cookies-yes':
      await window.api.browserCookiesClear();
      closeBrowserMenu();
      break;
    case 'clear-all':
      renderBrowserMenuConfirm(
        'Clear All Browser Data?',
        'This removes history, cookies, cache, and all stored data. You will be logged out of every site. This cannot be undone.',
        'Clear Everything',
        'clear-all'
      );
      break;
    case 'clear-all-yes':
      await window.api.browserClearAll();
      closeBrowserMenu();
      break;
  }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getDateGroup(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  return 'Older';
}

async function showBrowserHistoryPage(): Promise<void> {
  const result = await window.api.browserHistoryGet();
  const history = result.history || [];

  let lastGroup = '';
  let entriesHtml = '';

  if (history.length === 0) {
    entriesHtml = '<div class="empty">No browsing history yet</div>';
  } else {
    for (const entry of history) {
      const group = getDateGroup(entry.timestamp);
      if (group !== lastGroup) {
        entriesHtml += `<div class="date-group">${group}</div>`;
        lastGroup = group;
      }
      const displayUrl = entry.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const time = formatRelativeTime(entry.timestamp);
      entriesHtml += `<a class="entry" href="${entry.url}" data-url="${entry.url}">
        <div class="entry-info">
          <div class="entry-title">${escapeHtml(entry.title)}</div>
          <div class="entry-url">${escapeHtml(displayUrl)}</div>
        </div>
        <div class="entry-time">${time}</div>
      </a>`;
    }
  }

  const html = `<!DOCTYPE html>
<html><head><style>
body{background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:40px;margin:0}
h1{font-size:24px;font-weight:400;margin-bottom:24px}
.search{width:100%;padding:10px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e0e0e0;font-size:14px;margin-bottom:24px;outline:none;box-sizing:border-box}
.search:focus{border-color:rgba(255,255,255,0.2)}
.date-group{font-size:12px;opacity:0.5;text-transform:uppercase;letter-spacing:0.1em;margin:20px 0 8px}
.entry{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:6px;cursor:pointer;text-decoration:none;color:inherit}
.entry:hover{background:rgba(255,255,255,0.05)}
.entry-info{min-width:0;flex:1}
.entry-title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry-url{font-size:12px;opacity:0.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry-time{font-size:12px;opacity:0.4;white-space:nowrap;flex-shrink:0}
.empty{text-align:center;opacity:0.3;margin-top:60px;font-size:14px}
</style></head><body>
<h1>History</h1>
<input class="search" placeholder="Search history..." oninput="filterEntries(this.value)">
<div id="entries">${entriesHtml}</div>
<script>
function filterEntries(q){
  q=q.toLowerCase();
  document.querySelectorAll('.entry').forEach(el=>{
    el.style.display=el.textContent.toLowerCase().includes(q)?'flex':'none';
  });
}
document.addEventListener('click',function(e){
  var entry=e.target.closest('.entry');
  if(entry){
    e.preventDefault();
    window.location.href=entry.dataset.url;
  }
});
</script></body></html>`;

  await window.api.browserNavigate('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function resolveAddressInput(input: string): string {
  const query = input.trim();
  if (!query) return '';

  if (query.startsWith('http://') || query.startsWith('https://')) {
    return query;
  }

  if (query === 'localhost' || query.startsWith('localhost:')) {
    return `http://${query}`;
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(query)) {
    return `http://${query}`;
  }

  if (/^[^\s]+\.[^\s]+$/.test(query)) {
    return `https://${query}`;
  }

  const shortcut = SITE_SHORTCUTS[query.toLowerCase()];
  if (shortcut) return shortcut;

  if (/^[a-zA-Z0-9-]+$/.test(query)) {
    return `https://${query.toLowerCase()}.com`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function isTrackingQueryParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith('utm_') || ADDRESS_BAR_TRACKING_QUERY_PARAMS.has(normalized);
}

function formatAddressBarValue(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === 'about:blank') return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return trimmed;
    }

    const host = parsed.host.replace(/^www\./i, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const params = new URLSearchParams();
    parsed.searchParams.forEach((value, key) => {
      if (!isTrackingQueryParam(key)) {
        params.append(key, value);
      }
    });
    const query = params.toString();
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return trimmed;
  }
}

function initializeAddressHistory(): void {
  appState.browserAddressHistory = readAddressHistoryFromStorage();
  closeAddressSuggestions();
}

function readAddressHistoryFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(ADDRESS_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => normalizeAddressHistoryEntry(entry))
      .filter((entry): entry is string => entry !== null)
      .slice(0, ADDRESS_HISTORY_MAX_ITEMS);
  } catch {
    return [];
  }
}

function persistAddressHistory(): void {
  try {
    localStorage.setItem(ADDRESS_HISTORY_STORAGE_KEY, JSON.stringify(appState.browserAddressHistory));
  } catch {
    // Ignore storage failures.
  }
}

function normalizeAddressHistoryEntry(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'about:blank') return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function addAddressHistoryEntry(url: string): void {
  const normalized = normalizeAddressHistoryEntry(url);
  if (!normalized) return;

  appState.browserAddressHistory = [normalized, ...appState.browserAddressHistory.filter((entry) => entry !== normalized)].slice(
    0,
    ADDRESS_HISTORY_MAX_ITEMS
  );

  persistAddressHistory();
  if (document.activeElement === elements.browserUrlInput) {
    refreshAddressSuggestions();
  }
}

function collectAddressSuggestions(input: string): string[] {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput) {
    return appState.browserAddressHistory.slice(0, ADDRESS_HISTORY_VISIBLE_SUGGESTIONS);
  }

  const startsWithMatches: string[] = [];
  const containsMatches: string[] = [];

  for (const url of appState.browserAddressHistory) {
    const rawValue = url.toLowerCase();
    const displayValue = formatAddressBarValue(url).toLowerCase();
    const startsWith = rawValue.startsWith(normalizedInput) || displayValue.startsWith(normalizedInput);
    const contains = rawValue.includes(normalizedInput) || displayValue.includes(normalizedInput);

    if (startsWith) {
      startsWithMatches.push(url);
      continue;
    }
    if (contains) {
      containsMatches.push(url);
    }
  }

  return [...startsWithMatches, ...containsMatches].slice(0, ADDRESS_HISTORY_VISIBLE_SUGGESTIONS);
}

function refreshAddressSuggestions(): void {
  if (document.activeElement !== elements.browserUrlInput) return;

  appState.visibleAddressSuggestions = collectAddressSuggestions(elements.browserUrlInput.value);
  appState.highlightedAddressSuggestionIndex = -1;
  renderAddressSuggestions();
}

function renderAddressSuggestions(): void {
  if (appState.visibleAddressSuggestions.length === 0) {
    closeAddressSuggestions();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < appState.visibleAddressSuggestions.length; index += 1) {
    const url = appState.visibleAddressSuggestions[index];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'browser-url-suggestion';
    button.dataset.url = url;
    button.dataset.index = String(index);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');

    const formattedValue = formatAddressBarValue(url) || url;
    const valueEl = document.createElement('span');
    valueEl.className = 'browser-url-suggestion-value';
    valueEl.textContent = formattedValue;

    const fullEl = document.createElement('span');
    fullEl.className = 'browser-url-suggestion-full';
    fullEl.textContent = url;

    button.append(valueEl, fullEl);
    fragment.appendChild(button);
  }

  elements.browserUrlSuggestions.replaceChildren(fragment);
  elements.browserUrlSuggestions.classList.remove('hidden');
  elements.browserUrlInput.setAttribute('aria-expanded', 'true');
}

function setHighlightedAddressSuggestion(index: number): void {
  const nextIndex = index >= 0 && index < appState.visibleAddressSuggestions.length ? index : -1;
  appState.highlightedAddressSuggestionIndex = nextIndex;

  const items = elements.browserUrlSuggestions.querySelectorAll('.browser-url-suggestion');
  items.forEach((item, itemIndex) => {
    const isActive = itemIndex === nextIndex;
    item.classList.toggle('is-active', isActive);
    item.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) {
      (item as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  });
}

function shiftHighlightedAddressSuggestion(direction: number): void {
  const total = appState.visibleAddressSuggestions.length;
  if (total === 0) return;

  if (appState.highlightedAddressSuggestionIndex === -1) {
    setHighlightedAddressSuggestion(direction > 0 ? 0 : total - 1);
    return;
  }

  const nextIndex = (appState.highlightedAddressSuggestionIndex + direction + total) % total;
  setHighlightedAddressSuggestion(nextIndex);
}

function closeAddressSuggestions(): void {
  appState.visibleAddressSuggestions = [];
  appState.highlightedAddressSuggestionIndex = -1;
  elements.browserUrlSuggestions.replaceChildren();
  elements.browserUrlSuggestions.classList.add('hidden');
  elements.browserUrlInput.setAttribute('aria-expanded', 'false');
}

export function setBrowserAddressValue(url: string): void {
  elements.browserUrlInput.value = formatAddressBarValue(url);
}

async function navigateBrowser(inputOverride?: string): Promise<void> {
  const resolved = resolveAddressInput(inputOverride ?? elements.browserUrlInput.value);
  if (!resolved) return;

  closeAddressSuggestions();
  setBrowserAddressValue(resolved);
  const result = await window.api.browserNavigate(resolved);
  if (result?.success) {
    addAddressHistoryEntry(resolved);
  }
}

export async function navigatePanelToUrl(url: string): Promise<void> {
  if (elements.panelContainer.classList.contains('hidden')) {
    elements.panelContainer.classList.remove('hidden');
    elements.panelContainer.classList.remove('panel-user-hidden');
    syncBrowserBounds();
  }
  setBrowserAddressValue(url);
  await window.api.browserNavigate(url);
}

export function syncBrowserBounds(): void {
  if (elements.panelContainer.classList.contains('hidden')) {
    void window.api.browserSetBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    return;
  }

  const viewportHost = elements.panelContainer.querySelector('.browser-placeholder') as HTMLElement | null;
  const rect = (viewportHost ?? elements.panelContainer).getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const bounds = {
    x: Math.round(rect.left * dpr),
    y: Math.round(rect.top * dpr),
    width: Math.max(1, Math.round(rect.width * dpr)),
    height: Math.max(1, Math.round(rect.height * dpr)),
  };
  void window.api.browserSetBounds(bounds);
}

export function handleOutsideClick(target: Node): void {
  if (!elements.browserMenuDropdown.contains(target) && target !== elements.browserMenuBtn) {
    closeBrowserMenu();
  }
  if (elements.browserUrlInput.contains(target) || elements.browserUrlSuggestions.contains(target)) return;
  closeAddressSuggestions();
}
