import { getModelConfig, getModelTier, MODEL_CONFIGS, type ModelTier } from '../../shared/models';
import { createLogger } from '../logger';

const log = createLogger('model-router');

// ============================================================================
// TYPES
// ============================================================================

export type CallContext =
  | 'chat-only'           // Simple conversation, no tools needed
  | 'tool-planning'       // Main tool loop iterations
  | 'tool-planning-first' // First iteration (intent routing)
  | 'final-synthesis'     // Last iteration producing final answer
  | 'extraction-text'     // Nested: text extraction from pages
  | 'extraction-vision'   // Nested: OCR/vision extraction
  | 'extraction-json';    // Nested: structured data extraction

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface RouteDecision {
  model: string;
  effort: EffortLevel;
  reason: string;
}

export interface RouterConfig {
  ceilingModel: string;
  enableSmartRouting: boolean;
}

// ============================================================================
// TIER ORDERING — used to enforce ceiling constraint
// ============================================================================

const TIER_RANK: Record<ModelTier, number> = {
  haiku: 0,
  sonnet: 1,
  opus: 2,
};

/** Pick the best model at or below `maxTier` for the given target tier */
function pickModelAtTier(targetTier: ModelTier, maxTier: ModelTier): string {
  const maxRank = TIER_RANK[maxTier];
  const effectiveTier = TIER_RANK[targetTier] <= maxRank ? targetTier : maxTier;

  // Find the first (newest) model at the effective tier
  const model = MODEL_CONFIGS.find((m) => m.tier === effectiveTier);
  return model?.id ?? MODEL_CONFIGS[0].id;
}

// ============================================================================
// ROUTER
// ============================================================================

export function routeModel(config: RouterConfig, context: CallContext): RouteDecision {
  const { ceilingModel, enableSmartRouting } = config;
  const ceilingTier = getModelTier(ceilingModel);

  // Smart routing disabled — always use ceiling model at high effort
  if (!enableSmartRouting) {
    return {
      model: ceilingModel,
      effort: 'high',
      reason: 'Smart routing disabled',
    };
  }

  switch (context) {
    case 'extraction-text':
    case 'extraction-json':
      return {
        model: pickModelAtTier('haiku', ceilingTier),
        effort: 'low',
        reason: `Extraction → ${ceilingTier === 'haiku' ? 'ceiling' : 'Haiku'} at low effort`,
      };

    case 'extraction-vision':
      return {
        model: pickModelAtTier('haiku', ceilingTier),
        effort: 'low',
        reason: `Vision extraction → ${ceilingTier === 'haiku' ? 'ceiling' : 'Haiku'} at low effort`,
      };

    case 'chat-only':
      return {
        model: pickModelAtTier('sonnet', ceilingTier),
        effort: 'medium',
        reason: `Chat-only → ${ceilingTier === 'haiku' ? 'ceiling' : 'Sonnet'} at medium effort`,
      };

    case 'tool-planning':
      return {
        model: pickModelAtTier('sonnet', ceilingTier),
        effort: 'high',
        reason: `Tool planning → ${ceilingTier === 'haiku' ? 'ceiling' : 'Sonnet'} at high effort`,
      };

    case 'tool-planning-first':
      return {
        model: ceilingModel,
        effort: 'high',
        reason: 'First iteration → ceiling model at high effort',
      };

    case 'final-synthesis':
      return {
        model: ceilingModel,
        effort: 'high',
        reason: 'Final synthesis → ceiling model at high effort',
      };

    default: {
      log.warn(`Unknown call context: ${context} — using ceiling model`);
      return {
        model: ceilingModel,
        effort: 'high',
        reason: `Unknown context → ceiling model`,
      };
    }
  }
}
