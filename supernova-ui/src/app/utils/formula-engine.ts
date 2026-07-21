/**
 * Safe formula engine for evaluating mathematical expressions with path variables.
 * Uses recursive descent parsing — NO eval().
 *
 * Supported:
 *   Variables: P1, P2, P3, ... (1-based path index)
 *   Operators: +  -  *  /  ( )  and comparisons  >  <  >=  <=  ==  !=
 *   Functions: SUM(a,b,...), AVG(a,b,...), MAX(a,b,...), MIN(a,b,...),
 *              ABS(x), SQRT(x), POW(x,y), DIFF(a,b) = a-b, COUNT(a,b,...),
 *              ROUND(x,[d]), IF(cond, a, b), AND(...), OR(...), NOT(x),
 *              CLAMP(x, lo, hi), COALESCE(a, b, ...)
 *   Constants: PI, E
 */

// ── Token types ──────────────────────────────────────
type TokenKind = 'NUMBER' | 'VARIABLE' | 'OP' | 'CMP' | 'LPAREN' | 'RPAREN' | 'COMMA' | 'FUNC' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

// ── Tokeniser ────────────────────────────────────────────────
const FUNC_NAMES = new Set(['SUM', 'AVG', 'MAX', 'MIN', 'ABS', 'SQRT', 'POW', 'DIFF']);
const CONSTANTS: Record<string, number> = { PI: Math.PI, E: Math.E };

function tokenise(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.replace(/\s+/g, ''); // strip whitespace

  while (i < s.length) {
    const ch = s[i];

    // number (integer or decimal)
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < s.length && /[0-9.]/.test(s[i])) { num += s[i++]; }
      tokens.push({ kind: 'NUMBER', value: num });
      continue;
    }

    // variable P1..P99 or function name or constant
    if (/[A-Za-z]/.test(ch)) {
      let word = '';
      while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) { word += s[i++]; }
      const upper = word.toUpperCase();

      if (FUNC_NAMES.has(upper)) {
        tokens.push({ kind: 'FUNC', value: upper });
      } else if (upper in CONSTANTS) {
        tokens.push({ kind: 'NUMBER', value: String(CONSTANTS[upper]) });
      } else if (/^P\d+$/i.test(word)) {
        tokens.push({ kind: 'VARIABLE', value: upper });
      } else {
        throw new FormulaError(`Unknown identifier: ${word}`);
      }
      continue;
    }

    if (ch === '(') { tokens.push({ kind: 'LPAREN', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'RPAREN', value: ')' }); i++; continue; }
    if (ch === ',') { tokens.push({ kind: 'COMMA', value: ',' }); i++; continue; }

    // comparison operators (two-char first)
    if ('<>=!'.includes(ch)) {
      const next = s[i + 1];
      if (next === '=') {
        tokens.push({ kind: 'CMP', value: ch + '=' }); i += 2; continue;
      }
      if (ch === '<' || ch === '>') {
        tokens.push({ kind: 'CMP', value: ch }); i++; continue;
      }
      if (ch === '=') {
        // bare '=' treated as equality
        tokens.push({ kind: 'CMP', value: '==' }); i++; continue;
      }
      throw new FormulaError(`Unexpected character: ${ch}`);
    }

    if ('+-*/'.includes(ch)) { tokens.push({ kind: 'OP', value: ch }); i++; continue; }

    throw new FormulaError(`Unexpected character: ${ch}`);
  }

  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

// ── Parser (recursive descent) ───────────────────────────────
class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private expect(kind: TokenKind): Token {
    const t = this.advance();
    if (t.kind !== kind) throw new FormulaError(`Expected ${kind}, got ${t.kind} (${t.value})`);
    return t;
  }

  // entry
  parse(): ASTNode {
    const node = this.comparison();
    if (this.peek().kind !== 'EOF') throw new FormulaError('Unexpected token after expression');
    return node;
  }

  // comparison = expression ((> | < | >= | <= | == | !=) expression)?
  private comparison(): ASTNode {
    let left = this.expression();
    while (this.peek().kind === 'CMP') {
      const op = this.advance().value;
      const right = this.expression();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  // expression = term (('+' | '-') term)*
  private expression(): ASTNode {
    let left = this.term();
    while (this.peek().kind === 'OP' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.advance().value;
      const right = this.term();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  // term = unary (('*' | '/') unary)*
  private term(): ASTNode {
    let left = this.unary();
    while (this.peek().kind === 'OP' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.advance().value;
      const right = this.unary();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  // unary = ('-')? primary
  private unary(): ASTNode {
    if (this.peek().kind === 'OP' && this.peek().value === '-') {
      this.advance();
      const operand = this.primary();
      return { type: 'binary', op: '*', left: { type: 'number', value: -1 }, right: operand };
    }
    return this.primary();
  }

  // primary = NUMBER | VARIABLE | FUNC '(' args ')' | '(' expression ')'
  private primary(): ASTNode {
    const t = this.peek();

    if (t.kind === 'NUMBER') {
      this.advance();
      return { type: 'number', value: parseFloat(t.value) };
    }

    if (t.kind === 'VARIABLE') {
      this.advance();
      return { type: 'variable', name: t.value };
    }

    if (t.kind === 'FUNC') {
      const name = this.advance().value;
      this.expect('LPAREN');
      const args: ASTNode[] = [];
      if (this.peek().kind !== 'RPAREN') {
        args.push(this.comparison());
        while (this.peek().kind === 'COMMA') {
          this.advance();
          args.push(this.comparison());
        }
      }
      this.expect('RPAREN');
      return { type: 'function', name, args };
    }

    if (t.kind === 'LPAREN') {
      this.advance();
      const node = this.comparison();
      this.expect('RPAREN');
      return node;
    }

    throw new FormulaError(`Unexpected token: ${t.kind} (${t.value})`);
  }
}

// ── AST node types ───────────────────────────────────────────
type ASTNode =
  | { type: 'number'; value: number }
  | { type: 'variable'; name: string }
  | { type: 'binary'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'function'; name: string; args: ASTNode[] };

// ── Evaluator ────────────────────────────────────────────────
function evaluate(node: ASTNode, ctx: Record<string, number>): number {
  switch (node.type) {
    case 'number':
      return node.value;

    case 'variable': {
      const val = ctx[node.name];
      if (val === undefined) throw new FormulaError(`Variable ${node.name} is not defined`);
      return val;
    }

    case 'binary': {
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? NaN : l / r;
        case '>':  return l > r ? 1 : 0;
        case '<':  return l < r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '==': return l === r ? 1 : 0;
        case '!=': return l !== r ? 1 : 0;
        default: throw new FormulaError(`Unknown operator: ${node.op}`);
      }
    }

    case 'function': {
      // IF is short-circuit: only evaluate the chosen branch
      if (node.name === 'IF') {
        if (node.args.length < 3) throw new FormulaError('IF requires 3 arguments: IF(condition, then, else)');
        const cond = evaluate(node.args[0], ctx);
        return cond ? evaluate(node.args[1], ctx) : evaluate(node.args[2], ctx);
      }
      const vals = node.args.map(a => evaluate(a, ctx));
      switch (node.name) {
        case 'SUM':  return vals.reduce((s, v) => s + v, 0);
        case 'AVG':  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
        case 'MAX':  return Math.max(...vals);
        case 'MIN':  return Math.min(...vals);
        case 'ABS':  return Math.abs(vals[0]);
        case 'SQRT': return Math.sqrt(vals[0]);
        case 'POW':  return Math.pow(vals[0], vals[1] ?? 2);
        case 'DIFF': return vals[0] - (vals[1] ?? 0);
        case 'COUNT': return vals.length;
        case 'ROUND': {
          const d = vals[1] ?? 0;
          const f = Math.pow(10, d);
          return Math.round(vals[0] * f) / f;
        }
        case 'AND':  return vals.every(v => v !== 0) ? 1 : 0;
        case 'OR':   return vals.some(v => v !== 0) ? 1 : 0;
        case 'NOT':  return vals[0] === 0 ? 1 : 0;
        case 'CLAMP': {
          const [x, lo, hi] = vals;
          return Math.min(Math.max(x, lo), hi);
        }
        case 'COALESCE': {
          for (const v of vals) { if (!isNaN(v)) return v; }
          return NaN;
        }
        default:     throw new FormulaError(`Unknown function: ${node.name}`);
      }
    }
  }
}

// ── Error class ──────────────────────────────────────────────
export class FormulaError extends Error {
  constructor(message: string) { super(message); this.name = 'FormulaError'; }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Validate a formula string. Returns null if valid, or an error message.
 */
export function validateFormula(formula: string, pathCount: number): string | null {
  if (!formula || !formula.trim()) return null; // empty formula is valid (no-op)
  try {
    const tokens = tokenise(formula);
    const ast = new Parser(tokens).parse();
    // check that all referenced variables exist
    checkVariables(ast, pathCount);
    return null;
  } catch (e: any) {
    return e.message || 'Invalid formula';
  }
}

function checkVariables(node: ASTNode, pathCount: number): void {
  if (node.type === 'variable') {
    const idx = parseInt(node.name.substring(1), 10);
    if (idx < 1 || idx > pathCount) {
      throw new FormulaError(`${node.name} is out of range (you have ${pathCount} path${pathCount !== 1 ? 's' : ''})`);
    }
  } else if (node.type === 'binary') {
    checkVariables(node.left, pathCount);
    checkVariables(node.right, pathCount);
  } else if (node.type === 'function') {
    node.args.forEach(a => checkVariables(a, pathCount));
  }
}

/**
 * Evaluate a formula for a single set of values.
 * @param formula   e.g. "P1 + P2"
 * @param values    Map from variable name to value, e.g. { P1: 10, P2: 20 }
 */
export function evaluateFormula(formula: string, values: Record<string, number>): number {
  const tokens = tokenise(formula);
  const ast = new Parser(tokens).parse();
  return evaluate(ast, values);
}

/**
 * Evaluate a formula point-by-point across aligned arrays.
 * @param formula    e.g. "P1 + P2"
 * @param dataArrays Array of data arrays, index 0 = P1, index 1 = P2, etc.
 * @returns          Computed array
 */
export function evaluateFormulaOnArrays(formula: string, dataArrays: number[][]): number[] {
  if (!formula || !formula.trim()) return [];
  const tokens = tokenise(formula);
  const ast = new Parser(tokens).parse();

  // find the longest array length
  const len = Math.max(...dataArrays.map(a => a.length), 0);
  const result: number[] = [];

  for (let i = 0; i < len; i++) {
    const ctx: Record<string, number> = {};
    dataArrays.forEach((arr, idx) => {
      ctx[`P${idx + 1}`] = i < arr.length ? arr[i] : (arr.length > 0 ? arr[arr.length - 1] : 0);
    });
    try {
      result.push(evaluate(ast, ctx));
    } catch {
      result.push(NaN);
    }
  }

  return result;
}

/**
 * Extract all variable names from a formula (e.g. ['P1', 'P3'])
 */
export function extractVariables(formula: string): string[] {
  if (!formula || !formula.trim()) return [];
  try {
    const tokens = tokenise(formula);
    return tokens
      .filter(t => t.kind === 'VARIABLE')
      .map(t => t.value)
      .filter((v, i, arr) => arr.indexOf(v) === i); // unique
  } catch {
    return [];
  }
}
