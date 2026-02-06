import { CLAUDE_MODELS } from '../../shared/models';
import { hideArcade } from '../arcade/menu';
import { escapeHtml } from './markdown';
import { appState, elements } from './state';
import { hideThinking, setStreaming } from './stream';
import { setSetupMode } from './setup';

export function initSettings(): void {
  elements.readmeToggle.addEventListener('click', toggleReadme);
  elements.readmeClose.addEventListener('click', () => setReadmeVisible(false));
  elements.readmeView.addEventListener('click', (e) => {
    if (e.target === elements.readmeView) {
      setReadmeVisible(false);
    }
  });

  elements.settingsToggle.addEventListener('click', async () => {
    elements.settingsModal.classList.remove('hidden');
    try {
      const settings = await window.api.getSettings();
      elements.settingsApiKeyMasked.textContent = settings.anthropic_key_masked || settings.anthropic_api_key || 'Not configured';
      elements.searchBackendSelect.value = settings.search_backend || 'serper';
      if (settings.selected_model) {
        appState.currentSelectedModel = settings.selected_model;
        syncAllModelSelects(appState.currentSelectedModel);
      }
      elements.changeApiKeyForm.classList.add('hidden');
      elements.changeApiKeyInput.value = '';
      elements.changeApiKeyInput.type = 'password';
      setVisibilityToggleState(elements.changeApiKeyVisibilityBtn, false);
      setChangeKeyError(null);
    } catch {
      // Ignore settings load failures.
    }
  });

  elements.settingsClose.addEventListener('click', () => {
    elements.settingsModal.classList.add('hidden');
  });

  elements.settingsModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
    elements.settingsModal.classList.add('hidden');
  });

  elements.changeApiKeyBtn.addEventListener('click', () => {
    elements.changeApiKeyForm.classList.remove('hidden');
    setChangeKeyError(null);
    elements.changeApiKeyInput.focus();
  });

  elements.cancelChangeApiKeyBtn.addEventListener('click', () => {
    elements.changeApiKeyForm.classList.add('hidden');
    elements.changeApiKeyInput.value = '';
    elements.changeApiKeyInput.type = 'password';
    setVisibilityToggleState(elements.changeApiKeyVisibilityBtn, false);
    setChangeKeyError(null);
  });

  elements.changeApiKeyVisibilityBtn.addEventListener('click', () => {
    togglePasswordInputVisibility(elements.changeApiKeyInput, elements.changeApiKeyVisibilityBtn);
    elements.changeApiKeyInput.focus();
  });

  elements.changeApiKeyInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    elements.saveChangedApiKeyBtn.click();
  });

  elements.saveChangedApiKeyBtn.addEventListener('click', async () => {
    const nextKey = elements.changeApiKeyInput.value.trim();
    if (!nextKey) {
      setChangeKeyError('Please enter an API key.');
      return;
    }

    const prevText = elements.saveChangedApiKeyBtn.textContent || 'Validate & Save Key';
    elements.saveChangedApiKeyBtn.disabled = true;
    elements.saveChangedApiKeyBtn.textContent = 'Validating...';
    setChangeKeyError(null);

    try {
      const result = await validateAndPersistAnthropicKey(nextKey);
      if (!result.valid) {
        setChangeKeyError(result.error || 'Invalid API key. Please check and try again.');
        return;
      }

      elements.saveChangedApiKeyBtn.textContent = 'Saved';
      const settings = await window.api.getSettings();
      elements.settingsApiKeyMasked.textContent = settings.anthropic_key_masked || settings.anthropic_api_key || 'Configured';
      elements.changeApiKeyForm.classList.add('hidden');
      elements.changeApiKeyInput.value = '';
      elements.changeApiKeyInput.type = 'password';
      setVisibilityToggleState(elements.changeApiKeyVisibilityBtn, false);
      setChangeKeyError(null);
    } finally {
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      elements.saveChangedApiKeyBtn.disabled = false;
      elements.saveChangedApiKeyBtn.textContent = prevText;
    }
  });

  elements.removeApiKeyBtn.addEventListener('click', async () => {
    const confirmed = window.confirm('This will clear your key and return to setup. Continue?');
    if (!confirmed) return;
    await window.api.clearApiKey();
    elements.settingsModal.classList.add('hidden');
    if (appState.isStreaming) {
      await window.api.stopGeneration();
      hideThinking();
      setStreaming(false);
    }
    setSetupMode(true);
  });

  elements.saveSettingsBtn.addEventListener('click', async () => {
    const keyPairs: [HTMLInputElement, string][] = [
      [elements.serperKeyInput, 'serper_api_key'],
      [elements.braveKeyInput, 'brave_api_key'],
      [elements.serpapiKeyInput, 'serpapi_api_key'],
      [elements.bingKeyInput, 'bing_api_key'],
    ];
    for (const [input, storeKey] of keyPairs) {
      const val = input.value.trim();
      if (val) {
        await window.api.setSetting(storeKey, val);
        input.value = '';
      }
    }
    await window.api.setSetting('search_backend', elements.searchBackendSelect.value);
    elements.settingsModal.classList.add('hidden');
  });

  elements.settingsModal.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.get-key-btn') as HTMLElement | null;
    if (!btn) return;
    const url = btn.dataset.url;
    if (url) {
      void window.api.browserNavigate(url);
    }
  });

  elements.settingsModelSelect.addEventListener('change', () => {
    void selectModel(elements.settingsModelSelect.value);
  });

  elements.setupModelSelect.addEventListener('change', () => {
    appState.currentSelectedModel = elements.setupModelSelect.value;
  });

  elements.modelPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelPicker();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && appState.readmeVisible) {
      setReadmeVisible(false);
    }
  });

  document.addEventListener('click', (e) => {
    if (
      !elements.modelPickerPopup.contains(e.target as Node) &&
      e.target !== elements.modelPickerBtn &&
      !elements.modelPickerBtn.contains(e.target as Node)
    ) {
      closeModelPicker();
    }
  });
}

export function setVisibilityToggleState(button: HTMLButtonElement, visible: boolean): void {
  const eye = button.querySelector('.icon-eye');
  const eyeOff = button.querySelector('.icon-eye-off');
  eye?.classList.toggle('hidden', visible);
  eyeOff?.classList.toggle('hidden', !visible);
  button.title = visible ? 'Hide API key' : 'Show API key';
  button.setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
}

export function togglePasswordInputVisibility(input: HTMLInputElement, button: HTMLButtonElement): void {
  const visible = input.type !== 'password';
  input.type = visible ? 'password' : 'text';
  setVisibilityToggleState(button, !visible);
}

function setChangeKeyError(message: string | null): void {
  if (!message) {
    elements.changeApiKeyErrorEl.classList.add('hidden');
    elements.changeApiKeyErrorEl.textContent = '';
    return;
  }
  elements.changeApiKeyErrorEl.textContent = message;
  elements.changeApiKeyErrorEl.classList.remove('hidden');
}

function getShortModelLabel(modelId: string): string {
  const full = CLAUDE_MODELS.find((m) => m.id === modelId)?.label || modelId;
  return full.replace(/^Claude\s+/, '');
}

export function syncAllModelSelects(modelId: string): void {
  elements.settingsModelSelect.value = modelId;
  elements.setupModelSelect.value = modelId;
  elements.modelPickerLabel.textContent = getShortModelLabel(modelId);
  renderModelPickerList();
}

export async function selectModel(modelId: string): Promise<void> {
  appState.currentSelectedModel = modelId;
  await window.api.setSelectedModel(modelId);
  syncAllModelSelects(modelId);
}

function renderModelPickerList(): void {
  elements.modelPickerList.innerHTML = '';
  for (const model of CLAUDE_MODELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `model-picker-item${model.id === appState.currentSelectedModel ? ' active' : ''}`;
    const check = model.id === appState.currentSelectedModel ? '✓' : '';
    const expensiveTag = model.expensive ? '<span class="model-picker-item-expensive">expensive</span>' : '';
    btn.innerHTML = `<span class="model-picker-item-check">${check}</span><span>${escapeHtml(model.label)}</span>${expensiveTag}`;
    btn.addEventListener('click', () => {
      void selectModel(model.id);
      closeModelPicker();
    });
    elements.modelPickerList.appendChild(btn);
  }
}

function toggleModelPicker(): void {
  const isOpen = !elements.modelPickerPopup.classList.contains('hidden');
  if (isOpen) {
    closeModelPicker();
  } else {
    renderModelPickerList();
    elements.modelPickerPopup.classList.remove('hidden');
    elements.modelPickerBtn.classList.add('open');
  }
}

export function closeModelPicker(): void {
  elements.modelPickerPopup.classList.add('hidden');
  elements.modelPickerBtn.classList.remove('open');
}

export function setReadmeVisible(visible: boolean): void {
  appState.readmeVisible = visible;
  elements.readmeView.classList.toggle('hidden', !visible);
  elements.chatAppShell.classList.toggle('hidden', visible);
  elements.readmeToggle.classList.toggle('active', visible);
  if (visible) {
    hideArcade();
    elements.settingsModal.classList.add('hidden');
    elements.conversationsDropdown.classList.add('hidden');
  }
}

function toggleReadme(): void {
  setReadmeVisible(!appState.readmeVisible);
}

export async function validateAndPersistAnthropicKey(key: string): Promise<{ valid: boolean; error?: string }> {
  const normalized = key.trim();
  if (!normalized) {
    return { valid: false, error: 'Please enter an API key.' };
  }

  const validation = await window.api.validateApiKey(normalized);
  if (!validation.valid) {
    return validation;
  }

  await window.api.setApiKey(normalized);
  return { valid: true };
}
