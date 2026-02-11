import { AnthropicClient } from '../llm/client';
import { collectMetrics } from './metrics';
import type { HaikuDashboardResponse } from '../../shared/dashboard-types';
import { createLogger } from '../logger';

const log = createLogger('dashboard-suggestions');
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let cachedInsights: HaikuDashboardResponse | null = null;

export function getCachedInsights(): HaikuDashboardResponse | null {
  return cachedInsights;
}

export interface InsightsGenerationContext {
  userMemoryContext: string;
  topSitesContext: string;
  recentConversations: string;
  ambientContext?: string;
}

const INSIGHTS_SYSTEM_PROMPT = `You are Clawdia's dashboard intelligence engine. You receive ambient context about the user's computer activity and return structured data that the dashboard UI renders.

You do NOT generate user-facing text for suggestions. You do NOT give advice about breaks, time management, or wellness. You do NOT comment on healthy system state.

Your job:
1. RANK the user's projects by relevance. Consider: git state (uncommitted/unpushed changes rank higher), recency of activity, and whether the project relates to what the user has been browsing/researching.

2. GENERATE action commands for each project. These are natural language commands that Clawdia will execute when the user clicks a button. Be specific — reference actual file paths, branch names, and project state.

3. SELECT the most relevant activity to highlight. From browser history, shell commands, and recent files, pick the entries that tell the most coherent story about what the user has been doing. Skip noise (google.com searches, ls commands, etc.).

4. DETECT patterns if any are notable. Only include a pattern_note if something genuinely interesting emerges — like repeated searches for the same topic, or rapid context switching between projects.

Rules:
- NEVER include advice, wellness tips, break suggestions, or time-awareness messages
- NEVER comment on healthy/normal system metrics
- NEVER expose internal values like heat scores to the user
- NEVER tell the user what to work on or how to prioritize
- ALWAYS reference specific project names, domains, file names, and commit messages
- ALWAYS generate actionable commands that Clawdia can actually execute
- If no notable activity exists, return minimal data — don't fill space with generic content

Respond with valid JSON only. No markdown, no preamble.`;

export async function generateDashboardInsights(
  client: AnthropicClient,
  context: InsightsGenerationContext,
): Promise<HaikuDashboardResponse | null> {
  const metrics = collectMetrics();

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' });

  const ambientLine = context.ambientContext ? `\nAmbient: ${context.ambientContext.slice(0, 1600)}` : '';

  const userMessage = `Time: ${dayStr} ${timeStr}
CPU: ${metrics.cpu.usagePercent}% RAM: ${metrics.memory.usagePercent}%
${context.userMemoryContext ? `User context: ${context.userMemoryContext.slice(0, 400)}` : ''}
${context.topSitesContext ? `Sites: ${context.topSitesContext.slice(0, 200)}` : ''}
${context.recentConversations ? `Recent convos: ${context.recentConversations.slice(0, 200)}` : ''}${ambientLine}`;

  const fullPrompt = INSIGHTS_SYSTEM_PROMPT + '\n\n' + userMessage;
  log.info(`[Dashboard] Insights prompt (${fullPrompt.length} chars)`);

  try {
    const { text } = await client.complete(
      [{ role: 'user' as const, content: fullPrompt }],
      { maxTokens: 2048, model: HAIKU_MODEL },
    );

    log.info(`[Dashboard] Haiku insights response (${text.length} chars): ${text.slice(0, 500)}`);

    let jsonStr = text.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Try repair: extract complete objects
      parsed = repairInsightsJson(jsonStr);
      if (parsed) {
        log.info(`[Dashboard] Repaired truncated insights JSON`);
      } else {
        throw new Error('JSON parse failed and repair unsuccessful');
      }
    }

    const response: HaikuDashboardResponse = {
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.slice(0, 3).filter((p: any) => (p.path || p.name) && typeof p.rank === 'number').map((p: any) => ({
          path: String(p.path || p.name),
          rank: Math.max(1, Math.min(10, parseInt(p.rank, 10) || 5)),
          actions: Array.isArray(p.actions) ? p.actions.slice(0, 2).map((a: any) => ({
            label: String(a.label || '').slice(0, 30),
            command: String(a.command || ''),
          })) : undefined,
        }))
        : [],
      activity_highlights: Array.isArray(parsed.activity_highlights)
        ? parsed.activity_highlights.slice(0, 4).map((h: any) => String(h).slice(0, 60))
        : [],
      pattern_note: parsed.pattern_note ? String(parsed.pattern_note).slice(0, 80) : undefined,
    };

    log.info(`[Dashboard] Parsed insights: ${response.projects.length} projects, ${response.activity_highlights.length} highlights, note=${!!response.pattern_note}`);
    cachedInsights = response;
    return response;
  } catch (err: any) {
    log.warn(`[Dashboard] Insights generation failed: ${err?.message || err}`);
    return null;
  }
}

function repairInsightsJson(jsonStr: string): HaikuDashboardResponse | null {
  try {
    // Try to extract at least the projects array (greedy — handles truncation without closing bracket)
    const projectsMatch = jsonStr.match(/"projects"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
    const highlightsMatch = jsonStr.match(/"activity_highlights"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
    const noteMatch = jsonStr.match(/"pattern_note"\s*:\s*"([^"]*?)"/);

    const projects: any[] = [];
    if (projectsMatch) {
      // Match projects with either "path" or "name" field
      const projectPattern = /\{[^{}]*"(?:path|name)"\s*:\s*"[^"]+?"[^{}]*\}/g;
      const matches = projectsMatch[1].match(projectPattern);
      if (matches) {
        for (const m of matches) {
          try { projects.push(JSON.parse(m)); } catch { /* skip */ }
        }
      }
    }

    const highlights: string[] = [];
    if (highlightsMatch) {
      const strPattern = /"([^"]+?)"/g;
      let m;
      while ((m = strPattern.exec(highlightsMatch[1])) !== null) {
        highlights.push(m[1]);
      }
    }

    if (projects.length === 0 && highlights.length === 0) return null;

    return {
      projects: projects.map(p => ({ path: p.path || p.name, rank: p.rank || 5, actions: p.actions })),
      activity_highlights: highlights,
      pattern_note: noteMatch?.[1] || undefined,
    };
  } catch {
    return null;
  }
}
