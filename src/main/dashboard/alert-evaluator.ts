import type { SystemMetrics, DashboardAlert } from '../../shared/dashboard-types';
import { createLogger } from '../logger';

const log = createLogger('alert-evaluator');

const DISMISS_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const MAX_VISIBLE_ALERTS = 2;

// Track consecutive critical states to debounce CPU alerts
const consecutivePolls = new Map<string, number>();

// Persistent state across evaluations
const dismissedAlerts = new Map<string, number>(); // alertId → dismiss timestamp

export function evaluateAlerts(metrics: SystemMetrics): DashboardAlert[] {
  const now = Date.now();
  const alerts: DashboardAlert[] = [];

  // --- CPU ---
  const cpuPercent = metrics.cpu.usagePercent;
  const cpuId = 'alert-cpu';
  if (cpuPercent > 90) {
    const count = (consecutivePolls.get(cpuId) || 0) + 1;
    consecutivePolls.set(cpuId, count);

    if (count >= 2 && !isDismissed(cpuId, now)) {
      const topProc = metrics.topProcesses[0];
      const procInfo = topProc ? ` — ${topProc.name} using ${topProc.cpu.toFixed(0)}%` : '';
      alerts.push({
        id: cpuId,
        metric: 'cpu',
        severity: 'critical',
        message: `CPU at ${cpuPercent}%${procInfo}`,
        actionLabel: 'Show processes',
        action: 'Show me the top CPU consuming processes and help me fix it',
      });
    }
  } else {
    consecutivePolls.set(cpuId, 0);
  }

  // --- RAM ---
  const ramPercent = metrics.memory.usagePercent;
  const ramId = 'alert-ram';
  if (ramPercent > 85 && !isDismissed(ramId, now)) {
    // RAM often spikes, so maybe check top process
    // Find top memory process
    const topMemProc = metrics.topProcesses.sort((a, b) => b.mem - a.mem)[0];
    const procInfo = topMemProc ? ` — ${topMemProc.name} using ${(topMemProc.mem / 1024).toFixed(1)}GB` : '';

    alerts.push({
      id: ramId,
      metric: 'ram',
      severity: 'critical',
      message: `Memory at ${ramPercent}%${procInfo}`,
      actionLabel: 'Show processes',
      action: 'Show me the top memory consuming processes',
    });
  }

  // --- Disk ---
  const diskPercent = metrics.disk.usagePercent;
  const diskId = 'alert-disk';
  if (diskPercent > 90 && !isDismissed(diskId, now)) {
    const freeGB = (metrics.disk.totalGB - metrics.disk.usedGB).toFixed(1);
    alerts.push({
      id: diskId,
      metric: 'disk',
      severity: 'critical',
      message: `Disk at ${diskPercent}% — ${freeGB}GB free`,
      actionLabel: 'Find large files',
      action: 'Find large files on my disk that I can delete',
    });
  }

  // --- Battery ---
  if (metrics.battery) {
    const battPercent = metrics.battery.percent;
    const battId = 'alert-battery';
    if (battPercent < 15 && !metrics.battery.charging && !isDismissed(battId, now)) {
      alerts.push({
        id: battId,
        metric: 'battery',
        severity: 'warning',
        message: `Battery at ${battPercent}% — not charging`,
        // No action for battery usually
      });
    }
  }

  // Sort: Critical first, max 2
  alerts.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
  const result = alerts.slice(0, MAX_VISIBLE_ALERTS);

  if (result.length > 0) {
    log.info(`[AlertEval] ${result.length} alerts active: ${result.map(a => a.id).join(', ')}`);
  }

  return result;
}

function isDismissed(id: string, now: number): boolean {
  const dismissedAt = dismissedAlerts.get(id);
  if (dismissedAt && (now - dismissedAt) < DISMISS_COOLDOWN_MS) {
    return true;
  }
  return false;
}

export function dismissAlert(alertId: string): void {
  dismissedAlerts.set(alertId, Date.now());
  log.info(`[AlertEval] Dismissed ${alertId}`);
}
