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
 * Does this code declare an ES module — and so ask to be called as a function
 * over one object?
 *
 * See the module docblock for the rule and why it is the rule. Python is not
 * asked this question: {@link pythonHarness} writes the `def` itself, so a
 * Python transform never states a signature and never had the problem this
 * detector exists to solve.
 */
export function transformDeclaresModule(code: string): boolean {
  let lastSignificant = '';
  let newlineSince = false;
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  /**
   * Open template literals, innermost last. A `}` closes the innermost `${` when
   * this is non-empty and the brace depth has come back to where that `${`
   * opened it.
   */
  const templates: number[] = [];

  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    const next = code[i + 1];

    if (char === '\n') {
      newlineSince = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') continue;

    // Comments — skipped whole, and they do not disturb statement position: a
    // comment between `;` and `export` leaves the `export` exactly as much at
    // the start of a statement as it was.
    if (char === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      newlineSince = true;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      // A block comment containing a newline ends the line for ASI purposes,
      // and an unterminated one swallows the rest of the file.
      const chunk = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      if (chunk.includes('\n')) newlineSince = true;
      i = end === -1 ? code.length : end + 1;
      continue;
    }

    if (char === '"' || char === "'") {
      i += 1;
      while (i < code.length && code[i] !== char) {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
      lastSignificant = char;
      newlineSince = false;
      continue;
    }

    if (char === '`') {
      templates.push(braces);
      // Consume until the closing backtick or a `${`, whichever comes first.
      i += 1;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 1;
        } else if (code[i] === '`') {
          templates.pop();
          break;
        } else if (code[i] === '$' && code[i + 1] === '{') {
          // Back to scanning code, inside the interpolation. The `}` that ends
          // it is recognised below by the depth recorded on the stack.
          i += 1;
          break;
        }
        i += 1;
      }
      lastSignificant = '`';
      newlineSince = false;
      continue;
    }

    if (char === '/' && startsRegex(code, i, lastSignificant)) {
      i += 1;
      let inClass = false;
      while (i < code.length) {
        if (code[i] === '\\') i += 1;
        else if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) break;
        else if (code[i] === '\n') break;
        i += 1;
      }
      lastSignificant = '/';
      newlineSince = false;
      continue;
    }

    if (char === '{') braces += 1;
    else if (char === '[') brackets += 1;
    else if (char === '(') parens += 1;
    else if (char === ']') brackets -= 1;
    else if (char === ')') parens -= 1;
    else if (char === '}') {
      const resumes = templates.length > 0 && templates[templates.length - 1] === braces;
      if (resumes) {
        // The interpolation is over: keep reading the template literal it was
        // inside, from just past this brace.
        templates.pop();
        let j = i + 1;
        let reopened = false;
        while (j < code.length) {
          if (code[j] === '\\') {
            j += 1;
          } else if (code[j] === '`') {
            break;
          } else if (code[j] === '$' && code[j + 1] === '{') {
            templates.push(braces);
            j += 1;
            reopened = true;
            break;
          }
          j += 1;
        }
        i = j;
        if (!reopened) lastSignificant = '`';
        newlineSince = false;
        continue;
      }
      braces -= 1;
    }

    if (
      char === 'e' &&
      braces === 0 &&
      parens === 0 &&
      brackets === 0 &&
      templates.length === 0 &&
      (lastSignificant === '' ||
        lastSignificant === ';' ||
        lastSignificant === '}' ||
        newlineSince) &&
      code.startsWith('export', i) &&
      !isIdentifierChar(code[i + 6] ?? '')
    ) {
      return true;
    }

    lastSignificant = char;
    newlineSince = false;
  }

  return false;
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
