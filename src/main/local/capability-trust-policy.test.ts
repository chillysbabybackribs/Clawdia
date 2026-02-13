import { describe, expect, it } from 'vitest';
import { resolveCapabilityTrustPolicy } from './tools';

describe('capability trust policy resolution', () => {
  it('defaults to verified_fallback when context is missing', () => {
    expect(resolveCapabilityTrustPolicy()).toBe('verified_fallback');
  });

  it('maps autonomy modes to expected trust policies', () => {
    expect(resolveCapabilityTrustPolicy({ autonomyMode: 'safe' } as any)).toBe('strict_verified');
    expect(resolveCapabilityTrustPolicy({ autonomyMode: 'guided' } as any)).toBe('verified_fallback');
    expect(resolveCapabilityTrustPolicy({ autonomyMode: 'unrestricted' } as any)).toBe('best_effort');
  });

  it('uses explicit capabilityTrustPolicy override when provided', () => {
    expect(
      resolveCapabilityTrustPolicy({
        autonomyMode: 'safe',
        capabilityTrustPolicy: 'best_effort',
      } as any),
    ).toBe('best_effort');
  });
});
