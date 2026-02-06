import { PlannedAction, TaskSpec } from './types';
import { RouterResult } from './types';
import { sanitizeSearchQuery } from '../util/url_normalize';

const BASE_CRITERIA = [
  'Summarize the most relevant information requested by the user',
  'List concrete next steps or recommendations based on current knowledge',
  'Surface any risks, uncertainties, or open questions that should be acknowledged',
  'Point to credible sources that informed the response',
];

const BUDGET = {
  maxActions: 3,
  maxBatches: 1,
  maxTimeSeconds: 60,
};

const querySuffixMap: Record<string, string> = {
  SOFTWARE: 'software considerations and best practices',
  PHYSICAL_PROCESS: 'process constraints and hands-on steps',
  GENERAL: 'key facts and useful guidance',
};

function buildOverviewQuery(prompt: string, domain: RouterResult): string {
  const allowSecurity = domain.domain === 'SOFTWARE';
  const sanitized = sanitizeSearchQuery(prompt, allowSecurity);
  const suffix = querySuffixMap[domain.domain] || querySuffixMap.GENERAL;
  const trimmed = sanitized.length ? sanitized : 'latest updates';
  return `${trimmed} ${suffix}`.trim();
}

function includesSafety(prompt: string): boolean {
  return /safety|safe|danger|secure|risk/i.test(prompt);
}

export class Planner {
  plan(input: { prompt: string; routerResult: RouterResult }): TaskSpec {
    const { prompt, routerResult } = input;
    const overviewQuery = buildOverviewQuery(prompt, routerResult);
    const actions: PlannedAction[] = [
      {
        id: 'action-overview',
        type: 'search',
        source: 'google',
        query: overviewQuery,
        priority: 1,
        reason: 'Overview search',
      },
    ];

    if (includesSafety(prompt)) {
      const allowSecurity = routerResult.domain === 'SOFTWARE';
      const safetyQuery = sanitizeSearchQuery(`${prompt} safety review`, allowSecurity);
      if (safetyQuery) {
        actions.push({
          id: 'action-safety',
          type: 'search',
          source: 'google',
          query: safetyQuery,
          priority: 2,
          reason: 'Safety check',
        });
      }
    }

    const successCriteria = [
      BASE_CRITERIA[0],
      BASE_CRITERIA[1],
      routerResult.domain === 'SOFTWARE' ? BASE_CRITERIA[3] : BASE_CRITERIA[2],
    ];

    const deliverableSchema = ['summary', 'action items', 'source list'];

    return {
      userGoal: prompt,
      successCriteria,
      deliverableSchema,
      budget: BUDGET,
      actions,
      domain: routerResult.domain,
    };
  }
}
