import { AUTONOMY_MODES, DEFAULT_AUTONOMY_MODE } from '../../shared/autonomy';
import type { AutonomyMode } from '../../shared/autonomy';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentMode: AutonomyMode = DEFAULT_AUTONOMY_MODE;
let unrestrictedConfirmed = false;
let popoverOpen = false;
let highlightedIndex = -1;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let holdStart = 0;
let holdRafId: number | null = null;

// DOM refs created at init time
let triggerEl: HTMLButtonElement;
let popoverEl: HTMLDivElement;

// ---------------------------------------------------------------------------
// Public getters
// ---------------------------------------------------------------------------

export function getAutonomyMode(): AutonomyMode {
  return currentMode;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function initAutonomyMode(): Promise<void> {
  triggerEl = document.getElementById('autonomy-trigger') as HTMLButtonElement;
  popoverEl = document.getElementById('autonomy-popover') as HTMLDivElement;

  if (!triggerEl || !popoverEl) return;

  // Load persisted state
  try {
    const result = await window.api.getAutonomyMode();
    if (result?.mode) currentMode = result.mode as AutonomyMode;
    if (result?.unrestrictedConfirmed) unrestrictedConfirmed = true;
  } catch { /* use defaults */ }

  syncLabel();

  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popoverOpen) {
      closePopover();
    } else {
      openPopover();
    }
  });

  document.addEventListener('click', (e) => {
    if (popoverOpen && !popoverEl.contains(e.target as Node) && !triggerEl.contains(e.target as Node)) {
      closePopover();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!popoverOpen) return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        closePopover();
        triggerEl.focus();
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveHighlight(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveHighlight(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < AUTONOMY_MODES.length) {
          void selectMode(AUTONOMY_MODES[highlightedIndex].id);
        }
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Label sync
// ---------------------------------------------------------------------------

function syncLabel(): void {
  if (!triggerEl) return;
  const opt = AUTONOMY_MODES.find((m) => m.id === currentMode);
  triggerEl.textContent = opt ? opt.label : 'Guided';
}

// ---------------------------------------------------------------------------
// Popover open / close
// ---------------------------------------------------------------------------

function openPopover(): void {
  renderPopoverList();
  popoverEl.classList.remove('hidden');
  popoverOpen = true;
  highlightedIndex = AUTONOMY_MODES.findIndex((m) => m.id === currentMode);
  updateHighlight();
}

export function closePopover(): void {
  popoverEl.classList.add('hidden');
  popoverOpen = false;
  highlightedIndex = -1;
  cancelHold();
}

// ---------------------------------------------------------------------------
// Render list
// ---------------------------------------------------------------------------

function renderPopoverList(): void {
  popoverEl.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'autonomy-list';
  list.setAttribute('role', 'listbox');

  for (const opt of AUTONOMY_MODES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `autonomy-item${opt.id === currentMode ? ' active' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(opt.id === currentMode));
    item.dataset.mode = opt.id;

    const check = document.createElement('span');
    check.className = 'autonomy-item-check';
    check.textContent = opt.id === currentMode ? '\u2713' : '';

    const textWrap = document.createElement('div');
    textWrap.className = 'autonomy-item-text';

    const label = document.createElement('span');
    label.className = 'autonomy-item-label';
    label.textContent = opt.label;

    const desc = document.createElement('span');
    desc.className = 'autonomy-item-desc';
    desc.textContent = opt.description;

    textWrap.appendChild(label);
    textWrap.appendChild(desc);
    item.appendChild(check);
    item.appendChild(textWrap);

    if (opt.id === 'unrestricted') {
      const warn = document.createElement('span');
      warn.className = 'autonomy-item-warn';
      warn.textContent = '\u26a0';
      item.appendChild(warn);
    }

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      void selectMode(opt.id);
    });

    list.appendChild(item);
  }

  popoverEl.appendChild(list);
}

// ---------------------------------------------------------------------------
// Selection logic
// ---------------------------------------------------------------------------

async function selectMode(mode: AutonomyMode): Promise<void> {
  if (mode === 'unrestricted' && !unrestrictedConfirmed) {
    showConfirmUI();
    return;
  }

  try {
    const result = await window.api.setAutonomyMode(mode);
    if (result?.success) {
      currentMode = mode;
      syncLabel();
      closePopover();
    }
  } catch (err) {
    console.error('[autonomy] Failed to set mode:', err);
  }
}

// ---------------------------------------------------------------------------
// Highlight (keyboard nav)
// ---------------------------------------------------------------------------

function moveHighlight(delta: number): void {
  const count = AUTONOMY_MODES.length;
  if (highlightedIndex < 0) {
    highlightedIndex = delta > 0 ? 0 : count - 1;
  } else {
    highlightedIndex = (highlightedIndex + delta + count) % count;
  }
  updateHighlight();
}

function updateHighlight(): void {
  const items = popoverEl.querySelectorAll('.autonomy-item');
  items.forEach((el, i) => {
    el.classList.toggle('highlighted', i === highlightedIndex);
  });
}

// ---------------------------------------------------------------------------
// Unrestricted confirmation UI (hold-to-confirm)
// ---------------------------------------------------------------------------

function showConfirmUI(): void {
  // Replace popover content with confirmation
  popoverEl.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'autonomy-confirm';

  const title = document.createElement('div');
  title.className = 'autonomy-confirm-title';
  title.textContent = 'Enable Unrestricted Mode?';

  const desc = document.createElement('div');
  desc.className = 'autonomy-confirm-desc';
  desc.textContent = 'No guardrails. Full autonomy. All actions will execute without confirmation.';

  const holdBtn = document.createElement('button');
  holdBtn.type = 'button';
  holdBtn.className = 'autonomy-confirm-hold';

  const progress = document.createElement('div');
  progress.className = 'autonomy-confirm-progress';
  holdBtn.appendChild(progress);

  const holdLabel = document.createElement('span');
  holdLabel.className = 'autonomy-confirm-hold-label';
  holdLabel.textContent = 'Hold to confirm';
  holdBtn.appendChild(holdLabel);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'autonomy-confirm-cancel';
  cancelBtn.textContent = 'Cancel';

  wrap.appendChild(title);
  wrap.appendChild(desc);
  wrap.appendChild(holdBtn);
  wrap.appendChild(cancelBtn);
  popoverEl.appendChild(wrap);

  // Hold-to-confirm logic (1.5s)
  const HOLD_DURATION = 1500;

  function startHold(e: Event): void {
    e.preventDefault();
    holdStart = Date.now();
    holdBtn.classList.add('holding');

    function tick(): void {
      const elapsed = Date.now() - holdStart;
      const pct = Math.min(elapsed / HOLD_DURATION, 1);
      progress.style.width = `${pct * 100}%`;

      if (pct >= 1) {
        cancelHold();
        void confirmUnrestricted();
        return;
      }
      holdRafId = requestAnimationFrame(tick);
    }
    holdRafId = requestAnimationFrame(tick);
  }

  function stopHold(): void {
    cancelHold();
    progress.style.width = '0%';
    holdBtn.classList.remove('holding');
  }

  holdBtn.addEventListener('mousedown', startHold);
  holdBtn.addEventListener('touchstart', startHold, { passive: false });
  holdBtn.addEventListener('mouseup', stopHold);
  holdBtn.addEventListener('mouseleave', stopHold);
  holdBtn.addEventListener('touchend', stopHold);
  holdBtn.addEventListener('touchcancel', stopHold);

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Go back to mode list
    openPopover();
  });
}

function cancelHold(): void {
  if (holdRafId !== null) {
    cancelAnimationFrame(holdRafId);
    holdRafId = null;
  }
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

async function confirmUnrestricted(): Promise<void> {
  try {
    const result = await window.api.setAutonomyMode('unrestricted', true);
    if (result?.success) {
      unrestrictedConfirmed = true;
      currentMode = 'unrestricted';
      syncLabel();
      closePopover();
    }
  } catch (err) {
    console.error('[autonomy] Failed to confirm unrestricted:', err);
  }
}
