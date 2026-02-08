/**
 * Strategy Cache — per-session cache of successful tool sequences.
 *
 * Keyed by archetype + host + toolClass to prevent cross-contamination
 * (e.g., YouTube strategies don't poison Loom). Records exponential
 * moving averages of iteration counts and durations for strategy hints.
 */

import type { ArchetypeId } from './task-archetype';
import type { ToolClass } from './intent-router';
import { createLogger } from '../logger';

const log = createLogger('strategy-cache');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheKey {
  archetype: ArchetypeId;
  primaryHost: string | null;
  toolClass: ToolClass;
}

export interface CachedStrategy {
  key: CacheKey;
  toolSequence: string[];
  successCount: number;
  avgIterations: number;
  avgDurationMs: number;
}

// ---------------------------------------------------------------------------
// Cache implementation
// ---------------------------------------------------------------------------

const EMA_ALPHA = 0.3; // exponential moving average smoothing factor
const MIN_SUCCESS_FOR_HINT = 2; // need at least 2 successes before we trust the cache

function keyToString(key: CacheKey): string {
  return `${key.archetype}|${key.primaryHost || '_'}|${key.toolClass}`;
}

export class StrategyCache {
  private cache = new Map<string, CachedStrategy>();

  /**
   * Record a completed tool loop run.
   */
  record(
    key: CacheKey,
    toolsUsed: string[],
    iterations: number,
    durationMs: number,
    success: boolean,
  ): void {
    if (!success) return; // Only cache successes

    const k = keyToString(key);
    const existing = this.cache.get(k);

    if (existing) {
      existing.successCount += 1;
      existing.avgIterations =
        EMA_ALPHA * iterations + (1 - EMA_ALPHA) * existing.avgIterations;
      existing.avgDurationMs =
        EMA_ALPHA * durationMs + (1 - EMA_ALPHA) * existing.avgDurationMs;
      // Update tool sequence to latest successful one
      existing.toolSequence = toolsUsed;
      log.debug(
        `Cache update: ${k} successCount=${existing.successCount} avgIters=${existing.avgIterations.toFixed(1)}`
      );
    } else {
      this.cache.set(k, {
        key,
        toolSequence: toolsUsed,
        successCount: 1,
        avgIterations: iterations,
        avgDurationMs: durationMs,
      });
      log.debug(`Cache new: ${k} iters=${iterations}`);
    }
  }

  /**
   * Look up a cached strategy. Returns null if not enough data.
   */
  lookup(key: CacheKey): CachedStrategy | null {
    const k = keyToString(key);
    const cached = this.cache.get(k);
    if (!cached || cached.successCount < MIN_SUCCESS_FOR_HINT) return null;
    return cached;
  }

  /**
   * Get a system prompt hint from the cache. Empty string if no cache hit.
   */
  getHint(key: CacheKey): string {
    const cached = this.lookup(key);
    if (!cached) return '';
    return (
      `Previously successful approach for this task type: ` +
      `tools=[${cached.toolSequence.join(', ')}], ` +
      `avg ${cached.avgIterations.toFixed(1)} iterations.`
    );
  }

  /**
   * Clear the entire cache (called on new conversation).
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    if (size > 0) {
      log.debug(`Cache cleared (${size} entries)`);
    }
  }
}

/** Singleton instance. */
export const strategyCache = new StrategyCache();
