import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import { BrowserFacade } from '../browser/browser_facade';
import { buildFollowUpQueries, deriveCriterionKeywords } from './followup';
import {
  ActionResult,
  DomainId,
  ExecutionSummary,
  GateStatus,
  PlannedAction,
  ResearchProgressEvent,
  ResearchSourcePreview,
  SourceEvidence,
  SourceKind,
  SourceTier,
  TaskSpec,
} from './types';
import { log } from '../util/log';

type BrowserPoolType = any;

const IPC_EVENTS = {
  RESEARCH_PROGRESS: 'research:progress',
};

const MIN_TEXT_LENGTH = 500;
const MAX_VISITED_LINKS = 3;
const SERP_PREVIEW_KIND = 'search_results';

export class Executor {
  private mainWindow: BrowserWindow;
  private facade: BrowserFacade;
  private coverageKeywords = new Map<string, string[]>();
  private coverageHits = new Map<string, Set<string>>();
  private sourceMap = new Map<string, ResearchSourcePreview>();
  private followUpRound = 0;
  private currentDomain: DomainId = 'GENERAL';

  constructor(pool: BrowserPoolType, mainWindow: BrowserWindow) {
    this.facade = new BrowserFacade(pool);
    this.mainWindow = mainWindow;
  }

  async execute(spec: TaskSpec): Promise<ExecutionSummary> {
    this.currentDomain = spec.domain ?? 'GENERAL';
    this.resetCoverage(spec);
    this.sourceMap.clear();
    this.followUpRound = 0;

    const actionQueue: PlannedAction[] = [...spec.actions];
    const results: ActionResult[] = [];

    while (actionQueue.length > 0) {
      const action = actionQueue.shift()!;
      const actionResult = await this.executeAction(action, spec.domain ?? 'GENERAL');
      results.push(actionResult);
      this.recordSources(actionResult.previews);
      this.updateCoverage(actionResult);
      this.emitActionProgress(actionResult);

      if (actionQueue.length === 0 && this.followUpRound === 0) {
        const missingCriteria = this.getMissingCriteria();
        const gateStatus = this.evaluateGate(spec.domain ?? 'GENERAL');
        if ((missingCriteria.length > 0 || !gateStatus.ok) && results.length < spec.budget.maxActions) {
        const followUps = this.buildFollowUps(spec, missingCriteria, results.length);
          if (followUps.length > 0) {
            this.followUpRound = 1;
            actionQueue.push(...followUps);
            this.emitFollowUpQueued(followUps.length);
            continue;
          }
        }
      }
    }

    const gateStatus = this.evaluateGate(spec.domain ?? 'GENERAL');
    const missingCriteria = this.getMissingCriteria();
    this.sendCheckpoint(gateStatus, missingCriteria);

    return {
      results,
      gateStatus,
      missingCriteria,
      sources: Array.from(this.sourceMap.values()),
    };
  }

  private resetCoverage(spec: TaskSpec): void {
    this.coverageKeywords.clear();
    this.coverageHits.clear();
    const domain = spec.domain ?? 'GENERAL';

    for (const criterion of spec.successCriteria) {
      const keywords = deriveCriterionKeywords(domain, criterion);
      this.coverageKeywords.set(criterion, keywords);
      this.coverageHits.set(criterion, new Set());
    }
  }

  private buildFollowUps(spec: TaskSpec, missingCriteria: string[], usedActions: number): PlannedAction[] {
    const remainingBudget = Math.max(spec.budget.maxActions - usedActions, 0);
    const limit = Math.min(2, remainingBudget);
    if (limit <= 0) return [];
    const hostSet = new Set<string>(
      Array.from(this.sourceMap.values())
        .map((source) => source.host)
        .filter((host) => !!host)
    );
    const queries = buildFollowUpQueries(this.currentDomain, missingCriteria, hostSet, limit);
    const actions: PlannedAction[] = [];
    for (let i = 0; i < queries.length && actions.length < limit; i += 1) {
      actions.push({
        id: `followup-${Date.now().toString(36)}-${i}`,
        type: 'search',
        source: 'google',
        query: queries[i],
        priority: 1,
        reason: 'Targeted follow-up',
      });
    }
    return actions;
  }

  private async executeAction(action: PlannedAction, domain: DomainId): Promise<ActionResult> {
    const serpPreview = this.buildSerpPreview(action);
    this.sendProgress({
      phase: 'executing',
      message: `Searching: ${action.query}`,
      actions: [
        {
          id: action.id,
          source: action.source,
          status: 'running',
          reason: action.reason,
        },
      ],
      sources: [serpPreview],
      activeSourceUrl: serpPreview.url,
    });

    try {
      const serpResults = await this.facade.searchGoogle(action.query);
      const visitedEvidence: SourceEvidence[] = [];
      const visitedLinks: string[] = [];
      for (const result of serpResults.slice(0, MAX_VISITED_LINKS)) {
        if (!result.url) continue;
        visitedLinks.push(result.url);
        const text = await this.facade.fetchPageText(result.url);
        const snippet = this.makeSnippet(text, result.snippet);
        const host = this.extractHost(result.url);
        const title = result.title || host || 'Search result';
        const classification = this.classifyHost(host, domain);
        const eligible = text.length >= MIN_TEXT_LENGTH;
        visitedEvidence.push({
          sourceId: randomUUID(),
          title,
          host,
          url: result.url,
          snippet,
          reason: action.reason,
          keyFindings: snippet ? [snippet] : [],
          sourceKind: classification.kind,
          sourceTier: classification.tier,
          eligibleForSynthesis: eligible,
          eligibleForPrimaryClaims: classification.isPrimary,
          discardReason: eligible ? undefined : 'Content too compact',
        });
      }

      const previews: ResearchSourcePreview[] = [serpPreview, ...visitedEvidence];
      const bestSource = this.selectBestSource(previews);
      const statusMessage = visitedEvidence.length > 0 ? 'success' : 'failed';
      const executionStatus = visitedEvidence.length > 0 ? 'succeeded' : 'failed';

      return {
        actionId: action.id,
        source: action.source,
        status: statusMessage as 'success' | 'failed',
        previews,
        evidence: visitedEvidence,
        visitedLinks,
        executionStatus,
        reason: visitedEvidence.length > 0 ? 'Search completed' : 'No evidence collected',
      };
    } catch (error: any) {
      log.error('Search action failed', error);
      const previews = [serpPreview];
      return {
        actionId: action.id,
        source: action.source,
        status: 'failed',
        previews,
        evidence: [],
        visitedLinks: [],
        executionStatus: 'failed',
        reason: error.message ?? 'Action error',
      };
    }
  }

  private recordSources(previews: ResearchSourcePreview[]): void {
    for (const preview of previews) {
      if (!preview.sourceId) continue;
      this.sourceMap.set(preview.sourceId, preview);
    }
  }

  private updateCoverage(result: ActionResult): void {
    for (const evidence of result.evidence) {
      this.markCoverage(evidence);
    }
  }

  private markCoverage(evidence: SourceEvidence): void {
    const snippet = (evidence.snippet || '').toLowerCase();
    if (!snippet) return;
    for (const [criterion, keywords] of this.coverageKeywords.entries()) {
      const hits = keywords.filter((keyword) => keyword && snippet.includes(keyword.toLowerCase()));
      if (hits.length >= Math.min(2, keywords.length)) {
        const hitsSet = this.coverageHits.get(criterion);
        hitsSet?.add(evidence.sourceId);
      }
    }
  }

  private getMissingCriteria(): string[] {
    return Array.from(this.coverageHits.entries())
      .filter(([, hits]) => hits.size === 0)
      .map(([criterion]) => criterion);
  }

  private evaluateGate(domain: DomainId): GateStatus {
    const sources = Array.from(this.sourceMap.values()).filter((source) => source.eligibleForSynthesis);
    const hosts = new Set(sources.map((source) => source.host).filter(Boolean));
    const primary = sources.some((source) => source.eligibleForPrimaryClaims);
    const reasons: string[] = [];
    if (sources.length < 2) {
      reasons.push('Need at least two eligible sources');
    }
    if (hosts.size < 2) {
      reasons.push('Need at least two hosts');
    }
    return {
      ok: sources.length >= 2 && hosts.size >= 2,
      reasons,
      eligibleCount: sources.length,
      hostCount: hosts.size,
      hasPrimary: primary,
    };
  }

  private emitActionProgress(result: ActionResult): void {
    const bestSource = this.selectBestSource(result.previews);
    const firstPreview = result.previews[0];
    const actionStatus = result.status === 'success' ? 'success' : 'failed';
    this.sendProgress({
      phase: 'executing',
      message: `✓ ${result.source}`,
      actions: [
        {
          id: result.actionId,
          source: result.source,
          status: actionStatus,
          preview: firstPreview?.title,
          executionStatus: result.executionStatus,
          reason: result.reason,
          producedSources: result.previews.length > 0 ? result.previews : undefined,
        },
      ],
      sources: result.previews.length > 0 ? result.previews : undefined,
      activeSourceId: bestSource?.sourceId,
      activeSourceUrl: bestSource?.url,
      gateStatus: this.evaluateGate(this.currentDomain),
    });
  }

  private emitFollowUpQueued(count: number): void {
    this.sendProgress({
      phase: 'executing',
      message: `Queued ${count} follow-up search${count === 1 ? '' : 'es'}`,
      actions: [],
    });
  }

  private sendCheckpoint(gateStatus: GateStatus, missingCriteria: string[]): void {
    this.sendProgress({
      phase: 'checkpoint',
      message: `Coverage: ${missingCriteria.length}/${this.coverageHits.size} criteria missing`,
      checkpointNumber: 1,
      gateStatus,
    });
  }

  private sendProgress(progress: ResearchProgressEvent): void {
    this.mainWindow.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, progress);
  }

  private selectBestSource(sources: ResearchSourcePreview[]): ResearchSourcePreview | undefined {
    return sources.find((source) => source.eligibleForSynthesis) ?? sources[0];
  }

  private buildSerpPreview(action: PlannedAction): ResearchSourcePreview {
    return {
      sourceId: `${action.id}-serp`,
      title: 'Google search',
      host: 'www.google.com',
      url: `https://www.google.com/search?q=${encodeURIComponent(action.query)}`,
      sourceKind: SERP_PREVIEW_KIND,
      sourceTier: 'C',
      reason: action.reason ?? 'Search engine result',
      eligibleForSynthesis: false,
      eligibleForPrimaryClaims: false,
    };
  }

  private makeSnippet(text: string, fallback?: string): string {
    const candidate = text?.replace(/\s+/g, ' ').trim();
    if (!candidate && fallback) return fallback;
    if (!candidate) return '';
    return candidate.length > 300 ? `${candidate.slice(0, 300)}...` : candidate;
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch { return url; }
  }

  private classifyHost(host: string, domain: DomainId): { kind: SourceKind; tier: SourceTier; isPrimary: boolean } {
    const lower = host.toLowerCase();
    const base: { kind: SourceKind; tier: SourceTier; isPrimary: boolean } = {
      kind: 'content_secondary',
      tier: 'B',
      isPrimary: false,
    };
    if (domain === 'SOFTWARE') {
      if (lower.includes('docs.') || lower.includes('developer') || lower.includes('readthedocs')) {
        return { kind: 'official_docs', tier: 'A', isPrimary: true };
      }
      if (lower.includes('github.com') && lower.split('/').length >= 4) {
        return { kind: 'repo_canonical', tier: 'A', isPrimary: true };
      }
      if (lower.includes('github.com')) {
        return { kind: 'repo_noncanonical', tier: 'B', isPrimary: false };
      }
      return { kind: base.kind, tier: base.tier, isPrimary: false };
    }
    if (domain === 'PHYSICAL_PROCESS') {
      if (/[.]edu$/.test(lower) || /[.]gov$/.test(lower) || lower.includes('extension') || lower.includes('standards')) {
        return { kind: 'official_docs', tier: 'A', isPrimary: true };
      }
      if (/(wikipedia|encyclopedia)/.test(lower)) {
        return { kind: 'docs_meta', tier: 'A', isPrimary: true };
      }
      if (/(news|magazine)/.test(lower)) {
        return { kind: 'content_secondary', tier: 'B', isPrimary: false };
      }
    }
    if (domain === 'GENERAL') {
      if (/[.]edu$/.test(lower) || /[.]gov$/.test(lower) || /(wikipedia|encyclopedia)/.test(lower)) {
        return { kind: 'official_docs', tier: 'A', isPrimary: true };
      }
      if (/(docs|help|learn)/.test(lower)) {
        return { kind: 'docs_meta', tier: 'B', isPrimary: false };
      }
    }
    return base;
  }
}
