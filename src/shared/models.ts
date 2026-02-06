// ============================================================================
// CLAUDE MODEL DEFINITIONS
// ============================================================================

export interface ClaudeModelOption {
  id: string;
  label: string;
  expensive?: boolean;
}

export const CLAUDE_MODELS: readonly ClaudeModelOption[] = [
  // Claude 4.6 (current flagship)
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', expensive: true },

  // Claude 4.5 family
  { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', expensive: true },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },

  // Claude 4 family
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },

  // Claude 3.7 family
  { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet' },

  // Claude 3.5 family
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet v2' },
  { id: 'claude-3-5-sonnet-20240620', label: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },

  // Claude 3 family
  { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
  { id: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet' },
  { id: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
];

export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export function getModelLabel(modelId: string): string {
  return CLAUDE_MODELS.find((m) => m.id === modelId)?.label || modelId;
}
