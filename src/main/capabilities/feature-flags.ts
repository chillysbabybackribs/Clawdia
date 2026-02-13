import type { CapabilityPlatformFlags } from '../../shared/types';
import { store } from '../store';

const DEFAULT_CAPABILITY_PLATFORM_FLAGS: CapabilityPlatformFlags = {
  enabled: true,
  cohort: 'internal',
  lifecycleEvents: false,
  installOrchestrator: false,
  checkpointRollback: false,
  mcpRuntimeManager: false,
  containerExecution: false,
  containerizeMcpServers: false,
  containerizeInstalls: false,
};

export function getCapabilityPlatformFlags(): CapabilityPlatformFlags {
  const raw = store.get('capabilityPlatformFlags' as any) as Partial<CapabilityPlatformFlags> | undefined;
  return {
    ...DEFAULT_CAPABILITY_PLATFORM_FLAGS,
    ...(raw || {}),
  };
}

export function isCapabilityFlagEnabled(flag: keyof CapabilityPlatformFlags): boolean {
  return Boolean(getCapabilityPlatformFlags()[flag]);
}

export function setCapabilityPlatformFlags(flags: Partial<CapabilityPlatformFlags>): CapabilityPlatformFlags {
  const next = {
    ...getCapabilityPlatformFlags(),
    ...flags,
  };
  store.set('capabilityPlatformFlags' as any, next);
  return next;
}

export { DEFAULT_CAPABILITY_PLATFORM_FLAGS };
