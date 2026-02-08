import { elements } from './state';
import { escapeHtml } from './markdown';

interface AccountEntry {
  id: string;
  domain: string;
  platform: string;
  username: string;
  profileUrl: string;
  isManual: boolean;
}

export function initAccountsUI(): void {
  elements.addAccountBtn.addEventListener('click', () => {
    elements.addAccountForm.classList.remove('hidden');
    elements.addAccountBtn.classList.add('hidden');
    elements.addAccountPlatform.focus();
  });

  elements.cancelAccountBtn.addEventListener('click', () => {
    elements.addAccountForm.classList.add('hidden');
    elements.addAccountBtn.classList.remove('hidden');
    clearAddForm();
  });

  elements.saveAccountBtn.addEventListener('click', async () => {
    const platform = elements.addAccountPlatform.value.trim();
    const username = elements.addAccountUsername.value.trim();
    const domain = elements.addAccountDomain.value.trim();

    if (!platform || !username) return;

    await window.api.addAccount({
      platform,
      username,
      domain: domain || platform.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com',
      profileUrl: '',
    });

    clearAddForm();
    elements.addAccountForm.classList.add('hidden');
    elements.addAccountBtn.classList.remove('hidden');
    await loadAccountsList();
  });

  // Listen for real-time updates from main process (auto-detection)
  window.api.onAccountsUpdated((accounts: AccountEntry[]) => {
    renderAccountsList(accounts);
  });
}

function clearAddForm(): void {
  elements.addAccountPlatform.value = '';
  elements.addAccountUsername.value = '';
  elements.addAccountDomain.value = '';
}

export async function loadAccountsList(): Promise<void> {
  const accounts = await window.api.listAccounts();
  renderAccountsList(Array.isArray(accounts) ? accounts : []);
}

function renderAccountsList(accounts: AccountEntry[]): void {
  const container = elements.accountsList;
  if (accounts.length === 0) {
    container.innerHTML = '<div class="accounts-empty">No linked accounts. Accounts are auto-detected when you visit sites like Gmail, GitHub, Twitter, etc.</div>';
    return;
  }

  container.innerHTML = accounts.map((a) => `
    <div class="account-row" data-id="${escapeHtml(a.id)}">
      <div class="account-info">
        <span class="account-platform">${escapeHtml(a.platform)}</span>
        <span class="account-username">${escapeHtml(a.username)}</span>
        <span class="account-domain">${escapeHtml(a.domain)}</span>
        ${a.isManual ? '<span class="account-badge">manual</span>' : ''}
      </div>
      <button class="account-remove-btn" type="button" title="Remove account">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.account-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const row = (e.target as HTMLElement).closest('.account-row') as HTMLElement;
      const id = row?.dataset.id;
      if (!id) return;
      await window.api.removeAccount(id);
      await loadAccountsList();
    });
  });
}
