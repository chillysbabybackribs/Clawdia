import { elements, appState } from './state';
import { getModelConfig, DEFAULT_MODEL } from '../../shared/models';

type Metric = 'input' | 'output' | 'cost';

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function formatCost(value: number): string {
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function calculateCost(model: string, input: number, output: number, cacheRead: number, cacheCreate: number): number {
  const cfg = getModelConfig(model) || getModelConfig(DEFAULT_MODEL);
  if (!cfg) return 0;
  const freshInput = Math.max(input - cacheRead - cacheCreate, 0);
  const costInput = (freshInput / 1_000_000) * cfg.inputCostPerMTok;
  const costOutput = (output / 1_000_000) * cfg.outputCostPerMTok;
  const costCacheRead = (cacheRead / 1_000_000) * cfg.cacheReadCostPerMTok;
  // Treat cache creation like fresh input unless we add explicit pricing; conservative match to input
  const costCacheCreate = (cacheCreate / 1_000_000) * cfg.inputCostPerMTok;
  return costInput + costOutput + costCacheRead + costCacheCreate;
}

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cost: number;
};

const STORAGE_KEY = 'clawdia.token-totals.v1';

function loadTotals(): Totals {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 };
    const parsed = JSON.parse(raw);
    return {
      input: Number(parsed.input) || 0,
      output: Number(parsed.output) || 0,
      cacheRead: Number(parsed.cacheRead) || 0,
      cacheCreate: Number(parsed.cacheCreate) || 0,
      cost: Number(parsed.cost) || 0,
    };
  } catch {
    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 };
  }
}

function saveTotals(totals: Totals): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(totals));
  } catch {
    // ignore storage errors
  }
}

class TokenTracker {
  private totals: Totals = loadTotals();

  constructor(private host: HTMLElement) {
    this.renderSkeleton();
  }

  private renderSkeleton(): void {
    this.host.innerHTML = `
      <div class="token-stats__bar">
        <span class="token-stats__metric" data-metric="input">
          <span class="token-stats__label">in</span>
          <span class="token-stats__value">0</span>
        </span>
        <span class="token-stats__metric" data-metric="output">
          <span class="token-stats__label">out</span>
          <span class="token-stats__value">0</span>
        </span>
        <span class="token-stats__metric" data-metric="cost">
          <span class="token-stats__label">cost</span>
          <span class="token-stats__value">$0.000</span>
        </span>
        <button class="token-stats__reset" type="button" title="Reset totals">reset</button>
      </div>
    `;
    const resetBtn = this.host.querySelector<HTMLButtonElement>('.token-stats__reset');
    resetBtn?.addEventListener('click', () => this.reset());
    this.renderBar();
  }

  update(data: import('../../shared/types').TokenUsageUpdateEvent): void {
    this.totals.input += data.inputTokens;
    this.totals.output += data.outputTokens;
    this.totals.cacheRead += data.cacheReadTokens;
    this.totals.cacheCreate += data.cacheCreateTokens;

    const incrementalCost = calculateCost(
      data.model || appState.currentSelectedModel || DEFAULT_MODEL,
      data.inputTokens,
      data.outputTokens,
      data.cacheReadTokens,
      data.cacheCreateTokens
    );
    this.totals.cost += incrementalCost;

    this.renderBar();
    saveTotals(this.totals);
  }

  private renderBar(): void {
    this.setMetric('input', formatNumber(this.totals.input));
    this.setMetric('output', formatNumber(this.totals.output));
    this.setMetric('cost', formatCost(this.totals.cost));
  }

  private setMetric(metric: Metric, text: string): void {
    const el = this.host.querySelector<HTMLElement>(
      `.token-stats__metric[data-metric="${metric}"] .token-stats__value`
    );
    if (el) el.textContent = text;
  }

  reset(): void {
    this.totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 };
    this.renderBar();
    saveTotals(this.totals);
  }
}

let tracker: TokenTracker | null = null;

export function initTokenStats(): void {
  tracker = new TokenTracker(elements.tokenStatsEl);
  window.api.onTokenUsageUpdate((payload) => tracker?.update(payload));
}
