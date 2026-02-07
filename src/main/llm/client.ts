import Anthropic from '@anthropic-ai/sdk';
import { Message } from '../../shared/types';
import { DEFAULT_MODEL } from '../../shared/models';
import { RateLimiter } from '../rate-limiter';
import { usageTracker } from '../usage-tracker';
import { createLogger } from '../logger';

const log = createLogger('llm-client');

// ============================================================================
// TYPES
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextBlock | ToolUse;

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

// ============================================================================
// ANTHROPIC CLIENT
// ============================================================================

export class AnthropicClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  getModel(): string {
    return this.model;
  }

  async chat(
    messages: Message[],
    tools: ToolDefinition[],
    systemPrompt: string,
    onText?: (text: string) => void,
    options?: {
      maxTokens?: number;
      onToolUse?: (toolUse: ToolUse) => Promise<string> | string | undefined;
    }
  ): Promise<LLMResponse> {
    // Convert messages to Anthropic format
    const anthropicMessages = this.convertMessages(messages);

    // Add cache_control breakpoint to the last tool_result message.
    // Combined with system prompt (breakpoint 1) and last tool def (breakpoint 2),
    // this is breakpoint 3 of max 4. On tool loop iteration N, everything up to
    // the previous tool_result is cached — only the newest pair is fresh input.
    this.addMessageCacheBreakpoint(anthropicMessages);

    // Build request — use prompt caching for system prompt and tool definitions.
    // The system prompt + tools are identical across every call in a tool loop.
    // With cache_control: ephemeral, calls #2+ get a 90% input token discount.
    const toolsWithCaching = tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

    const anthropicLimiter = RateLimiter.getInstance('anthropic', {
      maxTokens: 20,
      refillRate: 10,
      maxQueueDepth: 10,
      maxWaitMs: 10_000,
    });
    await anthropicLimiter.acquire();
    usageTracker.trackApiCall('anthropic');

    // Diagnostic: warn about any messages with empty or suspicious content before the API call
    for (let i = 0; i < anthropicMessages.length; i++) {
      const m = anthropicMessages[i];
      const c = m.content;
      const empty = !c || (typeof c === 'string' && c.trim() === '') || (Array.isArray(c) && c.length === 0);
      if (empty) {
        log.error(`[SANITIZE] Empty message at index ${i}, role=${m.role} — this should have been caught by convertMessages`);
      }
    }

    log.info(`[API Request] model=${this.model} | endpoint=messages.create | stream=true | maxTokens=${options?.maxTokens ?? 4096} | msgCount=${anthropicMessages.length} | toolCount=${toolsWithCaching.length}`);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      system: [
        {
          type: 'text' as const,
          text: systemPrompt,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages: anthropicMessages,
      tools: toolsWithCaching,
      stream: true,
    });

    // Accumulate streamed response
    const contentBlocks: ContentBlock[] = [];
    let currentTextBlock: TextBlock | null = null;
    let currentToolUse: ToolUse | null = null;
    let currentToolJsonFragments = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    let stopReason: LLMResponse['stopReason'] = 'end_turn';

    for await (const event of response) {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message.usage?.input_tokens || 0;
          cacheReadInputTokens = (event.message.usage as any)?.cache_read_input_tokens || 0;
          cacheCreationInputTokens = (event.message.usage as any)?.cache_creation_input_tokens || 0;
          break;

        case 'content_block_start':
          if (event.content_block.type === 'text') {
            currentTextBlock = { type: 'text', text: '' };
          } else if (event.content_block.type === 'tool_use') {
            currentToolUse = {
              type: 'tool_use',
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            };
            currentToolJsonFragments = '';
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta' && currentTextBlock) {
            currentTextBlock.text += event.delta.text;
            if (onText) {
              onText(event.delta.text);
            }
          } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
            // Accumulate JSON fragments — parsed at content_block_stop
            // @ts-ignore - partial_json exists on input_json_delta
            currentToolJsonFragments += event.delta.partial_json || '';
          }
          break;

        case 'content_block_stop':
          if (currentTextBlock) {
            contentBlocks.push(currentTextBlock);
            currentTextBlock = null;
          } else if (currentToolUse) {
            // Parse the accumulated JSON fragments into tool input
            if (currentToolJsonFragments) {
              try {
                currentToolUse.input = JSON.parse(currentToolJsonFragments);
              } catch (err) {
                log.warn(`Failed to parse tool input JSON for ${currentToolUse.name}:`, err);
                currentToolUse.input = {};
              }
            }
            if (options?.onToolUse) {
              const started = options.onToolUse(currentToolUse);
              if (typeof started !== 'undefined') {
                void Promise.resolve(started);
              }
            }
            contentBlocks.push(currentToolUse);
            currentToolUse = null;
            currentToolJsonFragments = '';
          }
          break;

        case 'message_delta':
          outputTokens = event.usage?.output_tokens || 0;
          if (event.delta.stop_reason) {
            stopReason = event.delta.stop_reason as LLMResponse['stopReason'];
          }
          break;
      }
    }

    return {
      content: contentBlocks,
      stopReason,
      model: this.model,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
      },
    };
  }

  /**
   * Add a cache_control breakpoint to the last tool_result message in the
   * conversation. This is the 3rd cache breakpoint (system=1, tools=2,
   * last_tool_result=3). On subsequent tool loop iterations, everything up
   * to the previous tool_result is served from cache at 90% discount.
   */
  private addMessageCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
    // Walk backwards to find the last user message containing tool_result blocks
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      const content = msg.content as unknown[];
      const hasToolResult = content.some(
        (block) => block != null && typeof block === 'object' && (block as any).type === 'tool_result'
      );
      if (!hasToolResult) continue;

      // Add cache_control to the last block in this message
      const lastBlock = content[content.length - 1];
      if (lastBlock && typeof lastBlock === 'object') {
        (lastBlock as any).cache_control = { type: 'ephemeral' };
      }
      break;
    }
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages are handled separately
        continue;
      }

      // Check if content is JSON (tool use response or tool results)
      let content: Anthropic.MessageParam['content'] = msg.content;

      if (typeof msg.content === 'string' && msg.content.startsWith('[')) {
        try {
          const parsed = JSON.parse(msg.content);
          if (Array.isArray(parsed)) {
            // Could be tool_use blocks or tool_result blocks
            content = parsed;
          }
        } catch {
          // Not JSON, use as-is
        }
      }

      // If message has images, build multi-content block with image + text
      if (msg.images && msg.images.length > 0 && msg.role === 'user') {
        const blocks: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];
        for (const img of msg.images) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType,
              data: img.base64,
            },
          });
        }
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        content = blocks;
      }

      result.push({
        role: msg.role,
        content,
      });
    }

    // Validate tool_result references: every tool_result must have a matching
    // tool_use in the immediately preceding assistant message.
    for (let i = 1; i < result.length; i++) {
      const msg = result[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      const toolResults = (msg.content as Array<{ type?: string; tool_use_id?: string }>).filter(
        (b) => b.type === 'tool_result'
      );
      if (toolResults.length === 0) continue;

      // Collect tool_use ids from the preceding assistant message
      const prev = result[i - 1];
      const validIds = new Set<string>();
      if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
        for (const block of prev.content as Array<{ type?: string; id?: string }>) {
          if (block.type === 'tool_use' && block.id) {
            validIds.add(block.id);
          }
        }
      }

      // Filter out orphaned tool_results & ensure tool_result content is non-empty
      const filtered = (msg.content as unknown[]).filter((block: unknown) => {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown };
        if (b.type === 'tool_result' && b.tool_use_id && !validIds.has(b.tool_use_id)) {
          log.warn(`Dropping orphaned tool_result for id ${b.tool_use_id}`);
          return false;
        }
        return true;
      }).map((block: unknown) => {
        const b = block as { type?: string; content?: unknown };
        if (b.type === 'tool_result') {
          const c = b.content;
          if (!c || (typeof c === 'string' && c.trim() === '') || (Array.isArray(c) && c.length === 0)) {
            return { ...b, content: '[No output]' };
          }
        }
        return block;
      });

      if (filtered.length === 0) {
        // All content was orphaned tool_results — remove the message entirely
        result.splice(i, 1);
        i--;
      } else {
        msg.content = filtered as Anthropic.MessageParam['content'];
      }
    }

    // Final sanitization: ensure no message has empty content (Anthropic rejects these).
    // This is the last-resort safety net — ideally content should never be empty.
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      const content = msg.content;

      let isEmpty = false;
      if (!content) {
        isEmpty = true;
      } else if (typeof content === 'string' && content.trim() === '') {
        isEmpty = true;
      } else if (Array.isArray(content) && content.length === 0) {
        isEmpty = true;
      }

      if (isEmpty) {
        log.warn(`[SANITIZE] Empty content at message index ${i}, role=${msg.role} — removing`);
        result.splice(i, 1);
      }
    }

    // Ensure alternating user/assistant pattern after removals
    // (Anthropic requires strict alternation starting with user)
    for (let i = 1; i < result.length; i++) {
      if (result[i].role === result[i - 1].role) {
        // Two consecutive messages with same role — merge or remove the duplicate
        if (result[i].role === 'user' && typeof result[i].content === 'string' && typeof result[i - 1].content === 'string') {
          // Merge consecutive user messages
          result[i - 1].content = result[i - 1].content + '\n' + result[i].content;
          result.splice(i, 1);
          i--;
        } else if (result[i].role === 'assistant') {
          // Remove the earlier empty-ish assistant message
          result.splice(i - 1, 1);
          i--;
        }
      }
    }

    // Must start with a user message
    while (result.length > 0 && result[0].role !== 'user') {
      log.warn(`[SANITIZE] Removing leading non-user message, role=${result[0].role}`);
      result.splice(0, 1);
    }

    return result;
  }
}
