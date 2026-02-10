import { collectExtendedMetrics, buildMetricContext } from './metrics';
import { evaluateCondition } from './condition-parser';
import { getModelLabel, getModelConfig } from '../../shared/models';
import { createLogger } from '../logger';
import type {
  DashboardRule,
  DashboardSuggestion,
  DashboardState,
  StaticDashboardState,
  ToolStatusIndicator,
  ToolStatusLevel,
  PollingTier,
  ExtendedMetrics,
} from '../../shared/dashboard-types';

const log = createLogger('dashboard-executor');

// Polling intervals per tier (ms)
const TIER_INTERVALS: Record<PollingTier, number> = {
  IDLE: 5 * 60 * 1000,     // 5 minutes
  ELEVATED: 90 * 1000,      // 90 seconds
  ALERT: 30 * 1000,         // 30 seconds
};

// Tier thresholds
const SOFT_THRESHOLDS = { cpu: 70, ram: 75, disk: 85 };
const HARD_THRESHOLDS = { cpu: 90, ram: 90, disk: 95 };
const CALM_POLLS_TO_DOWNGRADE = 3;

interface RuleState {
  lastFired: number;
  fireCount: number;
  dismissed: boolean;
}

interface TokenUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
}

export interface ExecutorDeps {
  getSelectedModel: () => string;
  storeGet: (key: string) => unknown;
  getBrowserStatus: () => { status: ToolStatusLevel; currentUrl: string | null };
  lastMessageGetter: () => number | null;
}

export class DashboardExecutor {
  private rules: DashboardRule[] = [];
  private ruleStates = new Map<string, RuleState>();
  private currentTier: PollingTier = 'IDLE';
  private consecutiveCalm = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private dashboardVisible = false;
  private lastEmittedSuggestions: string = '[]';
  private emitUpdate: ((state: DashboardState) => void) | null = null;
  private lastMetrics: ExtendedMetrics | null = null;
  private stopped = false;

  // Token accumulators for session cost
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private sessionCacheRead = 0;
  private sessionCacheCreate = 0;

  private deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    log.info('[Dashboard] Executor started');
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('[Dashboard] Executor stopped');
  }

  setRules(rules: DashboardRule[]): void {
    this.rules = rules;
    // Initialize states for new rules
    for (const rule of rules) {
      if (!this.ruleStates.has(rule.id)) {
        this.ruleStates.set(rule.id, { lastFired: 0, fireCount: 0, dismissed: false });
      }
    }
    log.info(`[Dashboard] ${rules.length} rules loaded — triggering immediate poll`);
    // Trigger an immediate poll when rules arrive
    if (!this.stopped) {
      this.runPollCycle().catch((err) => log.warn(`[Dashboard] Immediate poll failed: ${err}`));
    }
  }

  setUpdateEmitter(fn: (state: DashboardState) => void): void {
    this.emitUpdate = fn;
  }

  setDashboardVisible(visible: boolean): void {
    this.dashboardVisible = visible;
    if (visible) {
      // Emit cached state immediately when becoming visible
      const state = this.getCurrentState();
      if (state && this.emitUpdate) {
        this.emitUpdate(state);
      }
    }
  }

  dismissRule(ruleId: string): void {
    const state = this.ruleStates.get(ruleId);
    if (state) {
      state.dismissed = true;
    } else {
      this.ruleStates.set(ruleId, { lastFired: 0, fireCount: 0, dismissed: true });
    }
  }

  addTokenUsage(data: TokenUsageData): void {
    this.sessionInputTokens += data.inputTokens || 0;
    this.sessionOutputTokens += data.outputTokens || 0;
    this.sessionCacheRead += data.cacheReadTokens || 0;
    this.sessionCacheCreate += data.cacheCreateTokens || 0;
  }

  getCurrentState(): DashboardState | null {
    const staticLayer = this.buildStaticLayer();
    const metrics = this.lastMetrics || null;
    if (!metrics) {
      // Haven't polled yet — return minimal state
      return {
        static: staticLayer,
        suggestions: [],
        metrics: {
          cpu: { usagePercent: 0, cores: 1 },
          memory: { totalMB: 0, usedMB: 0, usagePercent: 0 },
          disk: { totalGB: 0, usedGB: 0, usagePercent: 0, mountPoint: '/' },
          battery: null,
          topProcesses: [],
          uptime: 'unknown',
        },
        generatedAt: Date.now(),
        pollingTier: this.currentTier,
      };
    }

    const suggestions = this.evaluateRules(metrics);
    return {
      static: staticLayer,
      suggestions,
      metrics,
      generatedAt: Date.now(),
      pollingTier: this.currentTier,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Polling
  // ---------------------------------------------------------------------------

  private schedulePoll(): void {
    if (this.stopped) return;
    const interval = TIER_INTERVALS[this.currentTier];
    this.pollTimer = setTimeout(() => {
      this.runPollCycle()
        .catch((err) => log.warn(`[Dashboard] Poll cycle error: ${err}`))
        .finally(() => this.schedulePoll());
    }, interval);
  }

  private async runPollCycle(): Promise<void> {
    const metrics = await collectExtendedMetrics({
      lastMessageGetter: this.deps.lastMessageGetter,
    });
    this.lastMetrics = metrics;

    const context = buildMetricContext(metrics);
    log.info(`[Dashboard] Poll: tier=${this.currentTier} hour=${context.hour} cpu=${context.cpu_percent}% ram=${context.ram_percent}% disk=${context.disk_percent}% visible=${this.dashboardVisible} rules=${this.rules.length}`);
    this.updateTier(context);

    const suggestions = this.evaluateRules(metrics);
    const suggestionsJson = JSON.stringify(suggestions.map(s => s.text));

    if (suggestionsJson !== this.lastEmittedSuggestions || this.dashboardVisible) {
      this.lastEmittedSuggestions = suggestionsJson;
      const state: DashboardState = {
        static: this.buildStaticLayer(),
        suggestions,
        metrics,
        generatedAt: Date.now(),
        pollingTier: this.currentTier,
      };

      if (this.dashboardVisible && this.emitUpdate) {
        this.emitUpdate(state);
      }
    }
  }

  private updateTier(ctx: Record<string, number | boolean | string | null>): void {
    const cpu = (ctx.cpu_percent as number) || 0;
    const ram = (ctx.ram_percent as number) || 0;
    const disk = (ctx.disk_percent as number) || 0;

    const isHard = cpu > HARD_THRESHOLDS.cpu || ram > HARD_THRESHOLDS.ram || disk > HARD_THRESHOLDS.disk;
    const isSoft = cpu > SOFT_THRESHOLDS.cpu || ram > SOFT_THRESHOLDS.ram || disk > SOFT_THRESHOLDS.disk;

    if (isHard) {
      this.currentTier = 'ALERT';
      this.consecutiveCalm = 0;
    } else if (isSoft) {
      if (this.currentTier === 'ALERT') {
        this.consecutiveCalm++;
        if (this.consecutiveCalm >= CALM_POLLS_TO_DOWNGRADE) {
          this.currentTier = 'ELEVATED';
          this.consecutiveCalm = 0;
        }
      } else {
        this.currentTier = 'ELEVATED';
        this.consecutiveCalm = 0;
      }
    } else {
      this.consecutiveCalm++;
      if (this.consecutiveCalm >= CALM_POLLS_TO_DOWNGRADE) {
        this.currentTier = 'IDLE';
        this.consecutiveCalm = 0;
      }
    }
  }

  private evaluateRules(metrics: ExtendedMetrics): DashboardSuggestion[] {
    const context = buildMetricContext(metrics);
    const now = Date.now();
    const fired: Array<DashboardSuggestion & { priority: number }> = [];

    if (this.rules.length === 0) {
      log.debug('[Dashboard] evaluateRules: no rules loaded yet');
      return [];
    }

    log.info(`[Dashboard] evaluateRules: ${this.rules.length} rules | hour=${context.hour} cpu=${context.cpu_percent}% ram=${context.ram_percent}% disk=${context.disk_percent}%`);

    for (const rule of this.rules) {
      const state = this.ruleStates.get(rule.id);
      if (!state) {
        log.debug(`[Dashboard]   rule="${rule.id}" SKIP: no state entry`);
        continue;
      }
      if (state.dismissed) {
        log.debug(`[Dashboard]   rule="${rule.id}" SKIP: dismissed`);
        continue;
      }
      const cooldownRemaining = (state.lastFired + rule.cooldown_minutes * 60_000) - now;
      if (cooldownRemaining > 0) {
        log.debug(`[Dashboard]   rule="${rule.id}" SKIP: cooldown (${Math.round(cooldownRemaining / 1000)}s left)`);
        continue;
      }

      let matches = false;
      try {
        matches = evaluateCondition(rule.condition, context);
      } catch (err: any) {
        log.warn(`[Dashboard]   rule="${rule.id}" ERROR: ${err?.message} | condition="${rule.condition}"`);
        continue;
      }

      log.info(`[Dashboard]   rule="${rule.id}" condition="${rule.condition}" → ${matches ? 'FIRED' : 'false'}`);

      if (matches) {
        state.lastFired = now;
        state.fireCount++;

        // Resolve {{key}} templates
        let text = rule.suggestion_text;
        text = text.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
          const val = context[key];
          if (val === null || val === undefined) return 'N/A';
          if (typeof val === 'number') return String(Math.round(val * 10) / 10);
          return String(val);
        });

        fired.push({
          text,
          type: rule.type,
          action: rule.action,
          icon: rule.icon,
          ruleId: rule.id,
          priority: rule.priority,
        });
      }
    }

    log.info(`[Dashboard] ${fired.length} rules fired, returning top 2`);
    // Sort by priority (1=highest), take top 2
    fired.sort((a, b) => a.priority - b.priority);
    return fired.slice(0, 2).map(({ priority: _p, ...s }) => s);
  }

  private buildStaticLayer(): StaticDashboardState {
    const modelId = this.deps.getSelectedModel();
    const activeModel = getModelLabel(modelId);
    log.debug(`[Dashboard] buildStaticLayer: modelId="${modelId}" label="${activeModel}"`);

    // Session cost from accumulated tokens
    const config = getModelConfig(modelId);
    let sessionCost = '$0.00';
    if (config) {
      const inputCost = (this.sessionInputTokens / 1_000_000) * config.inputCostPerMTok;
      const outputCost = (this.sessionOutputTokens / 1_000_000) * config.outputCostPerMTok;
      const cacheReadCost = (this.sessionCacheRead / 1_000_000) * config.cacheReadCostPerMTok;
      const total = inputCost + outputCost + cacheReadCost;
      sessionCost = total < 0.01 ? '$0.00' : `$${total.toFixed(2)}`;
    }

    // Tool statuses
    const toolStatuses: ToolStatusIndicator[] = [];

    try {
      const browserStatus = this.deps.getBrowserStatus();
      toolStatuses.push({
        name: 'Browser',
        status: browserStatus.status,
        detail: browserStatus.currentUrl || undefined,
      });
    } catch {
      toolStatuses.push({ name: 'Browser', status: 'ready' });
    }
    toolStatuses.push({ name: 'Terminal', status: 'ready' });
    toolStatuses.push({ name: 'Files', status: 'ready' });

    const uptime = this.lastMetrics?.uptime || 'unknown';

    return { toolStatuses, activeModel, sessionCost, uptime };
  }
}
