import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import type { TaskExecutor } from '../../shared/task-types';

const TEST_DIR = path.resolve(__dirname, 'test_executor_store_data');

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => TEST_DIR,
        isPackaged: false,
    },
}));

vi.mock('os', () => ({
    homedir: () => TEST_DIR,
    platform: () => 'linux',
    tmpdir: () => '/tmp',
    release: () => '1.0.0',
    type: () => 'Linux',
    endianness: () => 'LE',
    arch: () => 'x64',
}));

function makeExecutor(taskId: string, overrides: Partial<TaskExecutor> = {}): TaskExecutor {
    return {
        id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        task_id: taskId,
        version: 1,
        created_at: Math.floor(Date.now() / 1000),
        created_from_run_id: 'run-1',
        steps: [
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
            { type: 'tool', tool_name: 'browser_read_page', tool_input: {}, store_as: 'content' },
            { type: 'result', template: '{{content}}' },
        ],
        validation: {
            expect_result: true,
            max_duration_ms: 300000,
            required_variables: ['content'],
            abort_on_empty_extract: false,
        },
        stats: {
            total_steps: 3,
            deterministic_steps: 2,
            llm_steps: 0,
            estimated_cost_per_run: 0,
        },
        ...overrides,
    };
}

describe('Executor Store (task-store.ts)', () => {
    let initVault: any;
    let getVaultDB: any;
    let createTask: any;
    let getExecutorForTask: any;
    let saveExecutor: any;
    let updateExecutorStats: any;
    let supersedeExecutor: any;

    beforeAll(async () => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(TEST_DIR, { recursive: true });

        const dbModule = await import('../vault/db');
        initVault = dbModule.initVault;
        getVaultDB = dbModule.getVaultDB;
        initVault(TEST_DIR);

        const storeModule = await import('./task-store');
        createTask = storeModule.createTask;
        getExecutorForTask = storeModule.getExecutorForTask;
        saveExecutor = storeModule.saveExecutor;
        updateExecutorStats = storeModule.updateExecutorStats;
        supersedeExecutor = storeModule.supersedeExecutor;
    });

    afterAll(() => {
        try { getVaultDB().close(); } catch { }
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    it('returns null when no executor exists for a task', () => {
        const result = getExecutorForTask('nonexistent-task');
        expect(result).toBeNull();
    });

    it('saves and retrieves an executor', () => {
        // Create a task first (FK constraint)
        const taskId = createTask({
            description: 'Test task for executor',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        const retrieved = getExecutorForTask(taskId);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.task_id).toBe(taskId);
        expect(retrieved!.steps).toHaveLength(3);
        expect(retrieved!.stats.deterministic_steps).toBe(2);
    });

    it('auto-increments version on save', () => {
        const taskId = createTask({
            description: 'Version test task',
            triggerType: 'scheduled',
            triggerConfig: '*/15 * * * *',
        });

        const exec1 = makeExecutor(taskId);
        saveExecutor(exec1);

        const v1 = getExecutorForTask(taskId);
        expect(v1!.version).toBe(1);

        const exec2 = makeExecutor(taskId);
        saveExecutor(exec2);

        const v2 = getExecutorForTask(taskId);
        expect(v2!.version).toBe(2);
        // v1 should be superseded, v2 should be active
        expect(v2!.id).toBe(exec2.id);
    });

    it('supersedes previous executors when saving a new one', () => {
        const taskId = createTask({
            description: 'Supersede test',
            triggerType: 'scheduled',
            triggerConfig: '0 * * * *',
        });

        const exec1 = makeExecutor(taskId);
        saveExecutor(exec1);
        saveExecutor(makeExecutor(taskId));
        saveExecutor(makeExecutor(taskId));

        // Only the latest should be returned
        const current = getExecutorForTask(taskId);
        expect(current!.version).toBe(3);

        // Verify old ones are superseded in DB
        const db = getVaultDB();
        const all = db.prepare(
            'SELECT * FROM task_executors WHERE task_id = ? ORDER BY version'
        ).all(taskId) as any[];
        expect(all).toHaveLength(3);
        expect(all[0].superseded_at).not.toBeNull(); // v1 superseded
        expect(all[1].superseded_at).not.toBeNull(); // v2 superseded
        expect(all[2].superseded_at).toBeNull();      // v3 active
    });

    it('updates success stats and last_used_at', () => {
        const taskId = createTask({
            description: 'Stats test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        updateExecutorStats(executor.id, true, 0.038);
        updateExecutorStats(executor.id, true, 0.035);

        const db = getVaultDB();
        const row = db.prepare('SELECT * FROM task_executors WHERE id = ?').get(executor.id) as any;
        expect(row.success_count).toBe(2);
        expect(row.failure_count).toBe(0);
        expect(row.total_cost_saved).toBeCloseTo(0.073, 3);
        expect(row.last_used_at).toBeGreaterThan(0);
    });

    it('updates failure stats', () => {
        const taskId = createTask({
            description: 'Failure stats test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        updateExecutorStats(executor.id, false, 0);
        updateExecutorStats(executor.id, false, 0);

        const db = getVaultDB();
        const row = db.prepare('SELECT * FROM task_executors WHERE id = ?').get(executor.id) as any;
        expect(row.success_count).toBe(0);
        expect(row.failure_count).toBe(2);
        expect(row.total_cost_saved).toBe(0);
    });

    it('supersedes executor after 3 consecutive failures', () => {
        const taskId = createTask({
            description: 'Auto-supersede test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        // Simulate 3 failures
        updateExecutorStats(executor.id, false, 0);
        updateExecutorStats(executor.id, false, 0);
        updateExecutorStats(executor.id, false, 0);

        // getExecutorForTask should detect the failures and supersede
        const result = getExecutorForTask(taskId);
        expect(result).toBeNull();

        // Verify it was superseded in DB
        const db = getVaultDB();
        const row = db.prepare('SELECT * FROM task_executors WHERE id = ?').get(executor.id) as any;
        expect(row.superseded_at).not.toBeNull();
    });

    it('supersedes stale executors (>30 days unused)', () => {
        const taskId = createTask({
            description: 'Staleness test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        // Manually set created_at and last_used_at to 31 days ago
        const db = getVaultDB();
        const staleTime = Math.floor(Date.now() / 1000) - (31 * 24 * 3600);
        db.prepare('UPDATE task_executors SET created_at = ?, last_used_at = ? WHERE id = ?')
            .run(staleTime, staleTime, executor.id);

        // Should detect staleness and supersede
        const result = getExecutorForTask(taskId);
        expect(result).toBeNull();
    });

    it('does not supersede recently used executors', () => {
        const taskId = createTask({
            description: 'Fresh executor test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        // Mark as recently used
        updateExecutorStats(executor.id, true, 0.01);

        const result = getExecutorForTask(taskId);
        expect(result).not.toBeNull();
        expect(result!.task_id).toBe(taskId);
    });

    it('supersedeExecutor marks as superseded', () => {
        const taskId = createTask({
            description: 'Manual supersede test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        supersedeExecutor(executor.id);

        const result = getExecutorForTask(taskId);
        expect(result).toBeNull();
    });

    it('handles invalid JSON in executor_json gracefully', () => {
        const taskId = createTask({
            description: 'Bad JSON test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        // Insert a row with bad JSON directly
        const db = getVaultDB();
        db.prepare(
            `INSERT INTO task_executors (id, task_id, version, executor_json, created_at) VALUES (?, ?, 1, ?, ?)`
        ).run('bad-exec', taskId, 'not valid json{{{', Math.floor(Date.now() / 1000));

        const result = getExecutorForTask(taskId);
        expect(result).toBeNull();
    });

    it('cascades delete when task is deleted', () => {
        const taskId = createTask({
            description: 'Cascade test',
            triggerType: 'scheduled',
            triggerConfig: '0 9 * * *',
        });

        const executor = makeExecutor(taskId);
        saveExecutor(executor);

        // Delete the task
        const db = getVaultDB();
        db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

        // Executor should be gone too
        const rows = db.prepare('SELECT * FROM task_executors WHERE task_id = ?').all(taskId);
        expect(rows).toHaveLength(0);
    });
});
