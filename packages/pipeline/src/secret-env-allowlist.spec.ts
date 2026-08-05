import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOW_EVERY_SECRET_ENV,
  SECRET_ENV_ALLOW_VAR,
  admitsSecretEnv,
  credentialUnavailable,
  describeSecretEnvAllowlist,
  installSecretEnvAllowlist,
  normaliseSecretEnvPatterns,
  secretEnvAllowlist,
  secretEnvAllowlistSource,
} from './secret-env-allowlist';

/**
 * The process is the thing under test here, so it has to be put back.
 *
 * Both halves: the installed list and the environment variable. A case that
 * left either behind would decide the next one, and the failure would look like
 * the allow-list being wrong rather than the spec being wrong.
 */
const previous = process.env[SECRET_ENV_ALLOW_VAR];

beforeEach(() => {
  installSecretEnvAllowlist(undefined);
  delete process.env[SECRET_ENV_ALLOW_VAR];
});

afterEach(() => {
  installSecretEnvAllowlist(undefined);
  if (previous === undefined) delete process.env[SECRET_ENV_ALLOW_VAR];
  else process.env[SECRET_ENV_ALLOW_VAR] = previous;
});

describe('admitsSecretEnv', () => {
  it('admits a name the list spells out', () => {
    expect(admitsSecretEnv('FLEET_DB_URL', ['FLEET_DB_URL'])).toBe(true);
  });

  // The whole attack in one assertion. A deployment that lists the two variables
  // its connectors read must not hand over the one the host application reads.
  it('refuses the host application’s own variables', () => {
    const list = ['FLEET_DB_URL', 'VENDOR_*'];
    expect(admitsSecretEnv('DATABASE_URL', list)).toBe(false);
    expect(admitsSecretEnv('REDIS_URL', list)).toBe(false);
    expect(admitsSecretEnv('AWS_SECRET_ACCESS_KEY', list)).toBe(false);
    expect(admitsSecretEnv('SMTP_PASSWORD', list)).toBe(false);
  });

  it('admits nothing at all when the list is empty', () => {
    expect(admitsSecretEnv('FLEET_DB_URL', [])).toBe(false);
  });

  it('admits a name under a prefix, and only from the front', () => {
    expect(admitsSecretEnv('VENDOR_TOKEN', ['VENDOR_*'])).toBe(true);
    expect(admitsSecretEnv('VENDOR_', ['VENDOR_*'])).toBe(true);
    // Not a suffix match, and this is the one that matters: `DPAS_VENDOR_TOKEN`
    // is a different variable set by somebody else.
    expect(admitsSecretEnv('DPAS_VENDOR_TOKEN', ['VENDOR_*'])).toBe(false);
  });

  it('reads the bare star as the whole environment', () => {
    expect(admitsSecretEnv('DATABASE_URL', [ALLOW_EVERY_SECRET_ENV])).toBe(true);
  });

  it('admits a name matched by any one entry of several', () => {
    expect(admitsSecretEnv('DPAS_API_TOKEN', ['FLEET_DB_URL', 'DPAS_*', 'VENDOR_KEY'])).toBe(true);
  });

  // Case-sensitive, matching how a POSIX environment addresses a variable. The
  // direction of the error is what matters: this can only ever be stricter than
  // the lookup, never looser, so a case trick cannot reach outside the family the
  // operator named.
  it('does not fold case', () => {
    expect(admitsSecretEnv('database_url', ['DATABASE_URL'])).toBe(false);
    expect(admitsSecretEnv('fleet_db_url', ['FLEET_*'])).toBe(false);
  });
});

describe('normaliseSecretEnvPatterns', () => {
  it('keeps an exact name, a prefix and the bare star', () => {
    expect(normaliseSecretEnvPatterns(['A_URL', 'B_*', ALLOW_EVERY_SECRET_ENV])).toEqual([
      'A_URL',
      'B_*',
      ALLOW_EVERY_SECRET_ENV,
    ]);
  });

  it('drops blanks and repeats rather than carrying them into the boot line', () => {
    expect(normaliseSecretEnvPatterns(['A_URL', '  ', 'A_URL', ' B_* '])).toEqual(['A_URL', 'B_*']);
  });

  // The refusal that keeps the grammar worth having. `*_URL` reads like a tidy
  // way to admit connection strings and it admits DATABASE_URL — an infix star
  // can only ever widen in a direction the operator was not looking.
  it('refuses a star anywhere but the end, naming the entry and why', () => {
    expect(() => normaliseSecretEnvPatterns(['*_URL'])).toThrow(/"\*_URL"/);
    expect(() => normaliseSecretEnvPatterns(['*_URL'])).toThrow(/DATABASE_URL/);
    expect(() => normaliseSecretEnvPatterns(['FLEET*URL'])).toThrow(/FLEET\*URL/);
    expect(() => normaliseSecretEnvPatterns(['FLEET_**'])).toThrow(/FLEET_\*\*/);
  });

  // Throwing rather than dropping. A pattern nobody can interpret is a sentence
  // about which credentials may be read, and both ways of guessing at it — drop
  // it and cause an outage, keep it and open a hole — are worse than refusing.
  it('refuses rather than silently skipping the entry it cannot read', () => {
    expect(() => normaliseSecretEnvPatterns(['FLEET_DB_URL', '*_URL'])).toThrow();
  });
});

describe('the policy in force', () => {
  it('is nothing at all when neither lever has been used', () => {
    expect(secretEnvAllowlist()).toEqual([]);
    expect(secretEnvAllowlistSource()).toBe('nothing');
  });

  it('reads the operator’s variable, comma- or whitespace-separated', () => {
    process.env[SECRET_ENV_ALLOW_VAR] = 'FLEET_DB_URL, VENDOR_*';
    expect(secretEnvAllowlist()).toEqual(['FLEET_DB_URL', 'VENDOR_*']);
    expect(secretEnvAllowlistSource()).toBe('environment');

    // A manifest, a `.env` file and a shell export each have a different idea of
    // the natural separator, and a policy that silently admitted nothing because
    // somebody used spaces is the worst available failure of a list like this.
    process.env[SECRET_ENV_ALLOW_VAR] = 'FLEET_DB_URL VENDOR_*';
    expect(secretEnvAllowlist()).toEqual(['FLEET_DB_URL', 'VENDOR_*']);
  });

  it('lets the host’s list win over the operator’s variable', () => {
    process.env[SECRET_ENV_ALLOW_VAR] = 'FROM_THE_ENVIRONMENT';
    installSecretEnvAllowlist(['FROM_THE_MODULE']);
    expect(secretEnvAllowlist()).toEqual(['FROM_THE_MODULE']);
    expect(secretEnvAllowlistSource()).toBe('module');
  });

  // An installed empty list is a host saying "nothing on this deployment reads a
  // credential", which is a real statement. Falling through to the environment
  // there would let a variable somebody set years ago quietly overrule it.
  it('treats an installed empty list as a statement, not as absence', () => {
    process.env[SECRET_ENV_ALLOW_VAR] = 'FROM_THE_ENVIRONMENT';
    installSecretEnvAllowlist([]);
    expect(secretEnvAllowlist()).toEqual([]);
    expect(secretEnvAllowlistSource()).toBe('module');
  });

  it('is read on every call, so a host that sets the variable late is still heard', () => {
    expect(secretEnvAllowlist()).toEqual([]);
    process.env[SECRET_ENV_ALLOW_VAR] = 'LATE_URL';
    expect(secretEnvAllowlist()).toEqual(['LATE_URL']);
  });

  it('refuses a malformed pattern at the moment it is installed', () => {
    expect(() => installSecretEnvAllowlist(['*_URL'])).toThrow(/\*_URL/);
  });
});

describe('credentialUnavailable', () => {
  it('repeats the name the caller supplied', () => {
    expect(credentialUnavailable('DATABASE_URL')).toContain('DATABASE_URL');
  });

  // The mechanism, stated as a test. Not "the sentence avoids these words" —
  // that is a spelling check, and it passes by luck the day somebody rewords it.
  // The property is that the sentence is a pure function of the name: it cannot
  // vary with the environment because it never reads one.
  it('is a pure function of the name, so nothing about the environment can reach it', () => {
    const name = 'CATALOG_SPEC_ORACLE';
    const before = credentialUnavailable(name);

    process.env[name] = 'now it exists';
    installSecretEnvAllowlist([name]);
    const admittedAndSet = credentialUnavailable(name);

    delete process.env[name];
    installSecretEnvAllowlist([]);
    const refused = credentialUnavailable(name);

    expect(admittedAndSet).toBe(before);
    expect(refused).toBe(before);
  });

  // It does say that there are two reasons and that it will not name which,
  // which is the difference between a message that is quiet and one that is
  // simply unhelpful.
  it('says outright that it is refusing to say which', () => {
    expect(credentialUnavailable('X')).toMatch(/indistinguishable/i);
  });

  it('sends the person who can act to the log', () => {
    expect(credentialUnavailable('X')).toContain('CatalogSecretEnv');
  });
});

describe('describeSecretEnvAllowlist', () => {
  // The line that makes a fail-closed default survivable. Without it, the first
  // anybody hears of the upgrade is a run at 03:00 being told — correctly — that
  // it may not say why it failed.
  it('warns when nothing is in force, and names both levers and the consequence', () => {
    const { level, message } = describeSecretEnvAllowlist([], 'nothing');

    expect(level).toBe('warn');
    expect(message).toContain('secretEnvAllowlist');
    expect(message).toContain(SECRET_ENV_ALLOW_VAR);
    expect(message).toContain('refused');
    // Where to find the list to write. The union of what is already on screen IS
    // the migration, and an operator who does not know that has to go and read a
    // changeset to recover their own deployment.
    expect(message).toContain('Credential env var');
  });

  it('warns about the escape hatch every time, and says what it costs', () => {
    const { level, message } = describeSecretEnvAllowlist([ALLOW_EVERY_SECRET_ENV], 'environment');

    expect(level).toBe('warn');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('catalog:write');
  });

  // Named rather than counted, for the same reason its sibling gives: the
  // question this answers on the morning after a deploy is "did my entry take?",
  // and a number cannot answer it.
  it('names the admitted variables when a real policy is in force', () => {
    const { level, message } = describeSecretEnvAllowlist(['FLEET_DB_URL', 'VENDOR_*'], 'module');

    expect(level).toBe('log');
    expect(message).toContain('FLEET_DB_URL');
    expect(message).toContain('VENDOR_*');
  });

  // Setting the variable and seeing nothing change is otherwise an hour of
  // somebody's afternoon.
  it('says which lever the policy came from, and that the module one wins', () => {
    expect(describeSecretEnvAllowlist(['A'], 'module').message).toMatch(
      /takes precedence over CATALOG_SECRET_ENV_ALLOW/,
    );
    expect(describeSecretEnvAllowlist(['A'], 'environment').message).toContain(
      SECRET_ENV_ALLOW_VAR,
    );
  });
});
