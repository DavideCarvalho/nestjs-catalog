// The gate that was missing.
//
// CI ran `pnpm lint` and `pnpm build`, and `build` compiles each package's `src` through its own
// tsconfig — which every package deliberately excludes the specs from, because a spec compiled into
// `dist/` would be published. So the specs were typechecked by nothing at all. Not loosely: nothing.
// `vitest` strips types with SWC and never asks whether they were right, so a spec could drift for
// months behind a green suite, and several had: fixtures missing fields the type had since gained,
// a test harness importing a package that did not resolve, and a config that was itself invalid
// (TS5069) and therefore reported one error instead of the thirty behind it.
//
// This runs `tsc` over every `packages/*/tsconfig.spec.json` and fails if any of them does.
//
// It also answers the question the old setup could not: is a package's specs being unchecked a
// decision or an oversight? A package with spec files and no `tsconfig.spec.json` is a failure here
// (see MISSING_CONFIG below) rather than a silent skip, so the next package added to this workspace
// cannot repeat the thing this script exists to stop.
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const PACKAGES = fileURLToPath(new URL('packages/', ROOT));

/** Spec files, by the same globs the spec configs `include` — kept in step by eye, deliberately:
 *  the alternative is parsing tsconfig globs, and the only thing that needs to agree is which
 *  extensions count as a spec. */
const SPEC = /\.(spec|test)\.tsx?$/;

/**
 * Does this package directory contain any spec file at all?
 *
 * An explicit stack rather than recursion, because it can stop at the FIRST hit — the answer is a
 * boolean, and a package like `react` holds hundreds of files this would otherwise walk to no end.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function hasSpecs(dir) {
  const pending = [`${dir}/src`, `${dir}/test`];

  while (pending.length > 0) {
    const current = pending.pop() ?? '';
    for (const entry of readDir(current)) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isDirectory()) pending.push(`${current}/${entry.name}`);
      else if (SPEC.test(entry.name)) return true;
    }
  }

  return false;
}

/**
 * `readdirSync` that answers "nothing there" instead of throwing. Plenty of packages have no
 * `test/`, and a missing directory is an ordinary answer to the question above, not an error.
 *
 * @param {string} dir
 * @returns {import('node:fs').Dirent[]}
 */
function readDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** @param {string} name @returns {Promise<{ name: string, status: 'ok' | 'failed', output: string }>} */
function typecheck(name) {
  return new Promise((resolve) => {
    // `tsc` rather than `tsc --noEmit`: the spec configs set `noEmit` themselves (with `declaration`
    // and `declarationMap` off alongside it, which TS requires and one of them had got wrong), and a
    // config that has to be rescued by its caller's flags is a config that is wrong on its own.
    const child = spawn('npx', ['tsc', '-p', `packages/${name}/tsconfig.spec.json`], {
      cwd: fileURLToPath(ROOT),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => {
      resolve({ name, status: code === 0 ? 'ok' : 'failed', output: output.trim() });
    });
  });
}

const packages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** @type {string[]} */
const toCheck = [];
/** @type {string[]} */
const missingConfig = [];
/** @type {string[]} */
const noSpecs = [];

for (const name of packages) {
  const dir = `${PACKAGES}${name}`;
  let hasConfig = true;
  try {
    statSync(`${dir}/tsconfig.spec.json`);
  } catch {
    hasConfig = false;
  }

  if (hasConfig) toCheck.push(name);
  else if (hasSpecs(dir)) missingConfig.push(name);
  else noSpecs.push(name);
}

// Run them together. Each is an independent `tsc` process and they are the long pole in this gate;
// serially this is minutes, in parallel it is the slowest single package.
const results = await Promise.all(toCheck.map(typecheck));

for (const { name, status, output } of results) {
  console.log(`${status === 'ok' ? 'ok  ' : 'FAIL'}  ${name}`);
  if (output) console.log(`${output}\n`);
}
for (const name of noSpecs) {
  // Not a pass and not a failure: a package with no spec files has nothing to check. Printed rather
  // than skipped silently, so "why is this one not in the list" has an answer on screen.
  console.log(`--    ${name} (no spec files)`);
}

const failed = results.filter((result) => result.status === 'failed').map((result) => result.name);

if (missingConfig.length > 0) {
  // MISSING_CONFIG. A package that has spec files and no `tsconfig.spec.json` is a hole of exactly
  // the shape this gate exists to close, and it is invisible from the inside: the specs run, the
  // suite is green, and nobody is checking their types. Adding the config is a four-line file that
  // extends the package's build config and `../../tsconfig.spec.base.json`; copy any sibling's.
  const listed = missingConfig.map((name) => `  packages/${name}`).join('\n');
  console.error(
    `\nThese packages have spec files but no tsconfig.spec.json, so nothing typechecks them:\n${listed}\nCopy a sibling's tsconfig.spec.json — it is four lines and two extends.`,
  );
}

if (failed.length > 0 || missingConfig.length > 0) {
  console.error(`\nspec typecheck failed: ${[...failed, ...missingConfig].join(', ')}`);
  process.exit(1);
}

console.log(`\nspec typecheck passed (${results.length} packages)`);
