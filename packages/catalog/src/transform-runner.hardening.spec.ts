import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubprocessTransformRunner } from './transform-runner';

/**
 * The three ways a transform outlasted or outgrew the thing meant to bound it.
 *
 * These spawn real children, for the reason `transform-runner.spec.ts` gives at
 * length: the harness exists only as a string of source for another interpreter,
 * and a fake proves nothing about a process group, a pipe, or a working
 * directory. Every case here is timed or sized against a real one.
 *
 * What is deliberately **not** here: a case asserting that the child cannot read
 * `/proc/<ppid>/environ` or a service-account token. It can, the class docblock
 * now says so, and a test pinning the opposite would be a test of a claim this
 * package does not make. Containment is a `TransformRunner` swap, not a patch.
 */
const runner = new SubprocessTransformRunner();

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('the timeout stops what the transform started', () => {
  it('kills a grandchild the transform spawned', async () => {
    // `child.kill()` signals one pid. A transform that spawns anything at all —
    // `curl`, a second node, a `sh -c` — leaves work that the direct child's
    // death says nothing about, so the timeout fired, the caller was told the
    // run had been stopped, and the work carried on. A bound the person being
    // bounded can step out of is not a bound.
    const marker = join(mkdtempSync(join(tmpdir(), 'catalog-transform-')), 'survived');
    temporary.push(marker);

    await expect(
      runner.run(
        {
          language: 'javascript',
          code: `
            const cp = await import("node:child_process");
            cp.spawn(process.execPath, [
              "-e",
              "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'survived'), 2000)",
              ${JSON.stringify(marker)},
            ], { stdio: "ignore" }).unref();
            await new Promise((keepAlive) => setTimeout(keepAlive, 60000));
            return [];
          `,
        },
        [],
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow(/longer than 500ms/);

    // Comfortably past the grandchild's own 2s timer, so "it has not written
    // yet" cannot pass for "it will never write".
    await new Promise((done) => setTimeout(done, 3_500));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('does not reach a grandchild that starts a process group of its own', async () => {
    // The limit, asserted rather than left to a docblock nobody opens. A
    // grandchild spawned `detached` is a group leader in its own right, and a
    // negative pid reaches one group. Answering this needs a cgroup or a
    // container — the same place the class docblock's honesty about the boundary
    // ends up, and for the same reason.
    //
    // This test exists so that the sentence stays true rather than to bless the
    // gap: a runner that ever does contain this should arrive here and find a
    // named expectation to invert.
    const marker = join(mkdtempSync(join(tmpdir(), 'catalog-transform-')), 'escaped');
    temporary.push(marker);

    await expect(
      runner.run(
        {
          language: 'javascript',
          code: `
            const cp = await import("node:child_process");
            cp.spawn(process.execPath, [
              "-e",
              "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'escaped'), 2000)",
              ${JSON.stringify(marker)},
            ], { detached: true, stdio: "ignore" }).unref();
            await new Promise((keepAlive) => setTimeout(keepAlive, 60000));
            return [];
          `,
        },
        [],
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow(/longer than 500ms/);

    await new Promise((done) => setTimeout(done, 3_500));
    expect(existsSync(marker)).toBe(true);
  }, 30_000);

  it('still reports the timeout when the child is already gone', async () => {
    // The group kill can legitimately find nothing — a race between the timer
    // and the child exiting. That has to fall through to the direct kill rather
    // than throw, or an `ESRCH` replaces a timeout message that says something
    // true with an unhandled one that says nothing.
    await expect(
      runner.run(
        {
          language: 'javascript',
          code: 'await new Promise((r) => setTimeout(r, 60000)); return [];',
        },
        [],
        { timeoutMs: 300 },
      ),
    ).rejects.toThrow(/longer than 300ms and was stopped/);
  }, 20_000);
});

describe('stderr is bounded', () => {
  it('does not grow the parent heap with what a transform writes to fd 2', async () => {
    // `stderr += chunk` had no ceiling at all, for the whole timeout window, and
    // the heap it grew was the *parent's* — the process serving every other
    // request. 64MB here is twice the stdout cap and around a thousand times the
    // stderr one.
    const before = process.memoryUsage().heapUsed;
    const result = await runner.run(
      {
        language: 'javascript',
        code: `
          const chunk = "x".repeat(1024 * 1024);
          for (let i = 0; i < 64; i++) process.stderr.write(chunk);
          return [{ ok: true }];
        `,
      },
      [],
      { timeoutMs: 25_000 },
    );

    expect(result.rows).toEqual([{ ok: true }]);
    // A generous ceiling: what is being caught is tens of megabytes retained,
    // not a precise allocation figure, and a tight bound here would be a flaky
    // test about V8's GC timing.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(16 * 1024 * 1024);
  }, 40_000);

  it('lets a noisy transform that returns rows succeed', async () => {
    // The asymmetry with stdout, which kills on overflow. Stderr is only the
    // diagnostic: a chatty dependency's warnings must not fail a load that
    // produced perfectly good rows.
    const result = await runner.run(
      {
        language: 'javascript',
        code: `
          const chunk = "y".repeat(1024 * 1024);
          for (let i = 0; i < 40; i++) process.stderr.write(chunk);
          return [{ n: 1 }];
        `,
      },
      [],
      { timeoutMs: 25_000 },
    );
    expect(result.rows).toEqual([{ n: 1 }]);
  }, 40_000);

  it('keeps the head of stderr, which is the part that gets read', async () => {
    // Both consumers take `stderr.slice(0, 500)` — the import error, the first
    // line of a traceback. Dropping the head to keep the tail would discard
    // exactly the part anybody sees.
    await expect(
      runner.run(
        {
          language: 'javascript',
          code: `
            process.stderr.write("THE FIRST LINE, which is what a reader gets\\n");
            const chunk = "z".repeat(1024 * 1024);
            for (let i = 0; i < 8; i++) process.stderr.write(chunk);
            process.exit(3);
          `,
        },
        [],
        { timeoutMs: 25_000 },
      ),
    ).rejects.toThrow(/THE FIRST LINE/);
  }, 40_000);
});

describe('the working directory', () => {
  it('is not the parent process directory, so a relative read finds nothing', async () => {
    // The child inherited the service's cwd, so `readFileSync(".env")` — one
    // line, no knowledge of the deployment required — read the host
    // application's configuration straight past an environment allowlist whose
    // entire purpose was to withhold it.
    const result = await runner.run(
      { language: 'javascript', code: 'return [{ cwd: process.cwd() }];' },
      [],
    );
    expect(result.rows[0].cwd).not.toBe(process.cwd());
  });

  it('leaves absolute paths reachable, because it cannot do otherwise', async () => {
    // Stated as a test rather than left to a comment: this is a nuisance to the
    // one path a transform can name without knowing anything, not a boundary.
    // Somebody reading the cwd change as containment should meet this.
    const file = join(mkdtempSync(join(tmpdir(), 'catalog-transform-')), 'plain.txt');
    temporary.push(file);
    writeFileSync(file, 'reachable');

    const result = await runner.run(
      {
        language: 'javascript',
        code: `
          const fs = await import("node:fs");
          return [{ read: fs.readFileSync(${JSON.stringify(file)}, "utf8") }];
        `,
      },
      [],
    );
    expect(result.rows[0].read).toBe('reachable');
  });

  it('is somewhere a transform may still write', async () => {
    // A directory the child cannot write to would break transforms that spill to
    // disk, which is a legitimate thing for one to do.
    const result = await runner.run(
      {
        language: 'javascript',
        code: `
          const fs = await import("node:fs");
          fs.writeFileSync("scratch.txt", "ok");
          return [{ read: fs.readFileSync("scratch.txt", "utf8") }];
        `,
      },
      [],
    );
    expect(result.rows[0].read).toBe('ok');
  });
});
