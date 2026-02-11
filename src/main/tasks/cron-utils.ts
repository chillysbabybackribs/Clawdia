/**
 * Minimal cron parser and interval expression utilities.
 *
 * Supports:
 *  - Standard 5-field cron: minute hour day-of-month month day-of-week
 *  - Wildcards: *
 *  - Steps: * /N  (every N)
 *  - Ranges: A-B
 *  - Lists: A,B,C
 *  - Interval JSON: { "interval_minutes": N } or { "cron": "..." }
 */

// ── Cron field parsing ──────────────────────────────────────────

function parseCronField(field: string, min: number, max: number): number[] {
    const values: Set<number> = new Set();

    for (const part of field.split(',')) {
        const trimmed = part.trim();

        if (trimmed === '*') {
            for (let i = min; i <= max; i++) values.add(i);
        } else if (trimmed.startsWith('*/')) {
            const step = parseInt(trimmed.slice(2), 10);
            if (isNaN(step) || step <= 0) continue;
            for (let i = min; i <= max; i += step) values.add(i);
        } else if (trimmed.includes('-')) {
            const [aStr, bStr] = trimmed.split('-');
            const a = parseInt(aStr, 10);
            const b = parseInt(bStr, 10);
            if (isNaN(a) || isNaN(b)) continue;
            const lo = Math.max(a, min);
            const hi = Math.min(b, max);
            for (let i = lo; i <= hi; i++) values.add(i);
        } else {
            const n = parseInt(trimmed, 10);
            if (!isNaN(n) && n >= min && n <= max) values.add(n);
        }
    }

    return [...values].sort((a, b) => a - b);
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Validates whether a string is a valid 5-field cron expression.
 * Does not accept 6-field (second-level) or 7-field (year) cron.
 */
export function isValidCron(expression: string): boolean {
    if (!expression || typeof expression !== 'string') return false;
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    const limits: [number, number][] = [
        [0, 59],  // minute
        [0, 23],  // hour
        [1, 31],  // day-of-month
        [1, 12],  // month
        [0, 6],   // day-of-week (0=Sunday)
    ];

    for (let i = 0; i < 5; i++) {
        const parsed = parseCronField(fields[i], limits[i][0], limits[i][1]);
        if (parsed.length === 0) return false;
    }

    return true;
}

/**
 * Compute the next occurrence of a cron expression after the given date.
 * Searches up to 366 days ahead — returns null if nothing found (expression
 * is effectively unreachable).
 *
 * @param cronExpression  Standard 5-field cron string
 * @param after           Start time (default: now)
 * @returns               Unix epoch seconds, or null
 */
export function getNextRunTime(cronExpression: string, after?: Date): number | null {
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length !== 5) return null;

    const minutes = parseCronField(fields[0], 0, 59);
    const hours = parseCronField(fields[1], 0, 23);
    const doms = parseCronField(fields[2], 1, 31);
    const months = parseCronField(fields[3], 1, 12);
    const dows = parseCronField(fields[4], 0, 6); // 0=Sunday

    if (!minutes.length || !hours.length || !doms.length || !months.length || !dows.length) {
        return null;
    }

    const now = after ?? new Date();
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    // Start search from current minute, not next minute
    // This allows cron patterns like "*/1 * * * *" to execute correctly

    // Search up to 366 days ahead (in minutes)
    const limit = 366 * 24 * 60;
    for (let i = 0; i < limit; i++) {
        const m = candidate.getMinutes();
        const h = candidate.getHours();
        const dom = candidate.getDate();
        const mon = candidate.getMonth() + 1; // JS months are 0-based
        const dow = candidate.getDay(); // 0=Sunday

        if (
            months.includes(mon) &&
            doms.includes(dom) &&
            dows.includes(dow) &&
            hours.includes(h) &&
            minutes.includes(m)
        ) {
            return Math.floor(candidate.getTime() / 1000);
        }

        candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return null;
}

// ── Trigger config parsing ──────────────────────────────────────

export interface CronTrigger {
    type: 'cron';
    cron: string;
}

export interface IntervalTrigger {
    type: 'interval';
    intervalMinutes: number;
}

export type ParsedTrigger = CronTrigger | IntervalTrigger;

/**
 * Parse a trigger_config string into a structured trigger.
 * Accepts:
 *  - JSON object: { "cron": "..." } or { "interval_minutes": N }
 *  - Plain cron string: "* /5 * * * *"
 */
export function parseTriggerConfig(config: string): ParsedTrigger | null {
    if (!config) return null;
    const trimmed = config.trim();

    // Try JSON first
    if (trimmed.startsWith('{')) {
        try {
            const obj = JSON.parse(trimmed);
            if (typeof obj.cron === 'string' && isValidCron(obj.cron)) {
                return { type: 'cron', cron: obj.cron };
            }
            if (typeof obj.interval_minutes === 'number' && obj.interval_minutes > 0) {
                return { type: 'interval', intervalMinutes: obj.interval_minutes };
            }
            return null;
        } catch {
            return null;
        }
    }

    // Plain cron string
    if (isValidCron(trimmed)) {
        return { type: 'cron', cron: trimmed };
    }

    return null;
}

/**
 * Given a trigger config string, compute the next run time as unix seconds.
 * For intervals, computes based on `lastRunAt` (or now if first run).
 * For cron, delegates to `getNextRunTime`.
 */
export function computeNextRun(
    triggerConfig: string | null,
    lastRunAt?: number | null,
): number | null {
    if (!triggerConfig) return null;

    const parsed = parseTriggerConfig(triggerConfig);
    if (!parsed) return null;

    if (parsed.type === 'cron') {
        return getNextRunTime(parsed.cron);
    }

    // Interval: next = lastRun + interval, or now + interval if no previous run
    const baseSeconds = lastRunAt || Math.floor(Date.now() / 1000);
    const nextSeconds = baseSeconds + parsed.intervalMinutes * 60;

    // If the computed next time is in the past (e.g., app was down), set to now
    const nowSeconds = Math.floor(Date.now() / 1000);
    return nextSeconds > nowSeconds ? nextSeconds : nowSeconds;
}

/**
 * Normalize natural language trigger configs to proper cron expressions.
 * Handles patterns like "every N minutes", "every hour", "daily at 9am", etc.
 * If already valid cron, returns as-is. Otherwise attempts to convert.
 * 
 * @param triggerConfig Raw trigger config string (may be natural language)
 * @returns Normalized cron expression or original if already valid/parseable
 */
export function normalizeTriggerConfig(triggerConfig: string): string {
    if (!triggerConfig || typeof triggerConfig !== 'string') return triggerConfig;
    
    const trimmed = triggerConfig.trim();
    
    // Already valid cron expression — return as-is
    if (isValidCron(trimmed)) {
        return trimmed;
    }
    
    // Already valid JSON format — return as-is
    if (trimmed.startsWith('{')) {
        try {
            const obj = JSON.parse(trimmed);
            if ((obj.cron && isValidCron(obj.cron)) || typeof obj.interval_minutes === 'number') {
                return trimmed;
            }
        } catch {
            // Invalid JSON, try natural language normalization
        }
    }
    
    const lower = trimmed.toLowerCase();
    
    // Pattern: "every N minutes" or "every minute"
    const everyMinutesMatch = lower.match(/every\s+(\d+)?\s*minutes?/);
    if (everyMinutesMatch) {
        const interval = everyMinutesMatch[1] ? parseInt(everyMinutesMatch[1], 10) : 1;
        if (interval > 0 && interval <= 59) {
            return `*/${interval} * * * *`;
        }
    }
    
    // Pattern: "every N seconds" — convert to minutes (round up)
    const everySecondsMatch = lower.match(/every\s+(\d+)\s*seconds?/);
    if (everySecondsMatch) {
        const seconds = parseInt(everySecondsMatch[1], 10);
        if (seconds > 0) {
            const minutes = Math.ceil(seconds / 60);
            if (minutes <= 59) {
                return `*/${minutes} * * * *`;
            }
        }
    }
    
    // Pattern: "every N hours"
    const everyHoursMatch = lower.match(/every\s+(\d+)?\s*hours?/);
    if (everyHoursMatch) {
        const interval = everyHoursMatch[1] ? parseInt(everyHoursMatch[1], 10) : 1;
        if (interval > 0 && interval <= 23) {
            return `0 */${interval} * * *`;
        }
    }
    
    // Pattern: "every N days"
    const everyDaysMatch = lower.match(/every\s+(\d+)?\s*days?/);
    if (everyDaysMatch) {
        const interval = everyDaysMatch[1] ? parseInt(everyDaysMatch[1], 10) : 1;
        if (interval > 0 && interval <= 31) {
            return `0 0 */${interval} * *`;
        }
    }
    
    // Pattern: "hourly"
    if (lower.includes('hourly')) {
        return `0 * * * *`;
    }
    
    // Pattern: "daily" or "every day"
    if (lower.includes('daily') || lower === 'every day') {
        return `0 0 * * *`;
    }
    
    // Pattern: "weekly" or "every week"
    if (lower.includes('weekly') || lower === 'every week') {
        return `0 0 * * 0`; // Sundays at midnight
    }
    
    // Pattern: "every morning" or "daily at 9am" etc
    const timeMatch = lower.match(/(\d{1,2})\s*(?:am|pm)?/);
    if ((lower.includes('morning') || lower.includes('daily')) && timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        if (lower.includes('pm') && hour < 12) hour += 12;
        if (lower.includes('am') && hour === 12) hour = 0;
        if (hour >= 0 && hour <= 23) {
            return `0 ${hour} * * *`;
        }
    }
    
    // Pattern: "every 60 seconds" or "every minute"
    if (lower === 'every minute' || lower === 'every 60 seconds') {
        return `* * * * *`;
    }
    
    // If nothing matched, return original (will be caught by parseTriggerConfig later)
    return trimmed;
}
