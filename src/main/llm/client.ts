import Anthropic from '@anthropic-ai/sdk';
import { Message } from '../../shared/types';

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
    this.model = model ?? 'claude-sonnet-4-20250514';
  }

  getModel(): string {
    return this.model;
  }

  async chat(
    messages: Message[],
    tools: ToolDefinition[],
    systemPrompt: string,
    onText?: (text: string) => void,
    options?: { maxTokens?: number }
  ): Promise<LLMResponse> {
    // Convert messages to Anthropic format
    const anthropicMessages = this.convertMessages(messages);

    // Build request — use prompt caching for system prompt and tool definitions.
    // The system prompt + tools are identical across every call in a tool loop.
    // With cache_control: ephemeral, calls #2+ get a 90% input token discount.
    const toolsWithCaching = tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

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
    let stopReason: LLMResponse['stopReason'] = 'end_turn';

    for await (const event of response) {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message.usage?.input_tokens || 0;
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
                console.warn(`[Client] Failed to parse tool input JSON for ${currentToolUse.name}:`, err);
                currentToolUse.input = {};
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
      },
    };
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

      // Filter out orphaned tool_results
      const filtered = (msg.content as unknown[]).filter((block: unknown) => {
        const b = block as { type?: string; tool_use_id?: string };
        if (b.type === 'tool_result' && b.tool_use_id && !validIds.has(b.tool_use_id)) {
          console.warn(`[Client] Dropping orphaned tool_result for id ${b.tool_use_id}`);
          return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        // All content was orphaned tool_results — remove the message entirely
        result.splice(i, 1);
        i--;
      } else {
        msg.content = filtered as Anthropic.MessageParam['content'];
      }
    }

    return result;
  }
}
