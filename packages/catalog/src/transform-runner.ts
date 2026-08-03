import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type {
  CatalogTransform,
  TransformLanguage,
  TransformResult,
  TransformRunner,
} from './catalog.pipeline';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

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
 * **This is not a security boundary.** It stops accidents — an infinite loop, a
 * runaway allocation, a stray read of `process.env.DATABASE_PASSWORD` — because
 * the child gets a timeout and an empty environment. It does not stop code
 * written to escape it: a child process can still open sockets and read the
 * filesystem as whatever user the service runs as.
 *
 * That is a deliberate trade for the case this is built for, where transforms
 * are written by the same people who already have database access. A catalog
 * that accepts transforms from anyone else needs a container, gVisor, or a WASM
 * runtime — and `TransformRunner` is an interface precisely so that swap is a
 * provider change rather than a rewrite.
 *
 * `node:vm` was the other option and is worse on both counts: it is famously
 * not an isolation boundary either, and it cannot be killed mid-loop.
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
    options: { timeoutMs?: number } = {},
  ): Promise<TransformResult> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const python = transform.language === 'python';
    const interpreter = python ? await this.resolvePython() : process.execPath;
    if (!interpreter) {
      throw new Error(
        'No python3 on PATH, so python transforms cannot run here. Use javascript or typescript, or install python in the image.',
      );
    }

    const script = python ? pythonHarness(transform.code) : javascriptHarness(transform.code);

    // `module-typescript` is Node's own stripping — types are erased, never
    // checked. A transform with a wrong type still runs; the editor's try pane
    // is what catches it, not the compiler.
    const args = python
      ? ['-c', script]
      : [
          '--input-type',
          transform.language === 'typescript' ? 'module-typescript' : 'module',
          '-e',
          script,
        ];

    const { stdout, stderr } = await this.spawn(
      interpreter,
      args,
      JSON.stringify(records),
      timeoutMs,
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

    if (parsed.error) throw new Error(parsed.error);
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
      logs: Array.isArray(parsed.logs) ? parsed.logs.map(String) : [],
      elapsedMs: Date.now() - started,
    };
  }

  private spawn(
    command: string,
    args: string[],
    input: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        // An empty environment, not the parent's. A transform has no business
        // reading the database password, and inheriting env is how it would.
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`The transform ran for longer than ${timeoutMs}ms and was stopped.`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
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
          reject(new Error(`The transform exited with code ${code}. ${stderr.slice(0, 500)}`));
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
      const candidate = join(venv, 'bin', 'python');
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
 * The JavaScript and TypeScript harness.
 *
 * `console.log` is captured rather than left on stdout so user code cannot
 * corrupt the single JSON line this prints — a transform that logs a `{` would
 * otherwise break its own result parsing, which is a maddening thing to debug.
 */
function javascriptHarness(code: string): string {
  return `
const logs = [];
const write = (...args) => logs.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
console.log = write; console.info = write; console.warn = write; console.error = write;

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

try {
  const records = JSON.parse(input || "[]");
  const transform = async (records) => { ${code} };
  const rows = await transform(records);
  process.stdout.write(JSON.stringify({ rows: rows ?? [], logs }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    error: error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error),
    logs,
  }));
}
`;
}

/**
 * The Python harness. `records` in, a list of dicts out.
 *
 * A DataFrame is accepted as a return value and converted, because a transform
 * that reaches for pandas will naturally end with one — making it write
 * `.to_dict("records")` would be a papercut on the only path pandas is worth
 * importing for.
 */
function pythonHarness(code: string): string {
  const indented = code
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `
import sys, json

logs = []
def log(*args):
    logs.append(" ".join(str(a) for a in args))

def transform(records):
${indented || '    return records'}

def to_rows(result):
    if result is None:
        return []
    # A DataFrame, without importing pandas to find out — checking for the
    # method keeps this working when pandas is not installed at all.
    if hasattr(result, "to_dict") and hasattr(result, "columns"):
        return result.to_dict("records")
    return result

try:
    raw = sys.stdin.read()
    records = json.loads(raw) if raw.strip() else []
    rows = to_rows(transform(records))
    sys.stdout.write(json.dumps(rows and {"rows": rows, "logs": logs} or {"rows": [], "logs": logs}, default=str))
except Exception as error:
    sys.stdout.write(json.dumps({
        "error": "{}: {}".format(type(error).__name__, error),
        "logs": logs,
    }))
`;
}
