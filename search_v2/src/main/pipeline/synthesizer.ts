import { ExecutionSummary, ResearchSourcePreview, TaskSpec } from './types';
import { log } from '../util/log';

export class Synthesizer {
  synthesize(_spec: TaskSpec, summary: ExecutionSummary): string {
    log.info('Synthesizer building deterministic response');
    const summaryLines = this.buildSummaryLines(summary);
    const actionItems = this.buildActionItems(summary);
    const sourceLines = this.buildSourceLines(summary.sources);

    return `Summary:\n${summaryLines.map((line) => `- ${line}`).join('\n')}\n\nAction Items:\n${actionItems
      .map((line) => `- ${line}`)
      .join('\n')}\n\nSources:\n${sourceLines.map((line) => `- ${line}`).join('\n')}`;
  }

  private buildSummaryLines(summary: ExecutionSummary): string[] {
    const eligibleSources = summary.sources.filter((source) => source.eligibleForSynthesis && source.snippet);
    const lines: string[] = [];
    for (const source of eligibleSources) {
      lines.push(`${source.host}: ${source.snippet}`);
      if (lines.length >= 3) break;
    }
    if (lines.length < 3) {
      if (summary.missingCriteria.length > 0) {
        lines.push(`Coverage for ${summary.missingCriteria.join(', ')} is pending.`);
      } else {
        lines.push('Could not be determined from available sources.');
      }
    }
    return this.padLines(lines, 'Could not be determined from available sources.');
  }

  private buildActionItems(summary: ExecutionSummary): string[] {
    const items: string[] = [];
    if (summary.missingCriteria.length > 0) {
      for (const criterion of summary.missingCriteria) {
        items.push(`Gather more evidence for: ${criterion}.`);
      }
    } else {
      items.push('All criteria have sourced evidence.');
    }
    for (const reason of summary.gateStatus.reasons) {
      items.push(reason);
    }
    return this.padLines(items, 'Confirm the coverage remains consistent with user goals.');
  }

  private buildSourceLines(sources: ResearchSourcePreview[]): string[] {
    const lines: string[] = [];
    for (const source of sources) {
      const snippet = source.snippet || 'Key takeaways unavailable.';
      lines.push(`${source.title} (${source.host}) — ${snippet}`);
      if (lines.length >= 3) break;
    }
    if (lines.length === 0) {
      lines.push('No sources captured.');
    }
    return this.padLines(lines, 'No additional sources available.');
  }

  private padLines(lines: string[], filler: string): string[] {
    while (lines.length < 3) {
      lines.push(filler);
    }
    return lines.slice(0, 6);
  }
}
