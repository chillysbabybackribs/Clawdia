import { execFile, spawn } from 'child_process';
import { homedir } from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

export type ContainerRuntime = 'docker' | 'podman';
export type ContainerNetworkMode = 'allow' | 'restricted' | 'none' | 'host';

export interface ContainerMount {
  hostPath: string;
  containerPath?: string;
  readOnly?: boolean;
}

export interface ContainerRuntimeStatus {
  available: boolean;
  runtime: ContainerRuntime | null;
  detail: string;
  checkedAt: number;
}

export interface ContainerCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  networkMode?: ContainerNetworkMode;
  extraMounts?: ContainerMount[];
}

export interface ContainerCommandResult {
  stdout: string;
  stderr: string;
  runtime: ContainerRuntime;
  image: string;
  hostWorkspacePath: string;
  containerWorkspacePath: string;
}

export interface ContainerRunPlan {
  runtime: ContainerRuntime;
  image: string;
  args: string[];
  hostWorkspacePath: string;
  containerWorkspacePath: string;
  networkMode: ContainerNetworkMode;
}

const RUNTIME_CACHE_TTL_MS = 20_000;
let runtimeCache: ContainerRuntimeStatus | null = null;

function execFileSafe(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      resolve({
        ok: !err,
        output: output || (err ? String(err.message || err) : ''),
      });
    });
  });
}

async function checkRuntime(runtime: ContainerRuntime): Promise<ContainerRuntimeStatus> {
  const version = await execFileSafe(runtime, ['--version'], 1_500);
  if (!version.ok) {
    return {
      available: false,
      runtime: null,
      detail: `${runtime} binary unavailable`,
      checkedAt: Date.now(),
    };
  }

  const infoArgs = runtime === 'docker'
    ? ['info', '--format', '{{.ServerVersion}}']
    : ['info', '--format', '{{.Version.Version}}'];
  const info = await execFileSafe(runtime, infoArgs, 2_500);
  if (!info.ok) {
    return {
      available: false,
      runtime: null,
      detail: `${runtime} runtime unavailable`,
      checkedAt: Date.now(),
    };
  }

  return {
    available: true,
    runtime,
    detail: `${runtime} ready (${info.output.split('\n')[0].trim() || 'version unknown'})`,
    checkedAt: Date.now(),
  };
}

export async function detectContainerRuntime(force = false): Promise<ContainerRuntimeStatus> {
  if (!force && runtimeCache && Date.now() - runtimeCache.checkedAt < RUNTIME_CACHE_TTL_MS) {
    return runtimeCache;
  }

  const preferred = String(process.env.CLAWDIA_CONTAINER_RUNTIME || '').trim().toLowerCase();
  const candidates: ContainerRuntime[] = preferred === 'podman'
    ? ['podman', 'docker']
    : preferred === 'docker'
      ? ['docker', 'podman']
      : ['docker', 'podman'];

  for (const runtime of candidates) {
    const status = await checkRuntime(runtime);
    if (status.available) {
      runtimeCache = status;
      return status;
    }
  }

  runtimeCache = {
    available: false,
    runtime: null,
    detail: 'No supported container runtime found (docker/podman).',
    checkedAt: Date.now(),
  };
  return runtimeCache;
}

export function getContainerImage(): string {
  const configured = String(process.env.CLAWDIA_CONTAINER_IMAGE || '').trim();
  return configured || 'node:20-bookworm-slim';
}

export function getContainerNetworkMode(): ContainerNetworkMode {
  const raw = String(process.env.CLAWDIA_CONTAINER_NETWORK || '').trim().toLowerCase();
  if (!raw) return 'allow';
  if (raw === 'none') return 'none';
  if (raw === 'restricted') return 'restricted';
  if (raw === 'host') return 'host';
  return 'allow';
}

async function resolveWorkspacePath(cwd: string): Promise<string> {
  const candidate = path.resolve(cwd || homedir());
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) return candidate;
    return path.dirname(candidate);
  } catch {
    return homedir();
  }
}

function appendMount(args: string[], mount: ContainerMount): void {
  const containerPath = mount.containerPath || '/workspace';
  const suffix = mount.readOnly ? ':ro' : '';
  args.push('-v', `${mount.hostPath}:${containerPath}${suffix}`);
}

export function buildContainerRunPlan(
  runtime: ContainerRuntime,
  image: string,
  hostWorkspacePath: string,
  options?: { networkMode?: ContainerNetworkMode; extraMounts?: ContainerMount[] },
): ContainerRunPlan {
  const containerWorkspacePath = '/workspace';
  const args: string[] = [
    'run',
    '--rm',
    '--init',
    '-i',
    '-w',
    containerWorkspacePath,
    '-e',
    'HOME=/tmp/clawdia',
  ];

  const networkMode = options?.networkMode || 'allow';
  if (networkMode === 'none' || networkMode === 'restricted') {
    args.push('--network=none');
  } else if (networkMode === 'host') {
    args.push('--network=host');
  }

  appendMount(args, { hostPath: hostWorkspacePath, containerPath: containerWorkspacePath, readOnly: false });
  for (const mount of options?.extraMounts || []) {
    if (!mount.hostPath || mount.hostPath === hostWorkspacePath) continue;
    appendMount(args, mount);
  }

  if (process.platform !== 'win32' && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }

  args.push(image, '/bin/sh', '-lc');
  return {
    runtime,
    image,
    args,
    hostWorkspacePath,
    containerWorkspacePath,
    networkMode,
  };
}

export async function executeCommandInContainer(options: ContainerCommandOptions): Promise<ContainerCommandResult> {
  const status = await detectContainerRuntime();
  if (!status.available || !status.runtime) {
    throw new Error(status.detail);
  }

  const runtime = status.runtime;
  const image = getContainerImage();
  const hostWorkspacePath = await resolveWorkspacePath(options.cwd);
  const plan = buildContainerRunPlan(runtime, image, hostWorkspacePath, {
    networkMode: options.networkMode || getContainerNetworkMode(),
    extraMounts: options.extraMounts,
  });
  const args = [...plan.args, options.command];

  return new Promise<ContainerCommandResult>((resolve, reject) => {
    const proc = spawn(runtime, args, {
      cwd: hostWorkspacePath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 500);
      reject(new Error('Container command aborted by user'));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
        return;
      }
      options.signal.addEventListener('abort', abortHandler);
    }

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (proc.exitCode === null) {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 500);
        reject({ killed: true, stdout, stderr, message: `Timeout after ${options.timeoutMs}ms` });
      }, options.timeoutMs);
    }

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      options.onOutput?.(chunk);
    });

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      options.onOutput?.(chunk);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve({
          stdout,
          stderr,
          runtime,
          image,
          hostWorkspacePath,
          containerWorkspacePath: plan.containerWorkspacePath,
        });
      } else {
        reject({ code, stdout, stderr, message: `Exit code: ${code}` });
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject({ stdout, stderr, message: err.message });
    });
  });
}
