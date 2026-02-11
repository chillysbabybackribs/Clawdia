import { collectExtendedMetrics, buildMetricContext } from './metrics';
import { evaluateAlerts, dismissAlert as dismissAlertImpl } from './alert-evaluator';
import { buildProjectCards, buildActivityFeed } from './state-builder';
import { getModelLabel, getModelConfig } from '../../shared/models';
import { createLogger } from '../logger';
import type { AmbientData } from './ambient';
import type {
  DashboardProjectCard,
  DashboardActivityItem,
  DashboardAlert,
  DashboardState,
  StaticDashboardState,
  TaskDashboardItem,
  ToolStatusIndicator,
  ToolStatusLevel,
  PollingTier,
  ExtendedMetrics,
  HaikuDashboardResponse,
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
  getTaskDashboardItems?: () => TaskDashboardItem[];
  getTaskUnreadCount?: () => number;
}

export class DashboardExecutor {
  // Data-driven state (replaces rules)
  private projectCards: DashboardProjectCard[] = [];
  private activityFeed: DashboardActivityItem[] = [];
  private patternNote?: string;

  private currentTier: PollingTier = 'IDLE';
  private consecutiveCalm = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private dashboardVisible = false;
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

  /**
   * Feed raw ambient data + optional Haiku response.
   * Replaces the old setRules() — builds project cards & activity feed.
   */
  setAmbientData(data: AmbientData, haiku: HaikuDashboardResponse | null): void {
    this.projectCards = buildProjectCards(data, haiku);
    this.activityFeed = buildActivityFeed(data);
    this.patternNote = haiku?.pattern_note;

    log.info(`[Dashboard] Ambient data set: ${this.projectCards.length} cards, ${this.activityFeed.length} feed items, note=${!!this.patternNote} — triggering immediate poll`);
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
      const state = this.getCurrentState();
      if (state && this.emitUpdate) {
        this.emitUpdate(state);
      }
    }
  }

  dismissAlert(alertId: string): void {
    dismissAlertImpl(alertId);
  }

  addTokenUsage(data: TokenUsageData): void {
    this.sessionInputTokens += data.inputTokens || 0;
    this.sessionOutputTokens += data.outputTokens || 0;
    this.sessionCacheRead += data.cacheReadTokens || 0;
    this.sessionCacheCreate += data.cacheCreateTokens || 0;
  }

  getCurrentState(): DashboardState | null {
    const staticLayer = this.buildStaticLayer();
    const tasks = this.deps.getTaskDashboardItems?.() ?? [];
    const taskUnreadCount = this.deps.getTaskUnreadCount?.() ?? 0;
    const metrics = this.lastMetrics || null;
    if (!metrics) {
      return {
        projects: this.projectCards,
        activityFeed: this.activityFeed,
        alerts: [],
        tasks,
        taskUnreadCount,
        patternNote: this.patternNote,
        static: staticLayer,
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

    const alerts = evaluateAlerts(metrics);
    return {
      projects: this.projectCards,
      activityFeed: this.activityFeed,
      alerts,
      tasks,
      taskUnreadCount,
      patternNote: this.patternNote,
      static: staticLayer,
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
    log.info(`[Dashboard] Poll: tier=${this.currentTier} cpu=${context.cpu_percent}% ram=${context.ram_percent}% disk=${context.disk_percent}% visible=${this.dashboardVisible}`);
    this.updateTier(context);

    const alerts = evaluateAlerts(metrics);

    if (this.dashboardVisible && this.emitUpdate) {
      const tasks = this.deps.getTaskDashboardItems?.() ?? [];
      const taskUnreadCount = this.deps.getTaskUnreadCount?.() ?? 0;
      const state: DashboardState = {
        projects: this.projectCards,
        activityFeed: this.activityFeed,
        alerts,
        tasks,
        taskUnreadCount,
        patternNote: this.patternNote,
        static: this.buildStaticLayer(),
        metrics,
        generatedAt: Date.now(),
        pollingTier: this.currentTier,
      };
      this.emitUpdate(state);
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

  private buildStaticLayer(): StaticDashboardState {
    const modelId = this.deps.getSelectedModel();
    const activeModel = getModelLabel(modelId);

    const config = getModelConfig(modelId);
    let sessionCost = '$0.00';
    if (config) {
      const inputCost = (this.sessionInputTokens / 1_000_000) * config.inputCostPerMTok;
      const outputCost = (this.sessionOutputTokens / 1_000_000) * config.outputCostPerMTok;
      const cacheReadCost = (this.sessionCacheRead / 1_000_000) * config.cacheReadCostPerMTok;
      const total = inputCost + outputCost + cacheReadCost;
      sessionCost = total < 0.01 ? '$0.00' : `$${total.toFixed(2)}`;
    }

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
