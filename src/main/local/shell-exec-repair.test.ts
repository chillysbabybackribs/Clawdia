import { describe, it, expect, vi } from 'vitest';
import { toolShellExec } from './tools';
import { randomUUID } from 'crypto';

describe('shell_exec repair logic', () => {
    it('should support streaming output via onOutput callback', async () => {
        const onOutput = vi.fn();
        const ctx = {
            onOutput,
            signal: new AbortController().signal,
        };

        // Use a command that emits output incrementally
        await toolShellExec({
            command: 'echo "hello"; sleep 0.1; echo "world"',
        }, ctx as any);

        expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('hello'));
        expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('world'));
    });

    it('should capture cancellation message in return string', async () => {
        const controller = new AbortController();
        const ctx = {
            signal: controller.signal,
        };

        const promise = toolShellExec({
            command: 'sleep 10',
        }, ctx as any);

        // Give it a moment to start
        await new Promise(r => setTimeout(r, 100));

        controller.abort();

        const result = await promise;
        expect(result).toContain('Command aborted by user');
    });

    it('should handle large output without hanging', async () => {
        // Kill previous shell if any (indirectly via a failing command or just assume robustness)
        // Resetting isn't easily exposed, but we can rely on isolation potentially?
        // Actually, let's just run a simple command first to flush buffer
        await toolShellExec({ command: 'echo flush' });

        // seq 1 10000 generates about 50KB of output
        const result = await toolShellExec({
            command: 'seq 1 10000',
        });


        // Expect result to be truncated if it exceeds limit, but definitely return
        if (result.length < 10000) {
            expect(result).toContain('[Output truncated');
        } else {
            expect(result.length).toBeGreaterThan(10000);
        }
    });
});
