/**
 * Performance utilities for Clawdia
 */

/** Debounce - delays execution until after wait ms since last call */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return function debounced(...args: Parameters<T>) {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, wait);
  };
}

/** Throttle - ensures function called at most once per wait ms */
export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let lastTime = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return function throttled(...args: Parameters<T>) {
    const now = Date.now();
    const remaining = wait - (now - lastTime);
    if (remaining <= 0) {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      lastTime = now;
      func(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastTime = Date.now();
        timeoutId = null;
        func(...args);
      }, remaining);
    }
  };
}

/** RAF throttle - max once per animation frame */
export function rafThrottle<T extends (...args: unknown[]) => unknown>(
  func: T
): (...args: Parameters<T>) => void {
  let rafId: number | null = null;
  let lastArgs: Parameters<T> | null = null;
  return function rafThrottled(...args: Parameters<T>) {
    lastArgs = args;
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        if (lastArgs) func(...lastArgs);
        rafId = null;
      });
    }
  };
}

/** Track and cleanup event listeners to prevent memory leaks */
const listenerRegistry = new Map<string, { target: EventTarget; type: string; listener: EventListener }>();

export function addTrackedListener(
  id: string,
  target: EventTarget,
  type: string,
  listener: EventListener,
  options?: AddEventListenerOptions
): void {
  // Remove existing listener with same ID
  removeTrackedListener(id);
  target.addEventListener(type, listener, options);
  listenerRegistry.set(id, { target, type, listener });
}

export function removeTrackedListener(id: string): void {
  const entry = listenerRegistry.get(id);
  if (entry) {
    entry.target.removeEventListener(entry.type, entry.listener);
    listenerRegistry.delete(id);
  }
}

export function removeAllTrackedListeners(): void {
  for (const [id] of listenerRegistry) {
    removeTrackedListener(id);
  }
}
