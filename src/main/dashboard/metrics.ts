import { execSync } from 'child_process';
import * as dns from 'dns';
import type { SystemMetrics, ExtendedMetrics } from '../../shared/dashboard-types';
import { createLogger } from '../logger';

const log = createLogger('dashboard-metrics');

export type { SystemMetrics, ExtendedMetrics };

const APP_START = Date.now();
let previousCpuPercent: number | null = null;

const EMPTY_METRICS: SystemMetrics = {
  cpu: { usagePercent: 0, cores: 1 },
  memory: { totalMB: 0, usedMB: 0, usagePercent: 0 },
  disk: { totalGB: 0, usedGB: 0, usagePercent: 0, mountPoint: '/' },
  battery: null,
  topProcesses: [],
  uptime: 'unknown',
};

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function getCpu(): SystemMetrics['cpu'] {
  const cores = parseInt(exec('nproc'), 10) || 1;
  // /proc/stat gives cumulative CPU ticks — take a 200ms sample
  const raw1 = exec("head -1 /proc/stat");
  if (!raw1) return { usagePercent: 0, cores };

  const parse = (line: string) => {
    const parts = line.replace(/^cpu\s+/, '').split(/\s+/).map(Number);
    const idle = parts[3] || 0;
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };

  const s1 = parse(raw1);
  exec('sleep 0.2');
  const raw2 = exec("head -1 /proc/stat");
  if (!raw2) return { usagePercent: 0, cores };
  const s2 = parse(raw2);

  const dTotal = s2.total - s1.total;
  const dIdle = s2.idle - s1.idle;
  const usagePercent = dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 100) : 0;

  return { usagePercent, cores };
}

function getMemory(): SystemMetrics['memory'] {
  const raw = exec('free -m');
  if (!raw) return { totalMB: 0, usedMB: 0, usagePercent: 0 };

  const memLine = raw.split('\n').find(l => l.startsWith('Mem:'));
  if (!memLine) return { totalMB: 0, usedMB: 0, usagePercent: 0 };

  const parts = memLine.split(/\s+/);
  const totalMB = parseInt(parts[1], 10) || 0;
  const usedMB = parseInt(parts[2], 10) || 0;
  const usagePercent = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

  return { totalMB, usedMB, usagePercent };
}

function getDisk(): SystemMetrics['disk'] {
  const raw = exec("df -BG / | tail -1");
  if (!raw) return { totalGB: 0, usedGB: 0, usagePercent: 0, mountPoint: '/' };

  const parts = raw.split(/\s+/);
  const totalGB = parseInt(parts[1], 10) || 0;
  const usedGB = parseInt(parts[2], 10) || 0;
  const usagePercent = parseInt(parts[4], 10) || 0;
  const mountPoint = parts[5] || '/';

  return { totalGB, usedGB, usagePercent, mountPoint };
}

function getBattery(): SystemMetrics['battery'] {
  const capacityRaw = exec('cat /sys/class/power_supply/BAT0/capacity 2>/dev/null || cat /sys/class/power_supply/BAT1/capacity 2>/dev/null');
  if (!capacityRaw) return null;

  const percent = parseInt(capacityRaw, 10);
  if (isNaN(percent)) return null;

  const statusRaw = exec('cat /sys/class/power_supply/BAT0/status 2>/dev/null || cat /sys/class/power_supply/BAT1/status 2>/dev/null');
  const charging = statusRaw.toLowerCase() === 'charging' || statusRaw.toLowerCase() === 'full';

  return { percent, charging };
}

function getTopProcesses(): SystemMetrics['topProcesses'] {
  const raw = exec("ps aux --sort=-%cpu | head -6 | tail -5");
  if (!raw) return [];

  return raw.split('\n').map(line => {
    const parts = line.split(/\s+/);
    const cpu = parseFloat(parts[2]) || 0;
    const mem = parseFloat(parts[3]) || 0;
    const name = parts.slice(10).join(' ').split('/').pop()?.split(' ')[0] || parts[10] || 'unknown';
    return { name, cpu, mem };
  }).filter(p => p.cpu > 0 || p.mem > 0);
}

function getUptime(): string {
  const raw = exec('uptime -p');
  return raw.replace(/^up\s+/, '') || 'unknown';
}

export function collectMetrics(): SystemMetrics {
  if (process.platform !== 'linux') {
    log.warn('Metrics collection only supported on Linux');
    return { ...EMPTY_METRICS };
  }

  const start = Date.now();
  const metrics: SystemMetrics = {
    cpu: getCpu(),
    memory: getMemory(),
    disk: getDisk(),
    battery: getBattery(),
    topProcesses: getTopProcesses(),
    uptime: getUptime(),
  };
  log.debug(`Metrics collected in ${Date.now() - start}ms`);
  return metrics;
}

// ---------------------------------------------------------------------------
// Extended metrics for executor context
// ---------------------------------------------------------------------------

function getNetworkUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 3000);
    dns.resolve('dns.google', (err) => {
      clearTimeout(timeout);
      resolve(!err);
    });
  });
}

function getProcessCount(): number {
  const raw = exec('ps -e --no-headers | wc -l');
  return parseInt(raw, 10) || 0;
}

function getGitMetrics(dir?: string): { uncommitted: number | null; hoursSinceCommit: number | null } {
  const cwd = dir || process.cwd();
  try {
    // Check if inside a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { uncommitted: null, hoursSinceCommit: null };
  }

  let uncommitted: number | null = null;
  try {
    const raw = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    uncommitted = raw ? raw.split('\n').length : 0;
  } catch {
    uncommitted = null;
  }

  let hoursSinceCommit: number | null = null;
  try {
    const raw = execSync('git log -1 --format=%ct', { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const ts = parseInt(raw, 10);
    if (!isNaN(ts)) {
      hoursSinceCommit = Math.round((Date.now() / 1000 - ts) / 3600 * 10) / 10;
    }
  } catch {
    hoursSinceCommit = null;
  }

  return { uncommitted, hoursSinceCommit };
}

function getActiveProject(): string | null {
  try {
    const raw = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!raw) return null;
    // Return just the directory name
    return raw.split('/').pop() || null;
  } catch {
    return null;
  }
}

export interface ExtendedMetricsOpts {
  lastMessageGetter: () => number | null;
}

export async function collectExtendedMetrics(opts: ExtendedMetricsOpts): Promise<ExtendedMetrics> {
  const base = collectMetrics();

  const cpuDelta = previousCpuPercent !== null
    ? base.cpu.usagePercent - previousCpuPercent
    : 0;
  previousCpuPercent = base.cpu.usagePercent;

  const now = new Date();
  // JS: 0=Sunday..6=Saturday → convert to 0=Monday..6=Sunday
  const jsDay = now.getDay();
  const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;

  const lastMsg = opts.lastMessageGetter();
  const minutesSinceLastMessage = lastMsg !== null
    ? Math.round((Date.now() - lastMsg) / 60_000)
    : -1;

  const [networkUp, gitMetrics] = await Promise.all([
    getNetworkUp(),
    Promise.resolve(getGitMetrics()),
  ]);

  return {
    ...base,
    cpu_delta: cpuDelta,
    network_up: networkUp,
    process_count: getProcessCount(),
    hour: now.getHours(),
    day_of_week: dayOfWeek,
    session_duration_minutes: Math.round((Date.now() - APP_START) / 60_000),
    minutes_since_last_message: minutesSinceLastMessage,
    active_project: getActiveProject(),
    git_uncommitted_changes: gitMetrics.uncommitted,
    git_hours_since_last_commit: gitMetrics.hoursSinceCommit,
  };
}

/**
 * Flatten ExtendedMetrics into a flat key-value context for condition evaluation.
 */
export function buildMetricContext(m: ExtendedMetrics): Record<string, number | boolean | string | null> {
  return {
    cpu_percent: m.cpu.usagePercent,
    cpu_cores: m.cpu.cores,
    ram_percent: m.memory.usagePercent,
    ram_used_mb: m.memory.usedMB,
    ram_total_mb: m.memory.totalMB,
    disk_percent: m.disk.usagePercent,
    disk_used_gb: m.disk.usedGB,
    disk_total_gb: m.disk.totalGB,
    battery_percent: m.battery?.percent ?? null,
    battery_charging: m.battery?.charging ?? null,
    top_process_name: m.topProcesses[0]?.name ?? null,
    top_process_cpu: m.topProcesses[0]?.cpu ?? null,
    top_process_ram_mb: m.topProcesses[0]?.mem ?? null,
    cpu_delta: m.cpu_delta,
    network_up: m.network_up,
    process_count: m.process_count,
    hour: m.hour,
    day_of_week: m.day_of_week,
    session_duration_minutes: m.session_duration_minutes,
    minutes_since_last_message: m.minutes_since_last_message,
    active_project: m.active_project,
    git_uncommitted_changes: m.git_uncommitted_changes,
    git_hours_since_last_commit: m.git_hours_since_last_commit,
  };
}
