import type {
  MCPServerConfig,
  MCPServerRuntimeState,
  MCPServerHealthStatus,
} from '../../shared/types';
import { appendAuditEvent } from '../audit/audit-store';
import { createLogger } from '../logger';
import type {
  CapabilityDescriptor,
  CapabilityEvent,
  PolicyDecision,
  TrustPolicy,
  InstallResult,
  EvidenceRecord,
} from './contracts';
import { resolveCommandCapabilities, listCapabilities, getCapability, registerCapability } from './registry';
import { evaluateCommandPolicy } from './policy-engine';
import { ensureCommandCapabilities } from './install-orchestrator';
import { createFileCheckpoint, restoreFileCheckpoint, disposeFileCheckpoint, type FileCheckpoint } from './checkpoint-manager';

const log = createLogger('capability-services');

export interface CapabilityRegistryService {
  register(descriptor: CapabilityDescriptor): void;
  list(): CapabilityDescriptor[];
  get(id: string): CapabilityDescriptor | null;
  resolveCommand(command: string): ReturnType<typeof resolveCommandCapabilities>;
}

export interface PolicyEngineService {
  evaluate(command: string, options?: { cwd?: string; allowedRoots?: string[] }): PolicyDecision;
}

export interface InstallOrchestratorService {
  ensureForCommand(
    command: string,
    options?: {
      trustPolicy?: TrustPolicy;
      onEvent?: (event: CapabilityEvent) => void;
    },
  ): ReturnType<typeof ensureCommandCapabilities>;
}

export interface ExecutionSandboxService {
  isContainerFirst: boolean;
  activeRuntime(): 'container' | 'host';
}

export interface CheckpointService {
  create(path: string): Promise<FileCheckpoint>;
  restore(checkpoint: FileCheckpoint): Promise<{ ok: boolean; detail: string }>;
  dispose(checkpoint: FileCheckpoint): Promise<void>;
}

export interface EvidenceLedgerService {
  record(record: EvidenceRecord): void;
}

export interface McpRuntimeManagerService {
  registerServer(config: MCPServerConfig): MCPServerRuntimeState;
  updateHealth(serverName: string, status: MCPServerHealthStatus, detail?: string): MCPServerRuntimeState | null;
  recordRestart(serverName: string, reason?: string): MCPServerRuntimeState | null;
  list(): MCPServerRuntimeState[];
}

class DefaultCapabilityRegistryService implements CapabilityRegistryService {
  register(descriptor: CapabilityDescriptor): void {
    registerCapability(descriptor);
  }
  list(): CapabilityDescriptor[] {
    return listCapabilities();
  }
  get(id: string): CapabilityDescriptor | null {
    return getCapability(id);
  }
  resolveCommand(command: string): ReturnType<typeof resolveCommandCapabilities> {
    return resolveCommandCapabilities(command);
  }
}

class DefaultPolicyEngineService implements PolicyEngineService {
  evaluate(command: string, options?: { cwd?: string; allowedRoots?: string[] }): PolicyDecision {
    return evaluateCommandPolicy(command, options);
  }
}

class DefaultInstallOrchestratorService implements InstallOrchestratorService {
  ensureForCommand(
    command: string,
    options?: {
      trustPolicy?: TrustPolicy;
      onEvent?: (event: CapabilityEvent) => void;
    },
  ): ReturnType<typeof ensureCommandCapabilities> {
    return ensureCommandCapabilities(command, options);
  }
}

class DefaultExecutionSandboxService implements ExecutionSandboxService {
  isContainerFirst = true;
  activeRuntime(): 'container' | 'host' {
    // Runtime currently defaults to host execution while the container executor
    // is being integrated incrementally.
    return 'host';
  }
}

class DefaultCheckpointService implements CheckpointService {
  create(path: string): Promise<FileCheckpoint> {
    return createFileCheckpoint(path);
  }
  restore(checkpoint: FileCheckpoint): Promise<{ ok: boolean; detail: string }> {
    return restoreFileCheckpoint(checkpoint);
  }
  dispose(checkpoint: FileCheckpoint): Promise<void> {
    return disposeFileCheckpoint(checkpoint);
  }
}

class DefaultEvidenceLedgerService implements EvidenceLedgerService {
  record(record: EvidenceRecord): void {
    appendAuditEvent({
      ts: record.ts,
      kind: 'capability_event',
      toolName: record.toolName,
      outcome: 'info',
      detail: record.summary.slice(0, 300),
      commandPreview: record.command?.slice(0, 200),
    });
  }
}

class DefaultMcpRuntimeManagerService implements McpRuntimeManagerService {
  private readonly states = new Map<string, MCPServerRuntimeState>();

  registerServer(config: MCPServerConfig): MCPServerRuntimeState {
    const now = Date.now();
    const state: MCPServerRuntimeState = {
      name: config.name,
      namespace: `mcp.${config.name}`,
      status: 'starting',
      restartCount: 0,
      consecutiveFailures: 0,
      lastStartedAt: now,
      tools: (config.tools || []).map((tool) => ({
        namespace: `mcp.${config.name}`,
        name: tool.name,
        enabled: true,
        lastRegisteredAt: now,
      })),
    };
    this.states.set(config.name, state);
    return state;
  }

  updateHealth(serverName: string, status: MCPServerHealthStatus, detail?: string): MCPServerRuntimeState | null {
    const current = this.states.get(serverName);
    if (!current) return null;
    const next: MCPServerRuntimeState = {
      ...current,
      status,
      lastHealthCheckAt: Date.now(),
      lastError: status === 'healthy' ? undefined : detail || current.lastError,
      consecutiveFailures:
        status === 'healthy'
          ? 0
          : current.consecutiveFailures + 1,
    };
    this.states.set(serverName, next);
    log.debug(`[MCP Runtime] ${serverName} -> ${status}${detail ? ` (${detail})` : ''}`);
    return next;
  }

  recordRestart(serverName: string, reason?: string): MCPServerRuntimeState | null {
    const current = this.states.get(serverName);
    if (!current) return null;
    const now = Date.now();
    const next: MCPServerRuntimeState = {
      ...current,
      status: 'starting',
      restartCount: current.restartCount + 1,
      lastStartedAt: now,
      lastHealthCheckAt: now,
      lastError: reason || current.lastError,
    };
    this.states.set(serverName, next);
    log.info(`[MCP Runtime] restart ${serverName} (#${next.restartCount})${reason ? `: ${reason}` : ''}`);
    return next;
  }

  list(): MCPServerRuntimeState[] {
    return Array.from(this.states.values());
  }
}

export interface CapabilityPlatformServices {
  registry: CapabilityRegistryService;
  policy: PolicyEngineService;
  install: InstallOrchestratorService;
  sandbox: ExecutionSandboxService;
  checkpoint: CheckpointService;
  evidence: EvidenceLedgerService;
  mcpRuntime: McpRuntimeManagerService;
}

export function createCapabilityPlatformServices(): CapabilityPlatformServices {
  return {
    registry: new DefaultCapabilityRegistryService(),
    policy: new DefaultPolicyEngineService(),
    install: new DefaultInstallOrchestratorService(),
    sandbox: new DefaultExecutionSandboxService(),
    checkpoint: new DefaultCheckpointService(),
    evidence: new DefaultEvidenceLedgerService(),
    mcpRuntime: new DefaultMcpRuntimeManagerService(),
  };
}
