/**
 * Interactive Executor Store — SQLite-backed cache for interactive LLM call executors.
 *
 * Unlike `task_executors` (keyed by task_id for scheduled tasks), this store is
 * keyed by a SHA-256 hash of `archetype|host|toolClass|toolSequence`, allowing
 * executor reuse across interactive conversations that share the same pattern.
 */

import { createHash } from 'crypto';
import { getVaultDB } from '../vault/db';
import { createLogger } from '../logger';
import type { CacheKey } from './strategy-cache';
import type { TaskExecutor } from '../../shared/task-types';

const log = createLogger('interactive-executor-store');

const MAX_FAILURES = 3;
const STALE_DAYS = 30;

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/**
 * Build a deterministic SHA-256 hex hash from the cache key + tool sequence.
 * Format: `archetype|primaryHost|toolClass|tool1,tool2,...`
 */
export function buildCacheKeyHash(key: CacheKey, toolSequence: string[]): string {
    const raw = `${key.archetype}|${key.primaryHost || '_'}|${key.toolClass}|${toolSequence.join(',')}`;
    return createHash('sha256').update(raw).digest('hex');
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Retrieve the latest active (non-superseded) interactive executor for the
 * given cache key + tool sequence.
 *
 * Returns `null` if no executor exists, if it has too many consecutive
 * failures (>= MAX_FAILURES), or if it hasn't been used in STALE_DAYS.
 */
export function lookupInteractiveExecutor(
    key: CacheKey,
    toolSequence: string[],
): TaskExecutor | null {
    const db = getVaultDB();
    const hash = buildCacheKeyHash(key, toolSequence);

    const row = db
        .prepare(
            `SELECT * FROM interactive_executors
             WHERE cache_key_hash = ? AND superseded_at IS NULL
             ORDER BY version DESC LIMIT 1`,
        )
        .get(hash) as any;

    if (!row) return null;

    // Health check: consecutive failures
    if (row.failure_count >= MAX_FAILURES) {
        log.warn(
            `Interactive executor ${row.id} has ${row.failure_count} failures, superseding`,
        );
        supersedeInteractiveExecutor(row.id);
        return null;
    }

    // Health check: staleness
    const now = Math.floor(Date.now() / 1000);
    const lastActivity = row.last_used_at || row.created_at;
    const staleSec = STALE_DAYS * 24 * 3600;
    if (now - lastActivity > staleSec) {
        log.warn(
            `Interactive executor ${row.id} is stale (last used ${Math.floor((now - lastActivity) / 86400)}d ago), superseding`,
        );
        supersedeInteractiveExecutor(row.id);
        return null;
    }

    try {
        return JSON.parse(row.executor_json) as TaskExecutor;
    } catch {
        log.error(`Failed to parse executor JSON for interactive executor ${row.id}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Persist a new interactive executor, superseding any previous active version
 * for the same cache key hash.
 */
export function saveInteractiveExecutor(
    key: CacheKey,
    toolSequence: string[],
    executor: TaskExecutor,
): void {
    const db = getVaultDB();
    const hash = buildCacheKeyHash(key, toolSequence);
    const keyJson = JSON.stringify({ ...key, toolSequence });
    const now = Math.floor(Date.now() / 1000);

    // Determine next version
    const current = db
        .prepare(
            `SELECT MAX(version) as maxVer FROM interactive_executors WHERE cache_key_hash = ?`,
        )
        .get(hash) as any;
    const newVersion = (current?.maxVer || 0) + 1;

    // Supersede all previous active executors for this key
    db.prepare(
        `UPDATE interactive_executors SET superseded_at = ? WHERE cache_key_hash = ? AND superseded_at IS NULL`,
    ).run(now, hash);

    // Insert new executor
    db.prepare(
        `INSERT INTO interactive_executors
            (id, cache_key_hash, cache_key_json, version, executor_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(executor.id, hash, keyJson, newVersion, JSON.stringify(executor), now);

    log.info(`Saved interactive executor v${newVersion} (hash=${hash.slice(0, 12)}...)`);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Update success/failure counters and `last_used_at` after an executor run.
 * On success the failure_count is reset to 0 (consecutive-failure semantics).
 */
export function updateInteractiveExecutorStats(
    executorId: string,
    success: boolean,
    costSaved: number,
): void {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);

    if (success) {
        db.prepare(
            `UPDATE interactive_executors
             SET success_count = success_count + 1,
                 failure_count = 0,
                 total_cost_saved = total_cost_saved + ?,
                 last_used_at = ?
             WHERE id = ?`,
        ).run(costSaved, now, executorId);
    } else {
        db.prepare(
            `UPDATE interactive_executors
             SET failure_count = failure_count + 1,
                 last_used_at = ?
             WHERE id = ?`,
        ).run(now, executorId);
    }
}

// ---------------------------------------------------------------------------
// Supersede
// ---------------------------------------------------------------------------

/** Mark an interactive executor as superseded so it won't be returned by lookup. */
export function supersedeInteractiveExecutor(executorId: string): void {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
        `UPDATE interactive_executors SET superseded_at = ? WHERE id = ?`,
    ).run(now, executorId);
}
