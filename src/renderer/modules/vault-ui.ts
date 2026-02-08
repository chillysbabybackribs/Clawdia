
import { IngestionJob } from '../../shared/vault-types';

let statusEl: HTMLElement | null = null;
let statusTextEl: HTMLElement | null = null;
let activeJobs = new Set<string>();

export function initVaultUI(): void {
    statusEl = document.getElementById('vault-status');
    statusTextEl = statusEl?.querySelector('.vault-status-text') || null;

    if (!statusEl) return;

    window.api.onVaultJobUpdate((job: IngestionJob) => {
        handleJobUpdate(job);
    });
}

function handleJobUpdate(job: IngestionJob): void {
    if (job.status === 'pending' || job.status === 'processing') {
        activeJobs.add(job.id);
    } else {
        activeJobs.delete(job.id);

        // Ensure we flash completion or error briefly if it was the last job?
        // Or just let it hide.
    }

    updateStatusDisplay();
}

function updateStatusDisplay(): void {
    if (!statusEl || !statusTextEl) return;

    if (activeJobs.size > 0) {
        statusEl.classList.remove('hidden');
        statusTextEl.textContent = `Ingesting ${activeJobs.size} file${activeJobs.size > 1 ? 's' : ''}...`;
    } else {
        // Delay hiding slightly to prevent flicker
        setTimeout(() => {
            if (activeJobs.size === 0 && statusEl) {
                statusEl.classList.add('hidden');
            }
        }, 2000);
    }
}
