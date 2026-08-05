import type {
  CatalogSecretVault,
  SealedSecret,
  SecretContext,
  WorkflowEdge,
  WorkflowNode,
} from '@dudousxd/nestjs-catalog';
import { SecretOpenFailedError, isSealedSecret } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ConnectionRow, ConnectorRow, WorkflowRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * Encrypting the credential that has to rest in the catalog's own tables.
 *
 * The redaction stopped a password travelling in an HTTP response and the
 * refusal stopped a new one being written. Neither does anything for the reader
 * this is about: a dump, a read replica, a backup, or anybody holding `SELECT`
 * on the instance. For them, `config` was a list of every password the catalog
 * knew.
 *
 * Two assertions here matter more than the rest, and they are the two a
 * plausible-looking implementation gets wrong: that the plaintext genuinely
 * cannot reach the column, and that a value survives the round trip out through
 * a vault and back. An implementation that sealed on the way in and forgot to
 * open on the way out passes every "is it encrypted" test and breaks every
 * connector.
 */

const PASSWORD = 'S3cr3tPassw0rd';
const URL_WITH_PASSWORD = `mysql://api:${PASSWORD}@flip-dev.rds.amazonaws.com:3306/flip`;

/**
 * A vault that is reversible on purpose, and not by base64 alone.
 *
 * The ciphertext is the reversed plaintext, encoded — so a test can assert the
 * password does not appear in the stored column *as a substring*, which a plain
 * base64 fake would make a weaker claim about than it looks.
 */
class FakeVault implements CatalogSecretVault {
  readonly seals: SecretContext[] = [];
  readonly opens: SecretContext[] = [];

  constructor(
    readonly name = 'fake',
    private readonly keyId = 'key-1',
  ) {}

  seal(plaintext: string, context: SecretContext): Promise<SealedSecret> {
    this.seals.push(context);
    return Promise.resolve({
      vault: this.name,
      keyId: this.keyId,
      ciphertext: Buffer.from([...plaintext].reverse().join(''), 'utf8').toString('base64'),
    });
  }

  open(sealed: SealedSecret, context: SecretContext): Promise<string> {
    this.opens.push(context);
    return Promise.resolve(
      [...Buffer.from(sealed.ciphertext, 'base64').toString('utf8')].reverse().join(''),
    );
  }
}

/**
 * A vault that fails and says whether waiting would help — what both shipped
 * providers do, classified from what the vault actually returned.
 */
class ClassifyingVault implements CatalogSecretVault {
  constructor(
    readonly name = 'fake',
    private readonly retryable = false,
  ) {}

  seal(): Promise<SealedSecret> {
    return Promise.reject(this.error());
  }

  open(): Promise<string> {
    return Promise.reject(this.error());
  }

  private error(): Error {
    // A provider's own error type, carrying its own `retryable`. Deliberately
    // NOT one of this library's classes: a provider is a separate package and
    // must not have to import from here to be understood.
    return Object.assign(new Error('kms: AccessDeniedException'), { retryable: this.retryable });
  }
}

/** A vault that is bound, reachable, and fails — the outage case. */
class BrokenVault implements CatalogSecretVault {
  constructor(
    readonly name = 'fake',
    private readonly why = 'kms: ThrottlingException',
  ) {}

  seal(): Promise<SealedSecret> {
    return Promise.reject(new Error(this.why));
  }

  open(): Promise<string> {
    return Promise.reject(new Error(this.why));
  }
}

interface Seed {
  connections?: Array<Record<string, unknown>>;
  connectors?: Array<Record<string, unknown>>;
  workflows?: Array<Record<string, unknown>>;
}

/**
 * Enough EntityManager to write a row and read it back.
 *
 * In-memory rather than mocked call-by-call, because the claim under test is
 * about *what lands in the column* — a spy on `persist` would only prove the
 * store called it. {@link Db.stored} is what the assertions read, and it is the
 * same object the store mutated.
 */
class Db {
  readonly tables = new Map<unknown, Map<string, Record<string, unknown>>>();

  constructor(seed: Seed = {}) {
    this.seedInto(ConnectionRow, seed.connections);
    this.seedInto(ConnectorRow, seed.connectors);
    this.seedInto(WorkflowRow, seed.workflows);
  }

  private seedInto(entity: unknown, rows: Array<Record<string, unknown>> | undefined): void {
    const table = this.table(entity);
    for (const row of rows ?? []) {
      const id = row.id;
      if (typeof id === 'string') table.set(id, row);
    }
  }

  table(entity: unknown): Map<string, Record<string, unknown>> {
    const existing = this.tables.get(entity);
    if (existing) return existing;
    const created = new Map<string, Record<string, unknown>>();
    this.tables.set(entity, created);
    return created;
  }

  /** The one row of this kind, which every test here writes exactly one of. */
  stored(entity: unknown): Record<string, unknown> {
    const rows = [...this.table(entity).values()];
    if (rows.length !== 1) {
      throw new Error(`Expected exactly one stored row, found ${rows.length}.`);
    }
    return rows[0];
  }

  get em(): EntityManager {
    const fork = {
      findOne: (entity: unknown, where: { id?: string }) =>
        Promise.resolve(
          typeof where.id === 'string' ? (this.table(entity).get(where.id) ?? null) : null,
        ),
      find: (entity: unknown) => Promise.resolve([...this.table(entity).values()]),
      create: (entity: unknown, data: Record<string, unknown>) => {
        const row = { ...data };
        this.pending.push([entity, row]);
        return row;
      },
      persist: (row: Record<string, unknown>) => {
        this.persisted.push(row);
      },
      flush: () => {
        for (const [entity, row] of this.pending) {
          const id = row.id;
          if (typeof id === 'string') this.table(entity).set(id, row);
        }
        this.pending = [];
        return Promise.resolve();
      },
      nativeUpdate: () => Promise.resolve(1),
      nativeDelete: () => Promise.resolve(1),
    };
    // The same shape `pipeline.inline-credentials.spec.ts` uses to satisfy this
    // parameter without asserting a type onto a partial object.
    return Object.assign(Object.create(null), { fork: () => fork });
  }

  private pending: Array<[unknown, Record<string, unknown>]> = [];
  readonly persisted: Array<Record<string, unknown>> = [];
}

function connectionInput(config: Record<string, unknown>, id?: string) {
  return { id, name: 'Fleet warehouse', kind: 'sql' as const, config };
}

/** A `catalog_connection` row already holding a sealed credential. */
function storedConnection(url: unknown, id = 'c1'): Record<string, unknown> {
  return {
    id,
    name: 'Fleet warehouse',
    kind: 'sql',
    config: { url },
    createdBy: 'davi',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** A minimal graph that validates: one source into one sink. */
function graph(sourceConfig: Record<string, unknown>): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  return {
    nodes: [
      { id: 's1', name: 'Warehouse', kind: 'source', sourceKind: 'sql', config: sourceConfig },
      { id: 'k1', name: 'Commit', kind: 'sink', targetType: 'Mvr' },
    ],
    edges: [{ from: 's1', to: 'k1' }],
  };
}

describe('a credential on the way into the column', () => {
  it('is sealed, and the password is nowhere in the row', async () => {
    // The assertion this whole change exists for. Not "config.url is an object"
    // — that would pass for an implementation that stored `{...}` and lost the
    // credential — but that the value is a SealedSecret AND the password does
    // not appear anywhere in what was written.
    const db = new Db();
    const vault = new FakeVault();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);

    await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi');

    const row = db.stored(ConnectionRow);
    expect(isSealedSecret(Reflect.get(Object(row.config), 'url'))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it('comes back out as the password again', async () => {
    // The half an "is it encrypted" test cannot see. A store that seals and
    // never opens passes every assertion above and hands `fetchSql` an object
    // it stringifies to "[object Object]".
    const db = new Db();
    const vault = new FakeVault();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);

    const saved = await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi');
    const read = await store.getConnection(saved.id);

    expect(read?.config.url).toBe(URL_WITH_PASSWORD);
    // And through the list route as well, which is what the console reads and
    // what `applyPromotion` copies between environments.
    expect((await store.listConnections())[0]?.config.url).toBe(URL_WITH_PASSWORD);
  });

  it('leaves the address and options alone', async () => {
    // Selective, not the whole config object. Sealing everything would make
    // `config.query` unreadable to every query that legitimately needs it, and
    // would blind the plaintext refusal — which needs a string to inspect.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, new FakeVault());

    await store.saveConnection(
      connectionInput({ url: URL_WITH_PASSWORD, schema: 'public', query: 'SELECT 1' }),
      'davi',
    );

    const config = Object(db.stored(ConnectionRow).config);
    expect(Reflect.get(config, 'schema')).toBe('public');
    expect(Reflect.get(config, 'query')).toBe('SELECT 1');
  });

  it('touches no vault when there is no credential to seal', async () => {
    // A passwordless URL is not a secret, and a deployment whose connections
    // all name an env var should never pay a KMS call to find that out.
    const db = new Db();
    const vault = new FakeVault();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);

    await store.saveConnection(
      connectionInput({ url: 'mysql://flip-dev.rds.amazonaws.com/flip' }),
      'davi',
    );

    expect(vault.seals).toEqual([]);
  });

  it('tells the vault which row and field it is sealing', async () => {
    // The context is the reason this seam carries more than bytes: it is what a
    // KMS provider puts in an encryption context and a Vault provider writes an
    // audit line from.
    const db = new Db();
    const vault = new FakeVault();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);

    await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }, 'c1'), 'davi');

    expect(vault.seals).toEqual([{ kind: 'connection', id: 'c1', field: 'url' }]);
  });

  it('names the row even on a first save, so a provider can bind the id', async () => {
    // The property the seam claimed and could not deliver. `id` used to be
    // minted inside `em.create`, AFTER sealing, so a create sealed with `id:
    // undefined` and the next update opened with `id: 'c1'` — which is why both
    // shipped providers left `id` out of their encryption context. The id is
    // hoisted above the seal now, and it has to be the id the row is actually
    // written under, not merely some id.
    const db = new Db();
    const vault = new FakeVault();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);

    const saved = await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi');

    expect(vault.seals[0]?.id).toBe(saved.id);
    expect(db.stored(ConnectionRow).id).toBe(saved.id);
  });

  it('names the same row on the update that follows', async () => {
    // The half that makes it a binding rather than a label: seal-time context
    // on create and on update have to agree, or a provider that binds `id`
    // strands the row it just wrote.
    const db = new Db();
    const vault = new FakeVault();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);

    const saved = await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi');
    await store.saveConnection(
      connectionInput({ url: `${URL_WITH_PASSWORD}?ssl=true` }, saved.id),
      'davi',
    );

    expect(vault.seals.map((context) => context.id)).toEqual([saved.id, saved.id]);
  });

  it('does not seal a value that is already sealed', async () => {
    // Reached by a promotion carrying one across, or a host writing through the
    // store directly. Sealing it again would need to open it first, and nesting
    // one inside another produces a value nothing can read.
    const db = new Db();
    const vault = new FakeVault();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);
    const sealed = await vault.seal(URL_WITH_PASSWORD, { kind: 'connection', field: 'url' });

    await store.saveConnection(connectionInput({ url: sealed }), 'davi');

    expect(vault.seals).toHaveLength(1); // the one made by the test itself
    expect(db.stored(ConnectionRow).config).toEqual({ url: sealed });
  });
});

describe('the two flags, and the three things they can mean', () => {
  it('seals rather than refusing, with the refusal still on', async () => {
    // The combination a production deployment wants, and the one an obvious
    // implementation gets wrong. Read separately the two flags look
    // contradictory — "refuse inline credentials" and "encrypt inline
    // credentials" — and an implementation that asks the refusal BEFORE sealing
    // turns `encryptCredentials: true` into a configuration that refuses
    // everything and therefore encrypts nothing.
    const db = new Db();
    const store = new MySqlPipelineStore(
      db.em,
      { encryptCredentials: true, allowInlineCredentials: false },
      new FakeVault(),
    );

    const saved = await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi');

    expect(saved.config.url).toBe(URL_WITH_PASSWORD);
    expect(isSealedSecret(Reflect.get(Object(db.stored(ConnectionRow).config), 'url'))).toBe(true);
  });

  it('still refuses when nothing is being encrypted', async () => {
    // Unchanged behaviour, and the default. Encryption is what makes a
    // credential acceptable; without it the refusal is the whole protection.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: false }, new FakeVault());

    await expect(
      store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps sealed rows readable after encryption is turned back off', async () => {
    // The flag gates writes only. A flag that also gated decryption would make
    // turning it off a data-loss button, and a host would discover that as
    // every connector failing at once.
    const vault = new FakeVault();
    const sealed = await vault.seal(URL_WITH_PASSWORD, { kind: 'connection', field: 'url' });
    const db = new Db({ connections: [storedConnection(sealed)] });
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: false }, vault);

    expect((await store.getConnection('c1'))?.config.url).toBe(URL_WITH_PASSWORD);
  });

  it('answers a save with the plaintext, never the ciphertext it just wrote', async () => {
    // What the console gets back from a save. Answering with the SealedSecret
    // would render a blob where a URL belongs, and — worse — the round trip
    // would post it back as the value on the next edit.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, new FakeVault());

    const saved = await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi');

    expect(saved.config.url).toBe(URL_WITH_PASSWORD);
  });
});

describe('a vault that cannot be reached', () => {
  it('fails the save, and writes nothing at all', async () => {
    // The fallback that must not exist: store the plaintext and log a warning.
    // A deployment that did that during an outage would have no way afterwards
    // to find out which credentials went in clear.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, new BrokenVault());

    await expect(
      store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi'),
    ).rejects.toThrow(/could not be sealed/);
    expect(db.table(ConnectionRow).size).toBe(0);
  });

  it('refuses the save when no vault was bound, naming the token', async () => {
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true });

    await expect(
      store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }), 'davi'),
    ).rejects.toThrow(/CATALOG_SECRET_VAULT/);
    expect(db.table(ConnectionRow).size).toBe(0);
  });

  it('fails a read as retryable, and NOT as anything the run step calls fatal', async () => {
    // The sharp one. `ConnectorRunSteps.runConnector` catches exactly
    // `NotFoundException` and `BadRequestException` around the runner and
    // converts them into `UnavailableConnectorError`, which carries
    // `retryable = false`. A vault timeout thrown as a BadRequestException
    // would therefore never be retried — for a failure that is the textbook
    // case that step's three attempts over fifteen minutes exist for — and
    // would be filed under `connector_unavailable`, sending an operator to look
    // for a connector nobody deleted.
    const vault = new FakeVault();
    const sealed = await vault.seal(URL_WITH_PASSWORD, { kind: 'connection', field: 'url' });
    const db = new Db({ connections: [storedConnection(sealed)] });
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, new BrokenVault());

    const error = await store.getConnection('c1').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SecretOpenFailedError);
    expect(error).toMatchObject({ retryable: true });
    expect(error).not.toBeInstanceOf(BadRequestException);
    expect(error).not.toBeInstanceOf(NotFoundException);
  });

  it('reports a row sealed by a vault nobody bound as one no retry can fix', async () => {
    // The other direction. Waiting cannot help: it is the binding that is
    // wrong, and the message has to name the vault the row is asking for
    // because that is the only actionable fact.
    const other = new FakeVault('kms-eu');
    const sealed = await other.seal(URL_WITH_PASSWORD, { kind: 'connection', field: 'url' });
    const db = new Db({ connections: [storedConnection(sealed)] });
    const store = new MySqlPipelineStore(db.em, {}, new FakeVault('kms-us'));

    const error = await store.getConnection('c1').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SecretOpenFailedError);
    expect(error).toMatchObject({ retryable: false });
    expect(String(error)).toContain('kms-eu');
  });

  it("honours the vault's own verdict that waiting cannot help", async () => {
    // Only the vault can tell an AccessDeniedException from a throttle. Both
    // providers classify that and put `retryable` on their own error; without
    // this the knowledge stopped at the provider boundary and a key policy
    // nobody was going to change burned three attempts over fifteen minutes.
    const sealer = new FakeVault();
    const sealed = await sealer.seal(URL_WITH_PASSWORD, { kind: 'connection', field: 'url' });
    const db = new Db({ connections: [storedConnection(sealed)] });
    const store = new MySqlPipelineStore(db.em, {}, new ClassifyingVault('fake', false));

    const error = await store.getConnection('c1').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SecretOpenFailedError);
    expect(error).toMatchObject({ retryable: false });
  });

  it('treats a vault that did not say as retryable', async () => {
    // "Did not say" must read as retryable — the same rule the durable engine
    // applies one layer up (`error?.retryable !== false`), so the two agree by
    // construction rather than by coincidence.
    const sealer = new FakeVault();
    const sealed = await sealer.seal(URL_WITH_PASSWORD, { kind: 'connection', field: 'url' });
    const db = new Db({ connections: [storedConnection(sealed)] });
    const store = new MySqlPipelineStore(db.em, {}, new ClassifyingVault('fake', true));

    const error = await store.getConnection('c1').catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ retryable: true });
  });

  it('opens with whichever bound vault sealed it', async () => {
    // What makes a rotation possible without an outage: bind the next vault
    // first and the current one alongside, and every row stays readable while
    // saves move over.
    const current = new FakeVault('kms-us');
    const next = new FakeVault('kms-eu', 'key-2');
    const sealed = await current.seal(URL_WITH_PASSWORD, { kind: 'connection', field: 'url' });
    const db = new Db({ connections: [storedConnection(sealed)] });
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, [next, current]);

    expect((await store.getConnection('c1'))?.config.url).toBe(URL_WITH_PASSWORD);

    // And a save reseals under the FIRST, which is how the rotation finishes.
    await store.saveConnection(connectionInput({ url: URL_WITH_PASSWORD }, 'c1'), 'davi');
    expect(Reflect.get(Object(db.stored(ConnectionRow).config), 'url')).toMatchObject({
      vault: 'kms-eu',
    });
  });
});

describe('a credential inside a workflow source node', () => {
  it('is refused, exactly as one on a connector is', async () => {
    // The gap: `saveWorkflow` wrote `nodes` verbatim and asked nothing, while
    // `WorkflowSourceNode` promised "credentials stay out of the catalog here
    // exactly as they do everywhere else". `workflow-runner.service.ts` spreads
    // `node.config` into a synthesised connector, so `fetchSql` reads
    // `config.url` from here just as it does from a connector's.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em);

    await expect(
      store.saveWorkflow({ name: 'Fleet load', ...graph({ url: URL_WITH_PASSWORD }) }, 'davi'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.table(WorkflowRow).size).toBe(0);
  });

  it('names the node, not just the graph', async () => {
    // A graph has six boxes on a canvas and `config.url` names none of them.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em);

    await expect(
      store.saveWorkflow({ name: 'Fleet load', ...graph({ url: URL_WITH_PASSWORD }) }, 'davi'),
    ).rejects.toThrow(/nodes\["s1"\]\.config\.url/);
  });

  it('is sealed when this deployment encrypts, and the password leaves no trace', async () => {
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, new FakeVault());

    const saved = await store.saveWorkflow(
      { name: 'Fleet load', ...graph({ url: URL_WITH_PASSWORD }) },
      'davi',
    );

    expect(JSON.stringify(db.stored(WorkflowRow))).not.toContain(PASSWORD);
    // And the graph comes back drawable — the canvas gets what it posted.
    const source = saved.nodes.find((node) => node.kind === 'source');
    expect(source?.kind === 'source' && source.config.url).toBe(URL_WITH_PASSWORD);
    const read = await store.getWorkflow(saved.id);
    const readSource = read?.nodes.find((node) => node.kind === 'source');
    expect(readSource?.kind === 'source' && readSource.config.url).toBe(URL_WITH_PASSWORD);
  });

  it('does not bump the version because a ciphertext changed', async () => {
    // The fingerprint is a statement about what the graph DOES. Hashing the
    // sealed form would make every save a new version under any vault whose
    // ciphertext is not deterministic, which is every vault worth using.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { encryptCredentials: true }, new FakeVault());

    const first = await store.saveWorkflow(
      { name: 'Fleet load', ...graph({ url: URL_WITH_PASSWORD }) },
      'davi',
    );
    const second = await store.saveWorkflow(
      { id: first.id, name: 'Fleet load', ...graph({ url: URL_WITH_PASSWORD }) },
      'davi',
    );

    expect(second.version).toBe(first.version);
    expect(second.graphHash).toBe(first.graphHash);
  });

  it('grandfathers what is already stored, per node', async () => {
    // A graph is one JSON column, so comparing it as a whole would refuse a
    // rename over a credential nobody touched — the exact failure the
    // connector-level grandfathering was written to avoid. The identity has to
    // be the node id.
    const db = new Db({
      workflows: [
        {
          id: 'w1',
          name: 'Fleet load',
          nodes: graph({ url: URL_WITH_PASSWORD }).nodes,
          edges: graph({}).edges,
          version: 1,
          graphHash: 'stale',
          targetType: 'Mvr',
          createdBy: 'davi',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const store = new MySqlPipelineStore(db.em);

    const renamed = await store.saveWorkflow(
      { id: 'w1', name: 'Fleet load (EU)', ...graph({ url: URL_WITH_PASSWORD }) },
      'davi',
    );

    expect(renamed.name).toBe('Fleet load (EU)');
  });

  it('still refuses a credential moved to a node that did not have one', async () => {
    // What per-node identity buys, stated as its opposite: the stored graph
    // holds this exact password under `s1`, and putting it on a DIFFERENT node
    // is a new credential in a new place. A whole-object comparison would have
    // waved it through.
    const stored = graph({ url: URL_WITH_PASSWORD }).nodes;
    const db = new Db({
      workflows: [
        {
          id: 'w1',
          name: 'Fleet load',
          nodes: stored,
          edges: [{ from: 's1', to: 'k1' }],
          version: 1,
          graphHash: 'stale',
          targetType: 'Mvr',
          createdBy: 'davi',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const store = new MySqlPipelineStore(db.em);

    const moved: WorkflowNode[] = [
      { id: 's1', name: 'Warehouse', kind: 'source', sourceKind: 'sql', config: {} },
      {
        id: 's2',
        name: 'Second',
        kind: 'source',
        sourceKind: 'sql',
        config: { url: URL_WITH_PASSWORD },
      },
      { id: 'k1', name: 'Commit', kind: 'sink', targetType: 'Mvr' },
    ];

    await expect(
      store.saveWorkflow(
        {
          id: 'w1',
          name: 'Fleet load',
          nodes: moved,
          edges: [
            { from: 's1', to: 'k1' },
            { from: 's2', to: 'k1' },
          ],
        },
        'davi',
      ),
    ).rejects.toThrow(/nodes\["s2"\]\.config\.url/);
  });

  it('lets a graph through when this deployment allows inline credentials', async () => {
    // The escape hatch keeps meaning the same thing for a graph as for a
    // connector — otherwise a dev environment would find half its screens
    // working.
    const db = new Db();
    const store = new MySqlPipelineStore(db.em, { allowInlineCredentials: true });

    const saved = await store.saveWorkflow(
      { name: 'Fleet load', ...graph({ url: URL_WITH_PASSWORD }) },
      'davi',
    );

    expect(saved.id).toBeTruthy();
  });
});

describe('a connector, which reads through all of the same machinery', () => {
  it('seals, opens, and refuses on the same terms a connection does', async () => {
    const db = new Db();
    const vault = new FakeVault();
    const sealing = new MySqlPipelineStore(db.em, { encryptCredentials: true }, vault);

    const saved = await sealing.saveConnector(
      {
        name: 'Fleet',
        kind: 'sql',
        targetType: 'Mvr',
        config: { url: URL_WITH_PASSWORD },
        enabled: true,
      },
      'davi',
    );

    expect(JSON.stringify(db.stored(ConnectorRow))).not.toContain(PASSWORD);
    expect((await sealing.getConnector(saved.id))?.config.url).toBe(URL_WITH_PASSWORD);
    expect(vault.seals[0]).toMatchObject({ kind: 'connector', field: 'url' });

    const refusing = new MySqlPipelineStore(new Db().em);
    await expect(
      refusing.saveConnector(
        {
          name: 'Fleet',
          kind: 'sql',
          targetType: 'Mvr',
          config: { url: URL_WITH_PASSWORD },
          enabled: true,
        },
        'davi',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
