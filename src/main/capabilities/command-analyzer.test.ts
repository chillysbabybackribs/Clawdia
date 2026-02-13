import { describe, it, expect } from 'vitest';
import { splitCommandSegments, collectExecutables, extractExecutable } from './command-analyzer';

describe('command analyzer', () => {
  it('splits shell command chains into segments', () => {
    const segments = splitCommandSegments('BROWSER=none npm login && rg "foo" src | jq .');
    expect(segments.length).toBe(3);
    expect(segments[0]).toContain('npm login');
    expect(segments[1]).toContain('rg "foo" src');
    expect(segments[2]).toContain('jq .');
  });

  it('extracts executable while ignoring env prefixes', () => {
    expect(extractExecutable('FOO=bar BAZ=1 rg -n test src')).toBe('rg');
  });

  it('collects unique executables from a command chain', () => {
    const execs = collectExecutables('rg foo . && rg bar .; jq . out.json');
    expect(execs).toEqual(['rg', 'jq']);
  });
});
