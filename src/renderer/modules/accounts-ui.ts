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

const DOMAIN_PLATFORM_MAP: Record<string, string> = {
  'mail.google.com': 'Gmail',
  'gmail.com': 'Gmail',
  'github.com': 'GitHub',
  'twitter.com': 'Twitter/X',
  'x.com': 'Twitter/X',
  'reddit.com': 'Reddit',
  'youtube.com': 'YouTube',
  'linkedin.com': 'LinkedIn',
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'discord.com': 'Discord',
  'outlook.live.com': 'Outlook',
  'outlook.com': 'Outlook',
  'yahoo.com': 'Yahoo',
  'console.aws.amazon.com': 'AWS',
  'portal.azure.com': 'Azure',
  'cloud.google.com': 'Google Cloud',
  'app.slack.com': 'Slack',
  'notion.so': 'Notion',
  'trello.com': 'Trello',
  'atlassian.net': 'Jira',
  'figma.com': 'Figma',
  'vercel.com': 'Vercel',
  'netlify.com': 'Netlify',
  'shopify.com': 'Shopify',
};

export function initAccountsUI(): void {
  elements.addAccountBtn.addEventListener('click', () => {
    elements.addAccountForm.classList.remove('hidden');
    elements.addAccountBtn.classList.add('hidden');
    elements.addAccountDomain.focus();
  });

  elements.cancelAccountBtn.addEventListener('click', () => {
    elements.addAccountForm.classList.add('hidden');
    elements.addAccountBtn.classList.remove('hidden');
    clearAddForm();
  });

  // Auto-fill platform from domain
  elements.addAccountDomain.addEventListener('input', () => {
    const domain = elements.addAccountDomain.value.trim().toLowerCase();
    const matched = DOMAIN_PLATFORM_MAP[domain] || '';
    elements.addAccountPlatform.value = matched;
  });

  elements.saveAccountBtn.addEventListener('click', async () => {
    const domain = elements.addAccountDomain.value.trim();
    const username = elements.addAccountUsername.value.trim();

    if (!domain || !username) return;

    const platform = elements.addAccountPlatform.value.trim() ||
      domain.replace(/^(www\.)?/, '').split('.')[0].charAt(0).toUpperCase() +
      domain.replace(/^(www\.)?/, '').split('.')[0].slice(1);

    await window.api.addAccount({
      platform,
      username,
      domain,
      profileUrl: '',
    });

    clearAddForm();
    elements.addAccountForm.classList.add('hidden');
    elements.addAccountBtn.classList.remove('hidden');
    await loadAccountsList();
  });

  // Enter key in username field triggers save
  elements.addAccountUsername.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      elements.saveAccountBtn.click();
    }
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
    container.innerHTML = '<div class="accounts-empty">No linked accounts yet. Browse authenticated sites and they\'ll appear here automatically.</div>';
    return;
  }

  container.innerHTML = accounts.map((a) => `
    <div class="account-row" data-id="${escapeHtml(a.id)}">
      <div class="account-info">
        <span class="account-platform">${escapeHtml(a.platform)}</span>
        <span class="account-username">${escapeHtml(a.username)}</span>
        <span class="account-domain">${escapeHtml(a.domain)}</span>
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
