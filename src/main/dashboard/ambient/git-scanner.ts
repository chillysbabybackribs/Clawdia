import { execSync } from 'child_process';
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

function gitExec(repoPath: string, args: string): string | null {
  try {
    return execSync(`git -C ${JSON.stringify(repoPath)} ${args}`, {
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function scanRepo(project: ProjectActivity): GitRepoStatus | null {
  const dir = project.fullPath;

  // Branch name
  const branch = gitExec(dir, 'rev-parse --abbrev-ref HEAD') || 'unknown';

  // Uncommitted changes (working tree + staged combined from porcelain)
  const statusRaw = gitExec(dir, 'status --porcelain');
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
  const unpushedRaw = gitExec(dir, 'rev-list @{u}..HEAD --count 2>/dev/null');
  if (unpushedRaw !== null) {
    const n = parseInt(unpushedRaw, 10);
    if (isFinite(n)) unpushedCount = n;
  }

  // Last commit info
  const lastLogRaw = gitExec(dir, 'log -1 --format=%s%n%ct');
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
  const recentRaw = gitExec(dir, 'log -5 --format=%s|||%ct');
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

export function scanGitRepos(projects: ProjectActivity[]): GitScanResult {
  const t0 = Date.now();
  const errors: string[] = [];
  const repos: GitRepoStatus[] = [];

  const gitProjects = projects.filter(p => p.hasGit);
  log.info(`[Ambient:Git] Scanning ${gitProjects.length} git repos out of ${projects.length} projects`);

  for (const project of gitProjects) {
    try {
      const status = scanRepo(project);
      if (status) repos.push(status);
    } catch (err: any) {
      errors.push(`${project.name}: ${err?.message || err}`);
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
