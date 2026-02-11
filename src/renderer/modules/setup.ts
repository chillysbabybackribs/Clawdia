import { hideArcade, resetArcadeDismissed, showArcade } from '../arcade/menu';
import { navigatePanelToUrl } from './browser';
import { ensureChatShellInitialized } from './chat';
import { setVisibilityToggleState, syncAllModelSelects, togglePasswordInputVisibility } from './settings';
import { ANTHROPIC_CONSOLE_URL, appState, elements } from './state';

export function initSetup(): void {
  elements.setupToggleVisibilityBtn.addEventListener('click', () => {
    togglePasswordInputVisibility(elements.setupApiKeyInput, elements.setupToggleVisibilityBtn);
    elements.setupApiKeyInput.focus();
  });

  elements.setupGetKeyLinkBtn.addEventListener('click', () => {
    void navigatePanelToAnthropicConsole();
  });

  elements.setupArcadeBtn.addEventListener('click', () => {
    const nextVisible = elements.setupArcadeHost.classList.contains('hidden');
    setSetupArcadeVisible(nextVisible);
  });

  elements.setupApiKeyInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    elements.setupSaveKeyBtn.click();
  });

  elements.setupSaveKeyBtn.addEventListener('click', async () => {
    if (appState.isValidatingSetupKey) return;
    appState.isValidatingSetupKey = true;
    setSetupError(null);
    setSetupValidationState({ loading: true, success: false, text: 'Validating...' });

    try {
      const apiKey = elements.setupApiKeyInput.value.trim();
      if (!apiKey) {
        setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
        setSetupError('Please enter an API key.');
        return;
      }
      const result = await window.api.validateApiKeyWithModel(apiKey, appState.currentSelectedModel);
      if (!result.valid) {
        setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
        setSetupError(result.error || 'Invalid API key. Please check and try again.');
        return;
      }

      await window.api.setApiKey(apiKey);
      await window.api.setSelectedModel(appState.currentSelectedModel);
      syncAllModelSelects(appState.currentSelectedModel);

      setSetupValidationState({ loading: false, success: true, text: 'Saved' });
      await new Promise((resolve) => window.setTimeout(resolve, 380));
      setSetupMode(false);
      await ensureChatShellInitialized();
      elements.promptEl.focus();
    } finally {
      appState.isValidatingSetupKey = false;
      setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
    }
  });
}

function setSetupValidationState(options: { loading: boolean; success: boolean; text: string }): void {
  elements.setupSaveKeyBtn.disabled = options.loading;
  elements.setupSaveKeyText.textContent = options.text;
  elements.setupSaveKeySpinner.classList.toggle('hidden', !options.loading);
  elements.setupSaveKeyCheck.classList.toggle('hidden', !options.success);
  elements.setupSaveKeyBtn.classList.toggle('success', options.success);
}

function setSetupError(message: string | null): void {
  if (!message) {
    elements.setupErrorEl.classList.add('hidden');
    elements.setupErrorEl.textContent = '';
    return;
  }
  elements.setupErrorEl.textContent = message;
  elements.setupErrorEl.classList.remove('hidden');
}

function setSetupArcadeVisible(visible: boolean): void {
  if (visible) {
    elements.setupArcadeHost.classList.remove('hidden');
    resetArcadeDismissed();
    showArcade(elements.setupArcadeOutput);
    elements.setupArcadeBtn.textContent = 'Hide arcade';
    return;
  }
  hideArcade();
  elements.setupArcadeHost.classList.add('hidden');
  elements.setupArcadeBtn.textContent = 'Play arcade while you set up';
}

async function navigatePanelToAnthropicConsole(): Promise<void> {
  await navigatePanelToUrl(ANTHROPIC_CONSOLE_URL);
}

export function setSetupMode(enabled: boolean): void {
  appState.isSetupMode = enabled;
  elements.chatAppShell.classList.toggle('hidden', enabled);
  elements.setupView.classList.toggle('hidden', !enabled);

  if (enabled) {
    hideArcade();
    elements.setupArcadeHost.classList.add('hidden');
    elements.setupArcadeBtn.textContent = 'Play arcade while you set up';
    // Hide all view panels when entering setup
    elements.readmeView.classList.add('hidden');
    elements.conversationsView.classList.add('hidden');
    elements.settingsView.classList.add('hidden');
    elements.taskView.classList.add('hidden');
    elements.setupApiKeyInput.value = '';
    elements.setupApiKeyInput.type = 'password';
    setVisibilityToggleState(elements.setupToggleVisibilityBtn, false);
    setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
    setSetupError(null);
    elements.setupApiKeyInput.focus();
  } else {
    setSetupArcadeVisible(false);
  }
}
