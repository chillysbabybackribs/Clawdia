import { elements } from './state';

// ---------------------------------------------------------------------------
// Ambient Settings UI
// ---------------------------------------------------------------------------

interface AmbientSettings {
  enabled: boolean;
  browserHistory: boolean;
  filesystemScan: boolean;
  gitScan: boolean;
  shellHistory: boolean;
  recentFiles: boolean;
  scanRoots: string[];
  browserHistoryHours: number;
}

let currentScanRoots: string[] = [];

function renderScanRootsList(): void {
  const list = elements.ambientScanRootsList;
  list.innerHTML = '';
  for (const root of currentScanRoots) {
    const row = document.createElement('div');
    row.className = 'ambient-scan-root-item';

    const label = document.createElement('span');
    label.className = 'ambient-scan-root-path';
    label.textContent = root;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ambient-scan-root-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      currentScanRoots = currentScanRoots.filter(r => r !== root);
      renderScanRootsList();
    });

    row.appendChild(label);
    row.appendChild(removeBtn);
    list.appendChild(row);
  }
}

function updateSubTogglesVisibility(): void {
  const enabled = elements.ambientMasterToggle.checked;
  elements.ambientSubToggles.style.opacity = enabled ? '1' : '0.4';
  elements.ambientSubToggles.style.pointerEvents = enabled ? 'auto' : 'none';
}

export function initAmbientSettingsUI(): void {
  elements.ambientMasterToggle.addEventListener('change', updateSubTogglesVisibility);

  elements.ambientScanRootAddBtn.addEventListener('click', () => {
    const val = elements.ambientScanRootInput.value.trim();
    if (!val) return;
    if (currentScanRoots.includes(val)) {
      elements.ambientScanRootInput.value = '';
      return;
    }
    currentScanRoots.push(val);
    elements.ambientScanRootInput.value = '';
    renderScanRootsList();
  });

  elements.ambientScanRootInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      elements.ambientScanRootAddBtn.click();
    }
  });
}

export async function loadAmbientSettings(): Promise<void> {
  try {
    const settings: AmbientSettings = await window.api.getAmbientSettings();
    elements.ambientMasterToggle.checked = settings.enabled;
    elements.ambientBrowserHistory.checked = settings.browserHistory;
    elements.ambientFilesystemScan.checked = settings.filesystemScan;
    elements.ambientGitScan.checked = settings.gitScan;
    elements.ambientShellHistory.checked = settings.shellHistory;
    elements.ambientRecentFiles.checked = settings.recentFiles;
    currentScanRoots = [...settings.scanRoots];
    renderScanRootsList();
    updateSubTogglesVisibility();
  } catch {
    // Ignore load failures — defaults are already set in HTML
  }
}

export async function saveAmbientSettings(): Promise<void> {
  const settings: AmbientSettings = {
    enabled: elements.ambientMasterToggle.checked,
    browserHistory: elements.ambientBrowserHistory.checked,
    filesystemScan: elements.ambientFilesystemScan.checked,
    gitScan: elements.ambientGitScan.checked,
    shellHistory: elements.ambientShellHistory.checked,
    recentFiles: elements.ambientRecentFiles.checked,
    scanRoots: [...currentScanRoots],
    browserHistoryHours: 48,
  };
  await window.api.setAmbientSettings(settings as unknown as Record<string, unknown>);
}
