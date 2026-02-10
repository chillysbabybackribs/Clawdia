import { Conversation, Message } from '../../shared/types';
import Store from 'electron-store';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger';

const log = createLogger('conversation');

const DEFAULT_TITLE = 'New Chat';

/**
 * Maximum number of messages to persist per conversation.
 * Older messages are automatically pruned after each assistant response.
 * The LLM can always recover context by reading files, git log, grep, etc.
 * Users can change this at runtime via prompt (e.g. "change history to 20").
 */
let MAX_PERSISTED_MESSAGES = 50;

function evictToolResults(messages: Message[]): Message[] {
  return messages;
}

// ============================================================================
// CONVERSATION MANAGER
// ============================================================================

export class ConversationManager {
  private store: Store<any>;
  private conversations: Map<string, Conversation> = new Map();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: Store<any>) {
    this.store = store;
    this.loadFromStore();
  }

  private loadFromStore(): void {
    const saved = this.store.get('conversations') as Conversation[] | undefined;
    if (saved) {
      for (const conv of saved) {
        this.conversations.set(conv.id, conv);
      }
    }
  }

  private saveToStore(): void {
    // Debounce writes — coalesce rapid mutations (e.g. user+assistant addMessage)
    // into a single disk write.
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const convArray = Array.from(this.conversations.values());
      this.store.set('conversations', convArray);
    }, 500);
  }

  /** Flush any pending debounced write immediately. */
  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      const convArray = Array.from(this.conversations.values());
      this.store.set('conversations', convArray);
    }
  }

  create(title?: string): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      title: title || DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    this.conversations.set(conversation.id, conversation);
    this.saveToStore();
    return conversation;
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  list(): Conversation[] {
    return Array.from(this.conversations.values())
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  delete(id: string): void {
    this.conversations.delete(id);
    this.saveToStore();
  }

  addMessage(conversationId: string, message: Omit<Message, 'id' | 'createdAt'>): Message {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const fullMessage: Message = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...message,
    };

    conversation.messages.push(fullMessage);
    conversation.updatedAt = fullMessage.createdAt;

    // Auto-generate title from first user message
    const isUntitled = !conversation.title || conversation.title === 'New Conversation' || conversation.title === DEFAULT_TITLE;
    if (isUntitled && message.role === 'user') {
      const titleText = message.content || (message.images?.length ? `[${message.images.length} image${message.images.length > 1 ? 's' : ''}]` : '');
      conversation.title = titleText.slice(0, 50) + (titleText.length > 50 ? '...' : '');
    }

    // Auto-prune old messages after assistant replies.
    // The LLM can always recover context via file_read, grep, git log, etc.
    // This keeps token costs low and latency fast.
    if (message.role === 'assistant') {
      this.autoPrune(conversation);
    }

    this.saveToStore();
    return fullMessage;
  }

  /**
   * Auto-prune conversation to keep only the last MAX_PERSISTED_MESSAGES.
   * Called automatically after each assistant response.
   */
  private autoPrune(conversation: Conversation): void {
    const msgs = conversation.messages;
    if (msgs.length <= MAX_PERSISTED_MESSAGES) return;

    const pruned = msgs.length - MAX_PERSISTED_MESSAGES;
    conversation.messages = msgs.slice(-MAX_PERSISTED_MESSAGES);
    log.info(`Auto-pruned ${pruned} old messages from conversation ${conversation.id} (kept last ${MAX_PERSISTED_MESSAGES})`);
  }

  /**
   * Set max persisted messages at runtime (e.g. user says "change history to 20").
   */
  static setMaxPersistedMessages(count: number): void {
    MAX_PERSISTED_MESSAGES = Math.max(2, Math.min(count, 200));
    log.info(`MAX_PERSISTED_MESSAGES set to ${MAX_PERSISTED_MESSAGES}`);
  }

  static getMaxPersistedMessages(): number {
    return MAX_PERSISTED_MESSAGES;
  }

  pruneToolResults(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const updated = evictToolResults(conversation.messages);
    conversation.messages = updated;
    this.saveToStore();
  }

  updateTitle(conversationId: string, title: string): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      conversation.title = title;
      this.saveToStore();
    }
  }

  getTitle(conversationId: string): string {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return DEFAULT_TITLE;
    }

    const title = conversation.title?.trim();
    if (title && title !== 'New Conversation') {
      return title;
    }

    const firstUserMessage = conversation.messages.find((msg) => msg.role === 'user' && msg.content.trim().length > 0);
    return firstUserMessage?.content || DEFAULT_TITLE;
  }
}
