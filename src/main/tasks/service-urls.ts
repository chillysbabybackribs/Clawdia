/**
 * Smart URL mapping for common authenticated services.
 *
 * Many services redirect to landing/login pages when you hit their base URL,
 * even with valid session cookies. This module maps base URLs to their
 * authenticated inbox/dashboard views.
 *
 * Only applies to headless task contexts (overridePage is set), not the
 * interactive BrowserView where the user might intentionally navigate to
 * a landing page.
 */

const AUTHENTICATED_URLS: Record<string, string> = {
  'gmail.com':           'https://mail.google.com/mail/u/0/#inbox',
  'mail.google.com':     'https://mail.google.com/mail/u/0/#inbox',
  'yahoo.com':           'https://mail.yahoo.com/d/folders/1',
  'mail.yahoo.com':      'https://mail.yahoo.com/d/folders/1',
  'outlook.com':         'https://outlook.live.com/mail/0/inbox',
  'outlook.live.com':    'https://outlook.live.com/mail/0/inbox',
  'twitter.com':         'https://twitter.com/home',
  'x.com':               'https://x.com/home',
  'reddit.com':          'https://www.reddit.com/',
  'github.com':          'https://github.com/',
  'linkedin.com':        'https://www.linkedin.com/feed/',
  'facebook.com':        'https://www.facebook.com/',
  'instagram.com':       'https://www.instagram.com/',
  'discord.com':         'https://discord.com/channels/@me',
};

/**
 * Resolve a URL to its authenticated counterpart for headless task execution.
 *
 * Only redirects when the URL is a bare domain or root path — if the URL
 * already has a specific path, it's returned as-is.
 *
 * @param url - The URL to potentially resolve
 * @returns The authenticated URL if matched, otherwise the original URL
 */
export function resolveAuthenticatedUrl(url: string): string {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    const hostname = parsed.hostname.replace(/^www\./, '');
    const pathname = parsed.pathname;

    // Only redirect bare domain or root path
    if (pathname !== '/' && pathname !== '') return url;

    const authenticatedUrl = AUTHENTICATED_URLS[hostname];
    if (authenticatedUrl) {
      return authenticatedUrl;
    }
  } catch {
    // Invalid URL — return as-is
  }
  return url;
}
