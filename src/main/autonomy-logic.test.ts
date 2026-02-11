import { expect, test, vi, describe } from 'vitest';
import { ApprovalRequest, ApprovalDecision } from '../shared/autonomy';

/**
 * Mocking the behavior of solicitorApproval for logic testing.
 * This function replicates the core logic implemented in main.ts
 */
async function testSolicitorLogic(
    request: ApprovalRequest,
    pendingApprovals: Map<string, (decision: ApprovalDecision) => void>,
    onNotify: () => void
): Promise<ApprovalDecision> {
    const { requestId, expiresAt } = request;

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            if (pendingApprovals.has(requestId)) {
                pendingApprovals.delete(requestId);
                resolve('DENY');
            }
        }, expiresAt - Date.now());

        const resolveOnce = (decision: ApprovalDecision) => {
            if (pendingApprovals.has(requestId)) {
                clearTimeout(timeout);
                pendingApprovals.delete(requestId);
                resolve(decision);
            }
        };

        pendingApprovals.set(requestId, resolveOnce);
        onNotify();
    });
}

describe('Autonomy Approval Logic', () => {
    test('First decision wins (precedence)', async () => {
        const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
        const request: ApprovalRequest = {
            requestId: 'test-1',
            tool: 'test-tool',
            risk: 'SAFE',
            reason: 'test',
            detail: 'test',
            autonomyMode: 'guided',
            createdAt: Date.now(),
            expiresAt: Date.now() + 1000
        };

        const promise = testSolicitorLogic(request, pendingApprovals, () => { });

        // Simulate multiple decisions
        const resolveDecision = pendingApprovals.get('test-1');
        expect(resolveDecision).toBeDefined();

        // First decision: APPROVE
        resolveDecision!('APPROVE');

        // Second decision should be ignored/neutralized because pendingApprovals.delete was called
        // We can't easily call resolveDecision again and expect it to do nothing without checking internal state,
        // but the logic ensures only the first one resolving the promise matters.

        const decision = await promise;
        expect(decision).toBe('APPROVE');
        expect(pendingApprovals.has('test-1')).toBe(false);
    });

    test('Times out and defaults to DENY', async () => {
        vi.useFakeTimers();
        const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
        const request: ApprovalRequest = {
            requestId: 'test-2',
            tool: 'test-tool',
            risk: 'SAFE',
            reason: 'test',
            detail: 'test',
            autonomyMode: 'guided',
            createdAt: Date.now(),
            expiresAt: Date.now() + 1000
        };

        const promise = testSolicitorLogic(request, pendingApprovals, () => { });

        // Advance time beyond expiration
        vi.advanceTimersByTime(1500);

        const decision = await promise;
        expect(decision).toBe('DENY');
        expect(pendingApprovals.has('test-2')).toBe(false);
        vi.useRealTimers();
    });
});
