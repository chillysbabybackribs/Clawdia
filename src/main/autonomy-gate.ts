import { randomUUID } from 'crypto';
import {
    AutonomyMode,
    RiskLevel,
    RiskClassification,
    ApprovalDecision,
    ApprovalRequest,
    AutonomyOverrides
} from '../shared/autonomy';
import { store } from './store';
import { createLogger } from './logger';
import { appendAuditEvent } from './audit/audit-store';
import { redactCommand, redactUrl, truncatePreview } from '../shared/audit-types';
import type { DecisionSource } from '../shared/audit-types';

const log = createLogger('autonomy-gate');

// In-memory task approvals (cleared on app restart or new task)
const taskApprovals = new Map<string, Set<RiskLevel>>();

// External resolver for decision source tracking (set by main.ts)
let getDecisionSourceFn: ((requestId: string) => DecisionSource | undefined) | null = null;

/** Set a function that returns the decision source for a requestId. */
export function setDecisionSourceResolver(fn: (requestId: string) => DecisionSource | undefined): void {
    getDecisionSourceFn = fn;
}

// ---------------------------------------------------------------------------
// Shell command classification helpers
// ---------------------------------------------------------------------------

/** Read-only commands that never modify system state */
const READ_ONLY_COMMANDS = new Set([
    'ls', 'pwd', 'whoami', 'date', 'uname', 'id', 'echo',
    'cat', 'head', 'tail', 'wc', 'stat', 'du', 'file',
    'which', 'type', 'env', 'printenv', 'hostname', 'uptime',
    'df', 'free', 'lsb_release', 'arch', 'nproc', 'basename',
    'dirname', 'realpath', 'readlink', 'tee',
]);

/** Shell operators/chaining that could allow piping to destructive commands */
const SHELL_OPERATOR_RE = /[|;&`]|&&|\|\||>>|>\s|<\s|\$\(|\$\{/;

/** Sensitive paths that require approval even for reads */
const SENSITIVE_PATH_PATTERNS = [
    /~\/\.ssh\b/,
    /~\/\.aws\b/,
    /~\/\.gnupg\b/,
    /~\/\.gpg\b/,
    /~\/\.config\b/,
    /\/\.ssh\//,
    /\/\.aws\//,
    /\/\.gnupg\//,
    /\/\.config\//,
    /\/\.mozilla\//,
    /\/\.chrome\//,
    /\/\.chromium\//,
    /\/\.firefox\//,
    /\/\.thunderbird\//,
    /\.env\b/,
    /credential/i,
    /secret/i,
    /token/i,
    /api[_-]?key/i,
    /password/i,
    /\.pem\b/,
    /\.key\b/,
    /id_rsa\b/,
    /id_ed25519\b/,
    /id_ecdsa\b/,
    /known_hosts\b/,
    /authorized_keys\b/,
];

/**
 * Extract the first executable token from a shell command (ignoring env var assignments).
 * e.g. "FOO=bar ls -la" → "ls", "ls -la /home" → "ls"
 */
function extractFirstCommand(command: string): string {
    const trimmed = command.trim();
    // Skip leading env assignments like "FOO=bar BAZ=qux cmd ..."
    const tokens = trimmed.split(/\s+/);
    for (const tok of tokens) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
        return tok.toLowerCase();
    }
    return '';
}

/** Check if `find` is used without destructive flags */
function isSafeFind(command: string): boolean {
    const lower = command.toLowerCase();
    if (!/\bfind\b/.test(lower)) return false;
    // Dangerous find flags
    return !/-delete\b/.test(lower) && !/-exec\b/.test(lower) && !/-execdir\b/.test(lower);
}

/**
 * Classify a tool execution for risk.
 */
export function classifyAction(tool: string, input: Record<string, unknown>): RiskClassification {
    // Shell rules
    if (tool === 'shell_exec') {
        const rawCommand = String(input.command || '');
        const command = rawCommand.toLowerCase();

        // 1. Check for sensitive path reads FIRST — takes priority over EXFIL
        //    (e.g. "cat ~/.ssh/id_rsa" should be SENSITIVE_READ, not EXFIL)
        if (SENSITIVE_PATH_PATTERNS.some(re => re.test(rawCommand))) {
            return {
                risk: 'SENSITIVE_READ',
                reason: 'Accessing sensitive path (credentials, keys, or config).',
                detail: rawCommand
            };
        }

        // 2. Check EXFIL patterns — network tools only as first command token
        const firstCmd = extractFirstCommand(rawCommand);
        const EXFIL_COMMANDS = new Set([
            'curl', 'wget', 'httpie', 'nc', 'ncat', 'scp', 'rsync',
            'ssh', 'sftp', 'ftp', 'telnet',
        ]);
        // Also check for upload keywords anywhere
        const EXFIL_KEYWORD_RE = /\bupload\b/;

        if (EXFIL_COMMANDS.has(firstCmd) || EXFIL_KEYWORD_RE.test(command)) {
            return {
                risk: 'EXFIL',
                reason: 'Network tool detected which could be used to exfiltrate data.',
                detail: rawCommand
            };
        }

        // 3. Check ELEVATED patterns (destructive/privileged)
        const ELEVATED_PATTERNS = [
            /\bsudo\b/,
            /\bapt(-get)?\b/,
            /\bbrew\b/,
            /\bpip(3)?\b/,
            /\bnpm\b/,
            /\byarn\b/,
            /\bpnpm\b/,
            /\brm\b/,
            /\bmv\b/,
            /\bcp\b/,
            /\bmkdir\b/,
            /\btouch\b/,
            /\bmkfs\b/,
            /\bdd\b/,
            /\bpasswd\b/,
            /\bchown\b/,
            /\bchmod\b/,
            /\bsystemctl\b/,
            /\bsysctl\b/,
            /\bkill\b/,
            /\bkillall\b/,
            /\bpkill\b/,
            /\breboot\b/,
            /\bshutdown\b/,
            /\bservice\b/,
            /\bmount\b/,
            /\bumount\b/,
            /\bfdisk\b/,
            /\bparted\b/,
            /\biptables\b/,
            /\bufw\b/,
        ];

        if (ELEVATED_PATTERNS.some(re => re.test(command))) {
            return {
                risk: 'ELEVATED',
                reason: 'Sudo, package manager, or potentially destructive system command detected.',
                detail: rawCommand
            };
        }

        // 4. Check for shell operators/chaining — these can bypass read-only classification
        if (SHELL_OPERATOR_RE.test(rawCommand)) {
            return {
                risk: 'ELEVATED',
                reason: 'Shell operators or command chaining detected. Requires approval for safety.',
                detail: rawCommand
            };
        }

        // 5. Read-only allowlist — must be a known safe command with no operators
        if (READ_ONLY_COMMANDS.has(firstCmd) || (firstCmd === 'find' && isSafeFind(command))) {
            return { risk: 'SAFE', reason: '', detail: '' };
        }

        // 6. Git read-only commands
        if (firstCmd === 'git') {
            const gitReadOps = ['status', 'log', 'diff', 'branch', 'show', 'remote', 'describe', 'rev-parse', 'ls-files', 'ls-tree', 'shortlog', 'tag', 'stash list'];
            const gitSubCmd = command.replace(/^\s*git\s+/, '').split(/\s+/)[0];
            if (gitReadOps.includes(gitSubCmd)) {
                return { risk: 'SAFE', reason: '', detail: '' };
            }
        }

        // 7. Unknown command — classify as ELEVATED to be safe
        return {
            risk: 'ELEVATED',
            reason: 'Unrecognized command. Requires approval in safe mode.',
            detail: rawCommand
        };
    }

    // Browser rules
    if (tool.startsWith('browser_')) {
        const url = String(input.url || '').toLowerCase();
        const SENSITIVE_DOMAINS = [
            'bank', 'paypal', 'stripe', 'coinbase',
            'gmail', 'outlook', 'protonmail', 'mail.google',
            'aws', 'console.cloud.google', 'azure',
            'gov', 'health', 'med', 'hospital'
        ];

        if (url && SENSITIVE_DOMAINS.some(domain => url.includes(domain))) {
            return {
                risk: 'SENSITIVE_DOMAIN',
                reason: 'Attempting to access a sensitive domain (finance, email, cloud, gov, health).',
                detail: url
            };
        }

        // Network exfiltration via script injection or batch fetches
        if (tool === 'browser_batch' || tool === 'browser_interact') {
            // We'll treat batch/interact as complex and potentially risky if URLs are present
            if (url && (url.startsWith('http') || url.includes('://'))) {
                // Check for exfil patterns in input (e.g. upload, POST)
                const raw = JSON.stringify(input).toLowerCase();
                if (raw.includes('upload') || raw.includes('post')) {
                    return {
                        risk: 'EXFIL',
                        reason: 'Complex browser interaction pattern involving data transmission.',
                        detail: url
                    };
                }
            }
        }
    }

    // File writes
    if (tool === 'file_write' || tool === 'file_edit' || tool === 'action_execute_plan') {
        return {
            risk: 'ELEVATED',
            reason: 'File system modification detected.',
            detail: (input.path || input.planId || 'unknown') as string
        };
    }

    return { risk: 'SAFE', reason: '', detail: '' };
}

/**
 * Check if an action is allowed based on current autonomy mode and previous approvals.
 */
export async function shouldAuthorize(
    tool: string,
    input: Record<string, unknown>,
    conversationId: string,
    requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>
): Promise<{ allowed: boolean; error?: string }> {
    const mode = (store.get('autonomyMode') as AutonomyMode) || 'guided';
    const classification = classifyAction(tool, input);

    log.info(`[Gate] mode=${mode} tool=${tool} risk=${classification.risk}`);

    // Build redacted previews for audit
    const rawCmd = (tool === 'shell_exec') ? String(input.command || '') : '';
    const rawUrl = String(input.url || '');
    const cmdPreview = rawCmd ? redactCommand(rawCmd) : undefined;
    const urlPreview = rawUrl ? redactUrl(rawUrl) : undefined;

    // Emit risk_classified event
    if (classification.risk !== 'SAFE') {
        appendAuditEvent({
            ts: Date.now(),
            kind: 'risk_classified',
            conversationId,
            toolName: tool,
            risk: classification.risk,
            riskReason: classification.reason,
            autonomyMode: mode,
            commandPreview: cmdPreview,
            urlPreview: urlPreview,
            detail: truncatePreview(classification.detail || classification.reason, 120),
            outcome: 'info',
        });
    }

    if (mode === 'unrestricted') {
        return { allowed: true };
    }

    if (classification.risk === 'SAFE') {
        return { allowed: true };
    }

    // Check enforcement rules
    let levelRequired = false;
    if (mode === 'safe') {
        // Require approval for ELEVATED, EXFIL, SENSITIVE_DOMAIN, SENSITIVE_READ
        levelRequired = true;
    } else if (mode === 'guided') {
        // Require approval for EXFIL, SENSITIVE_DOMAIN, and SENSITIVE_READ
        // Allow ELEVATED automatically
        if (classification.risk === 'EXFIL' || classification.risk === 'SENSITIVE_DOMAIN' || classification.risk === 'SENSITIVE_READ') {
            levelRequired = true;
        }
    }

    if (!levelRequired) {
        return { allowed: true };
    }

    // Check history/persistence
    // 1. Task level
    if (taskApprovals.get(conversationId)?.has(classification.risk)) {
        log.info(`[Gate] Allowed via task override for ${classification.risk}`);
        return { allowed: true };
    }

    // 2. Global level (settings)
    const globalOverrides = (store.get('autonomyOverrides' as any) as AutonomyOverrides) || {};
    if (globalOverrides[classification.risk]) {
        log.info(`[Gate] Allowed via global override for ${classification.risk}`);
        return { allowed: true };
    }

    // Request approval
    const request: ApprovalRequest = {
        requestId: randomUUID(),
        tool,
        risk: classification.risk,
        reason: classification.reason,
        detail: classification.detail,
        autonomyMode: mode,
        createdAt: Date.now(),
        expiresAt: Date.now() + 90000 // 90 second expiration
    };

    // Emit approval_requested
    appendAuditEvent({
        ts: Date.now(),
        kind: 'approval_requested',
        conversationId,
        requestId: request.requestId,
        toolName: tool,
        risk: classification.risk,
        riskReason: classification.reason,
        autonomyMode: mode,
        commandPreview: cmdPreview,
        urlPreview: urlPreview,
        outcome: 'pending',
    });

    const decision = await requestApproval(request);
    log.info(`[Gate] Decision for ${request.requestId}: ${decision}`);
    const decisionSrc = getDecisionSourceFn?.(request.requestId) || 'desktop';

    switch (decision) {
        case 'APPROVE':
            appendAuditEvent({
                ts: Date.now(),
                kind: 'approval_decided',
                conversationId,
                requestId: request.requestId,
                toolName: tool,
                risk: classification.risk,
                decision: 'APPROVE',
                decisionScope: 'once',
                decisionSource: decisionSrc,
                outcome: 'executed',
                commandPreview: cmdPreview,
                urlPreview: urlPreview,
            });
            return { allowed: true };
        case 'TASK':
            if (!taskApprovals.has(conversationId)) {
                taskApprovals.set(conversationId, new Set());
            }
            taskApprovals.get(conversationId)!.add(classification.risk);
            appendAuditEvent({
                ts: Date.now(),
                kind: 'approval_decided',
                conversationId,
                requestId: request.requestId,
                toolName: tool,
                risk: classification.risk,
                decision: 'TASK',
                decisionScope: 'task',
                decisionSource: decisionSrc,
                outcome: 'executed',
                commandPreview: cmdPreview,
                urlPreview: urlPreview,
            });
            return { allowed: true };
        case 'ALWAYS': {
            const currentOverrides = (store.get('autonomyOverrides' as any) as AutonomyOverrides) || {};
            store.set('autonomyOverrides' as any, { ...currentOverrides, [classification.risk]: true });
            appendAuditEvent({
                ts: Date.now(),
                kind: 'approval_decided',
                conversationId,
                requestId: request.requestId,
                toolName: tool,
                risk: classification.risk,
                decision: 'ALWAYS',
                decisionScope: 'always',
                decisionSource: decisionSrc,
                outcome: 'executed',
                commandPreview: cmdPreview,
                urlPreview: urlPreview,
            });
            appendAuditEvent({
                ts: Date.now(),
                kind: 'override_added',
                risk: classification.risk,
                detail: `Always-approve added for ${classification.risk}`,
                outcome: 'info',
            });
            return { allowed: true };
        }
        case 'DENY':
        default:
            appendAuditEvent({
                ts: Date.now(),
                kind: 'approval_decided',
                conversationId,
                requestId: request.requestId,
                toolName: tool,
                risk: classification.risk,
                decision: 'DENY',
                decisionSource: decisionSrc,
                outcome: 'denied',
                commandPreview: cmdPreview,
                urlPreview: urlPreview,
            });
            return {
                allowed: false,
                error: `User denied tool execution (${classification.reason}).`
            };
    }
}

export function clearTaskApprovals(conversationId: string): void {
    taskApprovals.delete(conversationId);
}
