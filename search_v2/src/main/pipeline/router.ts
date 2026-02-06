import { DomainId, RouterResult, TimeIntent } from './types';

const SOFTWARE_KEYWORDS = ['code', 'app', 'api', 'software', 'deploy', 'sdk', 'engineer', 'developer', 'bug', 'github'];
const PHYSICAL_KEYWORDS = ['manufacturing', 'process', 'assembly', 'machine', 'hardware', 'logistics', 'factory'];
const ENTITY_HINT_PATTERNS = /([A-Z][a-z]+[A-Z][a-z]+)/g;

function detectDomain(text: string): DomainId {
  const normalized = text.toLowerCase();
  if (SOFTWARE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 'SOFTWARE';
  }
  if (PHYSICAL_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 'PHYSICAL_PROCESS';
  }
  return 'GENERAL';
}

function detectTimeIntent(text: string): TimeIntent {
  const normalized = text.toLowerCase();
  if (/(today|now|currently|present|this week|this weekend|immediately)/.test(normalized)) {
    return 'IMMEDIATE';
  }
  if (/(tomorrow|next|upcoming|future|soon)/.test(normalized)) {
    return 'FUTURE';
  }
  return 'UNKNOWN';
}

function extractEntityHint(text: string): string | undefined {
  const matches = text.match(ENTITY_HINT_PATTERNS);
  if (!matches || matches.length === 0) return undefined;
  return matches[0];
}

export class Router {
  classify(input: { latestMessage: string }): RouterResult {
    const domain = detectDomain(input.latestMessage);
    const timeIntent = detectTimeIntent(input.latestMessage);
    const entityHint = extractEntityHint(input.latestMessage);
    return { domain, timeIntent, entityHint };
  }
}
