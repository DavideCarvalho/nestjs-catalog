/**
 * Which of the two shapes a JavaScript or TypeScript transform is written in,
 * and the one rule that tells them apart.
 *
 * ## The two shapes
 *
 * A transform used to be — and, for everything already stored, still is — a
 * **bare body**: the text between the braces of a function the harness supplies.
 *
 * ```js
 * return records.map((r) => ({ mgmtCd: r["Mgmt Cd"] }));
 * ```
 *
 * That shape works, and its problem is not syntax. The harness supplied
 * `(records, context)` **positionally**, so the set of things a transform can be
 * given was fixed by the day the second parameter was added: a third one changes
 * the meaning of every signature ever written, and there is no version of
 * "records, context, andNowAlsoThis" that does not make the previous shape a
 * subset by luck rather than by design. So the supported shape is now a real
 * function over **one object**:
 *
 * ```js
 * export default function transform({ records, context }) {
 *   return records.map((r) => ({ mgmtCd: r["Mgmt Cd"] }));
 * }
 * ```
 *
 * A field can be added to that object without touching a single stored
 * transform, which is the entire argument for it.
 *
 * ## The rule
 *
 * **A top-level `export` keyword, and nothing else.** Code that has one is a
 * module; code that has none is a body.
 *
 * That is a discriminator rather than a heuristic, and the reason is worth being
 * exact about: `export` is a *syntax error* inside a function body. Every
 * transform stored today runs as a function body today, so no stored transform
 * can contain a top-level `export` — not "probably does not", cannot. Backward
 * compatibility here is a property of the language, not of how good the guess is.
 *
 * ## What the rule deliberately does not look at
 *
 * Not the word `function`. Not a function *declaration* named `transform`
 * either, which is the tempting second rule and is the one that would break
 * real code:
 *
 * ```js
 * function transform(r) { return { mgmtCd: r["Mgmt Cd"] }; }
 * return records.map(transform);
 * ```
 *
 * That is a bare body which declares a local helper it happens to have named
 * `transform`. A detector that called it the new shape would call the helper
 * with `{records, context}` — one object where a record was expected — and store
 * 100,000 rows of `undefined` without erroring once. Silent wrong data is the
 * worst failure available here, so the detector does not offer an opinion about
 * names at all.
 *
 * ## The scan, and its one known limit
 *
 * Strings, template literals (including `${}` nesting), regular-expression
 * literals and both kinds of comment are skipped, so `// export default` and
 * `"export"` are not exports. The keyword must then appear at **statement
 * position** — start of input, or after `;`, `}`, or a newline — at brace,
 * paren and bracket depth zero.
 *
 * Regular-expression literals are found by the usual rule (a `/` is a regex
 * unless what precedes it could end a value), which is the one place a scanner
 * without a full parser can be wrong. Its consequence is bounded on purpose: a
 * misread makes this return `false` for a module, the code is run as a body, and
 * the author gets `SyntaxError: Unexpected token 'export'` — which
 * {@link transformShapeHint} turns into a sentence naming this exact rule. A
 * wrong answer here produces a reported error, never a silently different run.
 */

/** What shape a transform's code is in. */
export type TransformShape = 'module' | 'body';

/** Characters that may make up an identifier, for the boundary check. */
function isIdentifierChar(char: string): boolean {
  return /[\p{ID_Continue}$]/u.test(char);
}

/**
 * Words after which a `/` is a regular expression even though the character
 * before it is an identifier character.
 *
 * `return /a'b/` is the case that matters: without this the apostrophe would
 * open a string literal that never closes, and everything after it — including
 * a real `export` — would be skipped as string contents. That is precisely the
 * scanner's documented failure mode, so the cheap fix for its likeliest cause is
 * worth the fifteen words.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

/**
 * Whether a `/` at this point starts a regular expression rather than a
 * division.
 *
 * The conventional rule: a regex may only appear where a *value* may appear, so
 * anything that could end a value — an identifier, a number, a closing bracket
 * or paren — means division. `}` is treated as ending a value too, which is the
 * common convention and wrong only for `if (x) {} /re/.test(y)`, a statement
 * nobody writes.
 */
function startsRegex(code: string, at: number, lastSignificant: string): boolean {
  if (lastSignificant === '') return true;
  if (lastSignificant === ')' || lastSignificant === ']' || lastSignificant === '}') return false;
  if (!isIdentifierChar(lastSignificant)) return true;
  // Back over the whitespace between the word and the slash, then over the word
  // itself: `return /x/` puts a space where `code[at - 1]` is.
  let end = at;
  while (end > 0 && /\s/.test(code[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && isIdentifierChar(code[start - 1])) start -= 1;
  return REGEX_PRECEDING_KEYWORDS.has(code.slice(start, end));
}

/**
 * The scan itself, as a cursor over the source.
 *
 * A class rather than one long loop because the loop *was* one long loop, and it
 * scored 126 on a complexity budget of 15 — which in this case the linter was
 * right about. Every branch below is one lexical thing the scanner has to be
 * able to walk past without losing its place, and naming them separately is what
 * makes it possible to read whether the list is complete.
 *
 * State is deliberately minimal: where we are, what the last meaningful
 * character was, whether a newline has happened since, and three depths plus a
 * stack of open template literals. Nothing here builds a tree, because nothing
 * here needs to answer any question except one.
 */
class ModuleScanner {
  private i = 0;
  private lastSignificant = '';
  private newlineSince = false;
  private braces = 0;
  private parens = 0;
  private brackets = 0;
  /**
   * Brace depths at which template literals opened, innermost last. A `}` ends
   * an interpolation when the depth has come back to the one recorded for it.
   */
  private readonly templates: number[] = [];

  constructor(private readonly code: string) {}

  /** Whether a top-level `export` appears anywhere in the source. */
  findsExport(): boolean {
    while (this.i < this.code.length) {
      if (this.step()) return true;
      this.i += 1;
    }
    return false;
  }

  private step(): boolean {
    const char = this.code[this.i];
    if (this.skipTrivia(char)) return false;
    if (this.skipLiteral(char)) return false;
    if (this.closesInterpolation(char)) return false;
    this.adjustDepth(char);
    if (this.isExportHere(char)) return true;
    this.lastSignificant = char;
    this.newlineSince = false;
    return false;
  }

  /**
   * Whitespace and comments.
   *
   * A comment leaves {@link lastSignificant} alone on purpose: a comment between
   * a `;` and an `export` does not move the `export` off the start of a
   * statement, and a rule that thought it did would fail on the most ordinary
   * thing anybody writes above a function.
   */
  private skipTrivia(char: string): boolean {
    if (char === '\n') {
      this.newlineSince = true;
      return true;
    }
    if (char === ' ' || char === '\t' || char === '\r') return true;
    return this.skipComment(char);
  }

  private skipComment(char: string): boolean {
    if (char !== '/') return false;
    const next = this.code[this.i + 1];
    if (next === '/') {
      while (this.i < this.code.length && this.code[this.i] !== '\n') this.i += 1;
      this.newlineSince = true;
      return true;
    }
    if (next !== '*') return false;
    const end = this.code.indexOf('*/', this.i + 2);
    const chunk = end === -1 ? this.code.slice(this.i) : this.code.slice(this.i, end + 2);
    // A block comment spanning lines ends the line for the newline rule, and an
    // unterminated one swallows the rest of the file.
    if (chunk.includes('\n')) this.newlineSince = true;
    this.i = end === -1 ? this.code.length : end + 1;
    return true;
  }

  /** Strings, template literals and regular expressions — walked past whole. */
  private skipLiteral(char: string): boolean {
    if (char === '"' || char === "'") {
      this.skipQuoted(char);
      return this.consumedValue(char);
    }
    if (char === '`') {
      this.openTemplate();
      return this.consumedValue('`');
    }
    if (char === '/' && startsRegex(this.code, this.i, this.lastSignificant)) {
      this.skipRegex();
      return this.consumedValue('/');
    }
    return false;
  }

  /** Record that something which can end a value has just been walked past. */
  private consumedValue(ending: string): boolean {
    this.lastSignificant = ending;
    this.newlineSince = false;
    return true;
  }

  private skipQuoted(quote: string): void {
    this.i += 1;
    while (this.i < this.code.length && this.code[this.i] !== quote) {
      if (this.code[this.i] === '\\') this.i += 1;
      this.i += 1;
    }
  }

  private skipRegex(): void {
    this.i += 1;
    let inClass = false;
    while (this.i < this.code.length) {
      const char = this.code[this.i];
      if (char === '\\') this.i += 1;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      // A newline ends it either way: an unterminated regex is a syntax error,
      // and running to the end of the file on one would hide everything after.
      else if (char === '\n' || (char === '/' && !inClass)) break;
      this.i += 1;
    }
  }

  /**
   * Walk a template literal to its closing backtick, or to the `${` that hands
   * control back to the code scanner.
   */
  private openTemplate(): void {
    this.templates.push(this.braces);
    this.i += 1;
    while (this.i < this.code.length) {
      const char = this.code[this.i];
      if (char === '\\') {
        this.i += 1;
      } else if (char === '`') {
        this.templates.pop();
        return;
      } else if (char === '$' && this.code[this.i + 1] === '{') {
        this.i += 1;
        return;
      }
      this.i += 1;
    }
  }

  /**
   * A `}` that ends an interpolation rather than a block: keep reading the
   * template literal it was inside.
   */
  private closesInterpolation(char: string): boolean {
    if (char !== '}') return false;
    if (this.templates.length === 0) return false;
    if (this.templates[this.templates.length - 1] !== this.braces) return false;
    this.templates.pop();
    this.i += 1;
    this.resumeTemplate();
    return true;
  }

  private resumeTemplate(): void {
    while (this.i < this.code.length) {
      const char = this.code[this.i];
      if (char === '\\') {
        this.i += 1;
      } else if (char === '`') {
        this.consumedValue('`');
        return;
      } else if (char === '$' && this.code[this.i + 1] === '{') {
        this.templates.push(this.braces);
        this.i += 1;
        this.newlineSince = false;
        return;
      }
      this.i += 1;
    }
  }

  private adjustDepth(char: string): void {
    if (char === '{') this.braces += 1;
    else if (char === '}') this.braces -= 1;
    else if (char === '[') this.brackets += 1;
    else if (char === ']') this.brackets -= 1;
    else if (char === '(') this.parens += 1;
    else if (char === ')') this.parens -= 1;
  }

  /**
   * The whole question, in one place: the keyword `export`, whole, at the start
   * of a statement, at the outermost level of the source.
   */
  private isExportHere(char: string): boolean {
    if (char !== 'e') return false;
    if (this.braces !== 0 || this.parens !== 0 || this.brackets !== 0) return false;
    if (this.templates.length > 0) return false;
    if (!this.atStatementStart()) return false;
    if (!this.code.startsWith('export', this.i)) return false;
    return !isIdentifierChar(this.code[this.i + 6] ?? '');
  }

  /**
   * Start of input, after a `;` or a `}`, or on a new line — the last because
   * JavaScript does not require the semicolon and plenty of people do not write
   * one.
   */
  private atStatementStart(): boolean {
    return (
      this.lastSignificant === '' ||
      this.lastSignificant === ';' ||
      this.lastSignificant === '}' ||
      this.newlineSince
    );
  }
}

/**
 * Does this code declare an ES module — and so ask to be called as a function
 * over one object?
 *
 * See the module docblock for the rule and why it is the rule. Python is not
 * asked this question: its harness writes the `def` itself, so a Python
 * transform never states a signature and never had the problem this detector
 * exists to solve.
 */
export function transformDeclaresModule(code: string): boolean {
  return new ModuleScanner(code).findsExport();
}

/** {@link transformDeclaresModule}, as the shape it names. */
export function transformShape(code: string): TransformShape {
  return transformDeclaresModule(code) ? 'module' : 'body';
}

/**
 * The sentence to add when a body-shaped run died on the one syntax error that
 * means the detector and the author disagreed.
 *
 * The rule above is a scan, not a parser, and its documented limit is that a
 * regular-expression literal read as a division can hide a real `export`. The
 * author then sees `Unexpected token 'export'` from code they believe is a
 * perfectly good module, and has no way to know that a *rule they have never
 * read* is what decided otherwise. Naming the rule in the error is the whole
 * difference between a two-minute fix and an afternoon.
 *
 * Deliberately not a fallback re-run in the other shape. Running code twice
 * because the first attempt failed is guessing with extra steps: the second
 * attempt would report a different error for the same text, and neither error
 * would be trustworthy.
 */
export function transformShapeHint(shape: TransformShape, stderr: string): string {
  if (shape !== 'body') return '';
  if (!/Unexpected token '?export/.test(stderr)) return '';
  return (
    '\nThis ran as a bare function body, because the catalog looks for an `export` keyword at ' +
    'the start of a statement, outside any brackets, string or comment — and found none. If ' +
    'this was meant to be a module, move the `export` to the start of its own line.'
  );
}
