import { DomainId } from './types';
import { sanitizeSearchQuery } from '../util/url_normalize';

const DOMAIN_KEYWORDS: Record<DomainId, string[]> = {
  SOFTWARE: ['security', 'permissions', 'threat model', 'vulnerability', 'sandbox'],
  PHYSICAL_PROCESS: ['safety', 'HACCP', 'contamination', 'sanitation', 'worker safety', 'throughput'],
  GENERAL: ['overview', 'guidance', 'key facts'],
};

const DOMAIN_SUFFIX: Record<DomainId, string> = {
  SOFTWARE: 'security threat model permissions vulnerability analysis',
  PHYSICAL_PROCESS: 'food safety HACCP sanitation contamination workflow throughput',
  GENERAL: 'key facts useful guidance summary',
};

export function deriveCriterionKeywords(domain: DomainId, criterion: string): string[] {
  const tokens = criterion
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  const extras = DOMAIN_KEYWORDS[domain] ?? DOMAIN_KEYWORDS.GENERAL;
  return Array.from(new Set([...extras, ...tokens]));
}

export function buildFollowUpQueries(
  domain: DomainId,
  missingCriteria: string[],
  existingHosts: Set<string>,
  limit = 2
): string[] {
  const queries: string[] = [];
  const hostFilter = Array.from(existingHosts)
    .map((host) => `-site:${host}`)
    .join(' ');
  for (const criterion of missingCriteria) {
    if (queries.length >= limit) break;
    const keywords = deriveCriterionKeywords(domain, criterion).join(' ');
    const suffix = DOMAIN_SUFFIX[domain] || DOMAIN_SUFFIX.GENERAL;
    let raw = `${keywords} ${suffix}`.trim();
    if (existingHosts.size > 0 && existingHosts.size < 2) {
      raw = `${raw} ${hostFilter}`.trim();
    }
    const sanitized = sanitizeSearchQuery(raw, domain === 'SOFTWARE');
    if (!sanitized) continue;
    if (!queries.includes(sanitized)) {
      queries.push(sanitized);
    }
  }
  return queries;
}
