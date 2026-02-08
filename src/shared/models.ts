// ============================================================================
// CLAUDE MODEL DEFINITIONS
// ============================================================================

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface ModelConfig {
  id: string;
  name: string;
  tier: ModelTier;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheReadCostPerMTok: number;
  maxOutputTokens: number;
  contextWindow: number;
  supportsAdaptiveThinking: boolean;
  supportsCompaction: boolean;
  supportsFastMode: boolean;
  prefillSupported: boolean;
}

/** Backwards-compatible alias used by UI components */
export interface ClaudeModelOption {
  id: string;
  label: string;
  expensive?: boolean;
}

// ============================================================================
// MODEL REGISTRY — current supported models
// ============================================================================

export const MODEL_CONFIGS: readonly ModelConfig[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    tier: 'opus',
    inputCostPerMTok: 5,
    outputCostPerMTok: 25,
    cacheReadCostPerMTok: 0.5,
    maxOutputTokens: 128_000,
    contextWindow: 200_000,
    supportsAdaptiveThinking: true,
    supportsCompaction: true,
    supportsFastMode: true,
    prefillSupported: false,
  },
  {
    id: 'claude-opus-4-5-20250929',
    name: 'Claude Opus 4.5',
    tier: 'opus',
    inputCostPerMTok: 5,
    outputCostPerMTok: 25,
    cacheReadCostPerMTok: 0.5,
    maxOutputTokens: 64_000,
    contextWindow: 200_000,
    supportsAdaptiveThinking: false,
    supportsCompaction: false,
    supportsFastMode: false,
    prefillSupported: true,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    tier: 'sonnet',
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    cacheReadCostPerMTok: 0.3,
    maxOutputTokens: 64_000,
    contextWindow: 200_000,
    supportsAdaptiveThinking: false,
    supportsCompaction: false,
    supportsFastMode: false,
    prefillSupported: true,
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    tier: 'sonnet',
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    cacheReadCostPerMTok: 0.3,
    maxOutputTokens: 64_000,
    contextWindow: 200_000,
    supportsAdaptiveThinking: false,
    supportsCompaction: false,
    supportsFastMode: false,
    prefillSupported: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    tier: 'haiku',
    inputCostPerMTok: 1,
    outputCostPerMTok: 5,
    cacheReadCostPerMTok: 0.1,
    maxOutputTokens: 64_000,
    contextWindow: 200_000,
    supportsAdaptiveThinking: false,
    supportsCompaction: false,
    supportsFastMode: false,
    prefillSupported: true,
  },
];

/** Backwards-compatible CLAUDE_MODELS array for UI dropdowns and IPC validation */
export const CLAUDE_MODELS: readonly ClaudeModelOption[] = MODEL_CONFIGS.map((m) => ({
  id: m.id,
  label: m.name,
  expensive: m.tier === 'opus' ? true : undefined,
}));

export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

export function getModelLabel(modelId: string): string {
  return MODEL_CONFIGS.find((m) => m.id === modelId)?.name || modelId;
}

export function getModelConfig(modelId: string): ModelConfig | undefined {
  return MODEL_CONFIGS.find((m) => m.id === modelId);
}

export function getModelTier(modelId: string): ModelTier {
  return MODEL_CONFIGS.find((m) => m.id === modelId)?.tier ?? 'sonnet';
}
