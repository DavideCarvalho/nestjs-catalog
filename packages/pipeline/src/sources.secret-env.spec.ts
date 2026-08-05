import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOW_EVERY_SECRET_ENV, installSecretEnvAllowlist } from './secret-env-allowlist';
import { resolveSecretEnv } from './sources';

/**
 * The connector the security report was written about, and the one every host
 * already has.
 *
 * `FLEET_DB_URL` stands for an ordinary connector credential somebody
 * provisioned on purpose. `DATABASE_URL` stands for the host application's own
 * database — set in the same pod, never intended for a connector, and the thing
 * a `catalog:write` principal could name and read back through a load.
 */
const CONNECTOR_VAR = 'FLEET_DB_URL';
const HOST_VAR = 'CATALOG_SPEC_HOST_DATABASE_URL';

const touched: string[] = [];

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

beforeEach(() => {
  installSecretEnvAllowlist(undefined);
  // Both are set, and that is the setup rather than an accident: the whole
  // question is whether naming one of them gets you the other.
  setEnv(CONNECTOR_VAR, 'postgres://fleet:pw@warehouse/fleet');
  setEnv(HOST_VAR, 'postgres://app:pw@rds/app');
});

afterEach(() => {
  installSecretEnvAllowlist(undefined);
  for (const name of touched.splice(0)) delete process.env[name];
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------
 * The hole itself.
 * ------------------------------------------------------------------------- */

describe('a caller naming the environment variable the server reads', () => {
  // The unfixed behaviour, stated as the thing that must not happen. Before the
  // allow-list this returned the host application's connection string to a
  // connector whose author had done nothing but type a name.
  it('does not hand over the host application’s own database', () => {
    installSecretEnvAllowlist([CONNECTOR_VAR]);
    expect(() => resolveSecretEnv(HOST_VAR)).toThrow();
  });

  it('still reads the credential the deployment provisioned for connectors', () => {
    installSecretEnvAllowlist([CONNECTOR_VAR]);
    expect(resolveSecretEnv(CONNECTOR_VAR)).toBe('postgres://fleet:pw@warehouse/fleet');
  });

  it('admits a family by prefix without admitting what sits outside it', () => {
    setEnv('FLEET_S3_KEYS', 'ak:sk');
    installSecretEnvAllowlist(['FLEET_*']);
    expect(resolveSecretEnv('FLEET_S3_KEYS')).toBe('ak:sk');
    expect(() => resolveSecretEnv(HOST_VAR)).toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * The amplifier: the error was an oracle for the pod's environment.
 * ------------------------------------------------------------------------- */

describe('what a refused caller is told', () => {
  // The load-bearing assertion in this file. A variable that exists and a
  // variable that does not must produce the *same string*, or `POST
  // connectors/:id/discover` — which writes nothing and leaves nothing behind —
  // is a probe for the pod's environment, one name per request.
  it('cannot tell a variable that is set from one that does not exist', () => {
    installSecretEnvAllowlist([CONNECTOR_VAR]);

    const set = messageFrom(() => resolveSecretEnv(HOST_VAR));
    const absent = messageFrom(() => resolveSecretEnv('CATALOG_SPEC_NOTHING_IS_HERE'));

    // Byte for byte apart from the name the caller supplied, which they already
    // knew. Any other difference is the leak coming back.
    expect(set.replace(HOST_VAR, 'NAME')).toBe(
      absent.replace('CATALOG_SPEC_NOTHING_IS_HERE', 'NAME'),
    );
  });

  it('cannot tell "not on the list" from "on the list and not set"', () => {
    installSecretEnvAllowlist(['FLEET_*']);

    const notAdmitted = messageFrom(() => resolveSecretEnv(HOST_VAR));
    const admittedButUnset = messageFrom(() => resolveSecretEnv('FLEET_NEVER_PROVISIONED'));

    expect(notAdmitted.replace(HOST_VAR, 'NAME')).toBe(
      admittedButUnset.replace('FLEET_NEVER_PROVISIONED', 'NAME'),
    );
  });

  // The old message was `${name} is not set in this environment`, and it is the
  // *variation* that was the oracle rather than any particular phrase. So the
  // check is that the same name produces the same sentence across every state
  // the environment and the policy can be in — a spelling check on "is not set"
  // would go green again the day somebody reworded the leak.
  it('says the same thing about one name whatever the environment is doing', () => {
    installSecretEnvAllowlist(['FLEET_*']);
    const refusedWhileUnset = messageFrom(() => resolveSecretEnv('FLEET_LATER'));

    setEnv('FLEET_LATER', 'a value appeared');
    // Now admitted AND set, so it resolves — the one distinguishable case, and
    // the one that is supposed to be: a working connector works.
    expect(resolveSecretEnv('FLEET_LATER')).toBe('a value appeared');

    installSecretEnvAllowlist(['SOMETHING_ELSE']);
    const refusedWhileSet = messageFrom(() => resolveSecretEnv('FLEET_LATER'));

    expect(refusedWhileSet).toBe(refusedWhileUnset);
  });

  it('repeats the name back, because the caller is the one who chose it', () => {
    installSecretEnvAllowlist([CONNECTOR_VAR]);
    expect(messageFrom(() => resolveSecretEnv(HOST_VAR))).toContain(HOST_VAR);
  });
});

/* ---------------------------------------------------------------------------
 * …while remaining diagnosable by an operator.
 * ------------------------------------------------------------------------- */

describe('what the operator is told', () => {
  it('records which of the two it was, where only an operator can read it', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    installSecretEnvAllowlist(['FLEET_*']);

    expect(() => resolveSecretEnv(HOST_VAR)).toThrow();
    expect(() => resolveSecretEnv('FLEET_NEVER_PROVISIONED')).toThrow();

    const [refused, unset] = warn.mock.calls.map((call) => String(call[0]));
    // The two the caller could not tell apart are told apart here, which is the
    // whole point of moving the reason rather than deleting it.
    expect(refused).toMatch(/does not admit/i);
    expect(unset).toMatch(/is not set/i);
  });

  it('tells an operator what to do about a name that should have been admitted', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    installSecretEnvAllowlist(['FLEET_*']);

    expect(() => resolveSecretEnv('DPAS_API_TOKEN')).toThrow();

    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('DPAS_API_TOKEN');
    expect(line).toContain('secretEnvAllowlist');
    expect(line).toContain('CATALOG_SECRET_ENV_ALLOW');
  });
});

/* ---------------------------------------------------------------------------
 * The upgrade. Every existing connector names a variable.
 * ------------------------------------------------------------------------- */

describe('a deployment upgrading onto this release', () => {
  // The refusal is what a host gets before it does anything, and it has to be
  // survivable. What makes it survivable is not this message — it is the boot
  // line, which is `pipeline.module.secret-env.spec.ts`. What this asserts is
  // that the refusal is total and quiet, which is the deliberate half.
  it('has every authenticating connector refused until it binds a list', () => {
    expect(() => resolveSecretEnv(CONNECTOR_VAR)).toThrow(/No credential is available/);
  });

  // The migration, in one line: the union of the names already shown on the
  // connector cards.
  it('works again the moment the names its connectors already use are listed', () => {
    installSecretEnvAllowlist([CONNECTOR_VAR, 'DPAS_API_TOKEN']);
    expect(resolveSecretEnv(CONNECTOR_VAR)).toBe('postgres://fleet:pw@warehouse/fleet');
  });

  it('keeps working for a connector that needs no credential at all', () => {
    // Unchanged and deliberately so: an `inline`, `file` or role-based S3
    // connector names nothing, and a fail-closed policy that broke those would
    // be refusing a question nobody asked.
    expect(resolveSecretEnv()).toBeUndefined();
    expect(resolveSecretEnv('')).toBeUndefined();
  });

  it('restores the previous behaviour wholesale under the escape hatch', () => {
    installSecretEnvAllowlist([ALLOW_EVERY_SECRET_ENV]);
    expect(resolveSecretEnv(CONNECTOR_VAR)).toBe('postgres://fleet:pw@warehouse/fleet');
    // Including the part nobody wants, which is why it warns at every boot.
    expect(resolveSecretEnv(HOST_VAR)).toBe('postgres://app:pw@rds/app');
  });
});

/** The message a call threw, or a failure that says it did not throw at all. */
function messageFrom(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the credential to be refused, and it was resolved.');
}
