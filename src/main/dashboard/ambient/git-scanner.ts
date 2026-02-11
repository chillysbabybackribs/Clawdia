import { spawn } from 'child_process';
import { createLogger } from '../../logger';
import type { ProjectActivity } from './filesystem-scan';

const log = createLogger('ambient-git');

const GIT_TIMEOUT_MS = 5_000;

export interface GitCommitInfo {
  message: string;
  timestampMs: number;
}

export interface GitRepoStatus {
  name: string;
  fullPath: string;
  branch: string;
  uncommittedCount: number;
  stagedCount: number;
  unpushedCount: number;
  lastCommitMessage: string;
  lastCommitTimestampMs: number;
  hoursSinceLastCommit: number;
  recentCommits: GitCommitInfo[];
}

export interface GitScanResult {
  repos: GitRepoStatus[];
  scanDurationMs: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gitExec(repoPath: string, args: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    const proc = spawn('git', ['-C', repoPath, ...args.split(' ').filter(a => a.length > 0)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    });
    proc.stdout!.on('data', d => stdout += d.toString());
    proc.on('close', () => resolve(stdout.trim() || null));
    proc.on('error', () => resolve(null));
  });
}

async function scanRepo(project: ProjectActivity): Promise<GitRepoStatus | null> {
  const dir = project.fullPath;

  // Branch name
  const branch = (await gitExec(dir, 'rev-parse --abbrev-ref HEAD')) || 'unknown';

  // Uncommitted changes (working tree + staged combined from porcelain)
  const statusRaw = await gitExec(dir, 'status --porcelain');
  let uncommittedCount = 0;
  let stagedCount = 0;
  if (statusRaw) {
    const lines = statusRaw.split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      uncommittedCount++;
      // First char is index status — non-space/? means staged
      const indexChar = line[0];
      if (indexChar !== ' ' && indexChar !== '?') {
        stagedCount++;
      }
    }
  }

  // Unpushed commits — fails gracefully if no upstream
  let unpushedCount = 0;
  const unpushedRaw = await gitExec(dir, 'rev-list @{u}..HEAD --count');
  if (unpushedRaw !== null) {
    const n = parseInt(unpushedRaw, 10);
    if (isFinite(n)) unpushedCount = n;
  }

  // Last commit info
  const lastLogRaw = await gitExec(dir, 'log -1 --format=%s%n%ct');
  let lastCommitMessage = '';
  let lastCommitTimestampMs = 0;
  if (lastLogRaw) {
    const parts = lastLogRaw.split('\n');
    if (parts.length >= 2) {
      lastCommitMessage = parts[0];
      const epoch = parseInt(parts[1], 10);
      if (isFinite(epoch)) lastCommitTimestampMs = epoch * 1000;
    }
  }

  const hoursSinceLastCommit = lastCommitTimestampMs > 0
    ? Math.round((Date.now() - lastCommitTimestampMs) / (1000 * 60 * 60) * 10) / 10
    : -1;

  // Recent 5 commits
  const recentRaw = await gitExec(dir, 'log -5 --format=%s|||%ct');
  const recentCommits: GitCommitInfo[] = [];
  if (recentRaw) {
    for (const line of recentRaw.split('\n')) {
      const sep = line.lastIndexOf('|||');
      if (sep === -1) continue;
      const message = line.slice(0, sep);
      const epoch = parseInt(line.slice(sep + 3), 10);
      if (message && isFinite(epoch)) {
        recentCommits.push({ message, timestampMs: epoch * 1000 });
      }
    }
  }

  return {
    name: project.name,
    fullPath: dir,
    branch,
    uncommittedCount,
    stagedCount,
    unpushedCount,
    lastCommitMessage,
    lastCommitTimestampMs,
    hoursSinceLastCommit,
    recentCommits,
  };
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export async function scanGitRepos(projects: ProjectActivity[]): Promise<GitScanResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const repos: GitRepoStatus[] = [];

  const gitProjects = projects.filter(p => p.hasGit);
  log.info(`[Ambient:Git] Scanning ${gitProjects.length} git repos out of ${projects.length} projects`);

  const results = await Promise.allSettled(gitProjects.map(p => scanRepo(p)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) {
      repos.push(r.value);
    } else if (r.status === 'rejected') {
      errors.push(`${gitProjects[i].name}: ${r.reason?.message || r.reason}`);
    }
  }

  const elapsed = Date.now() - t0;
  log.info(`[Ambient:Git] Scan complete in ${elapsed}ms — ${repos.length} repos (${errors.length} errors)`);
  for (const r of repos.slice(0, 8)) {
    log.info(`[Ambient:Git]   ${r.name}: branch=${r.branch} uncommitted=${r.uncommittedCount} staged=${r.stagedCount} unpushed=${r.unpushedCount} lastCommit="${r.lastCommitMessage.slice(0, 50)}" ${r.hoursSinceLastCommit}h ago`);
  }

  return { repos, scanDurationMs: elapsed, errors };
}

/**
 * Format git scan results as a compact string for injection into the Haiku prompt.
 * Max ~500 chars.
 */
export function formatGitActivity(result: GitScanResult): string {
  if (result.repos.length === 0) return '';

  const lines = result.repos.slice(0, 6).map(r => {
    const parts = [`${r.name}/${r.branch}`];
    if (r.uncommittedCount > 0) parts.push(`${r.uncommittedCount}uncommitted`);
    if (r.stagedCount > 0) parts.push(`${r.stagedCount}staged`);
    if (r.unpushedCount > 0) parts.push(`${r.unpushedCount}unpushed`);
    if (r.hoursSinceLastCommit >= 0) parts.push(`${r.hoursSinceLastCommit}h`);
    if (r.lastCommitMessage) parts.push(`"${r.lastCommitMessage.slice(0, 40)}"`);
    return parts.join(' ');
  });

  const block = `<git_activity>\n${lines.join('\n')}\n</git_activity>`;
  return block.slice(0, 500);
}
