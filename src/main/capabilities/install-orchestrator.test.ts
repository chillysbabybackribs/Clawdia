import { beforeEach, describe, expect, it, vi } from 'vitest';

const flagState = {
  containerExecution: false,
  containerizeInstalls: false,
};

vi.mock('./feature-flags', () => ({
  getCapabilityPlatformFlags: () => ({
    enabled: true,
    cohort: 'internal',
    lifecycleEvents: false,
    installOrchestrator: false,
    checkpointRollback: false,
    mcpRuntimeManager: false,
    containerExecution: flagState.containerExecution,
    containerizeMcpServers: false,
    containerizeInstalls: flagState.containerizeInstalls,
  }),
}));

describe('install orchestrator container policy', () => {
  beforeEach(() => {
    flagState.containerExecution = false;
    flagState.containerizeInstalls = false;
  });

  it('skips container when flags are off', async () => {
    const { shouldRunInstallInContainer } = await import('./install-orchestrator');
    expect(shouldRunInstallInContainer({ runInContainer: true })).toBe(false);
  });

  it('uses container when both flags are on and recipe allows it', async () => {
    flagState.containerExecution = true;
    flagState.containerizeInstalls = true;
    const { shouldRunInstallInContainer } = await import('./install-orchestrator');
    expect(shouldRunInstallInContainer({ runInContainer: true })).toBe(true);
    expect(shouldRunInstallInContainer({ runInContainer: false })).toBe(false);
  });
});
