import { randomUUID } from 'crypto';
import type { UserAccount } from '../../shared/accounts';
import { store } from '../store';
import { createLogger } from '../logger';

const log = createLogger('account-store');

const MAX_ACCOUNTS = 50;

function readAccounts(): UserAccount[] {
  return (store.get('userAccounts') as UserAccount[] | undefined) ?? [];
}

function writeAccounts(accounts: UserAccount[]): void {
  store.set('userAccounts', accounts);
}

export function listAccounts(): UserAccount[] {
  return readAccounts();
}

export function addAccount(data: {
  domain: string;
  platform: string;
  username: string;
  profileUrl: string;
  isManual: boolean;
}): UserAccount {
  const accounts = readAccounts();

  if (accounts.length >= MAX_ACCOUNTS) {
    log.warn(`Account limit (${MAX_ACCOUNTS}) reached, removing oldest`);
    accounts.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    accounts.shift();
  }

  const now = Date.now();
  const account: UserAccount = {
    id: randomUUID(),
    domain: data.domain,
    platform: data.platform,
    username: data.username,
    profileUrl: data.profileUrl,
    detectedAt: now,
    lastSeenAt: now,
    isManual: data.isManual,
  };

  accounts.push(account);
  writeAccounts(accounts);
  log.info(`Account added: ${account.platform} — ${account.username} (${account.domain})`);
  return account;
}

export function removeAccount(id: string): boolean {
  const accounts = readAccounts();
  const before = accounts.length;
  const filtered = accounts.filter((a) => a.id !== id);
  if (filtered.length === before) return false;
  writeAccounts(filtered);
  log.info(`Account removed: ${id}`);
  return true;
}

export function updateAccount(id: string, updates: Partial<Pick<UserAccount, 'username' | 'profileUrl' | 'platform' | 'domain'>>): UserAccount | null {
  const accounts = readAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  Object.assign(accounts[idx], updates, { lastSeenAt: Date.now() });
  writeAccounts(accounts);
  return accounts[idx];
}

export function findAccount(domain: string, username: string): UserAccount | null {
  const accounts = readAccounts();
  return accounts.find((a) => a.domain === domain && a.username === username) ?? null;
}

export function touchAccount(id: string): void {
  const accounts = readAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  account.lastSeenAt = Date.now();
  writeAccounts(accounts);
}
