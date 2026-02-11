import { ApprovalRequest, ApprovalDecision } from '../../shared/autonomy';
import { setStreaming, hideThinking } from './stream';

let container: HTMLElement | null = null;
let currentRequestId: string | null = null;

export function initApprovalPanel(): void {
    container = document.getElementById('approval-panel-container');
    if (!container) return;

    // Listen for approval requests from main process
    window.api.onApprovalRequest((request: ApprovalRequest) => {
        showApprovalPanel(request);
    });

    // Global Esc key to deny
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && currentRequestId) {
            handleDecision('DENY');
        }
    });
}

function showApprovalPanel(request: ApprovalRequest): void {
    if (!container) return;
    currentRequestId = request.requestId;

    // Show clean detail without technical code formatting
    const detailText = request.detail.replace(/`/g, '');

    container.innerHTML = `
    <div class="approval-panel-content">
      <div class="approval-panel-warning-icon">⚠</div>
      <div class="approval-panel-main">
        <div class="approval-panel-title">This action requires your approval</div>
        <div class="approval-panel-detail">${detailText}</div>
        <div class="approval-panel-reason">${request.reason}</div>
      </div>
    </div>
    <div class="approval-panel-actions">
      <button class="approval-btn approval-btn--primary" id="approve-once-btn">Approve once</button>
      <button class="approval-btn" id="approve-task-btn">For this task</button>
      <button class="approval-btn" id="approve-always-btn">Always</button>
      <button class="approval-btn approval-btn--danger" id="deny-btn">Deny</button>
    </div>
  `;

    container.classList.remove('hidden');

    // Bind buttons
    document.getElementById('approve-once-btn')?.addEventListener('click', () => handleDecision('APPROVE'));
    document.getElementById('approve-task-btn')?.addEventListener('click', () => handleDecision('TASK'));
    document.getElementById('approve-always-btn')?.addEventListener('click', () => handleDecision('ALWAYS'));
    document.getElementById('deny-btn')?.addEventListener('click', () => handleDecision('DENY'));

    // Auto-scroll chat to bottom if it's near bottom
    const output = document.getElementById('output');
    if (output) {
        output.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
}

async function handleDecision(decision: ApprovalDecision): Promise<void> {
    if (!currentRequestId) return;

    const id = currentRequestId;
    currentRequestId = null;

    if (container) {
        container.classList.add('hidden');
        container.innerHTML = '';
    }

    // Emit event for enhanced activity feed
    const event = new CustomEvent('clawdia:approval:resolved', {
        detail: { decision, requestId: id }
    });
    document.dispatchEvent(event);

    try {
        await window.api.sendApprovalResponse(id, decision);
    } catch (err) {
        // If sending the response fails, reset UI state so user can continue
        console.error('[ApprovalPanel] Failed to send response:', err);
    }

    // When user denies, immediately reset UI so they can type a new message
    if (decision === 'DENY') {
        hideThinking();
        setStreaming(false);
        const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
        if (prompt) {
            prompt.focus();
        }
    }
}
