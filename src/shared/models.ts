// ============================================================================
// CLAUDE MODEL DEFINITIONS
// ============================================================================

export interface ClaudeModelOption {
  id: string;
  label: string;
  description: string;
  badge: string;
}

export const CLAUDE_MODELS: readonly ClaudeModelOption[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    description: 'Fast & cheap — simple tasks, quick chat',
    badge: 'FAST',
  },
  {
    id: 'claude-sonnet-4-20250514',
    label: 'Sonnet 4',
    description: 'Balanced — best for most tasks',
    badge: 'DEFAULT',
  },
  {
    id: 'claude-opus-4-20250514',
    label: 'Opus 4',
    description: 'Most capable — complex research & generation',
    badge: 'PRO',
  },
] as const;

export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export function getModelLabel(modelId: string): string {
  return CLAUDE_MODELS.find((m) => m.id === modelId)?.label || 'Sonnet 4';
}
