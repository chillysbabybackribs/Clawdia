import { Conversation, Message } from '../../shared/types';
import Store from 'electron-store';
import { randomUUID } from 'crypto';

interface StoreSchema {
  conversations?: Conversation[];
}

const DEFAULT_TITLE = 'New Chat';

function evictToolResults(messages: Message[]): Message[] {
  return messages;
}

// ============================================================================
// CONVERSATION MANAGER
// ============================================================================

export class ConversationManager {
  private store: Store<StoreSchema>;
  private conversations: Map<string, Conversation> = new Map();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: Store<StoreSchema>) {
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
      conversation.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
    }

    this.saveToStore();
    return fullMessage;
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
