import { CLAUDE_MODELS } from '../../shared/models';
import { escapeHtml } from './markdown';
import { appState, elements } from './state';
import { hideThinking, setStreaming } from './stream';
import { setSetupMode } from './setup';
import { initAccountsUI, loadAccountsList } from './accounts-ui';
import { initAmbientSettingsUI, loadAmbientSettings, saveAmbientSettings } from './ambient-settings-ui';
import { initTelegramSettingsUI, loadTelegramSettings } from './telegram-settings-ui';
import type { CapabilityPlatformFlags, CapabilityPlatformStatus } from '../../shared/types';

let settingsContentMoved = false;
let capabilityControlsBound = false;
let applyingCapabilityStatus = false;
let capabilityFlagUpdateSeq = 0;

const CAPABILITY_FLAG_INPUTS: Array<{ id: string; key: keyof CapabilityPlatformFlags }> = [
  { id: 'cap-flag-install-orchestrator', key: 'installOrchestrator' },
  { id: 'cap-flag-lifecycle-events', key: 'lifecycleEvents' },
  { id: 'cap-flag-checkpoint-rollback', key: 'checkpointRollback' },
  { id: 'cap-flag-mcp-runtime', key: 'mcpRuntimeManager' },
  { id: 'cap-flag-containerize-installs', key: 'containerizeInstalls' },
  { id: 'cap-flag-container-execution', key: 'containerExecution' },
  { id: 'cap-flag-containerize-mcp', key: 'containerizeMcpServers' },
];

export function initSettings(): void {
  initAccountsUI();
  initAmbientSettingsUI();
  initTelegramSettingsUI();

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
    await saveAmbientSettings();
    document.dispatchEvent(new CustomEvent('clawdia:switch-view', { detail: 'chat' }));
  });

  // Handle get-key-btn clicks in both settings modal and settings view
  document.addEventListener('click', (e) => {
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

  document.addEventListener('click', (e) => {
    if (
      !elements.modelPickerPopup.contains(e.target as Node) &&
      e.target !== elements.modelPickerBtn &&
      !elements.modelPickerBtn.contains(e.target as Node)
    ) {
      closeModelPicker();
    }
  });

  bindCapabilityPlatformControls();
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

/** Populate a <select> element with options from CLAUDE_MODELS. */
function populateModelSelect(select: HTMLSelectElement): void {
  if (select.options.length === CLAUDE_MODELS.length) return; // already populated
  select.innerHTML = '';
  for (const model of CLAUDE_MODELS) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.label;
    select.appendChild(opt);
  }
}

export function syncAllModelSelects(modelId: string): void {
  populateModelSelect(elements.settingsModelSelect);
  populateModelSelect(elements.setupModelSelect);
  elements.settingsModelSelect.value = modelId;
  elements.setupModelSelect.value = modelId;
  elements.modelPickerLabel.textContent = getShortModelLabel(modelId);
  renderModelPickerList();
}

export async function selectModel(modelId: string): Promise<void> {
  console.log(`[IPC:Renderer→Main] selectModel=${modelId}`);
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

/** Move settings form content into the settings view panel, then load fresh data. */
export async function loadSettingsView(): Promise<void> {
  // Move the settings form from its hidden source into the view panel (once)
  if (!settingsContentMoved) {
    const source = elements.settingsModal;
    const target = elements.settingsBody;
    // Move all child nodes from the source container into the target
    while (source.firstChild) {
      target.appendChild(source.firstChild);
    }
    settingsContentMoved = true;
  }

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
    void loadAccountsList();
    void loadAmbientSettings();
    void loadTelegramSettings();
    void loadCapabilityPlatformStatus();
  } catch {
    // Ignore settings load failures.
  }
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

function getCapabilityFlagInput(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function renderCapabilityPlatformStatus(status: CapabilityPlatformStatus): void {
  const summaryEl = document.getElementById('capability-platform-summary');
  const containerRuntimeEl = document.getElementById('capability-platform-container-runtime');
  const containerPolicyEl = document.getElementById('capability-platform-container-policy');
  const mcpRuntimeEl = document.getElementById('capability-platform-mcp-runtime');
  const mcpProcessesEl = document.getElementById('capability-platform-mcp-processes');
  if (!summaryEl || !containerRuntimeEl || !containerPolicyEl || !mcpRuntimeEl || !mcpProcessesEl) return;

  summaryEl.textContent =
    `Cohort: ${status.flags.cohort} | Sandbox runtime: ${status.sandboxRuntime} | ` +
    `Lifecycle events: ${status.flags.lifecycleEvents ? 'on' : 'off'}`;
  containerRuntimeEl.textContent =
    `Container runtime: ${status.containerRuntime.available ? `${status.containerRuntime.runtime || 'detected'} ready` : 'unavailable'} ` +
    `(${status.containerRuntime.detail})`;
  containerPolicyEl.textContent =
    `Container policy: network=${status.containerPolicy.networkMode} roots=${status.containerPolicy.allowedRoots.join(', ')}`;

  const mcpHealthy = status.mcpRuntime.filter((server) => server.status === 'healthy').length;
  mcpRuntimeEl.textContent =
    `MCP runtime: ${status.mcpRuntime.length} server(s), ${mcpHealthy} healthy`;

  const processLines = status.mcpProcesses.map((proc) => {
    const pid = proc.pid ? ` pid=${proc.pid}` : '';
    const source = proc.source ? ` source=${proc.source}` : '';
    const containerized = proc.containerized ? ' container' : '';
    return `${proc.running ? 'running' : 'stopped'} ${proc.name}${pid}${source}${containerized}`;
  });
  mcpProcessesEl.textContent = processLines.length
    ? processLines.join('\n')
    : 'No MCP processes configured.';

  applyingCapabilityStatus = true;
  for (const { id, key } of CAPABILITY_FLAG_INPUTS) {
    const input = getCapabilityFlagInput(id);
    if (!input) continue;
    input.checked = Boolean(status.flags[key]);
  }
  applyingCapabilityStatus = false;
}

async function setCapabilityPlatformFlagsFromInputs(): Promise<void> {
  const payload: Partial<CapabilityPlatformFlags> = {};
  for (const { id, key } of CAPABILITY_FLAG_INPUTS) {
    const input = getCapabilityFlagInput(id);
    if (!input) continue;
    payload[key] = input.checked;
  }

  const seq = ++capabilityFlagUpdateSeq;
  const response = await window.api.setCapabilityPlatformFlags(payload);
  if (seq !== capabilityFlagUpdateSeq) return;
  if (response && response.status) {
    renderCapabilityPlatformStatus(response.status);
    return;
  }
  await loadCapabilityPlatformStatus();
}

function bindCapabilityPlatformControls(): void {
  if (capabilityControlsBound) return;
  capabilityControlsBound = true;

  const refreshBtn = document.getElementById('capability-platform-refresh') as HTMLButtonElement | null;
  refreshBtn?.addEventListener('click', () => {
    void loadCapabilityPlatformStatus();
  });

  for (const { id, key } of CAPABILITY_FLAG_INPUTS) {
    const input = getCapabilityFlagInput(id);
    if (!input) continue;
    input.addEventListener('change', () => {
      if (applyingCapabilityStatus) return;
      void setCapabilityPlatformFlagsFromInputs();
    });
  }
}

async function loadCapabilityPlatformStatus(): Promise<void> {
  const summaryEl = document.getElementById('capability-platform-summary');
  if (summaryEl) {
    summaryEl.textContent = 'Loading capability platform status...';
  }
  try {
    const status = await window.api.getCapabilityPlatformStatus();
    renderCapabilityPlatformStatus(status);
  } catch {
    if (summaryEl) {
      summaryEl.textContent = 'Unable to load capability platform status.';
    }
  }
}
