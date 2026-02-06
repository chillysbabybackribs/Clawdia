import { describe, expect, test } from 'vitest';
import { buildFollowUpQueries } from './followup';

describe('follow-up query builder', () => {
  test('olive oil prompt adds HACCP safety terms and avoids infosec', () => {
    const queries = buildFollowUpQueries('PHYSICAL_PROCESS', ['food safety overview'], new Set(['oliveoil.com']), 2);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((query) => /haccp/i.test(query))).toBe(true);
    expect(queries.every((query) => !/cve/i.test(query))).toBe(true);
    expect(queries.every((query) => !/oauth/i.test(query))).toBe(true);
  });

  test('OpenClaw prompt surfaces security-specific keywords', () => {
    const queries = buildFollowUpQueries('SOFTWARE', ['security review process'], new Set(['openclaw.dev']), 2);
    expect(queries.some((query) => /security/i.test(query))).toBe(true);
    expect(queries.some((query) => /threat model/i.test(query))).toBe(true);
  });

  test('host diversity filter injects site exclusions when only one host', () => {
    const queries = buildFollowUpQueries('GENERAL', ['best practices'], new Set(['example.com']), 2);
    expect(queries.some((query) => /-site:example\.com/i.test(query))).toBe(true);
  });
});
