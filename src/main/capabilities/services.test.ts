import { describe, expect, it } from 'vitest';
import { createCapabilityPlatformServices } from './services';

describe('capability platform services', () => {
  it('tracks MCP runtime health transitions and restart metadata', () => {
    const services = createCapabilityPlatformServices();
    const runtime = services.mcpRuntime;
    const now = Date.now();

    const registered = runtime.registerServer({
      name: 'test-mcp',
      command: 'node',
      args: ['server.js'],
      tools: [
        {
          name: 'test_tool',
          description: 'test',
          inputSchema: { type: 'object' },
        },
      ],
    });
    expect(registered.status).toBe('starting');
    expect(registered.restartCount).toBe(0);
    expect(registered.lastStartedAt).toBeGreaterThanOrEqual(now);

    const degraded = runtime.updateHealth('test-mcp', 'degraded', 'probe failed');
    expect(degraded?.status).toBe('degraded');
    expect(degraded?.consecutiveFailures).toBe(1);
    expect(degraded?.lastError).toContain('probe failed');

    const restarted = runtime.recordRestart('test-mcp', 'circuit breaker');
    expect(restarted?.status).toBe('starting');
    expect(restarted?.restartCount).toBe(1);
    expect(restarted?.lastError).toContain('circuit breaker');

    const healthy = runtime.updateHealth('test-mcp', 'healthy');
    expect(healthy?.status).toBe('healthy');
    expect(healthy?.consecutiveFailures).toBe(0);
    expect(healthy?.lastError).toBeUndefined();
  });
});
