import { elements } from './state';

interface TelegramConfig {
  enabled: boolean;
  hasToken: boolean;
  authorizedChatId?: number;
  running: boolean;
}

export function initTelegramSettingsUI(): void {
  elements.telegramSaveTokenBtn.addEventListener('click', async () => {
    const token = elements.telegramTokenInput.value.trim();
    if (!token) return;

    elements.telegramSaveTokenBtn.disabled = true;
    elements.telegramSaveTokenBtn.textContent = 'Saving...';
    try {
      await window.api.telegramSetToken(token);
      elements.telegramTokenInput.value = '';
      elements.telegramSaveTokenBtn.textContent = 'Saved';
      await loadTelegramSettings();
    } finally {
      setTimeout(() => {
        elements.telegramSaveTokenBtn.disabled = false;
        elements.telegramSaveTokenBtn.textContent = 'Save';
      }, 600);
    }
  });

  elements.telegramTokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      elements.telegramSaveTokenBtn.click();
    }
  });

  elements.telegramEnableToggle.addEventListener('change', async () => {
    const enabled = elements.telegramEnableToggle.checked;
    await window.api.telegramSetEnabled(enabled);
    await loadTelegramSettings();
  });

  elements.telegramClearAuthBtn.addEventListener('click', async () => {
    const confirmed = window.confirm('Clear the authorized Telegram user? They will need to re-pair by messaging the bot.');
    if (!confirmed) return;
    await window.api.telegramClearAuth();
    await loadTelegramSettings();
  });
}

export async function loadTelegramSettings(): Promise<void> {
  try {
    const config: TelegramConfig = await window.api.telegramGetConfig();
    renderTelegramStatus(config);
  } catch {
    // Ignore load failures
  }
}

function renderTelegramStatus(config: TelegramConfig): void {
  elements.telegramEnableToggle.checked = config.enabled;

  const statusEl = elements.telegramStatus;
  const dot = statusEl.querySelector('.telegram-status-dot') as HTMLElement;
  const text = statusEl.querySelector('.telegram-status-text') as HTMLElement;

  if (!config.hasToken) {
    dot.className = 'telegram-status-dot telegram-status-dot--gray';
    text.textContent = 'Not configured — add a Bot Token above';
  } else if (!config.enabled) {
    dot.className = 'telegram-status-dot telegram-status-dot--gray';
    text.textContent = 'Disabled';
  } else if (config.running) {
    dot.className = 'telegram-status-dot telegram-status-dot--green';
    text.textContent = 'Connected';
  } else {
    dot.className = 'telegram-status-dot telegram-status-dot--red';
    text.textContent = 'Disconnected — check token';
  }

  // Auth section
  if (config.authorizedChatId) {
    elements.telegramAuthSection.classList.remove('hidden');
    elements.telegramAuthId.textContent = String(config.authorizedChatId);
  } else {
    elements.telegramAuthSection.classList.remove('hidden');
    elements.telegramAuthId.textContent = 'No user paired yet — send a message to your bot on Telegram';
    elements.telegramClearAuthBtn.classList.add('hidden');
  }

  if (config.authorizedChatId) {
    elements.telegramClearAuthBtn.classList.remove('hidden');
  } else {
    elements.telegramClearAuthBtn.classList.add('hidden');
  }
}
