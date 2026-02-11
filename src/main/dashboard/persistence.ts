import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { createLogger } from '../logger';
import type { AmbientData } from './ambient';
import type { HaikuDashboardResponse, DashboardProjectCard, DashboardActivityItem } from '../../shared/dashboard-types';

const log = createLogger('dashboard-persistence');

const STATE_FILENAME = 'dashboard-state.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // discard states older than 24h

// ---------------------------------------------------------------------------
// Persisted state shape
// ---------------------------------------------------------------------------

export interface PersistedDashboardState {
  /** Haiku response (project rankings, activity highlights) */
  haiku: HaikuDashboardResponse | null;
  /** Pre-built project cards so we can render without Haiku */
  projectCards: DashboardProjectCard[];
  /** Pre-built activity feed */
  activityFeed: DashboardActivityItem[];
  /** MD5 hash of ambient context fingerprint */
  contextHash: string;
  /** Whether the session had real user activity (at least 1 message sent) */
  sessionHadActivity: boolean;
  /** When this state was saved */
  savedAt: number;
}

// ---------------------------------------------------------------------------
// Context hashing
// ---------------------------------------------------------------------------

/**
 * Compute an MD5 hash fingerprint from ambient data.
 * Uses: top 5 browser domains + top 3 project paths + git uncommitted counts.
 */
export function computeContextHash(data: AmbientData): string {
  const parts: string[] = [];

  // Top 5 browser domains
  if (data.browserHistory) {
    const domains = data.browserHistory.topDomains
      .slice(0, 5)
      .map(d => d.domain);
    parts.push('domains:' + domains.join(','));
  }

  // Top 3 project paths (by heat)
  const topProjects = data.projects
    .sort((a, b) => b.heatScore - a.heatScore)
    .slice(0, 3)
    .map(p => p.fullPath);
  parts.push('projects:' + topProjects.join(','));

  // Git uncommitted counts for those projects
  const uncommittedCounts = data.gitRepos
    .filter(g => topProjects.includes(g.fullPath))
    .map(g => `${g.fullPath}:${g.uncommittedCount}`)
    .sort();
  parts.push('git:' + uncommittedCounts.join(','));

  const fingerprint = parts.join('|');
  return createHash('md5').update(fingerprint).digest('hex');
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILENAME);
}

export function saveDashboardState(state: PersistedDashboardState): void {
  try {
    const filePath = getStatePath();
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
    log.info(`[Persistence] Saved dashboard state (hash=${state.contextHash.slice(0, 8)}, activity=${state.sessionHadActivity})`);
  } catch (err: any) {
    log.warn(`[Persistence] Failed to save state: ${err?.message || err}`);
  }
}

export function loadDashboardState(): PersistedDashboardState | null {
  try {
    const filePath = getStatePath();
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    const state = JSON.parse(raw) as PersistedDashboardState;

    // Discard stale states (>24h)
    if (Date.now() - state.savedAt > MAX_AGE_MS) {
      log.info(`[Persistence] Discarding stale state (${Math.round((Date.now() - state.savedAt) / 3600000)}h old)`);
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }

    // Basic shape validation
    if (typeof state.contextHash !== 'string' || typeof state.savedAt !== 'number') {
      log.warn('[Persistence] Invalid state shape, discarding');
      return null;
    }

    log.info(`[Persistence] Loaded state (hash=${state.contextHash.slice(0, 8)}, age=${Math.round((Date.now() - state.savedAt) / 60000)}min, activity=${state.sessionHadActivity})`);
    return state;
  } catch (err: any) {
    log.warn(`[Persistence] Failed to load state: ${err?.message || err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session message counter (module-level)
// ---------------------------------------------------------------------------

let sessionMessageCount = 0;

export function incrementSessionMessageCount(): void {
  sessionMessageCount++;
}

export function getSessionMessageCount(): number {
  return sessionMessageCount;
}

export function sessionHadActivity(): boolean {
  return sessionMessageCount > 0;
}
