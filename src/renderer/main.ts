import { ensureLandingTab, initBrowser, syncBrowserBounds } from './modules/browser';
import { ensureChatShellInitialized, initChat } from './modules/chat';
import { initAttachments } from './modules/attachments';
import { initDocuments } from './modules/documents';
import { initMarkdown } from './modules/markdown';
import { initSettings, syncAllModelSelects } from './modules/settings';
import { initSetup, setSetupMode } from './modules/setup';
import { appState, initElements } from './modules/state';
import { initStream } from './modules/stream';
import { initToolActivity } from './modules/tool-activity';
import { initAffirmationWidget } from './modules/affirmation-widget';

function initClock(): void {
  const clockElement = document.getElementById('header-clock');
  if (!clockElement) return;

  const updateClock = () => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    clockElement.textContent = `${hours}:${minutes}`;
  };

  // Update immediately
  updateClock();

  // Update every minute
  setInterval(updateClock, 60000);
}

async function init(): Promise<void> {
  initElements();

  initMarkdown();
  initDocuments();
  initAttachments();
  initStream();
  initToolActivity();
  initBrowser();
  initSettings();
  initSetup();
  initChat();
  initAffirmationWidget();
  initClock();

  requestAnimationFrame(() => syncBrowserBounds());

  await ensureLandingTab();

  try {
    appState.currentSelectedModel = await window.api.getSelectedModel();
  } catch {
    // Keep default model from state.
  }
  console.log(`[Renderer:Init] loadedModel=${appState.currentSelectedModel}`);
  syncAllModelSelects(appState.currentSelectedModel);

  const hasCompletedSetup = await window.api.hasCompletedSetup();
  if (!hasCompletedSetup) {
    setSetupMode(true);
    return;
  }

  setSetupMode(false);
  await ensureChatShellInitialized();
}

// CSP violation listener — logs violations during development so they're visible
// immediately rather than silently failing. Tree-shaken in production builds.
if (import.meta.env.DEV) {
  document.addEventListener('securitypolicyviolation', (event) => {
    console.warn('[CSP VIOLATION]', {
      directive: event.violatedDirective,
      blocked: event.blockedURI,
      source: event.sourceFile,
      line: event.lineNumber,
    });
  });
}

console.log('[Renderer] Starting...');
console.log('[Renderer] window.api:', window.api);

if (!window.api) {
  console.error('[Renderer] ERROR: window.api is not defined! Preload script may not have loaded.');
  document.body.innerHTML = '<h1 style="color: red; padding: 20px;">Error: Preload script not loaded. Check console.</h1>';
} else {
  console.log('[Renderer] API available, initializing...');
  void init();
}
