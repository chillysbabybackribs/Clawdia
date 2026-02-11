import { ApprovalRequest, ApprovalDecision } from '../../shared/autonomy';

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

    const riskClass = request.risk === 'EXFIL' ? 'risk-exfil' : '';

    container.innerHTML = `
    <div class="approval-panel-header">
      <span class="approval-panel-risk-badge ${riskClass}">${request.risk}</span>
      <span>Approval Needed</span>
    </div>
    <div class="approval-panel-content">
      <div class="approval-panel-tool">${request.tool}</div>
      <div class="approval-panel-reason">${request.reason}</div>
      <div class="approval-panel-detail">${request.detail}</div>
    </div>
    <div class="approval-panel-actions">
      <button class="approval-btn approval-btn--primary" id="approve-once-btn">Approve once</button>
      <button class="approval-btn" id="approve-task-btn">For this task</button>
      <button class="approval-btn" id="approve-always-btn">Always approve</button>
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

    await window.api.sendApprovalResponse(id, decision);
}
