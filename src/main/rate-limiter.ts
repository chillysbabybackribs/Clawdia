import { createLogger, perfLog } from './logger';

const log = createLogger('rate-limiter');

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface RateLimiterConfig {
  maxTokens: number;
  refillRate: number;
  maxQueueDepth?: number;
  maxWaitMs?: number;
}

const DEFAULT_MAX_QUEUE_DEPTH = 10;
const DEFAULT_MAX_WAIT_MS = 30_000;

export class RateLimiter {
  private static registry = new Map<string, RateLimiter>();

  static getInstance(name: string, config?: RateLimiterConfig): RateLimiter {
    const existing = RateLimiter.registry.get(name);
    if (existing) return existing;
    if (!config) {
      throw new Error(`Rate limiter [${name}] is not initialized`);
    }
    const limiter = new RateLimiter(name, config);
    RateLimiter.registry.set(name, limiter);
    return limiter;
  }

  private readonly name: string;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly maxQueueDepth: number;
  private readonly maxWaitMs: number;
  private tokens: number;
  private lastRefillMs: number;
  private queue: QueueEntry[] = [];
  private nextDrainTimer: NodeJS.Timeout | null = null;

  private constructor(name: string, config: RateLimiterConfig) {
    if (config.maxTokens <= 0) {
      throw new Error(`Rate limiter [${name}] maxTokens must be > 0`);
    }
    if (config.refillRate <= 0) {
      throw new Error(`Rate limiter [${name}] refillRate must be > 0`);
    }

    this.name = name;
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.maxQueueDepth = config.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.tokens = config.maxTokens;
    this.lastRefillMs = Date.now();
  }

  async acquire(): Promise<void> {
    const t0 = performance.now();
    this.refillTokens();

    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const ms = performance.now() - t0;
      if (ms > 1) perfLog('rate-limiter', `${this.name}-acquire`, ms, { queued: false });
      return;
    }

    if (this.queue.length >= this.maxQueueDepth) {
      throw new Error(
        `Rate limiter [${this.name}] queue full (${this.maxQueueDepth}). Try again shortly.`
      );
    }

    await new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
          }
          reject(
            new Error(
              `Rate limiter [${this.name}] wait timeout (${this.maxWaitMs}ms).`
            )
          );
        }, this.maxWaitMs),
      };

      this.queue.push(entry);
      log.debug(`Rate limiter [${this.name}]: request queued, ${this.queue.length} in queue`);
      this.scheduleDrain();
    });
    const ms = performance.now() - t0;
    perfLog('rate-limiter', `${this.name}-acquire-waited`, ms, { queued: true, queueLen: this.queue.length });
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;

    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsedSeconds * this.refillRate
    );
    this.lastRefillMs = now;
  }

  private drainQueue(): void {
    this.nextDrainTimer = null;
    this.refillTokens();

    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const entry = this.queue.shift();
      if (!entry) break;
      clearTimeout(entry.timeout);
      entry.resolve();
    }

    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }

  private scheduleDrain(): void {
    if (this.nextDrainTimer || this.queue.length === 0) return;

    this.refillTokens();
    if (this.tokens >= 1) {
      this.drainQueue();
      return;
    }

    const msUntilToken = Math.max(
      1,
      Math.ceil(((1 - this.tokens) / this.refillRate) * 1000)
    );
    this.nextDrainTimer = setTimeout(() => this.drainQueue(), msUntilToken);
  }
}
