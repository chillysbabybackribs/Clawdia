import { AnthropicClient } from '../llm/client';
import { collectMetrics } from './metrics';
import { evaluateCondition } from './condition-parser';
import type { DashboardSuggestion, DashboardRule, DashboardState, SuggestionIcon } from '../../shared/dashboard-types';
import { createLogger } from '../logger';

const log = createLogger('dashboard-suggestions');
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export type { DashboardSuggestion, DashboardState, SuggestionIcon };

const VALID_ICONS: Set<string> = new Set([
  'cpu', 'memory', 'disk', 'network', 'battery', 'browser',
  'terminal', 'git', 'project', 'time', 'cleanup', 'alert',
]);

const AVAILABLE_METRIC_KEYS = [
  'cpu_percent', 'cpu_cores', 'ram_percent', 'ram_used_mb', 'ram_total_mb',
  'disk_percent', 'disk_used_gb', 'disk_total_gb',
  'battery_percent', 'battery_charging',
  'top_process_name', 'top_process_cpu', 'top_process_ram_mb',
  'cpu_delta', 'network_up', 'process_count',
  'hour', 'day_of_week', 'session_duration_minutes', 'minutes_since_last_message',
  'active_project', 'git_uncommitted_changes', 'git_hours_since_last_commit',
];

const RULES_SYSTEM_PROMPT = `Generate 5-8 dashboard rules as JSON. Each rule is evaluated against live metrics.

Rule schema: {"id":"string","condition":"expr","suggestion_text":"template","type":"actionable|info","action":"string (if actionable)","icon":"cpu|memory|disk|network|battery|browser|terminal|git|project|time|cleanup|alert","priority":1-5,"cooldown_minutes":1-120}

Condition syntax: metric_key OP value, joined with AND/OR/NOT. Operators: > >= < <= == !=
Metric keys: ${AVAILABLE_METRIC_KEYS.join(', ')}
Templates: {{key}} for dynamic values. Keep suggestion_text under 100 chars.
null comparisons → false. Skip battery rules if battery_percent is null.
Mix system health with time/workflow suggestions. Be concise.

Respond ONLY with: {"rules":[...]}`;


let cachedRules: DashboardRule[] | null = null;

export function getCachedRules(): DashboardRule[] | null {
  return cachedRules;
}

export interface RulesGenerationContext {
  userMemoryContext: string;
  topSitesContext: string;
  recentConversations: string;
}

/**
 * Attempt to repair a truncated JSON rules array by finding the last complete
 * rule object and closing the array/object brackets.
 */
function repairTruncatedRulesJson(jsonStr: string): { rules: any[] } | null {
  // Find all complete rule objects: {...}
  const rulePattern = /\{[^{}]*"id"\s*:\s*"[^"]+?"[^{}]*\}/g;
  const matches = jsonStr.match(rulePattern);
  if (!matches || matches.length === 0) return null;

  // Try to parse each match as a valid rule
  const validRules: any[] = [];
  for (const m of matches) {
    try {
      const obj = JSON.parse(m);
      if (obj.id && obj.condition) validRules.push(obj);
    } catch {
      // skip malformed match
    }
  }

  return validRules.length > 0 ? { rules: validRules } : null;
}

export async function generateDashboardRules(
  client: AnthropicClient,
  context: RulesGenerationContext,
): Promise<DashboardRule[]> {
  const metrics = collectMetrics();

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' });

  const userMessage = `Metrics: ${JSON.stringify(metrics)}
Time: ${dayStr} ${timeStr}
${context.userMemoryContext ? `User context: ${context.userMemoryContext.slice(0, 400)}` : ''}
${context.topSitesContext ? `Sites: ${context.topSitesContext.slice(0, 200)}` : ''}
${context.recentConversations ? `Recent: ${context.recentConversations.slice(0, 200)}` : ''}`;

  let rules: DashboardRule[] = [];

  try {
    const { text } = await client.complete(
      [{ role: 'user' as const, content: RULES_SYSTEM_PROMPT + '\n\n' + userMessage }],
      { maxTokens: 2048, model: HAIKU_MODEL }
    );

    log.info(`[Dashboard] Haiku raw response (${text.length} chars):\n${text.slice(0, 2000)}`);

    let jsonStr = text.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Truncated JSON — try to repair by closing brackets
      parsed = repairTruncatedRulesJson(jsonStr);
      if (parsed) {
        log.info(`[Dashboard] Repaired truncated JSON, recovered ${parsed.rules?.length ?? 0} rules`);
      } else {
        throw new Error('JSON parse failed and repair unsuccessful');
      }
    }
    if (parsed.rules && Array.isArray(parsed.rules)) {
      log.info(`[Dashboard] Parsed ${parsed.rules.length} raw rules from Haiku`);
      rules = parsed.rules
        .slice(0, 10)
        .filter((r: any) => r.id && r.condition && r.suggestion_text && r.icon)
        .map((r: any): DashboardRule => ({
          id: String(r.id),
          condition: String(r.condition).slice(0, 500),
          suggestion_text: String(r.suggestion_text),
          type: r.type === 'actionable' ? 'actionable' : 'info',
          action: r.action ? String(r.action) : undefined,
          icon: VALID_ICONS.has(r.icon) ? (r.icon as SuggestionIcon) : 'alert',
          priority: Math.max(1, Math.min(5, parseInt(r.priority, 10) || 3)),
          cooldown_minutes: Math.max(1, Math.min(120, parseInt(r.cooldown_minutes, 10) || 5)),
        }));

      log.info(`[Dashboard] After filter: ${rules.length} valid rules`);
      for (const r of rules) {
        log.info(`[Dashboard]   rule="${r.id}" condition="${r.condition}" priority=${r.priority} icon=${r.icon}`);
      }

      // Dry-run validation: remove rules with unparseable conditions
      const dummyContext: Record<string, number | boolean | string | null> = {};
      for (const key of AVAILABLE_METRIC_KEYS) dummyContext[key] = 0;
      rules = rules.filter((r) => {
        try {
          evaluateCondition(r.condition, dummyContext);
          return true;
        } catch (err: any) {
          log.warn(`[Dashboard] Discarding rule ${r.id}: invalid condition "${r.condition}" — ${err?.message}`);
          return false;
        }
      });
      log.info(`[Dashboard] After dry-run validation: ${rules.length} rules survived`);
    } else {
      log.warn(`[Dashboard] Haiku response did not contain a rules array`);
    }
  } catch (err: any) {
    log.warn(`Dashboard rules generation failed: ${err?.message || err}`);
  }

  cachedRules = rules;
  log.info(`Dashboard: ${rules.length} rules generated and cached`);
  return rules;
}
