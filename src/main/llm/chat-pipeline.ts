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
import type { ToolLoopEmitter, DocumentAttachment, DocumentMeta, ImageAttachment } from '../../shared/types';

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

  // 2. Create ToolLoop
  const loop = new ToolLoop(emitter, client);
  onToolLoopCreated?.(loop);
  incrementSessionMessageCount();

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
    // 3. Run the tool loop (contains ALL pipeline logic)
    const response = await usageTracker.runWithConversation(conversation.id, () =>
      loop.run(message, history, images, documents, {
        conversationId: conversation.id,
        messageId,
      })
    );

    // 4a. Transport-specific response handling
    onResponse?.(response, loop);

    // 4b. Pre-prune flush: extract memories from messages about to be deleted
    const currentMsgs = conversationManager.get(conversation.id)?.messages || [];
    const willPruneCount = (currentMsgs.length + 2) - ConversationManager.getMaxPersistedMessages();
    if (willPruneCount > 0) {
      const doomed = currentMsgs.slice(0, willPruneCount);
      flushBeforePrune(conversation.id, doomed, client).catch(() => { });
    }

    // 4c. Save messages to conversation history
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

    // 4d. Extract learnings from the updated conversation
    const updatedConversation = conversationManager.get(conversation.id);
    if (updatedConversation) {
      maybeExtractMemories(conversation.id, updatedConversation.messages, client);
    }

    // 4e. Transport-specific post-save notification
    onConversationUpdated?.(conversation.id);

    return { conversationId: conversation.id, response };
  } catch (error: any) {
    onError?.(error);
    throw error;
  } finally {
    onToolLoopCreated?.(null);
  }
}
