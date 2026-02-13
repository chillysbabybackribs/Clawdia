import { describe, expect, it, vi } from 'vitest';
import { toolShellExec } from './tools';
import { homedir } from 'os';

vi.mock('../capabilities/feature-flags', () => ({
  getCapabilityPlatformFlags: () => ({
    enabled: true,
    cohort: 'internal',
    lifecycleEvents: false,
    installOrchestrator: false,
    checkpointRollback: false,
    mcpRuntimeManager: false,
    containerExecution: true,
    containerizeMcpServers: false,
    containerizeInstalls: false,
  }),
}));

vi.mock('../capabilities/container-executor', () => ({
  detectContainerRuntime: vi.fn(async () => ({
    available: true,
    runtime: 'docker',
    detail: 'docker ready (mock)',
    checkedAt: Date.now(),
  })),
  executeCommandInContainer: vi.fn(async () => {
    throw new Error('mock container failure');
  }),
}));

describe('shell_exec container fallback', () => {
  it('falls back to host execution when container run fails', async () => {
    const output = await toolShellExec(
      { command: 'echo ok', working_directory: homedir() },
      { autonomyMode: 'guided' } as any,
    );
    expect(output).toContain('ok');
    expect(output).toContain('host fallback');
  });
});
