export const log = {
  info: (...args: unknown[]) => console.log('[SearchV2]', ...args),
  warn: (...args: unknown[]) => console.warn('[SearchV2]', ...args),
  error: (...args: unknown[]) => console.error('[SearchV2]', ...args),
};
