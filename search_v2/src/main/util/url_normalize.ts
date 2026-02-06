export function normalizeQuery(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s\-':.]/g, ' ')
    .trim();
}

export function sanitizeSearchQuery(text: string, allowSecurity = false): string {
  const normalized = normalizeQuery(text);
  const banned = allowSecurity ? [] : ['cve', 'sandbox', 'oauth', 'token', 'webhook', 'prompt injection'];
  return normalized
    .split(' ')
    .filter((word) => word.length > 0 && !banned.includes(word.toLowerCase()))
    .join(' ')
    .trim();
}
