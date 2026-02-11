export { scanFilesystemActivity, formatProjectActivity } from './filesystem-scan';
export type { ProjectActivity, FilesystemScanResult } from './filesystem-scan';

export { scanGitRepos, formatGitActivity } from './git-scanner';
export type { GitRepoStatus, GitScanResult, GitCommitInfo } from './git-scanner';

export { scanBrowserHistory, formatBrowserActivity } from './browser-history';
export type { DomainVisit, PageVisit, BrowserHistoryResult } from './browser-history';

export { scanShellHistory, formatShellActivity } from './shell-history';
export type { ShellCommand, ShellHistoryResult } from './shell-history';

export { scanRecentFiles, formatRecentFiles } from './recent-files';
export type { RecentFile, RecentFilesResult } from './recent-files';

export { isSensitiveDomain, filterSensitiveDomains } from './privacy-filter';

import { homedir } from 'os';
import { createLogger } from '../../logger';
import { scanFilesystemActivity, formatProjectActivity } from './filesystem-scan';
import type { ProjectActivity, FilesystemScanResult } from './filesystem-scan';
import { scanGitRepos, formatGitActivity } from './git-scanner';
import type { GitRepoStatus, GitScanResult } from './git-scanner';
import { scanBrowserHistory, formatBrowserActivity } from './browser-history';
import type { BrowserHistoryResult } from './browser-history';
import { scanShellHistory, formatShellActivity } from './shell-history';
import type { ShellHistoryResult } from './shell-history';
import { scanRecentFiles, formatRecentFiles } from './recent-files';
import type { RecentFilesResult } from './recent-files';
import { withSoftTimeout } from '../../utils/timeout';
import { store, DEFAULT_AMBIENT_SETTINGS, type AmbientSettings } from '../../store';

const log = createLogger('ambient');

const BROWSER_HISTORY_TIMEOUT_MS = 1000;
const SHELL_HISTORY_TIMEOUT_MS = 200;
const RECENT_FILES_TIMEOUT_MS = 200;

export interface AmbientContext {
  projectActivity: string;
  gitActivity: string;
  browserActivity: string;
  shellActivity: string;
  recentFilesActivity: string;
  combined: string;
}

// ---------------------------------------------------------------------------
// Raw structured ambient data (for state-builder)
// ---------------------------------------------------------------------------

export interface AmbientData {
  projects: ProjectActivity[];
  gitRepos: GitRepoStatus[];
  browserHistory: BrowserHistoryResult | null;
  shellHistory: ShellHistoryResult | null;
  recentFiles: RecentFilesResult | null;
}

function getAmbientSettings(): AmbientSettings {
  return (store.get('ambientSettings') as AmbientSettings | undefined) ?? { ...DEFAULT_AMBIENT_SETTINGS };
}

/**
 * Collect raw structured ambient data. Same parallel execution as
 * collectAmbientContext() but preserves original objects instead of
 * formatting to strings. Respects ambient settings toggles.
 */
export async function collectAmbientData(): Promise<AmbientData> {
  const settings = getAmbientSettings();

  if (!settings.enabled) {
    log.info('[Ambient] Master toggle off — skipping all collection');
    return { projects: [], gitRepos: [], browserHistory: null, shellHistory: null, recentFiles: null };
  }

  const [fsResult, browserResult, shellResult, filesResult] = await Promise.allSettled([
    settings.filesystemScan
      ? scanFilesystemActivity(settings.scanRoots)
      : Promise.resolve({ projects: [], scanDurationMs: 0, errors: [] } as FilesystemScanResult),
    settings.browserHistory
      ? withSoftTimeout(scanBrowserHistory(), BROWSER_HISTORY_TIMEOUT_MS, 'browser-history')
      : Promise.resolve(null),
    settings.shellHistory
      ? withSoftTimeout(Promise.resolve(scanShellHistory()), SHELL_HISTORY_TIMEOUT_MS, 'shell-history')
      : Promise.resolve(null),
    settings.recentFiles
      ? withSoftTimeout(Promise.resolve(scanRecentFiles()), RECENT_FILES_TIMEOUT_MS, 'recent-files')
      : Promise.resolve(null),
  ]);

  let projects: ProjectActivity[] = [];
  let gitRepos: GitRepoStatus[] = [];
  if (fsResult.status === 'fulfilled') {
    projects = fsResult.value?.projects ?? [];
    if (settings.gitScan && projects.length > 0) {
      const gitScan = await scanGitRepos(projects);
      gitRepos = gitScan.repos;
    }
  } else {
    log.warn(`[Ambient] Filesystem scan failed: ${fsResult.reason}`);
  }

  const browserHistory = (browserResult.status === 'fulfilled' ? browserResult.value : null) ?? null;
  const shellHistory = (shellResult.status === 'fulfilled' ? shellResult.value : null) ?? null;
  const recentFiles = (filesResult.status === 'fulfilled' ? filesResult.value : null) ?? null;

  log.info(`[Ambient] Raw data collected: ${projects.length} projects, ${gitRepos.length} git repos, browser=${!!browserHistory}, shell=${!!shellHistory}, files=${!!recentFiles}`);

  return { projects, gitRepos, browserHistory, shellHistory, recentFiles };
}

/**
 * Collect all ambient data sources as formatted strings (legacy).
 * Respects ambient settings toggles.
 */
export async function collectAmbientContext(): Promise<AmbientContext> {
  const settings = getAmbientSettings();
  const empty: AmbientContext = { projectActivity: '', gitActivity: '', browserActivity: '', shellActivity: '', recentFilesActivity: '', combined: '' };

  if (!settings.enabled) {
    log.info('[Ambient] Master toggle off — skipping all context collection');
    return empty;
  }

  const [fsResult, browserResult, shellResult, filesResult] = await Promise.allSettled([
    settings.filesystemScan
      ? scanFilesystemActivity(settings.scanRoots)
      : Promise.resolve({ projects: [], scanDurationMs: 0, errors: [] } as FilesystemScanResult),
    settings.browserHistory
      ? withSoftTimeout(scanBrowserHistory(), BROWSER_HISTORY_TIMEOUT_MS, 'browser-history')
      : Promise.resolve(null),
    settings.shellHistory
      ? withSoftTimeout(Promise.resolve(scanShellHistory()), SHELL_HISTORY_TIMEOUT_MS, 'shell-history')
      : Promise.resolve(null),
    settings.recentFiles
      ? withSoftTimeout(Promise.resolve(scanRecentFiles()), RECENT_FILES_TIMEOUT_MS, 'recent-files')
      : Promise.resolve(null),
  ]);

  let projectActivity = '';
  let gitActivity = '';
  if (fsResult.status === 'fulfilled') {
    const fsScan = fsResult.value;
    if (fsScan) {
      projectActivity = formatProjectActivity(fsScan);
      if (settings.gitScan) {
        const gitScan = await scanGitRepos(fsScan.projects);
        gitActivity = formatGitActivity(gitScan);
      }
    }
  } else {
    log.warn(`[Ambient] Filesystem scan failed: ${fsResult.reason}`);
  }

  let browserActivity = '';
  if (browserResult.status === 'fulfilled' && browserResult.value) {
    browserActivity = formatBrowserActivity(browserResult.value);
  } else if (browserResult.status === 'rejected') {
    log.warn(`[Ambient] Browser history scan failed: ${browserResult.reason}`);
  }

  let shellActivity = '';
  if (shellResult.status === 'fulfilled' && shellResult.value) {
    shellActivity = formatShellActivity(shellResult.value);
  } else if (shellResult.status === 'rejected') {
    log.warn(`[Ambient] Shell history scan failed: ${shellResult.reason}`);
  }

  let recentFilesActivity = '';
  if (filesResult.status === 'fulfilled' && filesResult.value) {
    recentFilesActivity = formatRecentFiles(filesResult.value);
  } else if (filesResult.status === 'rejected') {
    log.warn(`[Ambient] Recent files scan failed: ${filesResult.reason}`);
  }

  const parts = [projectActivity, gitActivity, browserActivity, shellActivity, recentFilesActivity].filter(Boolean);
  const combined = parts.join('\n');

  log.info(`[Ambient] Context collected: fs=${projectActivity.length}chars git=${gitActivity.length}chars browser=${browserActivity.length}chars shell=${shellActivity.length}chars files=${recentFilesActivity.length}chars total=${combined.length}chars`);

  return { projectActivity, gitActivity, browserActivity, shellActivity, recentFilesActivity, combined };
}

// ---------------------------------------------------------------------------
// Compact summary for LLM system prompt injection (~200-400 chars)
// ---------------------------------------------------------------------------

/**
 * Build a compact, token-efficient summary of the ambient environment data
 * suitable for injection into the LLM system prompt.
 *
 * Output format:
 * ```
 * ENVIRONMENT:
 * Projects: clawdia (~/Desktop/clawdia, 3 uncommitted, main), my-app (clean, feat/xyz)
 * Shell: npm, git, docker frequent | Last dir: ~/Desktop/clawdia
 * Browser: github.com (45), stackoverflow.com (12), docs.anthropic.com (8)
 * ```
 */
export function formatCompactSummary(data: AmbientData): string {
  const lines: string[] = ['ENVIRONMENT:'];
  const home = homedir();
  const shorten = (p: string) => p.startsWith(home) ? '~' + p.slice(home.length) : p;

  // Projects + Git (top 3)
  if (data.projects.length > 0 || data.gitRepos.length > 0) {
    const gitMap = new Map<string, GitRepoStatus>();
    for (const repo of data.gitRepos) {
      gitMap.set(repo.fullPath, repo);
    }

    const projectParts: string[] = [];
    const projects = data.projects.slice(0, 3);
    for (const proj of projects) {
      const git = gitMap.get(proj.fullPath);
      const parts: string[] = [shorten(proj.fullPath)];
      if (git) {
        if (git.uncommittedCount > 0) parts.push(`${git.uncommittedCount} uncommitted`);
        else parts.push('clean');
        parts.push(git.branch);
      }
      projectParts.push(`${proj.name} (${parts.join(', ')})`);
    }
    if (projectParts.length > 0) {
      lines.push(`Projects: ${projectParts.join(', ')}`);
    }
  }

  // Shell (top prefixes + last working dir)
  if (data.shellHistory) {
    const sh = data.shellHistory;
    const prefixes = sh.topPrefixes.slice(0, 5).map(p => p.prefix).join(', ');
    const lastDir = sh.workingDirs.length > 0 ? shorten(sh.workingDirs[0]) : '';
    const shellParts: string[] = [];
    if (prefixes) shellParts.push(`${prefixes} frequent`);
    if (lastDir) shellParts.push(`Last dir: ${lastDir}`);
    if (shellParts.length > 0) {
      lines.push(`Shell: ${shellParts.join(' | ')}`);
    }
  }

  // Browser (top 5 domains)
  if (data.browserHistory && data.browserHistory.topDomains.length > 0) {
    const domains = data.browserHistory.topDomains.slice(0, 5)
      .map(d => `${d.domain} (${d.visitCount})`)
      .join(', ');
    lines.push(`Browser: ${domains}`);
  }

  // Only return if we have more than just the header
  if (lines.length <= 1) return '';
  return lines.join('\n');
}
