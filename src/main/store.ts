import Store from 'electron-store';
import { DEFAULT_MODEL } from '../shared/models';

export interface ChatTabState {
  tabIds: string[];
  activeId: string | null;
}

export interface ClawdiaStoreSchema {
  anthropicApiKey: string;
  hasCompletedSetup: boolean;
  selectedModel: string;
  serper_api_key?: string;
  brave_api_key?: string;
  serpapi_api_key?: string;
  bing_api_key?: string;
  search_backend?: string;
  conversations?: unknown[];
  chat_tab_state?: ChatTabState;

  // Legacy key used by older builds before BYOK migration.
  anthropic_api_key?: string;
}

export const store = new Store<ClawdiaStoreSchema>({
  encryptionKey: 'clawdia-local-key',
  defaults: {
    anthropicApiKey: '',
    hasCompletedSetup: false,
    selectedModel: DEFAULT_MODEL,
    search_backend: 'serper',
  },
});

export function migrateLegacyStoreSchema(): void {
  const legacyApiKey = (store.get('anthropic_api_key') as string | undefined)?.trim();
  const currentApiKey = (store.get('anthropicApiKey') as string | undefined)?.trim() || '';

  if (!currentApiKey && legacyApiKey) {
    store.set('anthropicApiKey', legacyApiKey);
  }

  if (legacyApiKey !== undefined) {
    store.delete('anthropic_api_key');
  }

  const hasKey = Boolean((store.get('anthropicApiKey') as string | undefined)?.trim());
  if (store.get('hasCompletedSetup') !== hasKey) {
    store.set('hasCompletedSetup', hasKey);
  }
}
