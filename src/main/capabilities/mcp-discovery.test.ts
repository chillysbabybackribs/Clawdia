import { describe, expect, it } from 'vitest';
import { parseMcpServerList } from './mcp-discovery';

describe('mcp discovery parsing', () => {
  it('parses valid MCP server entries and normalizes tools', () => {
    const parsed = parseMcpServerList(
      [
        {
          name: 'search-agent',
          command: 'node',
          args: ['server.js'],
          tools: [
            {
              name: 'search_docs',
              description: 'search docs',
              inputSchema: { type: 'object' },
            },
          ],
        },
      ],
      'test-source',
    );

    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].name).toBe('search-agent');
    expect(parsed.servers[0].command).toBe('node');
    expect(parsed.servers[0].tools[0].name).toBe('search_docs');
    expect(parsed.servers[0].source).toBe('test-source');
  });

  it('filters invalid entries and returns warnings', () => {
    const parsed = parseMcpServerList(
      [
        { name: '', command: 'node' },
        { name: 'missing-command' },
        'not-an-object',
      ],
      'bad-source',
    );

    expect(parsed.servers).toHaveLength(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('supports object wrapper with servers array', () => {
    const parsed = parseMcpServerList(
      {
        servers: [
          {
            name: 'wrapped-server',
            command: 'python',
            args: ['main.py'],
            tools: [],
          },
        ],
      },
      'wrapped-source',
    );

    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].name).toBe('wrapped-server');
  });
});
