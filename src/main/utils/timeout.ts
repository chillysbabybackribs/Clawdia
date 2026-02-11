import { createLogger } from '../logger';

const log = createLogger('timeout');

/**
 * Hard timeout — rejects with an Error if the promise doesn't resolve within `ms`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Soft timeout — resolves null instead of rejecting on timeout.
 * Used for cleanup steps where we don't want to throw.
 */
export async function withSoftTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  const result = await Promise.race([promise, timeout]);
  if (result === null) log.warn(`${label} timed out after ${ms}ms, skipping`);
  return result;
}
