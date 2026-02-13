import { describe, expect, it } from 'vitest';
import { buildContainerRunPlan, getContainerImage } from './container-executor';

describe('container executor', () => {
  it('builds a deterministic container run plan', () => {
    const plan = buildContainerRunPlan('docker', 'node:20-bookworm-slim', '/tmp/project');
    expect(plan.runtime).toBe('docker');
    expect(plan.image).toBe('node:20-bookworm-slim');
    expect(plan.hostWorkspacePath).toBe('/tmp/project');
    expect(plan.containerWorkspacePath).toBe('/workspace');
    expect(plan.args[0]).toBe('run');
    expect(plan.args).toContain('-v');
    expect(plan.args).toContain('/tmp/project:/workspace');
    expect(plan.args).toContain('/bin/sh');
  });

  it('uses default container image when env is not set', () => {
    const original = process.env.CLAWDIA_CONTAINER_IMAGE;
    delete process.env.CLAWDIA_CONTAINER_IMAGE;
    expect(getContainerImage()).toBe('node:20-bookworm-slim');
    process.env.CLAWDIA_CONTAINER_IMAGE = original;
  });
});
