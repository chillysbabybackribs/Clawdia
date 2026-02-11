/**
 * LLM tool definition for searching the conversation archive.
 */

import type { Tool } from '../../shared/types';
import { searchArchive, getArchiveStats } from './writer';
import { createLogger } from '../logger';

const log = createLogger('archive-tools');

export const ARCHIVE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'memory_search',
    description:
      'Search past conversations from the permanent archive. Use this when the user asks about something discussed earlier, wants to recall a previous task, or references prior context. Returns snippets from matching messages with conversation titles and dates.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — keywords or phrases to find in past conversations.',
        },
        conversation_id: {
          type: 'string',
          description: 'Optional: limit search to a specific conversation ID.',
        },
        date_from: {
          type: 'string',
          description: 'Optional: earliest date to search (ISO 8601, e.g. "2026-02-01").',
        },
        date_to: {
          type: 'string',
          description: 'Optional: latest date to search (ISO 8601, e.g. "2026-02-10").',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 5, max 10).',
        },
      },
      required: ['query'],
    },
  },
];

const MAX_SNIPPET_CHARS = 2000;

export function executeArchiveTool(name: string, input: any): string {
  if (name !== 'memory_search') {
    return `Unknown archive tool: ${name}`;
  }

  try {
    const query = input?.query;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return 'Error: query is required and must be a non-empty string.';
    }

    const results = searchArchive(query.trim(), {
      conversationId: input?.conversation_id,
      dateFrom: input?.date_from,
      dateTo: input?.date_to,
      limit: input?.limit,
    });

    if (results.length === 0) {
      const stats = getArchiveStats();
      return `No matches found for "${query}" in the conversation archive (${stats.messageCount} messages across ${stats.conversationCount} conversations).`;
    }

    const formatted = results.map((r, i) => {
      const snippet = r.snippet.length > MAX_SNIPPET_CHARS
        ? r.snippet.slice(0, MAX_SNIPPET_CHARS) + '...'
        : r.snippet;
      const date = r.messageDate.slice(0, 10); // YYYY-MM-DD
      return `[${i + 1}] "${r.conversationTitle}" (${date}) — ${r.role}:\n${snippet}`;
    });

    return formatted.join('\n\n---\n\n');
  } catch (err: any) {
    log.warn(`memory_search error: ${err?.message}`);
    return `Error searching archive: ${err?.message || 'unknown error'}`;
  }
}
