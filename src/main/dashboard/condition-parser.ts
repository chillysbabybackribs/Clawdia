/**
 * Safe recursive descent condition parser for dashboard rules.
 * Grammar:
 *   Expr → OrExpr
 *   OrExpr → AndExpr ('OR' AndExpr)*
 *   AndExpr → NotExpr ('AND' NotExpr)*
 *   NotExpr → 'NOT' NotExpr | Comparison
 *   Comparison → Value (CompOp Value)?
 *   Value → '(' Expr ')' | number | boolean | null | identifier
 *   CompOp → > | >= | < | <= | == | !=
 */

const MAX_CONDITION_LENGTH = 500;
const MAX_DEPTH = 10;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

type Token =
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'keyword'; value: 'AND' | 'OR' | 'NOT' }
  | { type: 'paren'; value: '(' | ')' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }

    // Parentheses
    if (input[i] === '(' || input[i] === ')') {
      tokens.push({ type: 'paren', value: input[i] as '(' | ')' });
      i++;
      continue;
    }

    // Multi-char operators
    const twoChar = input.slice(i, i + 2);
    if (twoChar === '>=' || twoChar === '<=' || twoChar === '==' || twoChar === '!=') {
      tokens.push({ type: 'op', value: twoChar });
      i += 2;
      continue;
    }
    if (input[i] === '>' || input[i] === '<') {
      tokens.push({ type: 'op', value: input[i] });
      i++;
      continue;
    }

    // Numbers (integers and decimals, including negative)
    if (/[0-9]/.test(input[i]) || (input[i] === '-' && i + 1 < input.length && /[0-9]/.test(input[i + 1]))) {
      let num = '';
      if (input[i] === '-') { num += '-'; i++; }
      while (i < input.length && /[0-9.]/.test(input[i])) { num += input[i]; i++; }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    // String literals (single or double quoted)
    if (input[i] === "'" || input[i] === '"') {
      const quote = input[i];
      i++; // skip opening quote
      let str = '';
      while (i < input.length && input[i] !== quote) {
        str += input[i];
        i++;
      }
      if (i >= input.length) throw new Error(`Unterminated string literal`);
      i++; // skip closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Identifiers, keywords, booleans, null
    if (/[a-zA-Z_]/.test(input[i])) {
      let word = '';
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) { word += input[i]; i++; }
      if (word === 'AND' || word === 'OR' || word === 'NOT') {
        tokens.push({ type: 'keyword', value: word });
      } else if (word === 'true') {
        tokens.push({ type: 'boolean', value: true });
      } else if (word === 'false') {
        tokens.push({ type: 'boolean', value: false });
      } else if (word === 'null') {
        tokens.push({ type: 'null' });
      } else if (IDENT_RE.test(word)) {
        tokens.push({ type: 'ident', value: word });
      } else {
        throw new Error(`Invalid identifier: ${word}`);
      }
      continue;
    }

    throw new Error(`Unexpected character: ${input[i]}`);
  }
  return tokens;
}

type CondValue = number | boolean | string | null;

class Parser {
  private tokens: Token[];
  private pos = 0;
  private depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): CondValue {
    const result = this.orExpr();
    if (this.pos < this.tokens.length) {
      throw new Error('Unexpected tokens after expression');
    }
    return result;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private orExpr(): CondValue {
    let left = this.andExpr();
    while (this.peek()?.type === 'keyword' && (this.peek() as any).value === 'OR') {
      this.advance();
      const right = this.andExpr();
      left = toBool(left) || toBool(right);
    }
    return left;
  }

  private andExpr(): CondValue {
    let left = this.notExpr();
    while (this.peek()?.type === 'keyword' && (this.peek() as any).value === 'AND') {
      this.advance();
      const right = this.notExpr();
      left = toBool(left) && toBool(right);
    }
    return left;
  }

  private notExpr(): CondValue {
    if (this.peek()?.type === 'keyword' && (this.peek() as any).value === 'NOT') {
      this.advance();
      const val = this.notExpr();
      return !toBool(val);
    }
    return this.comparison();
  }

  private comparison(): CondValue {
    const left = this.value();
    const tok = this.peek();
    if (tok?.type === 'op') {
      const op = (this.advance() as { type: 'op'; value: string }).value;
      const right = this.value();
      return compare(left, op, right);
    }
    return left;
  }

  private value(): CondValue {
    this.depth++;
    if (this.depth > MAX_DEPTH) throw new Error('Max expression depth exceeded');

    const tok = this.peek();
    if (!tok) throw new Error('Unexpected end of expression');

    let result: CondValue;

    if (tok.type === 'paren' && tok.value === '(') {
      this.advance();
      result = this.orExpr();
      const closing = this.advance();
      if (!closing || closing.type !== 'paren' || (closing as any).value !== ')') {
        throw new Error('Expected closing parenthesis');
      }
    } else if (tok.type === 'number') {
      result = (this.advance() as { type: 'number'; value: number }).value;
    } else if (tok.type === 'boolean') {
      result = (this.advance() as { type: 'boolean'; value: boolean }).value;
    } else if (tok.type === 'string') {
      result = (this.advance() as { type: 'string'; value: string }).value;
    } else if (tok.type === 'null') {
      this.advance();
      result = null;
    } else if (tok.type === 'ident') {
      // Identifier is resolved from context by the caller — store as string
      result = (this.advance() as { type: 'ident'; value: string }).value;
    } else {
      throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
    }

    this.depth--;
    return result;
  }
}

function toBool(v: CondValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return true; // identifiers resolved to truthy
  return false;
}

function compare(left: CondValue, op: string, right: CondValue): boolean {
  // null comparison always returns false
  if (left === null || right === null) return false;

  const l = typeof left === 'number' ? left : left;
  const r = typeof right === 'number' ? right : right;

  switch (op) {
    case '>':  return (l as number) > (r as number);
    case '>=': return (l as number) >= (r as number);
    case '<':  return (l as number) < (r as number);
    case '<=': return (l as number) <= (r as number);
    case '==': return l === r;
    case '!=': return l !== r;
    default: return false;
  }
}

/**
 * Evaluates a condition string against a flat context object.
 * Identifiers in the condition are resolved from context keys.
 * Returns false on any error or null comparison.
 */
export function evaluateCondition(
  condition: string,
  context: Record<string, number | boolean | string | null>
): boolean {
  if (!condition || condition.length > MAX_CONDITION_LENGTH) return false;

  try {
    const tokens = tokenize(condition);

    // Resolve identifiers to context values
    const resolved = tokens.map((tok): Token => {
      if (tok.type === 'ident') {
        const val = context[tok.value];
        if (val === undefined || val === null) return { type: 'null' };
        if (typeof val === 'number') return { type: 'number', value: val };
        if (typeof val === 'boolean') return { type: 'boolean', value: val };
        return { type: 'ident', value: val as string };
      }
      return tok;
    });

    const parser = new Parser(resolved);
    const result = parser.parse();
    return toBool(result);
  } catch {
    return false;
  }
}
