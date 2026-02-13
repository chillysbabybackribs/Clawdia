import * as path from 'path';

const SHELL_BUILTINS = new Set([
  'alias', 'bg', 'bind', 'break', 'builtin', 'cd', 'command', 'compgen', 'complete', 'continue', 'declare',
  'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fg', 'getopts', 'hash',
  'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'popd', 'printf', 'pushd', 'pwd', 'read',
  'readonly', 'return', 'set', 'shift', 'source', 'shopt', 'test', 'times', 'trap', 'true', 'type', 'ulimit',
  'umask', 'unalias', 'unset', 'wait', ':', '.', '[', '[[',
]);

export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let single = false;
  let dbl = false;
  let escape = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1] || '';

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escape = true;
      continue;
    }

    if (ch === "'" && !dbl) {
      single = !single;
      current += ch;
      continue;
    }

    if (ch === '"' && !single) {
      dbl = !dbl;
      current += ch;
      continue;
    }

    if (!single && !dbl) {
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      if (ch === ';' || ch === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function tokenizeSegment(segment: string): string[] {
  const tokens = segment.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) || [];
  return tokens.map((t) => t.replace(/^['"]|['"]$/g, ''));
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function stripSubshellPrefix(token: string): string {
  return token.replace(/^\(+/, '').trim();
}

export function extractExecutable(segment: string): string | null {
  const tokens = tokenizeSegment(segment);
  if (!tokens.length) return null;

  let idx = 0;
  while (idx < tokens.length && isEnvAssignment(tokens[idx])) idx += 1;
  if (idx >= tokens.length) return null;

  const raw = stripSubshellPrefix(tokens[idx]);
  if (!raw || raw.startsWith('$(') || raw.startsWith('`')) return null;

  const base = path.basename(raw);
  if (!base || SHELL_BUILTINS.has(base)) return null;
  return base;
}

export function collectExecutables(command: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const segments = splitCommandSegments(command);
  for (const segment of segments) {
    const exec = extractExecutable(segment);
    if (!exec || seen.has(exec)) continue;
    seen.add(exec);
    out.push(exec);
  }
  return out;
}
