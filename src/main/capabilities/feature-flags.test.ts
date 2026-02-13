import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeData = new Map<string, unknown>();

vi.mock('../store', () => ({
  store: {
    get: (key: string) => storeData.get(key),
    set: (key: string, value: unknown) => {
      storeData.set(key, value);
    },
  },
}));

describe('capability platform feature flags', () => {
  beforeEach(() => {
    storeData.clear();
  });

  it('returns defaults when flags are not set', async () => {
    const { getCapabilityPlatformFlags } = await import('./feature-flags');
    const flags = getCapabilityPlatformFlags();
    expect(flags.enabled).toBe(true);
    expect(flags.cohort).toBe('internal');
    expect(flags.installOrchestrator).toBe(true);
    expect(flags.containerExecution).toBe(false);
  });

  it('merges persisted flags with defaults', async () => {
    storeData.set('capabilityPlatformFlags', {
      cohort: 'beta',
      containerExecution: true,
    });
    const { getCapabilityPlatformFlags } = await import('./feature-flags');
    const flags = getCapabilityPlatformFlags();
    expect(flags.cohort).toBe('beta');
    expect(flags.containerExecution).toBe(true);
    expect(flags.lifecycleEvents).toBe(true);
  });

  it('persists updates through setter', async () => {
    const { setCapabilityPlatformFlags } = await import('./feature-flags');
    const next = setCapabilityPlatformFlags({ cohort: 'default', mcpRuntimeManager: true });
    expect(next.cohort).toBe('default');
    expect(next.mcpRuntimeManager).toBe(true);
    expect(storeData.get('capabilityPlatformFlags')).toEqual(next);
  });
});
