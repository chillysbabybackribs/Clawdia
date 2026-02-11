
import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir, tmpdir } from 'os';
import { spawn } from 'child_process';
import { session } from 'electron';
import { createLogger } from '../logger';

const log = createLogger('cookie-import');

export interface ImportedCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    secure: boolean;
    httpOnly: boolean;
}

// ── Chrome cookie DB path detection ──────────────────────────

function getCookiePaths(): Array<{ path: string; label: string }> {
    const home = homedir();
    const candidates: Array<{ path: string; label: string }> = [];

    if (process.platform === 'linux') {
        candidates.push(
            { path: path.join(home, '.config/google-chrome/Default/Cookies'), label: 'Chrome' },
            { path: path.join(home, '.config/chromium/Default/Cookies'), label: 'Chromium' },
            { path: path.join(home, '.config/BraveSoftware/Brave-Browser/Default/Cookies'), label: 'Brave' },
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            { path: path.join(home, 'Library/Application Support/Google/Chrome/Default/Cookies'), label: 'Chrome' },
            { path: path.join(home, 'Library/Application Support/Chromium/Default/Cookies'), label: 'Chromium' },
            { path: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies'), label: 'Brave' },
        );
    } else if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
        candidates.push(
            { path: path.join(localAppData, 'Google/Chrome/User Data/Default/Cookies'), label: 'Chrome' },
            { path: path.join(localAppData, 'Chromium/User Data/Default/Cookies'), label: 'Chromium' },
            { path: path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data/Default/Cookies'), label: 'Brave' },
        );
    }

    return candidates;
}

function findCookieDb(): { path: string; label: string } | null {
    for (const candidate of getCookiePaths()) {
        try {
            fs.accessSync(candidate.path, fs.constants.R_OK);
            return candidate;
        } catch { /* not accessible */ }
    }
    return null;
}

function copyToTemp(sourcePath: string): string | null {
    try {
        const tempPath = path.join(tmpdir(), `clawdia-cookies-${Date.now()}.sqlite`);
        fs.copyFileSync(sourcePath, tempPath);
        return tempPath;
    } catch (err: any) {
        log.warn(`[Cookie] Failed to copy cookie DB: ${err?.message || err}`);
        return null;
    }
}

// ── Chrome cookie decryption (Linux) ─────────────────────────

let cachedDecryptionKey: Buffer | null = null;

async function getLinuxDecryptionKey(): Promise<Buffer | null> {
    if (cachedDecryptionKey) return cachedDecryptionKey;

    let password = 'peanuts'; // Chromium default on Linux

    // Try to get the real key from GNOME Keyring
    const secretToolQueries = [
        'secret-tool lookup application chrome',
        'secret-tool lookup xdg:schema chrome_libsecret_os_crypt_password_v2',
    ];

    for (const cmd of secretToolQueries) {
        try {
            const result = await new Promise<string>((resolve, reject) => {
                let stdout = '';
                const proc = spawn('/bin/bash', ['-c', cmd], { timeout: 5000 });
                proc.stdout.on('data', d => stdout += d.toString());
                proc.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Exit ${code}`)));
                proc.on('error', reject);
            });
            if (result) {
                password = result;
                log.info('[Cookie] Retrieved encryption key from GNOME Keyring');
                break;
            }
        } catch {
            // secret-tool not available or key not found — continue
        }
    }

    // Derive AES key using PBKDF2 (Chrome's method)
    try {
        cachedDecryptionKey = crypto.pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
        return cachedDecryptionKey;
    } catch (err: any) {
        log.error(`[Cookie] Failed to derive decryption key: ${err?.message}`);
        return null;
    }
}

async function decryptCookieValue(encryptedValue: Buffer): Promise<string | null> {
    if (!encryptedValue || encryptedValue.length === 0) return '';

    // Chrome prefixes encrypted values with 'v10' or 'v11'
    const prefix = encryptedValue.slice(0, 3).toString('utf8');
    if (prefix !== 'v10' && prefix !== 'v11') {
        // Unencrypted — return as-is
        return encryptedValue.toString('utf8');
    }

    if (process.platform !== 'linux') {
        // macOS/Windows decryption requires platform-specific key retrieval
        // which is more complex. For now, only support Linux.
        log.warn('[Cookie] Cookie decryption only supported on Linux');
        return null;
    }

    const key = await getLinuxDecryptionKey();
    if (!key) return null;

    try {
        const iv = Buffer.alloc(16, 0); // 16 null bytes
        const ciphertext = encryptedValue.slice(3); // Strip 'v10'/'v11' prefix
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(true);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (err: any) {
        // Decryption failure — cookie may use a different key version
        return null;
    }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Import cookies from Chrome for a specific domain.
 * Only imports cookies for the exact domain (and its parent domain).
 *
 * @param domain - The domain to import cookies for (e.g., "github.com")
 * @returns Array of decrypted cookies, or empty array on failure
 */
export async function importCookiesForDomain(domain: string): Promise<ImportedCookie[]> {
    const dbInfo = findCookieDb();
    if (!dbInfo) {
        log.info('[Cookie] No Chrome cookie database found');
        return [];
    }

    const tempPath = copyToTemp(dbInfo.path);
    if (!tempPath) return [];

    let db: InstanceType<typeof Database> | null = null;
    try {
        db = new Database(tempPath, { readonly: true, fileMustExist: true });

        // Match the domain and its parent (.domain.com)
        const cleanDomain = domain.replace(/^\./, '');
        const rows = db.prepare(`
            SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly
            FROM cookies
            WHERE host_key = ? OR host_key = ?
        `).all(cleanDomain, `.${cleanDomain}`) as Array<{
            host_key: string;
            name: string;
            encrypted_value: Buffer;
            path: string;
            expires_utc: number;
            is_secure: number;
            is_httponly: number;
        }>;

        db.close();
        db = null;

        // Clean up temp file
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }

        const cookies: ImportedCookie[] = [];
        let decryptionFailures = 0;

        for (const row of rows) {
            const value = await decryptCookieValue(row.encrypted_value);
            if (value === null) {
                decryptionFailures++;
                continue;
            }

            // Chrome stores expiry as microseconds since 1601-01-01
            // Convert to Unix epoch seconds
            const chromeEpochOffset = 11644473600;
            const expiresUnix = row.expires_utc > 0
                ? Math.floor(row.expires_utc / 1000000) - chromeEpochOffset
                : 0;

            cookies.push({
                name: row.name,
                value,
                domain: row.host_key,
                path: row.path || '/',
                expires: expiresUnix,
                secure: row.is_secure === 1,
                httpOnly: row.is_httponly === 1,
            });
        }

        if (decryptionFailures > 0) {
            log.warn(`[Cookie] ${decryptionFailures}/${rows.length} cookies failed decryption for ${domain}`);
        }

        log.info(`[Cookie] Imported ${cookies.length} cookies for ${domain} from ${dbInfo.label}`);
        return cookies;
    } catch (err: any) {
        log.error(`[Cookie] Failed to read cookie DB: ${err?.message || err}`);
        if (db) {
            try { db.close(); } catch { /* ignore */ }
        }
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        return [];
    }
}

/**
 * Convert imported cookies to Playwright's cookie format and inject into a browser context.
 */
export async function injectCookiesIntoContext(
    page: any, // Playwright Page
    cookies: ImportedCookie[],
): Promise<number> {
    if (!cookies.length || !page) return 0;

    try {
        const context = page.context();
        if (!context) return 0;

        const playwrightCookies = cookies
            .filter(c => c.value) // Skip empty values
            .map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expires > 0 ? c.expires : undefined,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite: 'Lax' as const,
            }));

        await context.addCookies(playwrightCookies);
        log.info(`[Cookie] Injected ${playwrightCookies.length} cookies into browser context`);
        return playwrightCookies.length;
    } catch (err: any) {
        log.error(`[Cookie] Failed to inject cookies: ${err?.message || err}`);
        return 0;
    }
}

/**
 * Extract domains from a task's execution prompt for targeted cookie import.
 * Looks for URLs and common domain references.
 */
export function extractDomainsFromPrompt(prompt: string): string[] {
    const domains = new Set<string>();

    // Match full URLs
    const urlMatches = prompt.match(/https?:\/\/([^/\s]+)/gi);
    if (urlMatches) {
        for (const url of urlMatches) {
            try {
                const hostname = new URL(url).hostname.replace(/^www\./, '');
                domains.add(hostname);
            } catch { /* invalid URL */ }
        }
    }

    // Match common domain patterns like "github.com", "x.com"
    const domainMatches = prompt.match(/\b([a-z0-9-]+\.(?:com|org|net|io|dev|app|co|me|ai))\b/gi);
    if (domainMatches) {
        for (const d of domainMatches) {
            domains.add(d.toLowerCase());
        }
    }

    return [...domains];
}

// ── Playwright Cookie Format ────────────────────────────────────

export interface PlaywrightCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Export cookies from Electron's BrowserView session to Playwright format.
 * Reads cookies from session.defaultSession (used by BrowserView) and converts
 * them to Playwright's cookie schema for injection into isolated contexts.
 *
 * @param url - Optional URL to filter cookies by domain. If not provided, exports all cookies.
 * @returns Promise resolving to array of Playwright-compatible cookies
 */
export async function getElectronSessionCookies(url?: string): Promise<PlaywrightCookie[]> {
    try {
        // Get cookies from Electron's default session (BrowserView session)
        const filter = url ? { url } : {};
        const electronCookies = await session.defaultSession.cookies.get(filter);

        if (!electronCookies || electronCookies.length === 0) {
            log.info('[Cookie] No Electron session cookies found');
            return [];
        }

        const playwrightCookies: PlaywrightCookie[] = [];

        for (const c of electronCookies) {
            // Skip cookies with empty name or value
            if (!c.name || !c.value) continue;

            // Map Electron's sameSite to Playwright format
            // Electron: "unspecified" | "no_restriction" | "lax" | "strict"
            // Playwright: "Strict" | "Lax" | "None"
            let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
            if (c.sameSite === 'strict') sameSite = 'Strict';
            else if (c.sameSite === 'no_restriction' || c.sameSite === 'unspecified') sameSite = 'None';

            // Convert expiration: Electron uses expirationDate (seconds since epoch, optional)
            // Playwright uses expires (seconds since epoch, optional)
            // Session cookies (no expirationDate) are represented as undefined
            const expires = typeof c.expirationDate === 'number' ? c.expirationDate : undefined;

            playwrightCookies.push({
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

        log.info(`[Cookie] Exported ${playwrightCookies.length} cookies from Electron session`);
        return playwrightCookies;
    } catch (err: any) {
        log.error(`[Cookie] Failed to export Electron session cookies: ${err?.message || err}`);
        return [];
    }
}
