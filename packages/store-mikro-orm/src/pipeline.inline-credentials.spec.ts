import type { EntityManager } from '@mikro-orm/sql';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ConnectionRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * Whether a password may rest in this catalog's own table.
 *
 * A connection URL IS the credential — `mysql://user:pass@host/db` — and
 * `config` is served by `GET pipeline/connections` under `catalog:read`. That
 * is how this column came to hold every SQL source's password in plaintext
 * while three separate docblocks promised it never would.
 *
 * The refusal is what made the promise true. `allowInlineCredentials` is the
 * deliberate way out for a deployment that would rather type a connection
 * string than provision an environment variable, and the shape worth pinning is
 * that **it is off unless somebody said so**: a store built with no options at
 * all must refuse, because that is what every host gets who never read this.
 *
 * What the flag does NOT change is the other half. Reads are redacted either
 * way, so the password does not travel in an HTTP response; the flag decides
 * only whether it may be written down here.
 */

/** Enough EntityManager for `saveConnection` to reach the refusal and no further. */
function em(existing?: ConnectionRow): EntityManager {
  const fork = {
    findOne: () => Promise.resolve(existing),
    create: () => {
      throw new Error('The refusal should have fired before anything was created.');
    },
    persistAndFlush: () => {
      throw new Error('The refusal should have fired before anything was written.');
    },
    // The update path persists an existing row rather than creating one, so the
    // marker has to sit on both doors — otherwise the grandfathering case fails
    // on a missing method and reads as the refusal having fired.
    persist: () => {
      throw new Error('The refusal should have fired before anything was written.');
    },
    flush: () => Promise.resolve(),
  };
  return Object.assign(Object.create(null), { fork: () => fork });
}

const WITH_PASSWORD = { url: 'mysql://api:S3cr3t@flip-dev.rds.amazonaws.com:3306/flip' };

function save(store: MySqlPipelineStore, config: Record<string, unknown>) {
  return store.saveConnection({ name: 'Fleet warehouse', kind: 'sql', config }, 'davi');
}

describe('a password inside a connection URL', () => {
  it('is refused when the deployment said nothing', async () => {
    // THE default. A host that never read the option gets the safe side, and
    // the message names the field rather than the rule — somebody hitting this
    // needs to know what to do, not what principle they violated.
    const store = new MySqlPipelineStore(em());

    await expect(save(store, WITH_PASSWORD)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is refused when the deployment explicitly said no', async () => {
    const store = new MySqlPipelineStore(em(), { allowInlineCredentials: false });

    await expect(save(store, WITH_PASSWORD)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reaches the write when the deployment allowed it', async () => {
    // The store's `create` throws with a message saying the refusal should have
    // fired first — so getting THAT error is the proof the check was passed
    // rather than skipped. Asserting "does not throw BadRequest" would also
    // pass if the method returned early for some unrelated reason.
    const store = new MySqlPipelineStore(em(), { allowInlineCredentials: true });

    await expect(save(store, WITH_PASSWORD)).rejects.toThrow(/before anything was created/);
  });

  it('lets a URL with no password through either way', async () => {
    // The refusal is about the credential, not about inline addresses. A
    // passwordless URL was always fine and must stay fine, or the flag would be
    // load-bearing for deployments that never needed it.
    const store = new MySqlPipelineStore(em());

    await expect(
      save(store, { url: 'mysql://flip-dev.rds.amazonaws.com:3306/flip' }),
    ).rejects.toThrow(/before anything was created/);
  });

  it('lets an unchanged stored password through, whatever the flag says', async () => {
    // Grandfathering, and it is what stops the refusal from bricking a row that
    // predates it: renaming a connection saved before the rule existed must not
    // require re-typing a credential the console only ever showed redacted.
    const stored = Object.assign(Object.create(ConnectionRow.prototype), {
      id: 'c1',
      name: 'Fleet warehouse',
      kind: 'sql',
      config: WITH_PASSWORD,
    });
    const store = new MySqlPipelineStore(em(stored));

    await expect(
      store.saveConnection(
        { id: 'c1', name: 'Renamed', kind: 'sql', config: WITH_PASSWORD },
        'davi',
      ),
    ).rejects.toThrow(/before anything was written/);
  });
});
