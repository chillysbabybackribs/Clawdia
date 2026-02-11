import { ensureLandingTab, initBrowser, syncBrowserBounds } from './modules/browser';
import { ensureChatShellInitialized, initChat, loadConversationsView } from './modules/chat';
import { initAttachments } from './modules/attachments';
import { initTaskNotifications } from './modules/dashboard';
import { initDocuments } from './modules/documents';
import { initMarkdown } from './modules/markdown';
import { initSettings, syncAllModelSelects, loadSettingsView } from './modules/settings';
import { initSetup, setSetupMode } from './modules/setup';
import { appState, elements, initElements } from './modules/state';
import { initStream } from './modules/stream';
import { initAffirmationWidget } from './modules/affirmation-widget';
import { initActivityFeed } from './modules/activity-feed';
import { initEnhancedActivityFeed } from './modules/enhanced-activity-feed';
import { initTokenStats } from './modules/token-stats';
import { initVaultUI } from './modules/vault-ui';
import { initAutonomyMode } from './modules/autonomy-mode';
import { initApprovalPanel } from './modules/approval-panel';
import { initTaskView, showTaskView, hideTaskView, highlightTaskInView } from './modules/task-view';

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

function switchView(view: 'chat' | 'tasks' | 'conversations' | 'readme' | 'settings'): void {
  if (appState.activeView === view) return;
  appState.activeView = view;

  // Update sidebar buttons
  const navBtns = [
    { btn: elements.navChatBtn, id: 'chat' },
    { btn: elements.navTasksBtn, id: 'tasks' },
    { btn: elements.navConversationsBtn, id: 'conversations' },
    { btn: elements.navReadmeBtn, id: 'readme' },
    { btn: elements.navSettingsBtn, id: 'settings' },
  ];
  for (const { btn, id } of navBtns) {
    btn.classList.toggle('sidebar-nav-btn--active', view === id);
  }

  // Toggle views — all hide/show via class
  const showChat = view === 'chat';
  elements.chatAppShell.classList.toggle('hidden', !showChat);
  elements.taskView.classList.toggle('hidden', view !== 'tasks');
  elements.conversationsView.classList.toggle('hidden', view !== 'conversations');
  elements.readmeView.classList.toggle('hidden', view !== 'readme');
  elements.settingsView.classList.toggle('hidden', view !== 'settings');

  if (view === 'tasks') {
    void showTaskView();
  } else {
    hideTaskView();
  }

  if (view === 'conversations') {
    void loadConversationsView();
  }

  if (view === 'settings') {
    void loadSettingsView();
  }
}

function initSidebarNav(): void {
  elements.navChatBtn.addEventListener('click', () => switchView('chat'));
  elements.navTasksBtn.addEventListener('click', () => switchView('tasks'));
  elements.navConversationsBtn.addEventListener('click', () => switchView('conversations'));
  elements.navReadmeBtn.addEventListener('click', () => switchView('readme'));
  elements.navSettingsBtn.addEventListener('click', () => switchView('settings'));

  // Listen for programmatic view switch events (from chat.ts conversation selection)
  document.addEventListener('clawdia:switch-view', ((e: CustomEvent) => {
    switchView(e.detail);
  }) as EventListener);

  // Wire dashboard task card clicks to switch to task view
  window.api.onTaskFocus((taskId) => {
    switchView('tasks');
    // Give DOM time to render, then highlight
    setTimeout(() => highlightTaskInView(taskId), 100);
  });
}

async function init(): Promise<void> {
  initElements();

  initMarkdown();
  initDocuments();
  initAttachments();
  initStream();
  initActivityFeed();
  initEnhancedActivityFeed(); // Initialize enhanced activity feed
  initTokenStats();
  initBrowser();
  initSettings();
  initSetup();
  initChat();
  initTaskNotifications();
  initTaskView();
  initSidebarNav();
  initAffirmationWidget();
  initAffirmationWidget();
  initVaultUI();
  void initAutonomyMode();
  initApprovalPanel();
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
