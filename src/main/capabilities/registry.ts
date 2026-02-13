import { execFile } from 'child_process';
import { createLogger } from '../logger';
import type { CapabilityDescriptor, CapabilityState } from './contracts';
import { collectExecutables } from './command-analyzer';

const log = createLogger('capability-registry');

const CHECK_TTL_MS = 30_000;

const descriptors = new Map<string, CapabilityDescriptor>();
const aliasToId = new Map<string, string>();
const binaryState = new Map<string, CapabilityState>();

let initialized = false;

function canonicalize(id: string): string {
  return id.trim().toLowerCase();
}

const DEFAULT_CAPABILITIES: CapabilityDescriptor[] = [
  {
    id: 'rg',
    kind: 'binary',
    binary: 'rg',
    aliases: ['ripgrep'],
    description: 'Fast text search (ripgrep).',
    installRecipes: [
      { id: 'apt-ripgrep', method: 'apt', command: 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y ripgrep || DEBIAN_FRONTEND=noninteractive apt-get install -y ripgrep', verified: true, timeoutMs: 120_000 },
    ],
  },
  {
    id: 'jq',
    kind: 'binary',
    binary: 'jq',
    description: 'JSON CLI processor.',
    installRecipes: [
      { id: 'apt-jq', method: 'apt', command: 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y jq || DEBIAN_FRONTEND=noninteractive apt-get install -y jq', verified: true, timeoutMs: 120_000 },
    ],
  },
  {
    id: 'yt-dlp',
    kind: 'binary',
    binary: 'yt-dlp',
    description: 'Media downloader.',
    installRecipes: [
      { id: 'apt-yt-dlp', method: 'apt', command: 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y yt-dlp || DEBIAN_FRONTEND=noninteractive apt-get install -y yt-dlp', verified: true, timeoutMs: 180_000 },
      { id: 'pip-yt-dlp', method: 'pip', command: 'python3 -m pip install --user yt-dlp', verified: false, timeoutMs: 180_000, runInContainer: true },
    ],
  },
  {
    id: 'ffmpeg',
    kind: 'binary',
    binary: 'ffmpeg',
    description: 'Video/audio processing.',
    installRecipes: [
      { id: 'apt-ffmpeg', method: 'apt', command: 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y ffmpeg || DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg', verified: true, timeoutMs: 180_000 },
    ],
  },
  {
    id: 'wget',
    kind: 'binary',
    binary: 'wget',
    description: 'HTTP downloader.',
    installRecipes: [
      { id: 'apt-wget', method: 'apt', command: 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y wget || DEBIAN_FRONTEND=noninteractive apt-get install -y wget', verified: true, timeoutMs: 120_000 },
    ],
  },
  {
    id: 'pnpm',
    kind: 'binary',
    binary: 'pnpm',
    description: 'Node package manager.',
    installRecipes: [
      { id: 'npm-pnpm', method: 'npm', command: 'npm install -g pnpm', verified: false, timeoutMs: 180_000 },
    ],
  },
  {
    id: 'tree',
    kind: 'binary',
    binary: 'tree',
    description: 'Directory tree visualizer.',
    installRecipes: [
      { id: 'apt-tree', method: 'apt', command: 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y tree || DEBIAN_FRONTEND=noninteractive apt-get install -y tree', verified: true, timeoutMs: 120_000 },
    ],
  },
  {
    id: 'fd',
    kind: 'binary',
    binary: 'fd',
    aliases: ['fdfind'],
    description: 'Fast find alternative.',
    installRecipes: [
      { id: 'apt-fd-find', method: 'apt', command: 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y fd-find || DEBIAN_FRONTEND=noninteractive apt-get install -y fd-find', verified: true, timeoutMs: 120_000 },
    ],
  },
];

export function registerCapability(descriptor: CapabilityDescriptor): void {
  const id = canonicalize(descriptor.id);
  descriptors.set(id, descriptor);
  aliasToId.set(id, id);
  if (descriptor.binary) aliasToId.set(canonicalize(descriptor.binary), id);
  for (const alias of descriptor.aliases || []) aliasToId.set(canonicalize(alias), id);
}

export function initializeCapabilityRegistry(): void {
  if (initialized) return;
  for (const descriptor of DEFAULT_CAPABILITIES) registerCapability(descriptor);
  initialized = true;
  log.info(`Initialized capability registry with ${descriptors.size} descriptors`);
}

function resolveDescriptorForExecutable(executable: string): CapabilityDescriptor | null {
  const key = aliasToId.get(canonicalize(executable));
  if (!key) return null;
  return descriptors.get(key) || null;
}

export function getCapability(id: string): CapabilityDescriptor | null {
  const key = aliasToId.get(canonicalize(id));
  if (!key) return null;
  return descriptors.get(key) || null;
}

export function listCapabilities(): CapabilityDescriptor[] {
  return [...descriptors.values()];
}

export async function isBinaryAvailable(binary: string): Promise<boolean> {
  const key = canonicalize(binary);
  const cached = binaryState.get(key);
  const now = Date.now();
  if (cached && now - cached.lastCheckedAt < CHECK_TTL_MS) return cached.available;

  const available = await new Promise<boolean>((resolve) => {
    execFile('bash', ['-lc', `command -v ${binary} >/dev/null 2>&1`], { timeout: 5_000 }, (err) => {
      resolve(!err);
    });
  });

  binaryState.set(key, {
    id: key,
    available,
    lastCheckedAt: now,
    source: 'command -v',
  });

  return available;
}

export function setBinaryState(id: string, available: boolean, detail?: string): void {
  const key = canonicalize(id);
  binaryState.set(key, {
    id: key,
    available,
    lastCheckedAt: Date.now(),
    detail,
    source: 'runtime',
  });
}

export interface CommandCapabilityResolution {
  executables: string[];
  knownCapabilities: CapabilityDescriptor[];
  missingCapabilities: CapabilityDescriptor[];
  unknownExecutables: string[];
}

export async function resolveCommandCapabilities(command: string): Promise<CommandCapabilityResolution> {
  const executables = collectExecutables(command);
  const knownCapabilities: CapabilityDescriptor[] = [];
  const missingCapabilities: CapabilityDescriptor[] = [];
  const unknownExecutables: string[] = [];
  const seenMissing = new Set<string>();

  for (const executable of executables) {
    const descriptor = resolveDescriptorForExecutable(executable);
    if (!descriptor) {
      unknownExecutables.push(executable);
      continue;
    }

    knownCapabilities.push(descriptor);
    const binary = descriptor.binary || executable;
    const available = await isBinaryAvailable(binary);
    if (!available && !seenMissing.has(descriptor.id)) {
      missingCapabilities.push(descriptor);
      seenMissing.add(descriptor.id);
    }
  }

  return { executables, knownCapabilities, missingCapabilities, unknownExecutables };
}
