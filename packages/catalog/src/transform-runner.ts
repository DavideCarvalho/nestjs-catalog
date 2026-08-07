import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import {
  CODE_CONTEXT_CONTRACT,
  type CatalogCodeContext,
  type CatalogTransform,
  type TransformLanguage,
  type TransformResult,
  type TransformRunner,
} from './catalog.pipeline';
import { type TransformShape, transformShape, transformShapeHint } from './transform-shape';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * How much of the child's stderr is held, and why it is a different number from
 * {@link MAX_OUTPUT_BYTES} with a different consequence.
 *
 * It had no bound at all, which is the one shape a capture must never have when
 * the thing filling it is user code: `stderr += chunk` ran for the whole timeout
 * window, so a transform whose only line is a loop writing to fd 2 grew the
 * **parent's** heap — not the child's — at whatever rate the pipe would carry,
 * and took the pod out with it. The timeout is no answer to that: thirty seconds
 * of an unthrottled writer is gigabytes, and the process that dies is the one
 * serving every other request.
 *
 * Bounded rather than killed, which is the opposite of what stdout overflow
 * does, and the asymmetry is the point. Stdout *is* the result channel — past
 * {@link MAX_OUTPUT_BYTES} there is no readable JSON line at the end of it and
 * the run has already failed, so killing costs nothing. Stderr is only ever the
 * diagnostic: a transform that writes a great deal to it and then returns a
 * perfectly good array of rows is a working transform, and killing it would turn
 * a noisy dependency's warnings into a failed load.
 *
 * The **head** is kept, because the head is what is read. Both places that
 * consume this take `stderr.slice(0, 500)` — the first line of a traceback, the
 * import error, the thing that says what went wrong — so dropping the tail
 * discards exactly the part nobody was going to see. 64 KiB is far more than any
 * of those and small enough that the ceiling is not itself a memory decision.
 */
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;

/**
 * Whether the child is put in its own process group, so that stopping it stops
 * what it started.
 *
 * POSIX only, because the mechanism is POSIX: `detached` there makes the child a
 * process-group leader and `process.kill(-pid)` signals the whole group, which
 * is the only way to reach a grandchild. On Windows `detached` means something
 * else entirely (a new console) and a negative pid is not a group, so the
 * platform gets the single-process kill it always had rather than a call that
 * would throw on every timeout.
 */
const KILL_PROCESS_GROUP = process.platform !== 'win32';

/**
 * How much of what a transform logged is carried back, on both axes.
 *
 * Both, because either one alone leaves the capture unbounded in the dimension
 * it does not cover, and this capture is *user code writing whatever it likes*.
 * A transform that logs one line per record — the most natural debugging move
 * there is — puts a copy of the source's data into `logs`, and `logs` is the one
 * thing that crosses a durable step boundary and lands in the run record. So the
 * ceiling is fixed here, in the child, before any of it is serialised: the
 * alternative is a `finishRun` write whose size is a property of somebody's
 * data.
 *
 * The same two numbers for JavaScript and for Python, applied by the two
 * harnesses below in the same order. A transform's log behaviour changing
 * because of the language it happens to be written in is a difference nobody can
 * predict from reading either one.
 *
 * Deliberately far above what anything downstream keeps — the connector runner
 * takes fifty lines, the workflow runner twenty per node at four hundred
 * characters — because this is the *safety* bound and those are the *display*
 * bounds. A harness that truncated at the display limit would decide, in the
 * child, what a future consumer is allowed to see.
 *
 * What is dropped is said out loud, in a final line, rather than dropped
 * quietly. Silence about a missing log is the exact failure this whole capture
 * exists to remove; reproducing it at line 501 would only move it.
 */
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_CHARS = 2_000;

/**
 * How much of what a *failing* transform logged is folded into the error.
 *
 * A failure throws, and a throw carries a message and nothing else — so the
 * `logs` of a run that raised never reach the caller at all, and every consumer
 * records the traceback with none of the output that led to it. Capturing
 * `print` and then discarding it at the exact moment it is most wanted would be
 * a fix that stops one step short of the case it was written for.
 *
 * The **last** lines, not the first, which is the opposite of what the display
 * caps downstream do — and deliberately. Those are trimming a successful run's
 * narrative, where the beginning is the story; this is the approach to a
 * traceback, where the last thing printed is the one that says where the code
 * got to.
 *
 * Small on both axes because this lands in an error message, and an error
 * message ends up in a run row, a log line and a console toast. The full set is
 * still on the result whenever the transform returned at all; this is the
 * consolation for the path where there is no result.
 */
const FAILURE_LOG_LINES = 10;
const FAILURE_LOG_CHARS = 200;

/** Packages worth telling the author about, if the environment has them. */
const REPORTED_PACKAGES = ['pandas', 'numpy', 'pyarrow', 'requests'];

export interface TransformRunnerOptions {
  /**
   * A Python virtualenv whose interpreter runs transforms.
   *
   * The supported way to give transforms libraries. PEP 668 stops a service
   * installing into the system Python, and it is right to: a transform that
   * can `pip install` is a transform that can change what every other
   * transform sees. An image provisions a venv, points this at it, and the set
   * of available libraries becomes a deployment decision with a Dockerfile line
   * behind it rather than something code negotiates at runtime.
   */
  pythonVenv?: string;
}

/**
 * Runs a transform in a child process, with a clock on it.
 *
 * **This is not a security boundary, and the trimmed environment is not one
 * either.** It stops accidents — an infinite loop, a runaway allocation, a stray
 * read of `process.env.DATABASE_PASSWORD` — because the child gets a timeout and
 * an environment of `{PATH, NODE_ENV}`. It does not stop code written to escape
 * it, and it is worth being exact about how thin the allowlist is rather than
 * leaving a reader to assume it holds:
 *
 * - the child inherits nothing of the parent's environment **through `env`**,
 *   and reads all of it anyway from `/proc/<ppid>/environ`, which is readable
 *   because parent and child run as the same uid;
 * - it runs in a working directory of this runner's choosing but on the host's
 *   filesystem, so a service account token under
 *   `/var/run/secrets/kubernetes.io/serviceaccount/` is an absolute path away;
 * - it can open sockets, as whatever user the service runs as.
 *
 * So the allowlist is a guard rail against the accident, and the reachability of
 * everything it names is a property of the process boundary, not a leak to be
 * patched. **Running a transform is running code in this pod.** Who is allowed
 * to is therefore an authorisation question and not a sandboxing one, and it is
 * answered at the HTTP surface — see the "Running a transform is running code"
 * section of `@dudousxd/nestjs-catalog-pipeline`'s README, which is where a host
 * can actually read it, and `pipeline.controller.ts` for the checks themselves.
 *
 * That is a deliberate trade for the case this is built for, where transforms
 * are written by the same people who already have database access. A catalog
 * that accepts transforms from anyone else needs a container, gVisor, or a WASM
 * runtime — and `TransformRunner` is an interface precisely so that swap is a
 * provider change rather than a rewrite.
 *
 * `node:vm` was the other option and is worse on both counts: it is famously
 * not an isolation boundary either, and it cannot be killed mid-loop.
 *
 * ## The environment the code is *given*, as opposed to the one it can reach
 *
 * Everything above says the trimmed `env` is a guard rail and not a boundary.
 * The corollary matters for {@link CatalogCodeContext}: since the child can
 * reach every variable anyway through `/proc`, `context.env` is not a
 * confinement mechanism and is not offered as one. It is the **supported**
 * route — the one that works on Windows, the one that survives a `TransformRunner`
 * swapped for a container, and the one whose contents a deployment declares on
 * purpose through the credential allow-list rather than by whatever happened to
 * be exported into the pod.
 *
 * That distinction is what makes the allow-list worth applying here at all. A
 * host that genuinely needs code not to read `DATABASE_URL` needs a different
 * runner; a host that needs its own operators to declare, once, which
 * credentials the pipeline is *meant* to use gets exactly that, in the same
 * list that already governs connectors.
 */
@Injectable()
export class SubprocessTransformRunner implements TransformRunner {
  private readonly logger = new Logger(SubprocessTransformRunner.name);
  private pythonPath: string | null | undefined;
  private packages: string[] | undefined;

  constructor(private readonly options: TransformRunnerOptions = {}) {}

  async available(): Promise<TransformLanguage[]> {
    // TypeScript is Node's own type stripping, so it is available exactly when
    // JavaScript is — no compiler, no build step, no extra dependency.
    const languages: TransformLanguage[] = ['javascript', 'typescript'];
    if (await this.resolvePython()) languages.push('python');
    return languages;
  }

  /**
   * Which Python libraries a transform can import here.
   *
   * Reported rather than assumed. "pandas is available" is a property of the
   * image, and a UI that promises it on an image without it turns a deployment
   * difference into a runtime traceback the author cannot act on.
   */
  async pythonPackages(): Promise<string[]> {
    if (this.packages !== undefined) return this.packages;
    const python = await this.resolvePython();
    if (!python) {
      this.packages = [];
      return this.packages;
    }

    const probe = REPORTED_PACKAGES.map(
      (name) =>
        `try:\n    __import__("${name}")\n    found.append("${name}")\nexcept Exception:\n    pass`,
    ).join('\n');

    try {
      const { stdout } = await this.spawn(
        python,
        ['-c', `found = []\n${probe}\nprint(",".join(found))`],
        '',
        10_000,
      );
      this.packages = stdout.trim() ? stdout.trim().split(',') : [];
    } catch {
      this.packages = [];
    }
    if (this.packages.length > 0) {
      this.logger.log(`Python transforms may import: ${this.packages.join(', ')}`);
    }
    return this.packages;
  }

  async run(
    transform: Pick<CatalogTransform, 'language' | 'code'>,
    records: unknown[],
    options: { timeoutMs?: number; context?: CatalogCodeContext } = {},
  ): Promise<TransformResult> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Never `undefined` past this line. A caller may legitimately have no
    // context to give — a spec, a host driving the runner directly — and the
    // one thing user code must not have to write is `context?.env?.X`, because
    // the optional chain is the spelling that silently reads nothing when the
    // caller *did* have a context and got the shape wrong. So the absence is
    // resolved here, once, into a context that says plainly there is no run and
    // no admitted credential.
    const context = options.context ?? contextlessRun(records.length);

    const python = transform.language === 'python';
    const interpreter = python ? await this.resolvePython() : process.execPath;
    if (!interpreter) {
      throw new Error(
        'No python3 on PATH, so python transforms cannot run here. Use javascript or typescript, or install python in the image.',
      );
    }

    // Python is not asked: its harness writes the `def`, so a Python transform
    // never states a signature and has nothing to detect. See
    // {@link pythonHarness}.
    const shape: TransformShape = python ? 'body' : transformShape(transform.code);

    // Written to disk only for the module shape, and only for the length of the
    // run. A module has to be *imported* to be a module — its `export default`
    // creates no binding this harness could name, and rewriting the keyword
    // into an assignment would be surgery on somebody's source. A file also
    // gives Node the extension it needs to strip TypeScript, and gives the
    // author stack frames with real line numbers instead of `[eval]`.
    const modulePath =
      shape === 'module'
        ? join(
            tmpdir(),
            `catalog-transform-${randomUUID()}.${transform.language === 'typescript' ? 'mts' : 'mjs'}`,
          )
        : undefined;

    try {
      if (modulePath) await writeFile(modulePath, transform.code, 'utf8');

      const script = python
        ? pythonHarness(transform.code)
        : modulePath
          ? javascriptModuleHarness(pathToFileURL(modulePath).href)
          : javascriptHarness(transform.code);

      // `module-typescript` is Node's own stripping — types are erased, never
      // checked. A transform with a wrong type still runs; the editor's try pane
      // is what catches it, not the compiler.
      //
      // The module shape needs none of it here: the harness itself is plain
      // JavaScript, and the author's `.mts` file is stripped on import by its
      // extension. That confines the stripper to the code that asked for it,
      // rather than running this file's own source through it as well.
      const args = python
        ? ['-c', script]
        : [
            '--input-type',
            transform.language === 'typescript' && !modulePath ? 'module-typescript' : 'module',
            '-e',
            script,
          ];

      return await this.execute(interpreter, args, records, context, timeoutMs, shape, started);
    } finally {
      // Unlinked whether the run returned, threw, or was killed on the timeout —
      // the parent settles in all three, so nothing is left in `tmpdir` for an
      // operator to find later and wonder about.
      if (modulePath) await rm(modulePath, { force: true });
    }
  }

  private async execute(
    interpreter: string,
    args: string[],
    records: unknown[],
    context: CatalogCodeContext,
    timeoutMs: number,
    shape: TransformShape,
    started: number,
  ): Promise<TransformResult> {
    // An envelope rather than the bare array stdin used to carry. The context
    // travels beside the records rather than in the child's `env`, and that is
    // the deliberate half of it: the child's own environment stays
    // `{PATH, NODE_ENV}`, so nothing about what a transform may read changes by
    // accident when somebody edits the spawn options later.
    const { stdout, stderr } = await this.spawn(
      interpreter,
      args,
      JSON.stringify({ records, context }),
      timeoutMs,
      shape,
    );

    let parsed: { rows?: unknown; logs?: unknown; error?: string };
    try {
      // The harness prints exactly one JSON line last; anything the code wrote
      // to stdout itself would corrupt that, which is why logs are captured.
      parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    } catch {
      throw new Error(
        `The transform did not return anything readable. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    const logs = Array.isArray(parsed.logs) ? parsed.logs.map(String) : [];

    if (parsed.error) throw new Error(withFinalLogs(parsed.error, logs));
    if (!Array.isArray(parsed.rows)) {
      throw new Error(
        'The transform must return an array of rows. Returning anything else would leave the load ambiguous.',
      );
    }

    return {
      rows: parsed.rows.filter(
        (row): row is Record<string, unknown> =>
          typeof row === 'object' && row !== null && !Array.isArray(row),
      ),
      logs,
      elapsedMs: Date.now() - started,
    };
  }

  private spawn(
    command: string,
    args: string[],
    input: string,
    timeoutMs: number,
    shape: TransformShape = 'body',
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        // An empty environment, not the parent's. A transform has no business
        // reading the database password, and inheriting env is how it would.
        // Read the class docblock before treating this as containment: the same
        // values are a `/proc/<ppid>/environ` read away, and this is a guard
        // rail against the accidental read rather than a boundary.
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
        // Not the parent's, which is a running service's directory and holds
        // the `.env` the allowlist above exists to withhold — a transform whose
        // first line is `readFileSync(".env")` was reading the host application's
        // configuration by relative path. A temporary directory keeps the file
        // writes a transform may legitimately want working while making the one
        // path it can name without knowing anything about the deployment
        // uninteresting. Absolute paths are unaffected, and cannot be.
        cwd: tmpdir(),
        // Its own process group, so the timeout below can reach a grandchild.
        // See {@link KILL_PROCESS_GROUP}.
        detached: KILL_PROCESS_GROUP,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stop(child);
        reject(new Error(`The transform ran for longer than ${timeoutMs}ms and was stopped.`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) stop(child);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Appended only while there is room, rather than appended and trimmed:
        // trimming after the fact still materialises the whole chunk into the
        // parent's heap, which is the thing being bounded. See
        // {@link MAX_CAPTURED_STDERR_BYTES} for why this bounds rather than kills.
        if (stderr.length >= MAX_CAPTURED_STDERR_BYTES) return;
        stderr += chunk.toString().slice(0, MAX_CAPTURED_STDERR_BYTES - stderr.length);
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 && stdout.trim().length === 0) {
          // The shape hint rides along here specifically: a body whose author
          // meant it as a module fails before the harness's own try/catch is
          // ever entered, so this branch is the only place that error can be
          // annotated. See {@link transformShapeHint}.
          reject(
            new Error(
              `The transform exited with code ${code}. ${stderr.slice(0, 500)}` +
                transformShapeHint(shape, stderr),
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });

      child.stdin.write(input);
      child.stdin.end();
    });
  }

  /** Cached, including the negative answer — probing on every run is wasteful. */
  private async resolvePython(): Promise<string | null> {
    if (this.pythonPath !== undefined) return this.pythonPath;

    const venv = this.options.pythonVenv ?? process.env.CATALOG_PYTHON_VENV;
    if (venv) {
      // Absolute, and it has to be: a child now runs in a temporary directory
      // rather than the parent's, so a relative `CATALOG_PYTHON_VENV` — which
      // `existsSync` here resolves against the *parent's* cwd — would pass this
      // check and then fail to spawn. Resolved once, at the point the two cwds
      // are still the same.
      const candidate = resolvePath(join(venv, 'bin', 'python'));
      if (existsSync(candidate)) {
        this.pythonPath = candidate;
        this.logger.log(`Python transforms run in the venv at ${venv}`);
        return candidate;
      }
      this.logger.warn(
        `CATALOG_PYTHON_VENV points at ${venv} but there is no python there — falling back to PATH, which will not have the venv's libraries.`,
      );
    }

    for (const candidate of ['python3', 'python']) {
      const ok = await new Promise<boolean>((resolve) => {
        const probe = spawn(candidate, ['--version'], { stdio: 'ignore' });
        probe.on('error', () => resolve(false));
        probe.on('close', (code) => resolve(code === 0));
      });
      if (ok) {
        this.pythonPath = candidate;
        return candidate;
      }
    }
    this.pythonPath = null;
    return null;
  }
}

/**
 * The context for a run that has none: a spec, or a host driving the runner by
 * hand.
 *
 * Empty rather than absent, so `context.env.ANYTHING` is `undefined` instead of
 * a `TypeError` and code written for a real run degrades to reading nothing.
 * `runId` is left off rather than filled with a placeholder — the field's whole
 * documented meaning is "there is a run and this is it", and a fabricated id
 * would be the one lie a reader could not detect.
 */
function contextlessRun(rowCount: number): CatalogCodeContext {
  return { contract: CODE_CONTEXT_CONTRACT, rowCount, inputs: [], env: {} };
}

/**
 * Stop the transform, and everything the transform started.
 *
 * `child.kill()` signals one pid. A transform that double-forks — two lines of
 * `child_process.spawn` with `detached` and an `unref` — leaves a grandchild
 * that the direct child's death says nothing about, so the timeout expired, the
 * caller was told the run had been stopped, and the work carried on
 * indefinitely. That is not a hypothetical: it is the standard way a timeout on
 * a process is escaped, and a bound that a caller can opt out of is not a bound.
 *
 * So the child leads its own process group and the negative pid signals the
 * group, which is every descendant that has not deliberately left it. Leaving
 * one is possible (`setsid` again) and there is no answer to that short of a
 * cgroup or a container — the same place the class docblock's honesty about the
 * boundary ends up, for the same reason.
 *
 * Falls through to the single-process kill whenever the group kill cannot be the
 * one that happens: on Windows, where a negative pid is not a group, and on an
 * `ESRCH` where the group is already gone and the direct kill is a harmless
 * no-op. A throw here would replace a timeout error — which says something true
 * and useful — with an unhandled one that says nothing.
 */
function stop(child: ChildProcess): void {
  const pid = child.pid;
  if (KILL_PROCESS_GROUP && pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Already gone, or never grouped. The direct kill below covers both.
    }
  }
  child.kill('SIGKILL');
}

/**
 * The traceback, plus the tail of what the code printed on its way to it.
 *
 * Named in the message rather than appended bare, and counted rather than
 * merely truncated: "the last 10 of 57 lines" tells a reader there is more to
 * find on the run's own log, where a silent tail would let them believe they
 * were looking at everything the transform said.
 */
function withFinalLogs(error: string, logs: string[]): string {
  if (logs.length === 0) return error;
  const tail = logs
    .slice(-FAILURE_LOG_LINES)
    .map((line) =>
      line.length > FAILURE_LOG_CHARS ? `${line.slice(0, FAILURE_LOG_CHARS)}…` : line,
    );
  const heading =
    logs.length > tail.length
      ? `The last ${tail.length} of ${logs.length} lines it logged first:`
      : `${tail.length === 1 ? 'The line' : `The ${tail.length} lines`} it logged first:`;
  return `${error}\n${heading}\n${tail.map((line) => `  ${line}`).join('\n')}`;
}

/**
 * The JavaScript and TypeScript harness for the **bare-body** shape: the
 * author's code is the inside of a function this string writes.
 *
 * Unchanged, and that is the feature. Every transform stored before the module
 * shape existed is a bare body, and it runs through the identical wrapper with
 * the identical positional parameters and the identical interpreter flags — the
 * new shape is a second path beside this one, not a rewrite of it. See
 * `transform-shape.ts` for the rule that decides which path a given piece of
 * code takes, and why a stored transform cannot be sent down the wrong one.
 *
 * `console.log` is captured rather than left on stdout so user code cannot
 * corrupt the single JSON line this prints — a transform that logs a `{` would
 * otherwise break its own result parsing, which is a maddening thing to debug.
 *
 * Every console channel that reaches a terminal is overridden, not just the four
 * that were here first. `console.debug` writes to stdout exactly as `console.log`
 * does, so leaving it alone left one spelling of "log something" that silently
 * corrupted the result line; `console.trace` writes to stderr, so leaving it
 * alone left one spelling that silently went nowhere. Both are the same mistake
 * the Python harness made with `print`, and there is no reading of "anything the
 * code logged" under which they are not it.
 *
 * The channels share one array and keep call order, which is the only ordering
 * that answers the question logs are read for — what happened, and in what
 * sequence. Nothing marks which channel a line came from: a reader looking at a
 * failed run wants the sequence, and splitting it into two lists would make the
 * interleaving unrecoverable to buy a label the line's own text usually carries.
 *
 * Bounded by {@link MAX_LOG_LINES} and {@link MAX_LOG_LINE_CHARS}, applied here
 * rather than after the fact, so a transform that logs a copy of its input never
 * gets as far as being serialised.
 */
function javascriptHarness(code: string): string {
  return `${JAVASCRIPT_PRELUDE}
try {
  ${JAVASCRIPT_PAYLOAD}
  const transform = async (records, context) => { ${code} };
  const rows = await transform(records, context);
  process.stdout.write(JSON.stringify({ rows: rows ?? [], logs: captured() }));
} catch (error) {
  ${JAVASCRIPT_FAILURE}
}
`;
}

/**
 * The harness for the module shape: import the author's module, call what it
 * exports with one object.
 *
 * Everything above the call is the same prelude the bare-body harness uses —
 * the same six console channels, the same two caps, the same envelope, the same
 * frozen `context`. A transform's log behaviour changing because of the shape it
 * happens to be written in would be exactly as surprising as it changing because
 * of the language, and the constants say why that is not allowed to happen.
 *
 * The code arrives as a **file URL**, not as text spliced into this string, and
 * the difference matters three times over. `export default` binds nothing that
 * an enclosing scope could name, so the module genuinely has to be imported;
 * `.mts` is what tells Node to strip the types, so the extension does the job
 * `--input-type module-typescript` does for a body; and a stack frame reads
 * `catalog-transform-….mts:3:11` rather than `[eval]`, which is the difference
 * between a line number and a shrug.
 *
 * ## What it accepts, and what it refuses
 *
 * `export default`, or a named export called `transform`. Two spellings rather
 * than one because both are things people write without being told to, and
 * because both are *real exports* — neither is a guess about a name in scope.
 *
 * A module that exports neither is **refused, by name**. The alternative is a
 * transform that returns no rows and says nothing about why, which downstream
 * reads as a source that produced nothing — a connector would commit an empty
 * snapshot over live data on the strength of a missing `default` keyword.
 *
 * The import is deliberately not wrapped in a fallback to the body shape. Code
 * that fails to parse as a module has one honest answer — the parse error, with
 * the line — and re-running it in the other shape would replace that with a
 * second, different error about text the author never wrote.
 */
function javascriptModuleHarness(moduleUrl: string): string {
  return `${JAVASCRIPT_PRELUDE}
try {
  ${JAVASCRIPT_PAYLOAD}
  const mod = await import(${JSON.stringify(moduleUrl)});
  const exported = typeof mod.default === "function"
    ? mod.default
    : typeof mod.transform === "function" ? mod.transform : null;
  if (!exported) {
    const names = Object.keys(mod).filter((key) => key !== "default");
    throw new Error(
      "This transform is a module — it has a top-level \`export\` — so the catalog imported it and " +
      "looked for a function to call. \`export default\` is " + (("default" in mod) ? typeof mod.default : "missing") +
      " and there is no exported \`transform\` function." +
      (names.length > 0 ? " It does export: " + names.join(", ") + "." : "") +
      " Export the function as \`export default\`, or name it \`transform\`."
    );
  }
  const rows = await exported({ records, context });
  process.stdout.write(JSON.stringify({ rows: rows ?? [], logs: captured() }));
} catch (error) {
  ${JAVASCRIPT_FAILURE}
}
`;
}

/**
 * Capture the console, before any of the author's code can reach it.
 *
 * Shared verbatim by both JavaScript harnesses rather than copied into each: two
 * copies of a log cap are two numbers that drift, and the one that drifts is
 * discovered by a run record nobody can explain.
 */
const JAVASCRIPT_PRELUDE = `
const logs = [];
let dropped = 0;
const keep = (line) => {
  if (logs.length >= ${MAX_LOG_LINES}) { dropped += 1; return; }
  logs.push(
    line.length > ${MAX_LOG_LINE_CHARS}
      ? line.slice(0, ${MAX_LOG_LINE_CHARS}) + "… (" + (line.length - ${MAX_LOG_LINE_CHARS}) + " more characters)"
      : line,
  );
};
const write = (...args) => keep(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
console.log = write; console.info = write; console.warn = write; console.error = write;
console.debug = write; console.trace = write;
const captured = () => dropped === 0
  ? logs
  : logs.concat(["… " + dropped + " more line(s) were logged and dropped: a transform keeps its first ${MAX_LOG_LINES}."]);

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
`;

/** Unpack the envelope. `context` is frozen one level down — see below. */
const JAVASCRIPT_PAYLOAD = `
  const payload = JSON.parse(input || "{}");
  const records = Array.isArray(payload.records) ? payload.records : [];
  // Frozen, and one level down as well, so that a transform assigning to
  // \`context.env.TOKEN\` fails loudly here rather than appearing to work and
  // then confusing whoever reads the next node's code. Nothing propagates out
  // of this process either way; the freeze buys the honest error, not safety.
  const context = Object.freeze({ ...payload.context, env: Object.freeze({ ...payload.context?.env }) });
`;

/** The one JSON line a failed run prints, logs and all. */
const JAVASCRIPT_FAILURE = `
  process.stdout.write(JSON.stringify({
    error: error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error),
    logs: captured(),
  }));
`;

/**
 * The Python harness. `records` in, a list of dicts out.
 *
 * ## Why this did not move to the one-object shape
 *
 * JavaScript moved because a JavaScript transform *states its own signature* —
 * the harness wrote `(records, context)` and the author's code depended on both
 * names being where they were, so a third parameter would have been a change to
 * text nobody was going to re-read. A Python transform states nothing. This
 * harness writes `def transform(records, context):` and indents the author's
 * code into it, so a fourth thing to pass is **one line changed here** and not a
 * single stored transform touched. Python already has the property the object
 * shape was introduced to buy.
 *
 * Moving it anyway would cost the thing the move was for. `records` and
 * `context` are names in scope today; a `payload` dict makes them
 * `payload["records"]` and `payload["context"]`, which is a break in every
 * Python transform in existence — the exact outcome the JavaScript change was
 * designed to avoid. Consistency between the two languages is worth something,
 * but not a migration bought with somebody else's pandas code, and not when the
 * inconsistency is *because* the two languages start from different places.
 *
 * The asymmetry left standing, said out loud: a Python author who writes their
 * own `def transform(...)` at column 0 gets it indented into a nested
 * definition, and the outer `transform` returns `None` — no error, no rows. That
 * is a real footgun and it is older than this change; it is named here so the
 * next person to open this file knows it is known rather than missed.
 *
 * A DataFrame is accepted as a return value and converted, because a transform
 * that reaches for pandas will naturally end with one — making it write
 * `.to_dict("records")` would be a papercut on the only path pandas is worth
 * importing for.
 *
 * **`print` is redirected, for the same reason `console.log` is.** It used to go
 * straight through to the child's real stdout, where the last-line result parse
 * discarded it — so the single most obvious thing a person writes while working
 * out what their transform is doing produced an empty log panel and no
 * explanation. That is not a missing nicety: it costs the author their trust in
 * the runner before they have written anything real, and the conclusion it
 * invites ("my code never ran") is the wrong one. `log()` still exists, because
 * transforms in the wild call it and a `NameError` is a worse answer than a
 * redundant helper, but it is now literally `print` — one buffer, one ordering,
 * and nothing that only works if you already knew about it.
 *
 * **stderr is captured too**, into the same list and in call order. `warnings`,
 * a `logging` handler at its default configuration, and a traceback the code
 * printed itself all land there, and those are precisely the lines somebody is
 * looking for when a transform misbehaves. It is not marked as stderr, matching
 * the JavaScript harness, which does not distinguish `console.error` either: the
 * sequence is what a reader is reconstructing, and two lists would make the
 * interleaving unrecoverable.
 *
 * What was written **before** an exception survives it. The redirect is a
 * context manager around the call rather than a swap held for the whole script,
 * so it unwinds on the way out of a traceback with the buffer intact, and the
 * error branch reports the same lines the success branch would have. A
 * transform that printed three things and then divided by zero is the case logs
 * matter most for, and it is the case a naive swap loses.
 *
 * Bounded by {@link MAX_LOG_LINES} and {@link MAX_LOG_LINE_CHARS}, the same two
 * numbers the JavaScript harness applies. Note that this bounds the *sink*, not
 * only the result: an unterminated write longer than a line's ceiling is flushed
 * as its own line rather than accumulated, so a transform writing without
 * newlines cannot grow the child's memory either.
 *
 * The limit worth stating: this redirects Python-level writes to `sys.stdout`
 * and `sys.stderr`. Output from a C extension or a subprocess that writes to the
 * file descriptors underneath goes to the real streams, exactly as it does past
 * an overridden `console` in Node. Redirecting the descriptors themselves would
 * take the result channel with it.
 */
function pythonHarness(code: string): string {
  const indented = code
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `
import sys, json, contextlib

logs = []
# A one-element list rather than a module global reassigned inside the helper,
# so the counter needs no \`global\` statement in generated code.
dropped = [0]

def keep(line):
    if len(logs) >= ${MAX_LOG_LINES}:
        dropped[0] += 1
        return
    if len(line) > ${MAX_LOG_LINE_CHARS}:
        line = "{}… ({} more characters)".format(
            line[:${MAX_LOG_LINE_CHARS}], len(line) - ${MAX_LOG_LINE_CHARS}
        )
    logs.append(line)

class Sink:
    """Stands in for stdout and stderr while the transform runs.

    Line-buffered by hand because \`print("a", "b")\` arrives as four separate
    writes — the parts, the separators and the terminator — and appending each
    one as its own entry would shred every multi-argument call.
    """

    def __init__(self):
        self.partial = ""

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        self.partial += text
        while "\\n" in self.partial:
            line, self.partial = self.partial.split("\\n", 1)
            keep(line)
        # A write with no newline in it is still bounded: past a line's ceiling
        # there is nothing more to keep, so it is emitted rather than held.
        if len(self.partial) > ${MAX_LOG_LINE_CHARS}:
            keep(self.partial)
            self.partial = ""
        return len(text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        pass

    def isatty(self):
        return False

    def drain(self):
        """Whatever was written without a trailing newline is still output."""
        if self.partial:
            keep(self.partial)
            self.partial = ""

sink = Sink()

def log(*args):
    print(*args)

def transform(records, context):
${indented || '    return records'}

def to_rows(result):
    if result is None:
        return []
    # A DataFrame, without importing pandas to find out — checking for the
    # method keeps this working when pandas is not installed at all.
    if hasattr(result, "to_dict") and hasattr(result, "columns"):
        return result.to_dict("records")
    return result

def captured():
    sink.drain()
    if dropped[0] == 0:
        return logs
    return logs + [
        "… {} more line(s) were logged and dropped: a transform keeps its first {}.".format(
            dropped[0], ${MAX_LOG_LINES}
        )
    ]

try:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    records = payload.get("records") or []
    # A plain dict, not an object with attributes. \`context["env"]["TOKEN"]\`
    # is the same expression in every Python transform anybody has written
    # against a JSON payload, and a bespoke wrapper would buy dotted access at
    # the cost of a KeyError that reads like a bug in the catalog.
    context = payload.get("context") or {}
    # \`to_rows\` is inside the redirect as well: a lazily-evaluated return value
    # does its printing here, not before.
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        rows = to_rows(transform(records, context))
    # Back on the real stdout by now — the context manager restores on the way
    # out, including out of an exception — so this is the only thing on it.
    out = captured()
    sys.stdout.write(json.dumps(rows and {"rows": rows, "logs": out} or {"rows": [], "logs": out}, default=str))
except Exception as error:
    sys.stdout.write(json.dumps({
        "error": "{}: {}".format(type(error).__name__, error),
        "logs": captured(),
    }))
`;
}
