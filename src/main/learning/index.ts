import { SiteKnowledgeBase } from './site-knowledge';
import { UserMemory } from './user-memory';
import type { Message } from '../../shared/types';
import { createLogger } from '../logger';
import { AnthropicClient } from '../llm/client';

const log = createLogger('learning');
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

let siteKnowledge: SiteKnowledgeBase | null = null;
let userMemory: UserMemory | null = null;
const extractionCounts = new Map<string, number>();

function initLearningSystem(): void {
  if (siteKnowledge && userMemory) return;
  siteKnowledge = new SiteKnowledgeBase();
  userMemory = new UserMemory(siteKnowledge.getDatabase());

  // Best-effort cleanup after startup
  setTimeout(() => {
    siteKnowledge?.prune();
    userMemory?.prune();
  }, 10_000);
}

function shutdownLearningSystem(): void {
  siteKnowledge?.close();
}

function getSiteKnowledge(): SiteKnowledgeBase | null {
  return siteKnowledge;
}

function getUserMemory(): UserMemory | null {
  return userMemory;
}

/**
 * Fire-and-forget memory extraction using the cheapest model.
 */
function maybeExtractMemories(
  conversationId: string,
  conversationMessages: Message[],
  client: AnthropicClient
): void {
  if (!userMemory) return;
  const lastExtractedAt = extractionCounts.get(conversationId) ?? 0;
  if (conversationMessages.length - lastExtractedAt < 10) return;
  const userMessages = conversationMessages.filter((m) => m.role === 'user');
  if (userMessages.length < 2) return;

  extractionCounts.set(conversationId, conversationMessages.length);
  const recent = conversationMessages.slice(-10);
  const existingContext = userMemory.getPromptContext(800) || 'Nothing yet.';

  const extractionPrompt = `You are a memory extraction system. Analyze this conversation and extract factual information about the user that would be useful to remember for future conversations.

Extract ONLY concrete facts, not opinions or transient states. Focus on:
- Account names (Twitter handle, email, etc.)
- Preferences (preferred model, coding style, tone)
- Workflows (how they like tasks done)
- Professional context (job, company, role)
- Personal context (name, location, timezone)

Already known (do not re-extract):
${existingContext}

Respond with a JSON array of objects. Each object has: category, key, value.
Categories: preference, account, workflow, fact, context
If nothing new to extract, respond with an empty array: []

IMPORTANT: Only extract information the user explicitly stated or clearly implied. Do not infer or guess.`;

  // Non-blocking
  void (async () => {
    try {
      const response = await client.chat(
        [...recent, { role: 'user', content: extractionPrompt } as Message],
        [],
        '',
        undefined,
        { maxTokens: 500, model: EXTRACTION_MODEL }
      );

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as any).text || '')
        .join('');

      const cleaned = text.replace(/```json\s*|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return;

      for (const mem of parsed) {
        if (mem?.category && mem?.key && mem?.value) {
          userMemory.remember(String(mem.category), String(mem.key), String(mem.value), 'extracted');
        }
      }
    } catch (err: any) {
      log.warn('[Memory] Extraction failed', { err: err?.message || err });
    }
  })();
}

/**
 * Fire-and-forget: extract memories from messages about to be pruned.
 * Called before autoPrune slices old messages so facts aren't lost.
 */
async function flushBeforePrune(
  conversationId: string,
  doomedMessages: Message[],
  client: AnthropicClient
): Promise<void> {
  try {
    if (!userMemory) return;

    const content = doomedMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n')
      .slice(0, 8000);

    if (content.length < 200) return;

    const extractionPrompt = `You are a memory extraction system. The following conversation messages are about to be deleted from history. Extract any factual information about the user that should be preserved for future conversations.

Extract ONLY concrete facts the user explicitly stated or clearly implied. Focus on:
- Account names, preferences, workflows, professional context, personal context

Respond with lines in this format:
REMEMBER:category:key:value
SUPERSEDE:category:key (if a fact contradicts an existing one)

Categories: preference, account, workflow, fact, context
If nothing to extract, respond with NOTHING.

Messages:
${content}`;

    const response = await client.complete([
      { role: 'user', content: extractionPrompt },
    ], { maxTokens: 1024, model: EXTRACTION_MODEL });

    const text = response.text;

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      const rememberMatch = trimmed.match(/^REMEMBER:(\w+):([^:]+):(.+)$/);
      if (rememberMatch) {
        userMemory.remember(rememberMatch[1], rememberMatch[2].trim(), rememberMatch[3].trim(), 'flush');
        continue;
      }
      const supersedeMatch = trimmed.match(/^SUPERSEDE:(\w+):(.+)$/);
      if (supersedeMatch) {
        userMemory.contradict(supersedeMatch[1], supersedeMatch[2].trim());
      }
    }

    log.info(`[Memory] Flushed memories from ${doomedMessages.length} doomed messages in conversation ${conversationId}`);
  } catch (err: any) {
    log.warn('[Memory] flushBeforePrune failed', { err: err?.message || err });
  }
}

export {
  initLearningSystem,
  shutdownLearningSystem,
  getSiteKnowledge,
  getUserMemory,
  maybeExtractMemories,
  flushBeforePrune,
  siteKnowledge,
  userMemory,
};
