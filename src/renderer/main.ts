import { ensureLandingTab, initBrowser, syncBrowserBounds } from './modules/browser';
import { ensureChatShellInitialized, initChat } from './modules/chat';
import { initAttachments } from './modules/attachments';
import { initDocuments } from './modules/documents';
import { initMarkdown } from './modules/markdown';
import { initSettings, syncAllModelSelects } from './modules/settings';
import { initSetup, setSetupMode } from './modules/setup';
import { appState, initElements } from './modules/state';
import { initStream } from './modules/stream';

async function init(): Promise<void> {
  initElements();

  initMarkdown();
  initDocuments();
  initAttachments();
  initStream();
  initBrowser();
  initSettings();
  initSetup();
  initChat();

  requestAnimationFrame(() => syncBrowserBounds());

  await ensureLandingTab();

  try {
    appState.currentSelectedModel = await window.api.getSelectedModel();
  } catch {
    // Keep default model from state.
  }
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
