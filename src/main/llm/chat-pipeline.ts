/**
 * Shared chat processing pipeline.
 *
 * The emitter abstracts the transport — everything else
 * (intent routing, system prompt, tool dispatch, post-completion hooks) is
 * identical regardless of caller.
 */

import { randomUUID } from 'crypto';
import { ToolLoop } from './tool-loop';
import { ConversationManager } from './conversation';
import { AnthropicClient } from './client';
import { maybeExtractMemories, flushBeforePrune } from '../learning';
import { incrementSessionMessageCount } from '../dashboard/persistence';
import { usageTracker } from '../usage-tracker';
import { TracingEmitter } from './tracing-emitter';
import { ExecutorRunner } from '../tasks/executor-runner';
import { generateExecutor } from '../tasks/executor-generator';
import {
    lookupInteractiveExecutor,
    saveInteractiveExecutor,
    updateInteractiveExecutorStats,
} from './interactive-executor-store';
import { estimateExecutorCost } from '../tasks/cost-estimator';
import { classifyEnriched } from './intent-router';
import { strategyCache, type CacheKey } from './strategy-cache';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';
import type { ToolLoopEmitter, DocumentAttachment, DocumentMeta, ImageAttachment } from '../../shared/types';
import type { ApprovalDecision, ApprovalRequest } from '../../shared/autonomy';

const log = createLogger('chat-pipeline');

export interface ChatPipelineOptions {
  /** The user's message text. */
  message: string;
  /** Conversation ID (existing or new). If empty/missing, a new conversation is created. */
  conversationId?: string;
  /** Unique ID for this message (auto-generated if not provided). */
  messageId?: string;
  /** The emitter (BrowserWindow wrapper). */
  emitter: ToolLoopEmitter;
  /** Pre-built AnthropicClient instance. */
  client: AnthropicClient;
  /** The ConversationManager instance. */
  conversationManager: ConversationManager;
  /** Optional image attachments. */
  images?: ImageAttachment[];
  /** Optional document attachments (with extracted text). */
  documents?: DocumentAttachment[];
  /**
   * Called when the ToolLoop is created, so the caller can track it
   * (e.g. for abort support). Called with null on completion.
   */
  onToolLoopCreated?: (loop: ToolLoop | null) => void;
  /**
   * Called after ToolLoop.run() completes (or errors) with the final response.
   * Use for transport-specific post-processing (e.g. sending CHAT_STREAM_END
   * to the renderer).
   */
  onResponse?: (response: string, loop: ToolLoop) => void;
  /**
   * Called after conversation messages are saved.
   * Use for transport-specific notifications (e.g. broadcasting update to desktop).
   */
  onConversationUpdated?: (conversationId: string) => void;
  /**
   * Called on error, before the error is re-thrown.
   */
  onError?: (error: Error) => void;
  /**
   * Request approval from the user.
   */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface ChatPipelineResult {
  conversationId: string;
  response: string;
}

/**
 * Process a chat message through the full pipeline.
 *
 * This is the single source of truth for chat processing. The pipeline:
 *
 * 1. Get or create conversation
 * 2. Create ToolLoop with the provided emitter + client
 * 3. ToolLoop.run() — this internally handles:
 *    - Intent routing (classifyEnriched)
 *    - System prompt construction (getStaticPrompt + getDynamicPrompt)
 *    - Tool set assembly (ALL_TOOLS, filtered by intent/archetype)
 *    - Fast path detection
 *    - Strategy hints
 *    - Tool execution (parallel where safe, sequential where stateful)
 *    - Stream interception (HTML live preview)
 * 4. Post-completion: save messages, extract memories, broadcast task state
 */
export async function processChatMessage(
  options: ChatPipelineOptions,
): Promise<ChatPipelineResult> {
  const {
    message,
    emitter,
    client,
    conversationManager,
    images,
    documents,
    onToolLoopCreated,
    onResponse,
    onConversationUpdated,
    onError,
  } = options;

  const messageId = options.messageId || randomUUID();

  // 1. Get or create conversation
  let conversation = conversationManager.get(options.conversationId || '');
  if (!conversation) {
    conversation = conversationManager.create();
  }

  // Convert DocumentAttachment[] to DocumentMeta[] for storage (strip extracted text)
  const documentMetas: DocumentMeta[] | undefined = documents?.map((d) => ({
    filename: d.filename,
    originalName: d.originalName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    pageCount: d.pageCount,
    sheetNames: d.sheetNames,
    truncated: d.truncated,
  }));

  const history = conversation.messages;

  try {
    // 2. Wrap emitter in TracingEmitter to capture execution traces
    const tracingEmitter = new TracingEmitter(emitter);

    // 3. Build archetype cache key for executor lookup/save
    const enriched = classifyEnriched(message, history.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    })), undefined);
    const cacheKey: CacheKey = {
      archetype: enriched.strategy.archetype,
      primaryHost: enriched.strategy.extractedParams.url
        ? (() => { try { return new URL(enriched.strategy.extractedParams.url as string).hostname.replace(/^www\./, ''); } catch { return null; } })()
        : null,
      toolClass: enriched.toolClass,
    };

    // 4. Check for cached executor (only for tool-intent requests with known archetype)
    let response: string | null = null;

    if (enriched.intent === 'tools' && enriched.strategy.archetype !== 'unknown') {
      const cachedStrategy = strategyCache.lookup(cacheKey);
      if (cachedStrategy) {
        const executor = lookupInteractiveExecutor(cacheKey, cachedStrategy.toolSequence);
        if (executor) {
          log.info(`[Pipeline] Found interactive executor v${executor.version} for ${cacheKey.archetype}|${cacheKey.primaryHost}`);
          try {
            const runner = new ExecutorRunner(client);
            const execResult = await runner.run(executor);

            if (execResult.success && execResult.result) {
              response = execResult.result;
              const costSaved = 0.12 - estimateExecutorCost(executor);
              updateInteractiveExecutorStats(executor.id, true, costSaved);
              emitter.send(IPC_EVENTS.CHAT_EXECUTOR_USED, {
                executorVersion: executor.version,
                costSaved: costSaved.toFixed(4),
                stepsReplayed: executor.stats.total_steps,
              });
              log.info(`[Pipeline] Executor v${executor.version} succeeded, saved ~$${costSaved.toFixed(4)}`);
            } else {
              log.warn(`[Pipeline] Executor v${executor.version} failed at step ${execResult.failedAt}, falling back to LLM`);
              updateInteractiveExecutorStats(executor.id, false, 0);
            }
          } catch (err: any) {
            log.warn(`[Pipeline] Executor error: ${err?.message}, falling back to LLM`);
          }
        }
      }
    }

    // 5. Normal LLM path if executor didn't handle it
    if (!response) {
      const loop = new ToolLoop(tracingEmitter, client);
      onToolLoopCreated?.(loop);
      incrementSessionMessageCount();

      response = await usageTracker.runWithConversation(conversation.id, () =>
        loop.run(message, history, images, documents, {
          conversationId: conversation.id,
          messageId,
          requestApproval: options.requestApproval,
        })
      );

      onResponse?.(response, loop);

      // 6. Generate executor from trace (fire-and-forget, non-critical)
      try {
        const trace = tracingEmitter.getExecutionTrace();
        const toolSeq = tracingEmitter.getToolSequence();
        if (trace.length > 0 && toolSeq.length > 0) {
          const syntheticTask = {
            id: 'interactive',
            description: message.slice(0, 200),
            triggerType: 'scheduled' as const,
            triggerConfig: null,
            executionPlan: '{}',
            status: 'active' as const,
            approvalMode: 'auto' as const,
            allowedTools: '[]',
            maxIterations: 30,
            model: null,
            tokenBudget: 50000,
            createdAt: Math.floor(Date.now() / 1000),
            updatedAt: Math.floor(Date.now() / 1000),
            lastRunAt: null,
            nextRunAt: null,
            runCount: 0,
            failureCount: 0,
            maxFailures: 3,
            conversationId: conversation.id,
            metadataJson: '{}',
          };
          const newExecutor = generateExecutor(syntheticTask, trace, messageId);
          if (newExecutor && newExecutor.stats.deterministic_steps > 0) {
            saveInteractiveExecutor(cacheKey, toolSeq, newExecutor);
            log.info(`[Pipeline] Generated interactive executor: ${newExecutor.stats.deterministic_steps} deterministic, ${newExecutor.stats.llm_steps} LLM steps`);
          }
        }
      } catch (genErr: any) {
        log.warn(`[Pipeline] Failed to generate interactive executor: ${genErr?.message}`);
      }
    } else {
      // Executor path: count message (cleanup handled by finally block)
      incrementSessionMessageCount();
    }

    // 7a. Pre-prune flush: extract memories from messages about to be deleted
    const currentMsgs = conversationManager.get(conversation.id)?.messages || [];
    const willPruneCount = (currentMsgs.length + 2) - ConversationManager.getMaxPersistedMessages();
    if (willPruneCount > 0) {
      const doomed = currentMsgs.slice(0, willPruneCount);
      flushBeforePrune(conversation.id, doomed, client).catch(() => { });
    }

    // 7b. Save messages to conversation history
    conversationManager.addMessage(conversation.id, {
      role: 'user',
      content: message || '[Empty message]',
      images,
      documents: documentMetas,
    });
    conversationManager.addMessage(conversation.id, {
      role: 'assistant',
      content: response || '[No response]',
    });

    // 7c. Extract learnings from the updated conversation
    const updatedConversation = conversationManager.get(conversation.id);
    if (updatedConversation) {
      maybeExtractMemories(conversation.id, updatedConversation.messages, client);
    }

    // 7d. Transport-specific post-save notification
    onConversationUpdated?.(conversation.id);

    return { conversationId: conversation.id, response };
  } catch (error: any) {
    onError?.(error);
    throw error;
  } finally {
    onToolLoopCreated?.(null);
  }
}
