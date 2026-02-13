import Store from 'electron-store';
import * as fs from 'fs';
import { DEFAULT_MODEL } from '../shared/models';
import type { UserAccount } from '../shared/accounts';
import type { AutonomyMode } from '../shared/autonomy';
import type { CapabilityPlatformFlags, MCPServerConfig } from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('store');

// ============================================================================
// STORE SCHEMA
// ============================================================================

export interface ChatTabState {
  tabIds: string[];
  activeId: string | null;
}

export interface BrowserHistoryEntry {
  id: string;
  url: string;
  title: string;
  timestamp: number;
}

export interface AmbientSettings {
  enabled: boolean;
  browserHistory: boolean;
  filesystemScan: boolean;
  gitScan: boolean;
  shellHistory: boolean;
  recentFiles: boolean;
  scanRoots: string[];
  browserHistoryHours: number;
}

export const DEFAULT_AMBIENT_SETTINGS: AmbientSettings = {
  enabled: true,
  browserHistory: true,
  filesystemScan: true,
  gitScan: true,
  shellHistory: true,
  recentFiles: true,
  scanRoots: ['~/Desktop', '~/Documents', '~/Projects', '~/repos', '~/code', '~/dev'],
  browserHistoryHours: 48,
};

export interface ClawdiaStoreSchema {
  schemaVersion: number;
  anthropicApiKey: string;
  hasCompletedSetup: boolean;
  selectedModel: string;
  serper_api_key?: string;
  serpapi_api_key?: string;
  bing_api_key?: string;
  search_backend?: string;
  conversations?: unknown[];
  chat_tab_state?: ChatTabState;
  browserHistory?: BrowserHistoryEntry[];
  userAccounts?: UserAccount[];
  /** Cached fast-path tool availability results (yt-dlp, wget, etc.) */
  fastPathToolStatus?: Record<string, unknown>;
  ambientSettings?: AmbientSettings;
  /** When true, headless task runs import cookies from Chrome for authenticated sessions. Default: false (opt-in). */
  importBrowserSessions?: boolean;

  // Telegram bot integration
  telegramBotToken?: string;
  telegramEnabled?: boolean;
  telegramAuthorizedChatId?: number;
  /** Conversation ID used for Telegram mobile chat — updated when user messages from Telegram */
  telegramConversationId?: string;

  // Autonomy mode
  autonomyMode?: AutonomyMode;
  unrestrictedConfirmed?: boolean;
  autonomyOverrides?: Record<string, boolean>;
  capabilityPlatformFlags?: CapabilityPlatformFlags;
  mcpServers?: MCPServerConfig[];

  // Legacy key used by older builds before BYOK migration.
  anthropic_api_key?: string;
}

// ============================================================================
// SCHEMA VERSIONING
// ============================================================================

/** Increment this every time the store schema changes. */
export const CURRENT_SCHEMA_VERSION = 6;

export interface Migration {
  version: number;
  description: string;
  migrate: (store: Store<ClawdiaStoreSchema>) => void;
}

/**
 * Ordered list of migrations. Each entry upgrades the store TO the given version.
 * Migrations must be idempotent where possible.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Move legacy anthropic_api_key to anthropicApiKey, sync hasCompletedSetup',
    migrate: (s) => {
      const legacyApiKey = (s.get('anthropic_api_key') as string | undefined)?.trim();
      const currentApiKey = (s.get('anthropicApiKey') as string | undefined)?.trim() || '';

      if (!currentApiKey && legacyApiKey) {
        s.set('anthropicApiKey', legacyApiKey);
      }

      if (legacyApiKey !== undefined) {
        s.delete('anthropic_api_key');
      }

      const hasKey = Boolean((s.get('anthropicApiKey') as string | undefined)?.trim());
      if (s.get('hasCompletedSetup') !== hasKey) {
        s.set('hasCompletedSetup', hasKey);
      }
    },
  },
  {
    version: 2,
    description: 'Initialize userAccounts',
    migrate: (s) => {
      if (!s.get('userAccounts')) {
        s.set('userAccounts', []);
      }
    },
  },
  {
    version: 3,
    description: 'Initialize ambientSettings',
    migrate: (s) => {
      if (!s.get('ambientSettings')) {
        s.set('ambientSettings', { ...DEFAULT_AMBIENT_SETTINGS });
      }
    },
  },
  {
    version: 5,
    description: 'Initialize autonomyOverrides',
    migrate: (s) => {
      if (!s.get('autonomyOverrides' as any)) {
        s.set('autonomyOverrides' as any, {});
      }
    },
  },
  {
    version: 6,
    description: 'Initialize capabilityPlatformFlags',
    migrate: (s) => {
      if (!s.get('capabilityPlatformFlags' as any)) {
        s.set('capabilityPlatformFlags' as any, {
          enabled: true,
          cohort: 'internal',
          lifecycleEvents: false,
          installOrchestrator: false,
          checkpointRollback: false,
          mcpRuntimeManager: false,
          containerExecution: false,
        });
      }
    },
  },
];

// ============================================================================
// STORE INSTANCE
// ============================================================================

export const store = new Store<ClawdiaStoreSchema>({
  encryptionKey: 'clawdia-local-key',
  defaults: {
    schemaVersion: 0,
    anthropicApiKey: '',
    hasCompletedSetup: false,
    selectedModel: DEFAULT_MODEL,
    search_backend: 'serper',
  },
});

// ============================================================================
// MIGRATION RUNNER
// ============================================================================

function backupStore(s: Store<ClawdiaStoreSchema>): void {
  const storePath = s.path;
  const currentVersion = (s.get('schemaVersion') as number) ?? 0;
  const backupPath = `${storePath}.backup-v${currentVersion}`;

  try {
    fs.copyFileSync(storePath, backupPath);
    log.info(`Store backed up to ${backupPath}`);
  } catch (err: any) {
    log.warn(`Store backup failed — proceeding anyway: ${err?.message}`);
  }
}

function cleanOldBackups(s: Store<ClawdiaStoreSchema>, keepVersion: number): void {
  const storePath = s.path;
  const dir = require('path').dirname(storePath);
  const base = require('path').basename(storePath);

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(`${base}.backup-v`) && !file.endsWith(`-v${keepVersion}`)) {
        const fullPath = require('path').join(dir, file);
        fs.unlinkSync(fullPath);
        log.info(`Removed old backup: ${file}`);
      }
    }
  } catch {
    // Best effort cleanup
  }
}

export function runMigrations(s: Store<ClawdiaStoreSchema>): void {
  const currentVersion = (s.get('schemaVersion') as number) ?? 0;

  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    log.info(`Store schema is current (v${currentVersion})`);
    return;
  }

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    log.warn(
      `Store schema version (${currentVersion}) is newer than app expects (${CURRENT_SCHEMA_VERSION}). Possible downgrade.`
    );
    return;
  }

  const pendingMigrations = migrations.filter((m) => m.version > currentVersion);
  log.info(`Running ${pendingMigrations.length} store migration(s) (v${currentVersion} → v${CURRENT_SCHEMA_VERSION})`);

  // Back up before any mutations
  backupStore(s);

  for (const migration of pendingMigrations) {
    try {
      log.info(`Migration v${migration.version}: ${migration.description}`);
      migration.migrate(s);
      s.set('schemaVersion', migration.version);
      log.info(`Migration v${migration.version}: complete`);
    } catch (err: any) {
      log.error(`Migration v${migration.version} FAILED: ${err?.message}`);
      throw new Error(`Store migration failed at v${migration.version}: ${err?.message || err}`);
    }
  }

  // Clean up old backups, keep only the pre-migration one
  cleanOldBackups(s, currentVersion);
}

// ============================================================================
// STORE RESET (escape hatch)
// ============================================================================

export function resetStore(s: Store<ClawdiaStoreSchema>): void {
  backupStore(s);
  s.clear();
  s.set('schemaVersion', CURRENT_SCHEMA_VERSION);
  log.info(`Store reset to clean state at v${CURRENT_SCHEMA_VERSION}`);
}
