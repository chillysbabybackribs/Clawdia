import { AnthropicClient } from '../client';
import { store } from '../../store';
import { DEFAULT_MODEL } from '../../../shared/models';
import { search } from '../../search/backends';
import { Message } from '../../../shared/types';
import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../../../shared/ipc-channels';
import { getMainWindow } from '../../main';

let activeAgentCount = 0;

function broadcastAgentCount() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_EVENTS.AGENT_COUNT_UPDATE, activeAgentCount);
    }
}

interface Tool {
    name: string;
    description: string;
    input_schema: any;
}

const SEARCH_TOOL_DEF: Tool = {
    name: 'search',
    description: 'Search the web for information.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
    }
};

const SYSTEM_PROMPT = `You are a specialized Research Assistant.
Your goal is to conduct deep, focused research on a specific topic assigned by the main agent.
You have access to a web search tool.

INSTRUCTIONS:
1.  Analyze the topic and the specific angle you are assigned.
2.  Formulate precise search queries.
3.  Execute searches to gather information.
4.  Synthesize the information into a detailed summary.
5.  Focus ONLY on your assigned angle. Do not drift into generalities.
6.  Cite your sources (URLs) where possible.
7.  If you cannot find anything, state that clearly.
`;

export async function delegateResearch(topic: string, angle: string): Promise<string> {
    activeAgentCount++;
    broadcastAgentCount();

    try {
        const apiKey = store.get('anthropicApiKey') as string;
        if (!apiKey) return "Error: No API key configured.";

        const model = (store.get('selectedModel') as string) || DEFAULT_MODEL;
        const client = new AnthropicClient(apiKey, model);

        const messages: Message[] = [
            {
                id: randomUUID(),
                role: 'user',
                content: `Topic: ${topic}\nFocus Angle: ${angle}\n\nPlease research this and provide a summary.`,
                createdAt: new Date().toISOString()
            }
        ];

        let iterations = 0;
        const MAX_ITERATIONS = 5;

        while (iterations < MAX_ITERATIONS) {
            iterations++;

            try {
                type AnthropicToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
                const tools: AnthropicToolDef[] = [SEARCH_TOOL_DEF];

                const response = await client.chat(
                    messages,
                    tools,
                    SYSTEM_PROMPT
                );

                // Append assistant response to history
                const assistantMsg: Message = {
                    id: randomUUID(),
                    role: 'assistant',
                    content: JSON.stringify(response.content),
                    createdAt: new Date().toISOString()
                };
                messages.push(assistantMsg);

                if (response.stopReason !== 'tool_use') {
                    const text = response.content
                        .filter(b => b.type === 'text')
                        .map(b => (b as any).text)
                        .join('');
                    return text || "No information found.";
                }

                // Execute tools
                const toolResults = [];
                for (const block of response.content) {
                    if (block.type === 'tool_use') {
                        let resultString = '';
                        if (block.name === 'search') {
                            const query = (block.input as any).query;
                            try {
                                const res = await search(query);
                                resultString = JSON.stringify(res);
                            } catch (err: any) {
                                resultString = `Error: ${err.message}`;
                            }
                        } else {
                            resultString = `Error: Tool ${block.name} not found`;
                        }

                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: resultString
                        });
                    }
                }

                // Append tool results to history
                const toolMsg: Message = {
                    id: randomUUID(),
                    role: 'user',
                    content: JSON.stringify(toolResults),
                    createdAt: new Date().toISOString()
                };
                messages.push(toolMsg);

            } catch (err: any) {
                return `Research Agent failed: ${err.message}`;
            }
        }

        return "Research agent timed out (max iterations reached).";
    } finally {
        activeAgentCount--;
        broadcastAgentCount();
    }
}
