import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { TaskExecutor } from '../../shared/task-types';
import type { CacheKey } from './strategy-cache';

// In-memory DB shared across tests
let memDb: Database.Database;

// Mock the vault/db module to return our in-memory DB
vi.mock('../vault/db', () => ({
    getVaultDB: () => memDb,
}));

// Mock logger
vi.mock('../logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// Import after mocks are set up
import {
    buildCacheKeyHash,
    lookupInteractiveExecutor,
    saveInteractiveExecutor,
    updateInteractiveExecutorStats,
    supersedeInteractiveExecutor,
} from './interactive-executor-store';

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS interactive_executors (
    id TEXT PRIMARY KEY,
    cache_key_hash TEXT NOT NULL,
    cache_key_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    executor_json TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    total_cost_saved REAL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    superseded_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_executors_key
    ON interactive_executors(cache_key_hash) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_interactive_executors_used
    ON interactive_executors(last_used_at);
`;

function makeKey(overrides: Partial<CacheKey> = {}): CacheKey {
    return {
        archetype: 'web_extraction' as any,
        primaryHost: 'example.com',
        toolClass: 'browser',
        ...overrides,
    };
}

function makeExecutor(overrides: Partial<TaskExecutor> = {}): TaskExecutor {
    return {
        id: 'exec-1',
        task_id: 'interactive',
        version: 1,
        created_at: Math.floor(Date.now() / 1000),
        created_from_run_id: '',
        steps: [],
        validation: {
            expect_result: true,
            max_duration_ms: 30000,
            required_variables: [],
            abort_on_empty_extract: false,
        },
        stats: {
            total_steps: 2,
            deterministic_steps: 2,
            llm_steps: 0,
            estimated_cost_per_run: 0.001,
        },
        ...overrides,
    };
}

const TOOL_SEQ = ['browser_navigate', 'browser_extract'];

describe('interactive-executor-store', () => {
    beforeEach(() => {
        memDb = new Database(':memory:');
        memDb.exec(TABLE_SQL);
    });

    afterEach(() => {
        memDb.close();
    });

    // -----------------------------------------------------------------------
    // buildCacheKeyHash
    // -----------------------------------------------------------------------
    describe('buildCacheKeyHash', () => {
        it('returns a deterministic 64-char hex string', () => {
            const key = makeKey();
            const h1 = buildCacheKeyHash(key, TOOL_SEQ);
            const h2 = buildCacheKeyHash(key, TOOL_SEQ);
            expect(h1).toBe(h2);
            expect(h1).toMatch(/^[0-9a-f]{64}$/);
        });

        it('produces different hashes for different tool sequences', () => {
            const key = makeKey();
            const h1 = buildCacheKeyHash(key, ['browser_navigate']);
            const h2 = buildCacheKeyHash(key, ['browser_navigate', 'browser_extract']);
            expect(h1).not.toBe(h2);
        });

        it('produces different hashes for different hosts', () => {
            const h1 = buildCacheKeyHash(makeKey({ primaryHost: 'a.com' }), TOOL_SEQ);
            const h2 = buildCacheKeyHash(makeKey({ primaryHost: 'b.com' }), TOOL_SEQ);
            expect(h1).not.toBe(h2);
        });
    });

    // -----------------------------------------------------------------------
    // save + lookup round-trip
    // -----------------------------------------------------------------------
    describe('saveInteractiveExecutor + lookupInteractiveExecutor', () => {
        it('saves and retrieves an executor', () => {
            const key = makeKey();
            const exec = makeExecutor();
            saveInteractiveExecutor(key, TOOL_SEQ, exec);

            const result = lookupInteractiveExecutor(key, TOOL_SEQ);
            expect(result).not.toBeNull();
            expect(result!.id).toBe(exec.id);
            expect(result!.stats.total_steps).toBe(2);
        });

        it('returns null when no executor exists', () => {
            const result = lookupInteractiveExecutor(makeKey(), TOOL_SEQ);
            expect(result).toBeNull();
        });

        it('supersedes old executor when saving new one with the same key', () => {
            const key = makeKey();
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'exec-old' }));
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'exec-new' }));

            const result = lookupInteractiveExecutor(key, TOOL_SEQ);
            expect(result).not.toBeNull();
            expect(result!.id).toBe('exec-new');

            // Old one should be superseded
            const oldRow = memDb
                .prepare('SELECT superseded_at FROM interactive_executors WHERE id = ?')
                .get('exec-old') as any;
            expect(oldRow.superseded_at).not.toBeNull();
        });

        it('increments version on successive saves with the same key', () => {
            const key = makeKey();
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'v1' }));
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'v2' }));

            const row = memDb
                .prepare('SELECT version FROM interactive_executors WHERE id = ?')
                .get('v2') as any;
            expect(row.version).toBe(2);
        });
    });

    // -----------------------------------------------------------------------
    // updateInteractiveExecutorStats
    // -----------------------------------------------------------------------
    describe('updateInteractiveExecutorStats', () => {
        it('resets failure_count on success', () => {
            const key = makeKey();
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'e1' }));

            // Simulate two failures then a success
            updateInteractiveExecutorStats('e1', false, 0);
            updateInteractiveExecutorStats('e1', false, 0);
            updateInteractiveExecutorStats('e1', true, 0.5);

            const row = memDb
                .prepare('SELECT success_count, failure_count, total_cost_saved FROM interactive_executors WHERE id = ?')
                .get('e1') as any;
            expect(row.failure_count).toBe(0);
            expect(row.success_count).toBe(1);
            expect(row.total_cost_saved).toBeCloseTo(0.5);
        });

        it('increments failure_count on failure', () => {
            const key = makeKey();
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'e1' }));

            updateInteractiveExecutorStats('e1', false, 0);
            updateInteractiveExecutorStats('e1', false, 0);

            const row = memDb
                .prepare('SELECT failure_count FROM interactive_executors WHERE id = ?')
                .get('e1') as any;
            expect(row.failure_count).toBe(2);
        });
    });

    // -----------------------------------------------------------------------
    // Health checks
    // -----------------------------------------------------------------------
    describe('health checks', () => {
        it('supersedes executor after 3 consecutive failures (MAX_FAILURES = 3)', () => {
            const key = makeKey();
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'fragile' }));

            // Accumulate 3 failures
            updateInteractiveExecutorStats('fragile', false, 0);
            updateInteractiveExecutorStats('fragile', false, 0);
            updateInteractiveExecutorStats('fragile', false, 0);

            // Lookup should detect the failures and supersede
            const result = lookupInteractiveExecutor(key, TOOL_SEQ);
            expect(result).toBeNull();

            // Verify it's actually superseded in the DB
            const row = memDb
                .prepare('SELECT superseded_at FROM interactive_executors WHERE id = ?')
                .get('fragile') as any;
            expect(row.superseded_at).not.toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // supersedeInteractiveExecutor
    // -----------------------------------------------------------------------
    describe('supersedeInteractiveExecutor', () => {
        it('marks an executor as superseded', () => {
            const key = makeKey();
            saveInteractiveExecutor(key, TOOL_SEQ, makeExecutor({ id: 'to-supersede' }));

            supersedeInteractiveExecutor('to-supersede');

            const result = lookupInteractiveExecutor(key, TOOL_SEQ);
            expect(result).toBeNull();
        });
    });
});
