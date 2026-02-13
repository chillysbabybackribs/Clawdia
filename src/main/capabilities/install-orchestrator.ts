import { execFile } from 'child_process';
import { createLogger } from '../logger';
import {
  getCapability,
  isBinaryAvailable,
  resolveCommandCapabilities,
  setBinaryState,
} from './registry';
import type {
  CapabilityDescriptor,
  CapabilityEvent,
  InstallAttempt,
  InstallResult,
  TrustPolicy,
} from './contracts';

const log = createLogger('install-orchestrator');

const INSTALL_FAILURE_COOLDOWN_MS = 10 * 60_000;
const failureCooldown = new Map<string, number>();

interface CommandResult {
  ok: boolean;
  durationMs: number;
  output: string;
}

function runInstallCommand(command: string, timeoutMs: number): Promise<CommandResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile('bash', ['-lc', command], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const durationMs = Math.round(performance.now() - started);
      const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ ok: !err, durationMs, output: output || '[no output]' });
    });
  });
}

function filterRecipes(capability: CapabilityDescriptor, trustPolicy: TrustPolicy) {
  const recipes = capability.installRecipes || [];
  if (trustPolicy === 'best_effort') return recipes;
  if (trustPolicy === 'strict_verified') return recipes.filter((r) => r.verified);
  // verified_fallback keeps all recipes but naturally tries them in declared order.
  return recipes;
}

function emit(event: CapabilityEvent, onEvent?: (event: CapabilityEvent) => void): void {
  try {
    onEvent?.(event);
  } catch {
    // swallow emitter errors
  }
}

export interface EnsureCapabilityOptions {
  trustPolicy?: TrustPolicy;
  onEvent?: (event: CapabilityEvent) => void;
}

export async function ensureCapabilityInstalled(
  capabilityId: string,
  options?: EnsureCapabilityOptions,
): Promise<InstallResult> {
  const trustPolicy = options?.trustPolicy || 'verified_fallback';
  const onEvent = options?.onEvent;

  const capability = getCapability(capabilityId);
  if (!capability) {
    return {
      capabilityId,
      ok: false,
      attempts: [],
      detail: `No capability descriptor found for ${capabilityId}`,
    };
  }

  const binary = capability.binary || capability.id;
  if (await isBinaryAvailable(binary)) {
    return { capabilityId: capability.id, ok: true, attempts: [], detail: `${binary} already available` };
  }

  const cooldownUntil = failureCooldown.get(capability.id) || 0;
  if (Date.now() < cooldownUntil) {
    const waitSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
    return {
      capabilityId: capability.id,
      ok: false,
      attempts: [],
      detail: `Install cooldown active for ${capability.id}. Retry in ${waitSec}s.`,
    };
  }

  const recipes = filterRecipes(capability, trustPolicy);
  if (!recipes.length) {
    return {
      capabilityId: capability.id,
      ok: false,
      attempts: [],
      detail: `No install recipes available under trust policy ${trustPolicy}.`,
    };
  }

  emit({ type: 'capability_missing', capabilityId: capability.id, message: `${capability.id} is missing. Attempting auto-install.` }, onEvent);

  const attempts: InstallAttempt[] = [];
  for (let i = 0; i < recipes.length; i += 1) {
    const recipe = recipes[i];
    const timeoutMs = recipe.timeoutMs || 180_000;

    emit({
      type: 'install_started',
      capabilityId: capability.id,
      recipeId: recipe.id,
      stepIndex: i + 1,
      totalSteps: recipes.length,
      message: `Installing ${capability.id} via ${recipe.method}:${recipe.id}`,
      command: recipe.command,
    }, onEvent);

    const result = await runInstallCommand(recipe.command, timeoutMs);
    attempts.push({ capabilityId: capability.id, recipeId: recipe.id, ok: result.ok, durationMs: result.durationMs, output: result.output });

    const binaryAvailable = await isBinaryAvailable(binary);
    if (result.ok && binaryAvailable) {
      setBinaryState(binary, true, `installed:${recipe.id}`);
      emit({
        type: 'install_succeeded',
        capabilityId: capability.id,
        recipeId: recipe.id,
        durationMs: result.durationMs,
        message: `${capability.id} installed successfully (${recipe.id}).`,
      }, onEvent);
      return {
        capabilityId: capability.id,
        ok: true,
        attempts,
        detail: `${capability.id} installed via ${recipe.id}`,
      };
    }
  }

  failureCooldown.set(capability.id, Date.now() + INSTALL_FAILURE_COOLDOWN_MS);
  const lastAttempt = attempts[attempts.length - 1];
  const detail = `Failed to auto-install ${capability.id}. Last output: ${lastAttempt?.output?.slice(0, 280) || 'n/a'}`;
  emit({ type: 'install_failed', capabilityId: capability.id, message: detail, detail }, onEvent);

  return {
    capabilityId: capability.id,
    ok: false,
    attempts,
    detail,
  };
}

export interface EnsureCommandCapabilitiesOptions extends EnsureCapabilityOptions {}

export interface EnsureCommandCapabilitiesResult {
  ok: boolean;
  installed: string[];
  failed: InstallResult[];
  missingKnown: string[];
  unknownExecutables: string[];
}

export async function ensureCommandCapabilities(
  command: string,
  options?: EnsureCommandCapabilitiesOptions,
): Promise<EnsureCommandCapabilitiesResult> {
  const resolution = await resolveCommandCapabilities(command);

  const installed: string[] = [];
  const failed: InstallResult[] = [];

  for (const capability of resolution.missingCapabilities) {
    const result = await ensureCapabilityInstalled(capability.id, options);
    if (result.ok) installed.push(capability.id);
    else failed.push(result);
  }

  if (installed.length > 0) {
    log.info(`[Capabilities] Installed: ${installed.join(', ')}`);
  }
  if (failed.length > 0) {
    log.warn(`[Capabilities] Install failures: ${failed.map((f) => f.capabilityId).join(', ')}`);
  }

  return {
    ok: failed.length === 0,
    installed,
    failed,
    missingKnown: resolution.missingCapabilities.map((c) => c.id),
    unknownExecutables: resolution.unknownExecutables,
  };
}
