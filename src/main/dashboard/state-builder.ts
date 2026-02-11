import * as fs from 'fs';
import type { AmbientData } from './ambient';
import type {
  DashboardProjectCard,
  DashboardActivityItem,
  HaikuDashboardResponse,
} from '../../shared/dashboard-types';
import { createLogger } from '../logger';

const log = createLogger('state-builder');

/** Resolve path to its real absolute form (follows symlinks, normalizes case). */
function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

const BORING_COMMANDS = new Set(['ls', 'cd', 'clear', 'pwd', 'exit', 'history', 'echo', 'cat', 'less', 'man']);

// ---------------------------------------------------------------------------
// Project cards
// ---------------------------------------------------------------------------

export function buildProjectCards(
  data: AmbientData,
  haiku: HaikuDashboardResponse | null,
): DashboardProjectCard[] {
  // Filter projects with heat > 10
  const hot = data.projects.filter(p => p.heatScore > 10);
  if (hot.length === 0) return [];

  // Deduplicate: resolve to real absolute path, keep highest heat score
  const deduped = new Map<string, typeof hot[0]>();
  for (const p of hot) {
    const realPath = safeRealpath(p.fullPath);
    const existing = deduped.get(realPath);
    if (!existing || p.heatScore > existing.heatScore) {
      deduped.set(realPath, { ...p, fullPath: realPath });
    }
  }
  const uniqueProjects = Array.from(deduped.values());

  // Merge git data (also resolve git paths for matching)
  const gitMap = new Map<string, typeof data.gitRepos[0]>();
  for (const g of data.gitRepos) {
    const realGitPath = safeRealpath(g.fullPath);
    gitMap.set(realGitPath, g);
    if (realGitPath !== g.fullPath) gitMap.set(g.fullPath, g);
  }

  // Build ranking: Haiku overrides if available, else sort by heat
  let ranked = uniqueProjects.map(p => {
    const git = gitMap.get(p.fullPath);
    const haikuProject = haiku?.projects.find(hp => p.fullPath.endsWith(hp.path) || p.name === hp.path);
    const rank = haikuProject?.rank ?? (100 - p.heatScore);

    const card: DashboardProjectCard = {
      name: p.name,
      fullPath: p.fullPath,
      heatScore: p.heatScore,
    };

    // Promote to full card if has uncommitted/unpushed changes even if heat ≤50
    const hasChanges = git && ((git.uncommittedCount ?? 0) > 0 || (git.unpushedCount ?? 0) > 0);
    const isFullCard = p.heatScore > 50 || hasChanges;

    if (isFullCard && git) {
      card.branch = git.branch;
      card.uncommittedCount = git.uncommittedCount;
      card.stagedCount = git.stagedCount;
      card.unpushedCount = git.unpushedCount;
      card.lastCommitMessage = git.lastCommitMessage;
      card.hoursSinceLastCommit = git.hoursSinceLastCommit;
    } else if (git) {
      // Cold (10-50) and clean: compact — just branch + hours
      card.branch = git.branch;
      card.hoursSinceLastCommit = git.hoursSinceLastCommit;
    }

    // Actions: only for full cards (hot or has changes)
    if (isFullCard) {
      if (haikuProject?.actions && haikuProject.actions.length > 0) {
        card.actions = haikuProject.actions.slice(0, 3);
      } else {
        card.actions = buildFallbackActions(p, git);
      }
    }

    return { card, rank };
  });

  ranked.sort((a, b) => a.rank - b.rank);
  const cards = ranked.slice(0, 3).map(r => r.card);

  log.info(`[StateBuilder] ${cards.length} project cards built (${uniqueProjects.length} unique above threshold, ${hot.length} pre-dedup)`);
  return cards;
}

function buildFallbackActions(
  project: AmbientData['projects'][0],
  git?: AmbientData['gitRepos'][0],
): DashboardProjectCard['actions'] {
  const actions: Array<{ label: string; command: string }> = [];

  if (git && git.uncommittedCount > 0) {
    actions.push({ label: 'Review changes', command: `Show me the uncommitted changes in ${project.fullPath}` });
  }
  if (git && git.unpushedCount > 0) {
    actions.push({ label: 'Push commits', command: `Push my unpushed commits in ${project.fullPath}` });
  }
  if (actions.length === 0) {
    actions.push({ label: 'Open project', command: `Open ${project.fullPath} and show me the recent activity` });
  }

  return actions.slice(0, 2);
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export function buildActivityFeed(data: AmbientData): DashboardActivityItem[] {
  const items: DashboardActivityItem[] = [];

  // Browser: group multiple titles per domain on one line
  if (data.browserHistory) {
    const domains = data.browserHistory.topDomains.slice(0, 4);
    for (const d of domains) {
      const titles = d.sampleTitles.slice(0, 3).filter(Boolean);
      const display = titles.length > 0 ? titles.join(', ') : d.domain;
      items.push({
        type: 'browser',
        text: `${d.domain} — ${display}`,
        command: `Go to ${d.domain}`,
      });
    }
  }

  // Shell: chain recent non-boring commands with arrows
  if (data.shellHistory) {
    const interesting = data.shellHistory.recentCommands
      .filter(c => {
        const prefix = c.command.split(/\s+/)[0];
        return !BORING_COMMANDS.has(prefix);
      })
      .slice(0, 5);
    if (interesting.length > 0) {
      // Truncate individual commands for chaining
      const cmds = interesting.map(c => c.command.length > 40 ? c.command.slice(0, 37) + '…' : c.command);
      items.push({
        type: 'shell',
        text: '> ' + cmds.join(' → '),
        command: interesting[0].command,
      });
    }
  }

  // Recent files: group by app, show top 2 groups
  if (data.recentFiles && data.recentFiles.files.length > 0) {
    const byApp = new Map<string, string[]>();
    for (const f of data.recentFiles.files) {
      const existing = byApp.get(f.appName) || [];
      if (!existing.includes(f.fileName)) existing.push(f.fileName);
      byApp.set(f.appName, existing);
    }

    let fileItems = 0;
    for (const [app, fileNames] of byApp) {
      if (fileItems >= 2) break;
      const display = fileNames.slice(0, 3).join(', ');
      const extra = fileNames.length > 3 ? ` +${fileNames.length - 3}` : '';
      items.push({
        type: 'file',
        text: `${display}${extra} — ${app}`,
      });
      fileItems++;
    }
  }

  const result = items.slice(0, 6);
  log.info(`[StateBuilder] ${result.length} activity items built`);
  return result;
}
