import {
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioPipe,
  spawn,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import {
  CODE_CONTEXT_CONTRACT,
  type CatalogCodeContext,
  type CatalogTransform,
  type TransformLanguage,
  type TransformResult,
  type TransformRunner,
  type TransformStream,
  type TransformStreamSummary,
  recordModeRefusal,
  transformMode,
  unreachableTransformMode,
} from './catalog.pipeline';
import { type TransformShape, transformShape, transformShapeHint } from './transform-shape';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * How many records ride on one line of the wire into the child.
 *
 * **Framing only.** The child calls the author's function once per record
 * whatever this is; nothing about the contract, the memory bound or what a
 * transform can see changes with the number. What changes is how many times
 * `JSON.parse` is entered, and that turned out to be worth measuring rather than
 * assuming: `bench/transform-stream.mjs` runs the identical rename at one record
 * per line and at five hundred, and over the real 102,520-row `af_fleet.csv` the
 * batched wire is about 7% faster end to end and holds the same memory.
 *
 * Five hundred, not five thousand, because this is the one buffer on the write
 * side that scales with nothing else: it is the *only* thing standing between a
 * streamed source and a bounded parent, so it is kept at the same order as the
 * `BATCH_SIZE` the pipeline's own writers use. At five columns that is roughly
 * 40 KB in flight, which is not a memory decision anybody has to think about.
 */
const RECORDS_PER_LINE = 500;

/**
 * When the child stops accumulating rows and puts a line on the wire.
 *
 * Two triggers rather than one, and each covers a case the other cannot.
 *
 * The **byte** trigger is the memory bound: a transform that fans one record out
 * into thousands of rows would otherwise hold all of them until the record after
 * it, and the child's heap would be a property of somebody's data.
 *
 * The **record** trigger is the liveness bound, and it is why the flush happens
 * even when there is nothing to say. A per-record transform that drops most of
 * what it sees — a normaliser that returns `[]` for a blank row — emits no bytes
 * for a long time, and a parent watching only the byte stream cannot tell that
 * from a child hung on record 60,000. The empty line carries `at`, so the stall
 * clock has something to reset on. See {@link SubprocessTransformRunner.runStream}.
 *
 * It is also the **attribution window**, which is what fixes its size at 200
 * rather than at a round thousand. A child killed mid-record cannot report where
 * it got to, so the finest a failure can be located is "after the last `at` the
 * child sent, and before the last record the parent sent" — and this number is
 * the first half of that. Two hundred costs about five hundred extra lines over a
 * hundred-thousand-record load, which is nothing measurable, and buys a window
 * five times narrower for the person reading the failure. {@link stallError}
 * states the window rather than picking a record inside it.
 */
const FLUSH_BYTES = 256 * 1024;
const FLUSH_RECORDS = 200;

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
 * The whole of the isolation, in one object, spawned identically by every path
 * in this file.
 *
 * One object rather than a literal per call site, and that is the point rather
 * than tidiness. The class docblock spends four paragraphs being exact about
 * what a transform can and cannot reach, and every sentence of it is a claim
 * about *these three fields*. A second literal somewhere else in the file would
 * be a second answer to "what environment does user code get", and the one that
 * drifted would be discovered by a transform reading something the docblock says
 * it cannot. The streaming path added below reuses this untouched, which is why
 * "a streamed transform is isolated exactly as a batched one is" is a property of
 * the code rather than a promise in a comment.
 *
 * - **`env`** is `{PATH, NODE_ENV}` and not the parent's. A transform has no
 *   business reading the database password, and inheriting env is how it would.
 *   Read the class docblock before treating this as containment: the same values
 *   are a `/proc/<ppid>/environ` read away, and this is a guard rail against the
 *   accidental read rather than a boundary.
 * - **`cwd`** is not the parent's, which is a running service's directory and
 *   holds the `.env` the allowlist exists to withhold — a transform whose first
 *   line is `readFileSync(".env")` was reading the host application's
 *   configuration by relative path. A temporary directory keeps the file writes a
 *   transform may legitimately want working while making the one path it can name
 *   without knowing anything about the deployment uninteresting. Absolute paths
 *   are unaffected, and cannot be.
 * - **`detached`** puts the child in its own process group, so a timeout can
 *   reach a grandchild. See {@link KILL_PROCESS_GROUP} and {@link stop}.
 */
const CHILD_PROCESS_OPTIONS: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe> = {
  env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
  cwd: tmpdir(),
  detached: KILL_PROCESS_GROUP,
  stdio: ['pipe', 'pipe', 'pipe'],
};

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
 * - it can open sockets, as whatever user the service runs as;
 * - a module-shaped transform is written to a file in that temporary directory
 *   for the length of the run, so its own source is briefly on disk. That is
 *   not a new exposure — the code is the thing running, and it can read itself
 *   from anywhere — but it is a fact worth having written down next to the
 *   others rather than discovered in a directory listing.
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
      const args = interpreterArgs(transform, modulePath);
      return await this.execute(interpreter, args, records, context, timeoutMs, shape, started);
    } finally {
      // Unlinked whether the run returned, threw, or was killed on the timeout —
      // the parent settles in all three, so nothing is left in `tmpdir` for an
      // operator to find later and wonder about.
      if (modulePath) await rm(modulePath, { force: true });
    }
  }

  /**
   * Run a `'record'`-mode transform over a stream, and hand the rows back as a
   * stream.
   *
   * ## What is and is not different from {@link run}
   *
   * **The isolation is not different, at all.** Same interpreter, same
   * {@link CHILD_PROCESS_OPTIONS} — the same `{PATH, NODE_ENV}`, the same
   * temporary cwd, the same process group — and the context still travels beside
   * the records on stdin rather than in the environment. It is worth being blunt
   * about why that is easy to say: the child here is **not longer-lived than the
   * one `run` spawns.** Both live for exactly one node run and are gone when it
   * ends. `run` was never a spawn per batch; it was a spawn per node with the
   * whole dataset in one blob. So there is no new window in which state could
   * leak between batches or between runs, because there was never a window to
   * widen. What a transform may retain *within* one run is stated exactly on
   * {@link javascriptRecordHarness}.
   *
   * **The timeout is different, and it has to be.** See {@link stallError}.
   *
   * **Failure names a record.** A batch call can only report that the transform
   * threw; here the child counts what it has consumed and puts that number on
   * every line, so a stream that dies names the record it died on. What was
   * already staged is a matter for the caller — for the connector runner it sits
   * in an uncommitted snapshot, for a workflow node it is overwritten by the next
   * attempt — and in neither case does a watermark move, because nothing here
   * reaches a commit.
   *
   * ## The one shape that would deadlock, and how it is avoided
   *
   * The writer runs as a floating loop and the reader is driven by the consumer
   * pulling rows. Awaiting the writer before yielding the first row is the one
   * arrangement that hangs: the child fills its stdout buffer with rows nobody is
   * draining, stops reading stdin, and this side waits forever for a `drain` that
   * requires the reader that has not started. Written the way it is, a slow
   * consumer simply back-pressures the whole chain, which is the point.
   */
  async runStream(
    transform: Pick<CatalogTransform, 'language' | 'code' | 'mode'>,
    records: AsyncIterable<unknown>,
    options: { timeoutMs?: number; context?: CatalogCodeContext } = {},
  ): Promise<TransformStream> {
    const mode = transformMode(transform);
    if (mode === 'batch') {
      throw new Error(
        'This transform is a function over the whole batch, so it cannot be streamed a record at a time — that would call it once per record and return one partial answer per record, which is exactly the silent wrong result TRANSFORM_MODES exists to prevent. Run it through `run`, or set the transform to per-record mode.',
      );
    }
    if (mode !== 'record')
      return unreachableTransformMode(mode, 'SubprocessTransformRunner.runStream');

    // Asked here as well as at the controller, because a transform row can reach
    // a runner without ever passing through this build's controller — promoted
    // from another environment, restored, written by an older version — and the
    // failure this must never have is the quiet one.
    const refusal = recordModeRefusal(transform);
    if (refusal) throw new Error(refusal);

    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `rowCount` is 0 rather than a guess: a stream does not know how many
    // records there are, and `contextlessRun` is only reached by a caller that
    // gave no context at all. A caller with a real run supplies the count it
    // knows, exactly as it does for a batch.
    const context = options.context ?? contextlessRun(0);

    // A record-mode transform is always a module — `recordModeRefusal` has just
    // refused anything else — so the file is unconditional here where `run` has
    // to decide. Removed in the generator's `finally` rather than in one here,
    // because the run is not over when this method returns: it is over when the
    // rows have been drained, thrown, or abandoned by a `break`.
    const modulePath = join(
      tmpdir(),
      `catalog-transform-${randomUUID()}.${transform.language === 'typescript' ? 'mts' : 'mjs'}`,
    );
    await writeFile(modulePath, transform.code, 'utf8');

    const child = spawn(
      process.execPath,
      ['--input-type', 'module', '-e', javascriptRecordHarness(pathToFileURL(modulePath).href)],
      CHILD_PROCESS_OPTIONS,
    );

    const pump = new RecordStreamPump(child, timeoutMs);
    pump.feed(records, context);

    let summary: TransformStreamSummary | undefined;
    const logger = this.logger;
    async function* rows(): AsyncGenerator<Record<string, unknown>> {
      try {
        for await (const message of pump.messages()) {
          if (message.done) {
            summary = { ...message.done, elapsedMs: Date.now() - started };
            continue;
          }
          for (const row of message.rows) {
            // The same filter `run` applies before it returns, through the same
            // predicate: anything that is not a plain object cannot be written
            // as a row, and dropping it silently downstream is how a load comes
            // out short with nothing to explain it.
            if (isRowObject(row)) yield row;
          }
        }
      } finally {
        // Every exit: drained, thrown, or a `break` in the consumer's loop. The
        // last one is why this cannot be a `finally` around the spawn — a
        // consumer that stops early leaves a child holding a pipe, and the kill
        // has to happen where the abandonment is observable.
        pump.close();
        await rm(modulePath, { force: true }).catch(() => {
          // A temporary file that will not unlink is not worth failing a load
          // that produced correct rows. It is logged rather than thrown.
          logger.warn(`Could not remove the transform's temporary module at ${modulePath}.`);
        });
      }
    }

    return {
      rows: rows(),
      summary: () => {
        if (!summary) {
          throw new Error(
            'The transform stream has not finished, so there is no summary yet. `summary()` is answered only once `rows` is exhausted — a running total asked for early is exactly the number somebody would go on to record as `fetched`.',
          );
        }
        return summary;
      },
    };
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
      rows: parsed.rows.filter(isRowObject),
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
      const child = spawn(command, args, CHILD_PROCESS_OPTIONS);

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
              `The transform exited with code ${code}. ${stderr.slice(0, 500)}${transformShapeHint(shape, stderr)}`,
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
 * Whether this is something that can be stored as a row.
 *
 * One predicate for both paths rather than the same three clauses written twice.
 * "A row is a plain object" is a rule the publish side already depends on, and
 * two copies of it are two places for an array or a `null` to start counting as
 * a row in one mode and not the other.
 */
function isRowObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One line the record harness put on the wire, already parsed. */
interface RecordStreamMessage {
  at: number;
  rows: unknown[];
  done?: { recordsIn: number; rowsOut: number; logs: string[] };
}

/**
 * Both halves of the pipe to a record-mode child: records in, rows out, and the
 * clock that decides the child has stopped.
 *
 * A class rather than closures inside `runStream` because the two halves have to
 * see each other. The stall clock cannot be armed by the reader alone — whether
 * the child *owes* an answer is a fact about what the writer has sent — and the
 * writer cannot arm it either, because whether anybody is *waiting* is a fact
 * about the reader. Separating them into two functions would mean passing a
 * mutable cell between them, which is this object with the name taken off.
 *
 * ## The stall clock, and why it is not the batch timeout
 *
 * `run` bounds total wall clock: the whole payload is written at once, so
 * "elapsed" is time the child spent working and nothing else. That bound cannot
 * be carried over unchanged, and this is the one genuine semantic change in the
 * streaming path, so it is worth stating rather than discovering. A streamed
 * transform's clock would include **time waiting for the source** — a SQL cursor
 * paging over ten million rows, an S3 prefix listing — which the batch path
 * finished before it spawned anything. Thirty seconds of total wall clock would
 * therefore fail loads that work today, for reasons that have nothing to do with
 * the transform.
 *
 * So what is bounded is a **stall**: `timeoutMs` with the child owing an answer
 * and nobody hearing one. The three states are kept apart deliberately —
 *
 * - the child is hung on a record → the reader is waiting, records are
 *   outstanding, the clock runs, and at `timeoutMs` the process group is killed.
 *   This is the failure the timeout exists for and it is caught *sooner* than the
 *   old bound caught it on a long load;
 * - the source is slow → the child has answered everything it was given, nothing
 *   is outstanding, the clock is not running. A load that spends an hour waiting
 *   on a database is not a stalled transform;
 * - the consumer is slow → the reader is not waiting on the child at all, so the
 *   clock is not running. A sink writing to a busy warehouse back-pressures the
 *   whole chain, which is the design, and must not read as a hang.
 *
 * What is given up is a bound on **total** time, and that is deliberate: a
 * stream's total time is a property of how much data there is, so a total bound
 * is a bound on dataset size wearing a clock's clothes. The outer bound has not
 * disappeared — a node runs inside a durable step, and `abandoned-runs.ts` is
 * what closes a run whose worker went away.
 *
 * On the kill, rows already yielded have already been written by whoever was
 * consuming them. Nothing promotes a watermark or commits a snapshot on this
 * path, so "staged but not committed" is where they stay — the same place every
 * other mid-run failure leaves its work.
 */
class RecordStreamPump {
  private readonly chunks: string[] = [];
  private carry = '';
  private stderr = '';
  /** How many records the writer has put on the wire. */
  private sent = 0;
  /** How many the child has said it consumed, from the last line it wrote. */
  private answered = 0;
  private waiting = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;
  private fail: ((error: Error) => void) | undefined;
  private ended = false;
  private failure: Error | undefined;
  /** Set once, and preferred over any later error: the reason we killed it. */
  private stalled = false;

  constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, Readable>,
    private readonly timeoutMs: number,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.chunks.push(chunk);
      this.notify();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded exactly as the batch path bounds it, and for the reason
      // {@link MAX_CAPTURED_STDERR_BYTES} gives at length: a transform looping on
      // writes to fd 2 grows the *parent's* heap, and a stream gives it longer to
      // do so.
      if (this.stderr.length >= MAX_CAPTURED_STDERR_BYTES) return;
      this.stderr += chunk.toString().slice(0, MAX_CAPTURED_STDERR_BYTES - this.stderr.length);
    });
    child.on('error', (error) => this.abort(error));
    child.on('close', (code) => {
      this.ended = true;
      if (code !== 0 && !this.failure) {
        this.failure = new Error(
          `The transform exited with code ${code} after ${this.answered} record(s), before it finished the stream. ${this.stderr.slice(0, 500)}`,
        );
      }
      this.notify();
    });
  }

  /**
   * Write the context, then the records, in lines of
   * {@link RECORDS_PER_LINE}.
   *
   * Floating on purpose — see {@link SubprocessTransformRunner.runStream} on the
   * deadlock this shape avoids. Its failure is recorded rather than thrown into
   * nowhere: a source that dies mid-read must surface on the row stream, not as
   * an unhandled rejection with the run reporting a short but successful load.
   */
  feed(records: AsyncIterable<unknown>, context: CatalogCodeContext): void {
    void (async () => {
      const stdin = this.child.stdin;
      await write(stdin, `${JSON.stringify(context)}\n`);
      let line: unknown[] = [];
      for await (const record of records) {
        line.push(record);
        if (line.length < RECORDS_PER_LINE) continue;
        await write(stdin, `${JSON.stringify(line)}\n`);
        this.sent += line.length;
        line = [];
        // The clock may have been idle while the child had nothing outstanding.
        // Sending work is one of the two events that can start it running.
        this.rearm();
      }
      if (line.length > 0) {
        await write(stdin, `${JSON.stringify(line)}\n`);
        this.sent += line.length;
        this.rearm();
      }
      stdin.end();
    })().catch((error: unknown) => {
      this.abort(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /** Every line the child wrote, in order, until it says it is done or it fails. */
  async *messages(): AsyncGenerator<RecordStreamMessage> {
    for (;;) {
      const line = await this.nextLine();
      if (line === undefined) {
        if (this.failure) throw this.failure;
        return;
      }
      // `parse` throws on the child's failure line, so that the record number is
      // in the sentence a consumer sees rather than in a field nobody reads.
      const message = this.parse(line);
      this.answered = message.at;
      yield message;
      if (message.done) return;
    }
  }

  /** Kill the child and everything it started. Idempotent. */
  close(): void {
    this.clearTimer();
    if (!this.ended) stop(this.child);
  }

  private parse(line: string): RecordStreamMessage {
    let parsed: {
      at?: unknown;
      rows?: unknown;
      done?: unknown;
      failed?: { at?: unknown; error?: unknown; logs?: unknown };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `The transform wrote a line this runner could not read after ${this.answered} record(s). That is a bug in the catalog's harness rather than in the transform. stderr: ${this.stderr.slice(0, 500)}`,
      );
    }
    if (parsed.failed) {
      const at = typeof parsed.failed.at === 'number' ? parsed.failed.at : this.answered + 1;
      const logs = Array.isArray(parsed.failed.logs) ? parsed.failed.logs.map(String) : [];
      throw new Error(
        withFinalLogs(`The transform failed on record ${at}: ${String(parsed.failed.error)}`, logs),
      );
    }
    if (isDoneLine(parsed.done)) {
      return { at: parsed.done.recordsIn, rows: [], done: parsed.done };
    }
    return {
      at: typeof parsed.at === 'number' ? parsed.at : this.answered,
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    };
  }

  /** One complete line, or `undefined` when the child has closed for good. */
  private async nextLine(): Promise<string | undefined> {
    for (;;) {
      const nl = this.carry.indexOf('\n');
      if (nl !== -1) {
        const line = this.carry.slice(0, nl);
        this.carry = this.carry.slice(nl + 1);
        if (line.length > 0) return line;
        continue;
      }
      if (this.chunks.length > 0) {
        this.carry += this.chunks.shift();
        if (this.carry.length > MAX_OUTPUT_BYTES) {
          this.abort(
            new Error(
              `The transform wrote more than ${MAX_OUTPUT_BYTES} bytes without a line break, at record ${this.answered}. One record cannot fan out to more rows than the runner can hold.`,
            ),
          );
        }
        continue;
      }
      if (this.ended) return undefined;
      if (this.failure) throw this.failure;
      await this.awaitChunk();
    }
  }

  /**
   * Wait for the child to say something, with the clock running only if it owes
   * us an answer.
   *
   * This method *is* the arming rule: the clock runs while, and only while,
   * control is inside it and {@link owes} holds.
   */
  private awaitChunk(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiting = true;
      this.wake = () => {
        this.waiting = false;
        this.wake = undefined;
        this.fail = undefined;
        this.clearTimer();
        resolve();
      };
      this.fail = (error) => {
        this.waiting = false;
        this.wake = undefined;
        this.fail = undefined;
        this.clearTimer();
        reject(error);
      };
      this.rearm();
    });
  }

  /** Any output at all is progress: the clock stops, and whoever waits wakes. */
  private notify(): void {
    this.clearTimer();
    this.wake?.();
  }

  private owes(): boolean {
    return this.sent > this.answered && !this.ended;
  }

  private rearm(): void {
    this.clearTimer();
    if (!this.waiting || !this.owes()) return;
    this.timer = setTimeout(() => {
      this.stalled = true;
      this.abort(stallError(this.timeoutMs, this.answered, this.sent));
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private abort(error: Error): void {
    // The first failure wins, except that a stall always does: a killed child
    // then closes with a signal, and reporting "exited with code null" instead of
    // "made no progress for 30000ms" would name the symptom rather than the
    // cause.
    if (!this.failure || this.stalled) this.failure = error;
    this.close();
    this.ended = true;
    if (this.fail) this.fail(this.failure);
  }
}

/** Whether the child's last line is the summary, with the fields it promises. */
function isDoneLine(
  value: unknown,
): value is { recordsIn: number; rowsOut: number; logs: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const done: { recordsIn?: unknown; rowsOut?: unknown } = value;
  return typeof done.recordsIn === 'number' && typeof done.rowsOut === 'number';
}

/**
 * The sentence a stalled stream fails with.
 *
 * It states a **window** rather than a record, and the difference is the whole
 * honesty of the message. A child killed with SIGKILL cannot report where it
 * got to, so what the parent knows is the last `at` the child sent and the
 * number of records it has been given since; the record that hung is somewhere
 * between them. Naming `answered + 1` would read as a precise answer and would
 * be wrong by up to {@link FLUSH_RECORDS} — and wrong in the direction that
 * sends somebody to look at a row that transformed perfectly well.
 *
 * The window collapses to one record when it can, because "somewhere in records
 * 618 to 618" is a sentence nobody should have to read.
 *
 * It also says what became of the rows, which is the second question anybody
 * asks and the one #96 established the rule for: rows already yielded were
 * already written by whoever consumed them, and they sit in an uncommitted
 * snapshot because nothing on this path reaches a commit or moves a watermark.
 */
function stallError(timeoutMs: number, answered: number, sent: number): Error {
  const where =
    sent <= answered + 1 ? `on record ${sent}` : `somewhere in records ${answered + 1} to ${sent}`;
  return new Error(
    `The transform stopped making progress for ${timeoutMs}ms and was stopped. It had finished ${answered} record(s) and been given ${sent}, so it stopped ${where}. Rows it had already produced were passed on and are in an uncommitted snapshot; nothing was committed and no watermark moved.`,
  );
}

/** Write, and wait for the pipe to drain if it asked us to. */
function write(stream: NodeJS.WritableStream, text: string): Promise<void> | undefined {
  if (stream.write(text)) return undefined;
  return new Promise((resolve) => stream.once('drain', resolve));
}

/**
 * What the interpreter is invoked with, and which harness it is handed.
 *
 * `module-typescript` is Node's own stripping — types are erased, never
 * checked. A transform with a wrong type still runs; the editor's try pane is
 * what catches it, not the compiler.
 *
 * The module shape needs none of that flag here: the harness itself is plain
 * JavaScript, and the author's `.mts` file is stripped on import by its
 * extension. That confines the stripper to the code that asked for it, rather
 * than running this file's own generated source through it as well.
 */
function interpreterArgs(
  transform: Pick<CatalogTransform, 'language' | 'code'>,
  modulePath: string | undefined,
): string[] {
  if (transform.language === 'python') return ['-c', pythonHarness(transform.code)];
  const script = modulePath
    ? javascriptModuleHarness(pathToFileURL(modulePath).href)
    : javascriptHarness(transform.code);
  const inputType =
    transform.language === 'typescript' && !modulePath ? 'module-typescript' : 'module';
  return ['--input-type', inputType, '-e', script];
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
  ${javascriptExportedFunction(moduleUrl)}
  const rows = await exported({ records, context });
  process.stdout.write(JSON.stringify({ rows: rows ?? [], logs: captured() }));
} catch (error) {
  ${JAVASCRIPT_FAILURE}
}
`;
}

/**
 * The harness for `'record'` mode: import the author's module, call it once per
 * record, and put the rows on the wire as they are produced.
 *
 * Everything about the *code* is the same as {@link javascriptModuleHarness} —
 * the same six console channels, the same two caps, the same frozen `context`,
 * the same two accepted export spellings, the same refusal by name when there is
 * neither. What differs is only the argument and the transport, and keeping the
 * rest identical is what makes "the same transform, called differently" true
 * rather than approximately true.
 *
 * ## What a per-record transform can and cannot retain
 *
 * The question is worth answering exactly, because "it cannot see the batch" is
 * a claim about a contract and people will build on it.
 *
 * **It cannot see other records.** The function is handed one `record` and there
 * is no array anywhere in scope. That is enforced by the shape of the call, not
 * by convention.
 *
 * **It cannot emit at the end.** There is no finish hook, no flush callback, no
 * second export this harness looks for. A transform that accumulates into a
 * module-scope `Map` intending to return the totals afterwards has nowhere to
 * return them *to*, so it emits nothing and the node's row count is zero — which
 * is loud, immediate and visible on the run, rather than a partial aggregate
 * committed as though it were the answer. This is the enforcement that matters,
 * because it is the one that turns "you have used the wrong mode" from silently
 * wrong data into an obvious failure.
 *
 * **It cannot retain anything past the node.** The process is spawned for one
 * node run and killed at the end of it, so nothing carries to the next run, the
 * next node, or another connector sharing the same transform. That is enforced
 * by process lifetime and is the identical guarantee the whole-batch path has
 * always had — the child was never reused there either.
 *
 * **It can retain state in module scope for the length of one run**, and no
 * honest harness can stop it: a module may close over a `let`, and preventing
 * that means either re-importing per record (which would cost more than the
 * subprocess this change exists to make cheaper) or forbidding modules, which is
 * the only shape the mode accepts. So it is stated rather than pretended
 * otherwise. What that buys an author is a memo table or a compiled regex, which
 * is legitimate and useful; what it does not buy is an aggregate, for the reason
 * directly above. Records arrive in source order, so such a transform is
 * deterministic — it is simply not what the mode is for.
 *
 * ## The wire, and why the child talks in lines
 *
 * Records arrive as JSON arrays, one per line, {@link RECORDS_PER_LINE} at a
 * time; the first line is the context. Rows leave as `{"at":N,"rows":[…]}`
 * lines, then one `{"done":…}` or `{"failed":…}`. `at` is how many records have
 * been *consumed*, and it is on every line for two separate consumers: it is
 * what a failure names so a stack trace can be tied to a row, and it is what the
 * parent's stall clock resets on. See {@link FLUSH_BYTES} and
 * {@link FLUSH_RECORDS} for why a line is written even when it carries no rows.
 *
 * `process.stdout.write` is awaited through its `drain`, which is the child's
 * half of the back-pressure: a parent that stops reading stops this loop, which
 * stops it reading stdin, which stops the source. Without it the child would
 * happily buffer the whole output in its own heap while congratulating itself on
 * streaming.
 */
function javascriptRecordHarness(moduleUrl: string): string {
  return `${JAVASCRIPT_CONSOLE}
let at = 0;
let rowsOut = 0;
let pending = [];
let pendingBytes = 0;
let sinceFlush = 0;
const send = async (line) => {
  if (!process.stdout.write(line)) await new Promise((r) => process.stdout.once("drain", r));
};
const flush = async () => {
  const line = '{"at":' + at + ',"rows":[' + pending.join(",") + ']}\\n';
  pending = [];
  pendingBytes = 0;
  sinceFlush = 0;
  await send(line);
};
// One rule for four return shapes: an object is a row, an array is those rows,
// and null or undefined is none. See CatalogRecordTransformFunction, which is
// where the argument for that rule lives.
const collect = (value) => {
  if (value === null || value === undefined) return;
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    const json = JSON.stringify(row);
    pending.push(json);
    pendingBytes += json.length;
    rowsOut += 1;
  }
};
try {
  ${javascriptExportedFunction(moduleUrl)}
  let context = null;
  let carry = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    carry += chunk;
    let nl = carry.indexOf("\\n");
    while (nl !== -1) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      nl = carry.indexOf("\\n");
      if (line.length === 0) continue;
      if (context === null) {
        const sent = JSON.parse(line);
        // Frozen one level down, exactly as the batch harnesses freeze it, so
        // assigning to context.env.TOKEN fails loudly here rather than appearing
        // to work. Frozen ONCE, outside the record loop: it is the same object
        // for every record by construction, so there is nothing a transform
        // could write on it that would reach the next one.
        context = Object.freeze({ ...sent, env: Object.freeze({ ...sent.env }) });
        continue;
      }
      for (const record of JSON.parse(line)) {
        at += 1;
        sinceFlush += 1;
        collect(await exported({ record, context }));
        if (pendingBytes >= ${FLUSH_BYTES} || sinceFlush >= ${FLUSH_RECORDS}) await flush();
      }
    }
  }
  await flush();
  await send(JSON.stringify({ done: { recordsIn: at, rowsOut, logs: captured() } }) + "\\n");
} catch (error) {
  // Whatever was pending is deliberately NOT flushed. The node has failed, so
  // nothing downstream will read this stage; sending the rows anyway would put
  // work on the wire that exists only to be discarded, and would make the last
  // "at" a reader sees larger than the record that actually threw.
  await send(JSON.stringify({
    failed: {
      at,
      error: error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error),
      logs: captured(),
    },
  }) + "\\n");
}
`;
}

/**
 * Find the function the author exported, or refuse by name.
 *
 * Shared verbatim by the module harness and the record harness rather than
 * copied into each, for the reason {@link JAVASCRIPT_CONSOLE} is shared: two
 * copies of "which exports are accepted" are two answers, and the one that
 * drifts is discovered by an author whose perfectly good `export default` works
 * in one mode and not the other.
 *
 * The sentence it throws deliberately does not name a mode. Both modes accept
 * exactly the same two spellings, and what differs — the argument — is already
 * on the type the author is writing against.
 */
function javascriptExportedFunction(moduleUrl: string): string {
  return `
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
`;
}

/**
 * Capture the console, before any of the author's code can reach it.
 *
 * Shared verbatim by both JavaScript harnesses rather than copied into each: two
 * copies of a log cap are two numbers that drift, and the one that drifts is
 * discovered by a run record nobody can explain.
 */
const JAVASCRIPT_CONSOLE = `
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
`;

/**
 * The whole of stdin, as one string.
 *
 * Split out of the prelude when the streaming harness arrived, because that one
 * must **not** do this: slurping the input is precisely the thing a per-record
 * run exists to avoid, and a harness that inherited it by sharing a constant
 * would have held the dataset in the child while the parent was carefully not
 * holding it in itself. The console capture above is shared by all three
 * harnesses and this is shared by the two that read a finished batch, which is
 * the line the split follows.
 */
const JAVASCRIPT_SLURP_STDIN = `
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
`;

/** What the two whole-batch harnesses open with: capture the console, read stdin. */
const JAVASCRIPT_PRELUDE = `${JAVASCRIPT_CONSOLE}${JAVASCRIPT_SLURP_STDIN}`;

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
