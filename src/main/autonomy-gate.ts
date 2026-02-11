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

const log = createLogger('autonomy-gate');

// In-memory task approvals (cleared on app restart or new task)
const taskApprovals = new Map<string, Set<RiskLevel>>();

/**
 * Classify a tool execution for risk.
 */
export function classifyAction(tool: string, input: Record<string, unknown>): RiskClassification {
    // Shell rules
    if (tool === 'shell_exec') {
        const command = String(input.command || '').toLowerCase();

        const ELEVATED_PATTERNS = [
            /\bsudo\b/,
            /\bapt(-get)?\b/,
            /\bbrew\b/,
            /\bpip(3)?\b/,
            /\bnpm\b/,
            /\byarn\b/,
            /\bpnpm\b/,
            /\brm\b\s+(-r|--recursive)/,
            /\bmkfs\b/,
            /\bdd\b/,
            /\bpasswd\b/,
            /\bchown\b/,
            /\bchmod\b/,
            /\bsystemctl\b/,
            /\bsysctl\b/
        ];

        const EXFIL_PATTERNS = [
            /\bcurl\b/,
            /\bwget\b/,
            /\bhttpie\b/,
            /\bnc\b/,
            /\bscp\b/,
            /\brsync\b/,
            /\bssh\b/,
            /\bfp\b/,
            /\bupload\b/
        ];

        if (ELEVATED_PATTERNS.some(re => re.test(command))) {
            return {
                risk: 'ELEVATED',
                reason: 'Sudo, package manager, or potentially destructive system command detected.',
                detail: input.command as string
            };
        }

        if (EXFIL_PATTERNS.some(re => re.test(command))) {
            return {
                risk: 'EXFIL',
                reason: 'Network tool detected which could be used to exfiltrate data.',
                detail: input.command as string
            };
        }
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

    if (mode === 'unrestricted') {
        return { allowed: true };
    }

    if (classification.risk === 'SAFE') {
        return { allowed: true };
    }

    // Check enforcement rules
    let levelRequired = false;
    if (mode === 'safe') {
        // Require approval for ELEVATED, EXFIL, SENSITIVE_DOMAIN
        levelRequired = true;
    } else if (mode === 'guided') {
        // Require approval for EXFIL and SENSITIVE_DOMAIN
        // Allow ELEVATED automatically
        if (classification.risk === 'EXFIL' || classification.risk === 'SENSITIVE_DOMAIN') {
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

    const decision = await requestApproval(request);
    log.info(`[Gate] Decision for ${request.requestId}: ${decision}`);

    switch (decision) {
        case 'APPROVE':
            return { allowed: true };
        case 'TASK':
            if (!taskApprovals.has(conversationId)) {
                taskApprovals.set(conversationId, new Set());
            }
            taskApprovals.get(conversationId)!.add(classification.risk);
            return { allowed: true };
        case 'ALWAYS':
            const currentOverrides = (store.get('autonomyOverrides' as any) as AutonomyOverrides) || {};
            store.set('autonomyOverrides' as any, { ...currentOverrides, [classification.risk]: true });
            return { allowed: true };
        case 'DENY':
        default:
            return {
                allowed: false,
                error: `User denied tool execution (${classification.reason}).`
            };
    }
}

export function clearTaskApprovals(conversationId: string): void {
    taskApprovals.delete(conversationId);
}
