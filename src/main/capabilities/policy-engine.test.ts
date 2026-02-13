import { describe, it, expect } from 'vitest';
import { evaluateCommandPolicy } from './policy-engine';

describe('policy engine', () => {
  it('blocks catastrophic rm -rf /', () => {
    const decision = evaluateCommandPolicy('rm -rf /');
    expect(decision.action).toBe('deny');
    expect(decision.reason).toContain('catastrophic');
  });

  it('rewrites apt install to noninteractive unattended form', () => {
    const decision = evaluateCommandPolicy('sudo apt-get install -y jq');
    expect(decision.action).toBe('rewrite');
    expect(decision.command).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(decision.command).toContain('sudo -n apt-get install');
  });

  it('blocks destructive operations on protected paths', () => {
    const decision = evaluateCommandPolicy('rm -rf /etc/nginx');
    expect(decision.action).toBe('deny');
    expect(decision.reason).toContain('outside allowed roots');
  });
});
