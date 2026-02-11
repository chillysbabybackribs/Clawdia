/**
 * Privacy filter for ambient browser history data.
 * Strips sensitive domains before data reaches the Haiku prompt.
 */

const SENSITIVE_PATTERNS: RegExp[] = [
  // Banking & finance
  /bank/i,
  /chase\.com/i,
  /wellsfargo/i,
  /capitalone/i,
  /venmo/i,
  /paypal/i,
  /fidelity/i,
  /schwab/i,
  /robinhood/i,
  /coinbase/i,

  // Health & medical
  /health/i,
  /patient/i,
  /medical/i,
  /pharmacy/i,
  /myChart/i,

  // Adult content
  /pornhub/i,
  /xvideos/i,
  /xnxx/i,
  /onlyfans/i,
  /xhamster/i,

  // Webmail content pages (domain-level email mentions are fine)
  /mail\.google\.com/i,
  /outlook\.live\.com/i,
];

export function isSensitiveDomain(domain: string): boolean {
  return SENSITIVE_PATTERNS.some(re => re.test(domain));
}

export function filterSensitiveDomains<T extends { domain: string }>(items: T[]): T[] {
  return items.filter(item => !isSensitiveDomain(item.domain));
}

export function filterSensitiveUrls<T extends { url: string }>(items: T[]): T[] {
  return items.filter(item => !SENSITIVE_PATTERNS.some(re => re.test(item.url)));
}
