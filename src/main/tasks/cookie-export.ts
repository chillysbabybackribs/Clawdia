/**
 * Unified cookie export for headless task contexts.
 *
 * Priority: Electron session cookies (from BrowserView) > Chrome OS cookies (fallback).
 * Every call exports FRESH cookies — no caching between task runs.
 */

import { session } from 'electron';
import { importCookiesForDomain, extractDomainsFromPrompt } from './cookie-import';
import type { PlaywrightCookie } from './cookie-import';
import { createLogger } from '../logger';

const log = createLogger('cookie-export');

// Common auth cookie names by service — used to detect if Electron has meaningful cookies
const AUTH_COOKIE_NAMES: Record<string, string[]> = {
  'google.com':   ['SID', 'SSID', 'APISID', 'SAPISID', 'HSID', '__Secure-1PSID', '__Secure-3PSID'],
  'yahoo.com':    ['Y', 'T', 'A3', 'GUC'],
  'outlook.com':  ['WLSSC', 'MSPAuth', 'MSPProf'],
  'github.com':   ['user_session', '_gh_sess', 'logged_in'],
  'twitter.com':  ['auth_token', 'ct0'],
  'x.com':        ['auth_token', 'ct0'],
  'reddit.com':   ['reddit_session', 'token_v2'],
  'facebook.com': ['c_user', 'xs', 'datr'],
  'linkedin.com': ['li_at', 'JSESSIONID'],
  'discord.com':  ['__dcfduid', '__sdcfduid'],
};

/**
 * Export cookies from Electron's BrowserView session to Playwright format.
 * This reads from session.defaultSession — the same session the user browses with.
 */
export async function exportElectronCookies(url?: string): Promise<PlaywrightCookie[]> {
  try {
    // Get all cookies, then optionally also domain-specific ones
    const allCookies = await session.defaultSession.cookies.get({});
    let domainCookies: Electron.Cookie[] = [];

    if (url) {
      try {
        domainCookies = await session.defaultSession.cookies.get({ url });
      } catch { /* domain filter failed — use all cookies */ }
    }

    // Merge: domain-specific cookies + all cookies (dedup by name+domain)
    const seen = new Set<string>();
    const merged: Electron.Cookie[] = [];

    // Domain-specific first (higher priority)
    for (const c of domainCookies) {
      const key = `${c.domain}:${c.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(c);
      }
    }
    // Then all cookies
    for (const c of allCookies) {
      const key = `${c.domain}:${c.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(c);
      }
    }

    const result: PlaywrightCookie[] = [];

    for (const c of merged) {
      if (!c.name || !c.value) continue;

      let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
      if (c.sameSite === 'strict') sameSite = 'Strict';
      else if (c.sameSite === 'no_restriction') sameSite = 'None';
      // 'unspecified' → keep as Lax (safest default for cross-context injection)

      const expires = typeof c.expirationDate === 'number' ? c.expirationDate : -1;

      result.push({
        name: c.name,
        value: c.value,
        domain: c.domain || '',
        path: c.path || '/',
        expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite,
      });
    }

    if (url) {
      const hostname = safeHostname(url);
      log.info(`[CookieExport] Exported ${result.length} cookies from Electron session (${domainCookies.length} for ${hostname})`);
    } else {
      log.info(`[CookieExport] Exported ${result.length} cookies from Electron session`);
    }

    return result;
  } catch (err: any) {
    log.error(`[CookieExport] Failed to export Electron session cookies: ${err?.message || err}`);
    return [];
  }
}

/**
 * Export cookies from the OS Chrome browser (SQLite DB, decrypted).
 * This is the FALLBACK source — only used when Electron session has no cookies for the target domain.
 */
export function exportChromeCookies(url?: string): PlaywrightCookie[] {
  if (!url) return [];

  try {
    const hostname = safeHostname(url);
    if (!hostname) return [];

    // Extract relevant domains from URL
    const domains = extractDomainsFromUrl(hostname);

    const allCookies: PlaywrightCookie[] = [];
    for (const domain of domains) {
      const imported = importCookiesForDomain(domain);
      for (const c of imported) {
        allCookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires > 0 ? c.expires : -1,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: 'Lax',
        });
      }
    }

    if (allCookies.length > 0) {
      log.info(`[CookieExport] Exported ${allCookies.length} cookies from Chrome OS for ${hostname}`);
    }
    return allCookies;
  } catch (err: any) {
    log.warn(`[CookieExport] Failed to export Chrome OS cookies: ${err?.message || err}`);
    return [];
  }
}

/**
 * Get the best available cookies for a headless task.
 *
 * Strategy:
 * 1. Export ALL Electron session cookies (user's active browsing session)
 * 2. If URL provided, check if Electron has auth cookies for that domain
 * 3. If not, try Chrome OS cookies as fallback
 * 4. Merge with Electron cookies taking priority for duplicates
 */
export async function getCookiesForTask(url?: string): Promise<PlaywrightCookie[]> {
  // Step 1: Get Electron session cookies (always fresh, never cached)
  const electronCookies = await exportElectronCookies(url);

  if (!url) {
    // No target URL — just return all Electron cookies
    if (electronCookies.length > 0) {
      log.info(`[CookieExport] Using ${electronCookies.length} Electron session cookies (no target URL)`);
    }
    return electronCookies;
  }

  // Step 2: Check if Electron has meaningful cookies for the target domain
  const hostname = safeHostname(url);
  if (hostname && hasAuthCookies(electronCookies, hostname)) {
    log.info(`[CookieExport] Using Electron session cookies for ${hostname} (auth cookies found)`);
    return electronCookies;
  }

  // Count domain-specific cookies from Electron
  const domainCookieCount = countDomainCookies(electronCookies, hostname || '');
  if (domainCookieCount > 3) {
    // Has several cookies for the domain — probably sufficient even without known auth cookie names
    log.info(`[CookieExport] Using Electron session cookies for ${hostname} (${domainCookieCount} domain cookies)`);
    return electronCookies;
  }

  // Step 3: Electron doesn't have enough cookies for this domain — try Chrome OS fallback
  const chromeCookies = exportChromeCookies(url);
  if (chromeCookies.length === 0) {
    // Chrome fallback also empty — return whatever Electron had
    if (electronCookies.length > 0) {
      log.info(`[CookieExport] Using Electron session cookies (Chrome OS fallback empty) for ${hostname}`);
    } else {
      log.warn(`[CookieExport] No cookies found for ${hostname} from any source`);
    }
    return electronCookies;
  }

  // Step 4: Merge — Electron cookies take priority for duplicates
  const merged = mergeCookies(electronCookies, chromeCookies);
  log.info(`[CookieExport] Merged cookies for ${hostname}: ${electronCookies.length} Electron + ${chromeCookies.length} Chrome → ${merged.length} total`);
  return merged;
}

/**
 * Get cookies for a task based on the execution prompt (extracts domains from text).
 * Convenience wrapper that extracts target URLs from the prompt.
 */
export async function getCookiesForPrompt(prompt: string): Promise<PlaywrightCookie[]> {
  const domains = extractDomainsFromPrompt(prompt);
  if (domains.length === 0) {
    return getCookiesForTask();
  }
  // Get cookies for the first domain (primary target)
  const primaryUrl = `https://${domains[0]}`;
  return getCookiesForTask(primaryUrl);
}

/**
 * Log a diagnostic summary of available Electron session cookies.
 * Call at app startup to verify cookies are accessible.
 */
export async function logCookieDiagnostic(): Promise<void> {
  try {
    const cookies = await session.defaultSession.cookies.get({});
    if (cookies.length === 0) {
      log.info('[CookieDiag] Electron session: 0 cookies (user has not browsed any sites yet)');
      return;
    }

    // Group by domain
    const domainCounts = new Map<string, number>();
    for (const c of cookies) {
      const domain = (c.domain || 'unknown').replace(/^\./, '');
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    }

    // Sort by count descending, take top 15
    const sorted = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const summary = sorted.map(([d, n]) => `${d} (${n})`).join(', ');

    log.info(`[CookieDiag] Electron session: ${cookies.length} cookies across ${domainCounts.size} domains: ${summary}`);
  } catch (err: any) {
    log.warn(`[CookieDiag] Failed to read cookies: ${err?.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────

function safeHostname(url: string): string | null {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function extractDomainsFromUrl(hostname: string): string[] {
  const domains = [hostname];
  // Also try parent domain (e.g., mail.google.com → google.com)
  const parts = hostname.split('.');
  if (parts.length > 2) {
    domains.push(parts.slice(-2).join('.'));
  }
  return domains;
}

function hasAuthCookies(cookies: PlaywrightCookie[], hostname: string): boolean {
  // Check known auth cookie names for this service
  const parts = hostname.split('.');
  const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;

  const knownNames = AUTH_COOKIE_NAMES[baseDomain] || AUTH_COOKIE_NAMES[hostname];
  if (!knownNames) return false;

  const cookieNames = new Set(cookies.filter(c => {
    const cDomain = (c.domain || '').replace(/^\./, '');
    return cDomain === hostname || cDomain === baseDomain || hostname.endsWith(`.${cDomain}`);
  }).map(c => c.name));

  return knownNames.some(name => cookieNames.has(name));
}

function countDomainCookies(cookies: PlaywrightCookie[], hostname: string): number {
  if (!hostname) return 0;
  const parts = hostname.split('.');
  const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;

  return cookies.filter(c => {
    const cDomain = (c.domain || '').replace(/^\./, '');
    return cDomain === hostname || cDomain === baseDomain || hostname.endsWith(`.${cDomain}`);
  }).length;
}

function mergeCookies(primary: PlaywrightCookie[], secondary: PlaywrightCookie[]): PlaywrightCookie[] {
  const seen = new Set<string>();
  const result: PlaywrightCookie[] = [];

  // Primary (Electron) takes priority
  for (const c of primary) {
    const key = `${c.domain}:${c.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }

  // Secondary (Chrome OS) fills gaps
  for (const c of secondary) {
    const key = `${c.domain}:${c.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }

  return result;
}
