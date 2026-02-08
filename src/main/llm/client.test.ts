import { describe, it, expect } from 'vitest';
import { computeCacheMetrics } from './client';

describe('computeCacheMetrics', () => {
  it('computes correct hit rate for typical usage', () => {
    // 100 fresh, 900 cache read, 0 cache create → 90% hit
    const m = computeCacheMetrics(100, 900, 0);
    expect(m.totalInputTokens).toBe(1000);
    expect(m.hitRate).toBeCloseTo(90, 1);
    expect(m.hitRateStr).toBe('90.0');
  });

  it('returns 0% hit rate when all tokens are fresh', () => {
    const m = computeCacheMetrics(500, 0, 0);
    expect(m.totalInputTokens).toBe(500);
    expect(m.hitRate).toBe(0);
    expect(m.hitRateStr).toBe('0.0');
  });

  it('returns 0% hit rate when all inputs are zero', () => {
    const m = computeCacheMetrics(0, 0, 0);
    expect(m.totalInputTokens).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.hitRateStr).toBe('0.0');
  });

  it('handles 100% cache read (no fresh, no create)', () => {
    const m = computeCacheMetrics(0, 5000, 0);
    expect(m.totalInputTokens).toBe(5000);
    expect(m.hitRate).toBe(100);
    expect(m.hitRateStr).toBe('100.0');
  });

  it('hit rate never exceeds 100%', () => {
    // Even with edge-case inputs, rate is clamped
    const m = computeCacheMetrics(0, 10000, 0);
    expect(m.hitRate).toBeLessThanOrEqual(100);
  });

  it('hit rate is never negative', () => {
    const m = computeCacheMetrics(100, 0, 200);
    expect(m.hitRate).toBeGreaterThanOrEqual(0);
  });

  it('clamps negative inputs to zero', () => {
    // If the API ever returned a negative (shouldn't happen), we don't go haywire
    const m = computeCacheMetrics(-5, -10, -3);
    expect(m.totalInputTokens).toBe(0);
    expect(m.hitRate).toBe(0);
  });

  // Regression: reproduces the exact scenario from the bug report
  // Observed: input_tokens=8, cache_read=8039, cache_create=8897
  // Old formula: fresh=8-8039-8897=-16928, hitRate=8039/8*100=100487.5%
  it('regression: reproduces the observed impossible log values', () => {
    const m = computeCacheMetrics(8, 8039, 8897);
    expect(m.totalInputTokens).toBe(8 + 8039 + 8897); // 16944
    expect(m.hitRate).toBeCloseTo((8039 / 16944) * 100, 1); // ~47.4%
    expect(m.hitRate).toBeGreaterThanOrEqual(0);
    expect(m.hitRate).toBeLessThanOrEqual(100);
    // fresh is simply the input (8), not a subtraction
    expect(m.totalInputTokens).toBeGreaterThanOrEqual(0);
  });

  it('handles large token counts without overflow', () => {
    const m = computeCacheMetrics(500_000, 2_000_000, 100_000);
    expect(m.totalInputTokens).toBe(2_600_000);
    expect(m.hitRate).toBeCloseTo((2_000_000 / 2_600_000) * 100, 1);
    expect(m.hitRate).toBeLessThanOrEqual(100);
  });

  it('cache create does not count as a hit', () => {
    // All tokens are cache creation, none are reads → 0% hit rate
    const m = computeCacheMetrics(0, 0, 5000);
    expect(m.totalInputTokens).toBe(5000);
    expect(m.hitRate).toBe(0);
  });
});
