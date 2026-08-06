import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowlistedCodeEnv, codeContext, namedEnvironment } from './code-context';
import { SECRET_ENV_ALLOW_VAR, installSecretEnvAllowlist } from './secret-env-allowlist';

/**
 * The process is under test here as much as the functions are, so it is put
 * back: the installed list, the environment variable, and the fixture variables
 * each case exports. A case that left any of them behind would decide the next
 * one, and the failure would read as the allow-list being wrong rather than the
 * spec being wrong.
 */
const FIXTURES = ['VENDOR_TOKEN', 'VENDOR_EMPTY', 'FLEET_DB_URL', 'DATABASE_URL'] as const;
const previousAllow = process.env[SECRET_ENV_ALLOW_VAR];
const previousFixtures = new Map(FIXTURES.map((name) => [name, process.env[name]]));

beforeEach(() => {
  installSecretEnvAllowlist(undefined);
  delete process.env[SECRET_ENV_ALLOW_VAR];
  process.env.VENDOR_TOKEN = 'vendor-secret';
  process.env.VENDOR_EMPTY = '';
  process.env.FLEET_DB_URL = 'postgres://fleet';
  process.env.DATABASE_URL = 'postgres://the-host-application';
});

afterEach(() => {
  installSecretEnvAllowlist(undefined);
  if (previousAllow === undefined) delete process.env[SECRET_ENV_ALLOW_VAR];
  else process.env[SECRET_ENV_ALLOW_VAR] = previousAllow;
  for (const [name, value] of previousFixtures) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('allowlistedCodeEnv', () => {
  it('admits nothing when no allow-list is in force, and names both levers', () => {
    const { env, notes } = allowlistedCodeEnv();

    expect(env).toEqual({});
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('secretEnvAllowlist');
    expect(notes[0]).toContain(SECRET_ENV_ALLOW_VAR);
  });

  it('admits nothing under "*", rather than copying the pod', () => {
    // The escape hatch keeps *connectors* running through an upgrade — one
    // named variable at a time, on a connector somebody can see. Copying the
    // environment into a context that code can print into a run log is a
    // different disclosure, and nobody consented to it by typing one character.
    installSecretEnvAllowlist(['*']);

    const { env, notes } = allowlistedCodeEnv();

    expect(env).toEqual({});
    expect(notes[0]).toContain('"*"');
    expect(notes[0]).toContain('List the variables this code actually reads');
  });

  it('admits exactly what the list names, by exact name and by prefix', () => {
    installSecretEnvAllowlist(['FLEET_DB_URL', 'VENDOR_*']);

    const { env } = allowlistedCodeEnv();

    expect(env).toEqual({ FLEET_DB_URL: 'postgres://fleet', VENDOR_TOKEN: 'vendor-secret' });
    // The whole point of the list: the host application's own credential is not
    // reachable from code just because code asked nicely.
    expect(env.DATABASE_URL).toBeUndefined();
    // Exported as "" cannot authenticate to anything, and offering it would only
    // move the failure into whatever the code does with it.
    expect(env.VENDOR_EMPTY).toBeUndefined();
  });

  it('names the admitted variables in the run log, and never their values', () => {
    installSecretEnvAllowlist(['VENDOR_*']);

    const { notes } = allowlistedCodeEnv();

    expect(notes[0]).toContain('VENDOR_TOKEN');
    expect(notes[0]).not.toContain('vendor-secret');
  });

  it('says so when a list is in force and matches nothing', () => {
    // Distinct from "no list at all", which is the whole reason this is a
    // separate sentence: the fix for one is to bind a list and the fix for the
    // other is to fix the one already bound.
    installSecretEnvAllowlist(['NOTHING_HERE_*']);

    const { env, notes } = allowlistedCodeEnv();

    expect(env).toEqual({});
    expect(notes[0]).toContain('NOTHING_HERE_*');
    expect(notes[0]).toContain('nothing matched it');
  });

  it('orders keys, so two resolutions of one policy serialise identically', () => {
    installSecretEnvAllowlist(['VENDOR_*', 'FLEET_*']);

    const first = JSON.stringify(allowlistedCodeEnv().env);
    const second = JSON.stringify(allowlistedCodeEnv().env);

    expect(first).toBe(second);
    expect(Object.keys(allowlistedCodeEnv().env)).toEqual(['FLEET_DB_URL', 'VENDOR_TOKEN']);
  });

  it('reads the environment variable as well as the installed list', () => {
    process.env[SECRET_ENV_ALLOW_VAR] = 'VENDOR_TOKEN';

    expect(allowlistedCodeEnv().env).toEqual({ VENDOR_TOKEN: 'vendor-secret' });
  });
});

describe('codeContext', () => {
  it('leaves an absent field off entirely rather than writing undefined', () => {
    // `{runId: undefined}` and a missing key round-trip to the same thing
    // through JSON and not through a deep-equality check — which is exactly the
    // check a replay-safety test would use.
    const context = codeContext({ environment: undefined, rowCount: 0, inputs: [], env: {} });

    expect(Object.hasOwn(context, 'runId')).toBe(false);
    expect(Object.hasOwn(context, 'workflow')).toBe(false);
    expect(Object.hasOwn(context, 'node')).toBe(false);
    expect(Object.hasOwn(context, 'connectorId')).toBe(false);
    expect(Object.hasOwn(context, 'environment')).toBe(false);
  });

  it('is a pure function of its arguments, so a caller can checkpoint it', () => {
    const parts = {
      runId: 'run-1',
      workflow: { id: 'wf-1', name: 'fleet', version: 4 },
      node: { id: 'n2', name: 'normalise' },
      environment: 'prod',
      rowCount: 12,
      inputs: [{ runId: 'run-1', nodeId: 'n1', batches: 2, rowCount: 12 }],
      env: { VENDOR_TOKEN: 'vendor-secret' },
    };

    const first = codeContext(parts);
    const second = codeContext(parts);

    expect(first).toEqual(second);
    // JSON, all the way down: what a durable checkpoint can hold is what a
    // conditional's predicate can be replayed against.
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('copies the stage refs, so a later edit cannot reach a checkpointed context', () => {
    const inputs = [{ runId: 'run-1', nodeId: 'n1', batches: 1, rowCount: 3 }];

    const context = codeContext({
      environment: undefined,
      rowCount: 3,
      inputs,
      env: {},
    });
    inputs[0].rowCount = 999;

    expect(context.inputs[0]?.rowCount).toBe(3);
  });

  it('carries the per-edge counts a predicate needs to ask whether anything arrived', () => {
    const context = codeContext({
      runId: 'run-1',
      environment: undefined,
      rowCount: 0,
      inputs: [{ runId: 'run-1', nodeId: 'source', batches: 0, rowCount: 0 }],
      env: {},
    });

    expect(context.rowCount).toBe(0);
    expect(context.inputs).toEqual([{ runId: 'run-1', nodeId: 'source', batches: 0, rowCount: 0 }]);
  });
});

describe('namedEnvironment', () => {
  it('is absent when the host bound nothing', () => {
    expect(namedEnvironment(undefined)).toBeUndefined();
  });

  it('resolves at the moment of the call, not at construction', () => {
    let current = 'dev';
    const resolve = () => current;

    expect(namedEnvironment(resolve)).toBe('dev');
    current = 'prod';
    expect(namedEnvironment(resolve)).toBe('prod');
  });

  it('reads an empty name as no name', () => {
    expect(namedEnvironment(() => '')).toBeUndefined();
  });

  it('does not fail a load because a host resolver threw', () => {
    expect(
      namedEnvironment(() => {
        throw new Error('no scope entered');
      }),
    ).toBeUndefined();
  });
});
