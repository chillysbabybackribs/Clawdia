import { describe, expect, it } from 'vitest';
import {
  toCapabilityLifecycleEventName,
  tryCapabilityLifecycleEventName,
  CAPABILITY_EVENT_NAME_BY_TYPE,
} from './contracts';

describe('capability contracts lifecycle event mapping', () => {
  it('maps known runtime event types to normalized lifecycle names', () => {
    expect(toCapabilityLifecycleEventName('capability_missing')).toBe('CAPABILITY_MISSING');
    expect(toCapabilityLifecycleEventName('install_started')).toBe('INSTALL_STARTED');
    expect(toCapabilityLifecycleEventName('install_succeeded')).toBe('INSTALL_VERIFIED');
    expect(toCapabilityLifecycleEventName('policy_rewrite')).toBe('POLICY_REWRITE_APPLIED');
    expect(toCapabilityLifecycleEventName('checkpoint_created')).toBe('CHECKPOINT_CREATED');
  });

  it('returns undefined for unknown event types in tolerant mapper', () => {
    expect(tryCapabilityLifecycleEventName('totally_unknown')).toBeUndefined();
  });

  it('keeps mapping table synchronized with lifecycle conversion helper', () => {
    for (const [type, eventName] of Object.entries(CAPABILITY_EVENT_NAME_BY_TYPE)) {
      expect(tryCapabilityLifecycleEventName(type)).toBe(eventName);
    }
  });
});
