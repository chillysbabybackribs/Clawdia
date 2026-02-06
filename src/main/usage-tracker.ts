import { AsyncLocalStorage } from 'async_hooks';
import { IPC_EVENTS } from '../shared/ipc-channels';
import { createLogger } from './logger';

const log = createLogger('usage-tracker');

export type ApiTarget = 'anthropic' | 'search';

export interface UsageWarningPayload {
  type: 'conversation-anthropic-threshold' | 'session-threshold';
  target: ApiTarget | 'all';
  threshold: number;
  sessionTotalCalls: number;
  conversationId?: string;
  conversationTotalCalls?: number;
  conversationAnthropicCalls?: number;
}

type UsageWarningEmitter = (event: string, payload: UsageWarningPayload) => void;

const CONVERSATION_ANTHROPIC_WARNING_THRESHOLD = 50;
const SESSION_WARNING_THRESHOLD = 200;

interface ConversationUsage {
  totalCalls: number;
  anthropicCalls: number;
}

const conversationContext = new AsyncLocalStorage<{ conversationId: string }>();

export class UsageTracker {
  private sessionTotalCalls = 0;
  private sessionCallsByTarget: Record<ApiTarget, number> = {
    anthropic: 0,
    search: 0,
  };
  private conversationUsage = new Map<string, ConversationUsage>();
  private warnedConversationIds = new Set<string>();
  private sessionWarningEmitted = false;
  private warningEmitter: UsageWarningEmitter | null = null;

  setWarningEmitter(emitter: UsageWarningEmitter | null): void {
    this.warningEmitter = emitter;
  }

  runWithConversation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    return conversationContext.run({ conversationId }, fn);
  }

  trackApiCall(target: ApiTarget): void {
    this.sessionTotalCalls += 1;
    this.sessionCallsByTarget[target] += 1;

    const conversationId = conversationContext.getStore()?.conversationId;
    if (conversationId) {
      const usage = this.conversationUsage.get(conversationId) ?? {
        totalCalls: 0,
        anthropicCalls: 0,
      };
      usage.totalCalls += 1;
      if (target === 'anthropic') {
        usage.anthropicCalls += 1;
      }
      this.conversationUsage.set(conversationId, usage);
      this.maybeEmitConversationWarning(conversationId, usage);
    }

    this.maybeEmitSessionWarning();
  }

  private maybeEmitConversationWarning(
    conversationId: string,
    usage: ConversationUsage
  ): void {
    if (this.warnedConversationIds.has(conversationId)) return;
    if (usage.anthropicCalls < CONVERSATION_ANTHROPIC_WARNING_THRESHOLD) return;

    this.warnedConversationIds.add(conversationId);
    this.emitWarning({
      type: 'conversation-anthropic-threshold',
      target: 'anthropic',
      threshold: CONVERSATION_ANTHROPIC_WARNING_THRESHOLD,
      sessionTotalCalls: this.sessionTotalCalls,
      conversationId,
      conversationTotalCalls: usage.totalCalls,
      conversationAnthropicCalls: usage.anthropicCalls,
    });
  }

  private maybeEmitSessionWarning(): void {
    if (this.sessionWarningEmitted) return;
    if (this.sessionTotalCalls < SESSION_WARNING_THRESHOLD) return;

    this.sessionWarningEmitted = true;
    this.emitWarning({
      type: 'session-threshold',
      target: 'all',
      threshold: SESSION_WARNING_THRESHOLD,
      sessionTotalCalls: this.sessionTotalCalls,
    });
  }

  private emitWarning(payload: UsageWarningPayload): void {
    log.warn('Warning threshold crossed:', payload);
    if (this.warningEmitter) {
      this.warningEmitter(IPC_EVENTS.API_USAGE_WARNING, payload);
    }
  }
}

export const usageTracker = new UsageTracker();
