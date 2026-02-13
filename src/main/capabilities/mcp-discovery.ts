import * as fs from 'fs';
import * as path from 'path';
import type { MCPServerConfig, MCPToolSchema } from '../../shared/types';
import { store } from '../store';
import { createLogger } from '../logger';

const log = createLogger('mcp-discovery');
const DEFAULT_MCP_CONFIG_FILE = 'mcp-servers.json';

export interface DiscoveredMcpServer extends MCPServerConfig {
  source: string;
}

interface ParseResult {
  servers: DiscoveredMcpServer[];
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeToolSchema(raw: unknown, serverName: string, source: string, index: number): MCPToolSchema | null {
  if (!isObject(raw)) {
    return null;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    log.warn(`[MCP Discovery] ${source}: server "${serverName}" tool[${index}] missing name`);
    return null;
  }
  const description = typeof raw.description === 'string' ? raw.description : '';
  const inputSchema = isObject(raw.inputSchema) ? raw.inputSchema : { type: 'object', properties: {} };
  return {
    name,
    description,
    inputSchema,
  };
}

function sanitizeServerConfig(raw: unknown, source: string, index: number): { config: MCPServerConfig | null; warning?: string } {
  if (!isObject(raw)) {
    return { config: null, warning: `${source}: entry[${index}] is not an object` };
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!name || !command) {
    return { config: null, warning: `${source}: entry[${index}] must include non-empty name and command` };
  }

  const args = Array.isArray(raw.args)
    ? raw.args.filter((value): value is string => typeof value === 'string')
    : [];

  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: MCPToolSchema[] = rawTools
    .map((tool, toolIndex) => sanitizeToolSchema(tool, name, source, toolIndex))
    .filter((tool): tool is MCPToolSchema => Boolean(tool));

  const idleTimeout = typeof raw.idleTimeout === 'number' && Number.isFinite(raw.idleTimeout)
    ? Math.max(0, Math.round(raw.idleTimeout))
    : undefined;

  return {
    config: {
      name,
      command,
      args,
      tools,
      ...(idleTimeout !== undefined ? { idleTimeout } : {}),
    },
  };
}

export function parseMcpServerList(raw: unknown, source: string): ParseResult {
  const warnings: string[] = [];
  const entries = Array.isArray(raw)
    ? raw
    : (isObject(raw) && Array.isArray(raw.servers) ? raw.servers : []);

  if (!entries.length) {
    return { servers: [], warnings };
  }

  const servers: DiscoveredMcpServer[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const { config, warning } = sanitizeServerConfig(entries[i], source, i);
    if (warning) warnings.push(warning);
    if (!config) continue;
    servers.push({ ...config, source });
  }
  return { servers, warnings };
}

function readJsonFileSafe(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err: any) {
    log.warn(`[MCP Discovery] Could not parse ${filePath}: ${err?.message || err}`);
    return null;
  }
}

export function loadConfiguredMcpServersSync(): ParseResult {
  const warnings: string[] = [];
  const merged = new Map<string, DiscoveredMcpServer>();

  const userDataDir = path.dirname(store.path);
  const configFilePath = process.env.CLAWDIA_MCP_SERVERS_FILE?.trim() || path.join(userDataDir, DEFAULT_MCP_CONFIG_FILE);

  const candidates: Array<{ source: string; raw: unknown }> = [
    {
      source: 'env:CLAWDIA_MCP_SERVERS',
      raw: (() => {
        const raw = process.env.CLAWDIA_MCP_SERVERS;
        if (!raw?.trim()) return null;
        try {
          return JSON.parse(raw);
        } catch (err: any) {
          warnings.push(`env:CLAWDIA_MCP_SERVERS is invalid JSON (${err?.message || err})`);
          return null;
        }
      })(),
    },
    {
      source: 'store:mcpServers',
      raw: store.get('mcpServers' as any),
    },
    {
      source: `file:${configFilePath}`,
      raw: readJsonFileSafe(configFilePath),
    },
  ];

  for (const candidate of candidates) {
    const parsed = parseMcpServerList(candidate.raw, candidate.source);
    warnings.push(...parsed.warnings);
    for (const server of parsed.servers) {
      if (merged.has(server.name)) continue;
      merged.set(server.name, server);
    }
  }

  return {
    servers: Array.from(merged.values()),
    warnings,
  };
}
