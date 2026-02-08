import type { UserAccount } from '../../shared/accounts';
import { executeInBrowserView } from '../browser/manager';
import { findAccount, addAccount, touchAccount } from './account-store';
import { createLogger } from '../logger';

const log = createLogger('account-detector');

interface PlatformDetector {
  platform: string;
  hostPatterns: RegExp[];
  extractJs: string;
}

const PLATFORM_DETECTORS: PlatformDetector[] = [
  {
    platform: 'Gmail',
    hostPatterns: [/^mail\.google\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('[data-email]');
        if (el) return { username: el.getAttribute('data-email'), profileUrl: 'https://mail.google.com' };
        return null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'Yahoo Mail',
    hostPatterns: [/^mail\.yahoo\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('#ybarAccountMenuOpener');
        if (!el) return null;
        const label = el.getAttribute('aria-label') || '';
        const match = label.match(/([^(]+)/);
        return match ? { username: match[1].trim(), profileUrl: 'https://mail.yahoo.com' } : null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'Outlook',
    hostPatterns: [/^outlook\.live\.com$/, /^outlook\.office\d*\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('#mectrl_headerPicture, #meControl [aria-label]');
        if (!el) return null;
        const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        return label ? { username: label, profileUrl: 'https://outlook.live.com' } : null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'Twitter/X',
    hostPatterns: [/^(www\.)?(x|twitter)\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
        if (el) {
          const href = el.getAttribute('href') || '';
          const username = href.replace(/^\\//, '');
          return username ? { username: '@' + username, profileUrl: 'https://x.com/' + username } : null;
        }
        return null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'Reddit',
    hostPatterns: [/^(www\.)?reddit\.com$/, /^(new\.)?reddit\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('#email-collection-tooltip-id, [data-testid="user-drawer-username"]');
        if (el && el.textContent) {
          const u = el.textContent.trim().replace(/^u\\//, '');
          return u ? { username: u, profileUrl: 'https://reddit.com/user/' + u } : null;
        }
        const meta = document.querySelector('meta[name="user-login"]');
        if (meta && meta.content) return { username: meta.content, profileUrl: 'https://reddit.com/user/' + meta.content };
        return null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'GitHub',
    hostPatterns: [/^(www\.)?github\.com$/],
    extractJs: `(() => {
      try {
        const meta = document.querySelector('meta[name="user-login"]');
        if (meta && meta.content) return { username: meta.content, profileUrl: 'https://github.com/' + meta.content };
        return null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'YouTube',
    hostPatterns: [/^(www\.)?youtube\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('#avatar-btn');
        if (!el) return null;
        const label = el.getAttribute('aria-label') || '';
        const match = label.match(/([^-–]+)/);
        return match ? { username: match[1].trim(), profileUrl: 'https://youtube.com' } : null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'LinkedIn',
    hostPatterns: [/^(www\.)?linkedin\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('.feed-identity-module__actor-meta a, .profile-rail-card__actor-link');
        if (el) {
          const href = el.getAttribute('href') || '';
          const text = (el.textContent || '').trim();
          return text ? { username: text, profileUrl: href.startsWith('http') ? href : 'https://linkedin.com' + href } : null;
        }
        return null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'Facebook',
    hostPatterns: [/^(www\.)?facebook\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('[aria-label="Your profile"]');
        if (el) {
          const href = el.getAttribute('href') || '';
          const match = href.match(/facebook\\.com\\/([^/?]+)/);
          const username = match ? match[1] : '';
          return username ? { username, profileUrl: 'https://facebook.com/' + username } : null;
        }
        return null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'Instagram',
    hostPatterns: [/^(www\.)?instagram\.com$/],
    extractJs: `(() => {
      try {
        const meta = document.querySelector('meta[property="al:ios:url"]');
        if (meta && meta.content) {
          const match = meta.content.match(/user\\?username=([^&]+)/);
          if (match) return { username: '@' + match[1], profileUrl: 'https://instagram.com/' + match[1] };
        }
        const link = document.querySelector('a[href*="/accounts/edit/"]');
        if (link) {
          const profileLink = document.querySelector('header a[href^="/"]');
          if (profileLink) {
            const href = profileLink.getAttribute('href') || '';
            const u = href.replace(/\\//g, '');
            return u ? { username: '@' + u, profileUrl: 'https://instagram.com/' + u } : null;
          }
        }
        return null;
      } catch { return null; }
    })()`,
  },
  {
    platform: 'Discord',
    hostPatterns: [/^(www\.)?discord\.com$/, /^(ptb\.|canary\.)?discord\.com$/],
    extractJs: `(() => {
      try {
        const el = document.querySelector('[class*="panelTitleContainer"] [class*="title"]');
        if (el && el.textContent) return { username: el.textContent.trim(), profileUrl: 'https://discord.com' };
        return null;
      } catch { return null; }
    })()`,
  },
];

// Per-domain cooldown to avoid repeated detection on the same site.
const cooldownMap = new Map<string, number>();
const COOLDOWN_MS = 60_000;

function matchPlatform(url: string): PlatformDetector | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  for (const detector of PLATFORM_DETECTORS) {
    for (const pattern of detector.hostPatterns) {
      if (pattern.test(hostname)) return detector;
    }
  }
  return null;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export async function detectAccountOnPage(url: string): Promise<{ platform: string; username: string; profileUrl: string; domain: string } | null> {
  const detector = matchPlatform(url);
  if (!detector) return null;

  const result = await executeInBrowserView<{ username?: string; profileUrl?: string } | null>(detector.extractJs);
  if (!result || !result.username) return null;

  return {
    platform: detector.platform,
    username: result.username,
    profileUrl: result.profileUrl || url,
    domain: getDomain(url),
  };
}

export async function tryDetectAndMerge(url: string): Promise<void> {
  const domain = getDomain(url);
  if (!domain) return;

  // Cooldown check
  const lastCheck = cooldownMap.get(domain) ?? 0;
  if (Date.now() - lastCheck < COOLDOWN_MS) return;
  cooldownMap.set(domain, Date.now());

  // Small delay to let the page render before extracting.
  await new Promise((r) => setTimeout(r, 1000));

  try {
    const detected = await detectAccountOnPage(url);
    if (!detected) return;

    const existing = findAccount(detected.domain, detected.username);
    if (existing) {
      touchAccount(existing.id);
      log.debug(`Account refreshed: ${existing.platform} — ${existing.username}`);
      return;
    }

    addAccount({
      domain: detected.domain,
      platform: detected.platform,
      username: detected.username,
      profileUrl: detected.profileUrl,
      isManual: false,
    });
  } catch (err: any) {
    log.debug(`Account detection failed for ${domain}: ${err?.message}`);
  }
}
