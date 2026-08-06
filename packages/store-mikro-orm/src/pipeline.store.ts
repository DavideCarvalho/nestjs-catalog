import { randomUUID } from 'node:crypto';
import type {
  CatalogConnection,
  CatalogConnector,
  CatalogPipelineStore,
  CatalogRevision,
  CatalogSecretVault,
  CatalogStageStore,
  CatalogTransform,
  CatalogWorkflow,
  CatalogWorkflowStore,
  ConnectionCheck,
  ConnectorKind,
  ConnectorRun,
  DeleteReconciliation,
  RowCountBound,
  SealedSecret,
  SecretContext,
  StoredLoadExpectation,
  TransformLanguage,
  WorkflowEdge,
  WorkflowExecutionMode,
  WorkflowNode,
  WorkflowNodeOutcome,
  WorkflowSourceNode,
  WorkflowStatus,
} from '@dudousxd/nestjs-catalog';
import {
  CATALOG_SECRET_VAULT,
  RefusingSecretVault,
  SecretOpenFailedError,
  SecretSealFailedError,
  SecretVaultNotConfiguredError,
  emitCatalog,
  isConnectorKind,
  isSealedSecret,
  isTransformLanguage,
  isWorkflowEdge,
  isWorkflowExecutionMode,
  isWorkflowNode,
  isWorkflowStatus,
  validateWorkflow,
  workflowGraphHash,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import {
  ConnectionRow,
  ConnectorRow,
  ConnectorRunRow,
  LoadExpectationRow,
  TransformRow,
  WorkflowRow,
  WorkflowStageRow,
} from './entities/pipeline';
import { CATALOG_STORE_OPTIONS, type CatalogStoreModuleOptions } from './options';
// One revision table, so one implementation of what a revision costs. See the
// block those are declared under: a second copy of the retention rule in this
// file is how the two subjects end up keeping different amounts of history.
import { pruneRevisions, readRevisions, recordRevision } from './workspace.store';

@Injectable()
export class MySqlPipelineStore
  implements CatalogPipelineStore, CatalogWorkflowStore, CatalogStageStore
{
  private readonly logger = new Logger(MySqlPipelineStore.name);

  /**
   * Every vault this store may open with. The first is the one it seals with.
   *
   * Never empty: an empty array binding is treated as no binding at all, so a
   * host that wired one meets the refusing default's message — which names the
   * token — rather than "no vault named X", which would be true and useless.
   */
  private readonly vaults: CatalogSecretVault[];

  constructor(
    // By token, never positionally. The default connection is whichever one the
    // host registered first, and in a host with a database of its own that is
    // not this catalog's.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
    // Optional so a host that constructs this store by hand — several specs do
    // — keeps working, and an absent options object reads as every default,
    // which for this one is the refusing side.
    @Optional()
    @Inject(CATALOG_STORE_OPTIONS)
    private readonly options?: CatalogStoreModuleOptions,
    // One vault, or several. Several is what makes rotation possible without an
    // outage — seals go to the first, opens go to whichever one's `name` the
    // row carries — and the token's docblock argues it. Optional so a host that
    // binds nothing still boots and pays nothing: the refusing default is only
    // ever reached by a deployment that asked for encryption.
    @Optional()
    @Inject(CATALOG_SECRET_VAULT)
    vault?: CatalogSecretVault | CatalogSecretVault[],
  ) {
    this.vaults = toVaultList(vault);
  }

  /**
   * Seal every credential-bearing value in a config, if this deployment asked
   * for it.
   *
   * ## What counts as a credential
   *
   * The same predicate the refusal uses: a top-level string that parses as a
   * URL carrying a password. **Not** the whole `config` object, and the reason
   * is not cost — it is that encryption and redaction have to agree about what
   * a secret is, or one of them is wrong in a way nobody sees. Seal something
   * `redactConfigSecrets` does not hide and the console renders a ciphertext
   * blob where a URL belongs; hide something this does not seal and the column
   * still holds the password the docblock says it does not. One predicate, two
   * consumers, and they cannot drift because there is only one of it.
   *
   * Sealing the whole object was the first idea and it fails on its own terms.
   * `config` also holds the address, the query, the bucket, the path — and
   * `connectorsUsingConnection`, the console list, and every "which connectors
   * reach this database" question read those. It would also blind the refusal:
   * `hasUrlPassword` needs a string to inspect, so with the whole config sealed
   * there would be nothing left to check and the check would have to be
   * deleted — a security feature removed as a side effect of a security
   * feature.
   *
   * The cost of choosing is that the rule can be wrong: a token in
   * `config.headers.authorization` is not sealed. That boundary is already
   * documented, in the same words, by the redaction this borrows its predicate
   * from — top-level strings only, and headers belong in `secretEnvVar`.
   *
   * ## Order matters
   *
   * This runs BEFORE `assertNoNewPlaintextCredential`, which is the whole
   * composition of the two flags. A sealed value is an object, so the refusal
   * looks at it, sees no string, and has nothing to refuse. Reverse the two and
   * `encryptCredentials: true` with the default `allowInlineCredentials: false`
   * would refuse every credential before it could be sealed — a configuration
   * that reads as "encrypt them" and means "there is nothing to encrypt".
   */
  private async sealCredentials(
    config: Record<string, unknown>,
    kind: string,
    id: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (!this.options?.encryptCredentials) return config;
    const vault = this.vaults[0];
    const sealed: Record<string, unknown> = { ...config };
    for (const [field, value] of Object.entries(config)) {
      // Strings only, which is also what makes an already-sealed value safe
      // here without a guard of its own. A `SealedSecret` is an object, so it
      // fails this test and passes through untouched — which is the behaviour
      // wanted when a promotion copies one across or a host writes through this
      // store directly, because resealing would mean opening it first (a vault
      // read the save did not need) and nesting one inside another produces a
      // value nothing can read.
      //
      // An `isSealedSecret` check was written here first and deleted: it could
      // not change any outcome, and a guard that cannot fire reads as proof
      // something is being handled when the line below is what handles it. The
      // behaviour is pinned by a test rather than by the dead branch.
      if (typeof value !== 'string' || !hasUrlPassword(value)) continue;
      sealed[field] = await sealOne(vault, value, { kind, id, field });
    }
    return sealed;
  }

  /**
   * Put the plaintext back, for every value that came out of the column sealed.
   *
   * **Unconditional — not gated on `encryptCredentials`.** That flag decides
   * whether new writes are sealed; a host that turns it off must keep reading
   * the rows it already sealed, or the switch is a data-loss button.
   *
   * ## Why the store opens, rather than the caller that needs the plaintext
   *
   * `config-secrets.ts` argues that *redaction* belongs at the HTTP boundary
   * and not here, because the store's readers are not all screens — the runner
   * and `applyPromotion` need the real value. That argument is about hiding,
   * and it points the other way for sealing: hiding has an audience, and
   * sealing has none. `CatalogConnection.config` means the same thing before
   * and after this feature — the address and options as authored — and nothing
   * outside this file has to learn that a vault exists.
   *
   * The alternative, handing sealed values out and making each caller open
   * them, fails concretely in two places and neither is theoretical:
   *
   *  - `fetchSql` reads `String(connector.config.url ?? '')`. Given a
   *    `SealedSecret` that is `"[object Object]"`, and the connector dials a
   *    garbage address and reports a connection error. The failure names the
   *    source, not the seal.
   *  - The console round trip breaks in the worst available way.
   *    `restoreRedactedSecrets` decides "unchanged" by comparing the incoming
   *    value against `redact(stored)`. If `stored` were sealed, `redact` sees a
   *    non-string, skips it, the comparison fails — and the literal string
   *    `REDACTED` is saved over the credential. The read path serving ciphertext
   *    to a console that then writes it back as the value is exactly the shape
   *    of accident this borrowed its predicate to avoid.
   *
   * Because the store opens, the read path still holds a real password, so the
   * redaction still has something to redact and is left untouched. The two
   * defend different attackers: redaction defends against `catalog:read` over
   * HTTP, sealing defends against `SELECT` on the database. Dropping either
   * because the other exists gives that attacker the password back.
   *
   * ## The cost, stated
   *
   * A vault round trip per sealed value per read, including list reads that
   * redact away what they just opened. The fast path below means a deployment
   * that never turned sealing on, and any config with no credential in it,
   * pays nothing at all. If the rest ever bites, the fix is a short-TTL cache
   * inside the provider — where the host's own KMS client already has one —
   * and not a store that opens on some reads and not others, which would hand
   * back two different configs for the same row depending on which method
   * asked.
   */
  private async openCredentials(
    config: Record<string, unknown>,
    kind: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    // Checked before anything is allocated or awaited. Every config that holds
    // no sealed value — which is all of them, for a host that never turned this
    // on — leaves here having touched no vault and copied no object.
    if (!Object.values(config).some(isSealedSecret)) return config;
    const opened: Record<string, unknown> = { ...config };
    for (const [field, value] of Object.entries(config)) {
      if (!isSealedSecret(value)) continue;
      opened[field] = await this.openSealed(value, { kind, id, field });
    }
    return opened;
  }

  /**
   * One sealed value, through the vault that sealed it.
   *
   * Dispatched by `sealed.vault` and never by "the one that is bound", because
   * handing a ciphertext to the wrong provider gets either an unhelpful decrypt
   * error attributed to the wrong system or, with a symmetric cipher and a
   * shared key, a plausible-looking wrong answer. The refusal names the vault
   * the row wants, which is the only thing an operator can act on.
   */
  private async openSealed(sealed: SealedSecret, context: SecretContext): Promise<string> {
    const vault = this.vaults.find((candidate) => candidate.name === sealed.vault);
    if (!vault) {
      throw new SecretOpenFailedError(
        `${context.kind}.config.${context.field} on ${context.id} was sealed by the "${sealed.vault}" vault, and the vaults bound here are ${this.vaults
          .map((candidate) => `"${candidate.name}"`)
          .join(
            ', ',
          )}. Bind that provider alongside the current one — CATALOG_SECRET_VAULT takes an array so both can be readable during a rotation.`,
        // Waiting cannot help: the binding is what is wrong, and it will be
        // just as wrong on the third attempt fifteen minutes from now.
        { retryable: false },
      );
    }
    try {
      return await vault.open(sealed, context);
    } catch (error) {
      throw new SecretOpenFailedError(
        `${context.kind}.config.${context.field} on ${context.id} could not be opened by the "${sealed.vault}" vault: ${describeCause(error)}`,
        // Retryable unless the vault said the problem is permanent. A vault
        // that timed out is the same failure as a source that timed out, which
        // is what the connector step's three attempts over fifteen minutes are
        // for. See SecretOpenFailedError, which explains why this must not
        // reach that step as a BadRequestException.
        { retryable: !isPermanent(error), cause: error },
      );
    }
  }

  /**
   * One connector or connection, with its config opened.
   *
   * Generic over the two rather than written twice, because the thing that must
   * not diverge is *which reads open* — a read that forgot to would hand a
   * `SealedSecret` to a caller expecting a string, and the two shapes only
   * differ once somebody stringifies one.
   */
  private async withOpenConfig<T extends { id: string; config: Record<string, unknown> }>(
    entity: T,
    kind: string,
  ): Promise<T> {
    const config = await this.openCredentials(entity.config, kind, entity.id);
    // Identity-compared rather than always copied: `openCredentials` returns the
    // same object when there was nothing sealed, and allocating a new entity per
    // row on every list read of every deployment that never turned this on is a
    // cost for nobody.
    return config === entity.config ? entity : { ...entity, config };
  }

  /**
   * Sequentially, not with `Promise.all`.
   *
   * A list read of a hundred connectors would otherwise open a hundred
   * ciphertexts at once, and the receiving end of that is a KMS account-level
   * request rate that answers a burst with a throttling error — turning a page
   * load into a failure that looks like the vault is broken. Slower and
   * finishes is the right trade for a path that is already a database round
   * trip, and the fast path above means the loop is free whenever nothing on
   * the page is sealed.
   */
  private async withOpenConfigs<T extends { id: string; config: Record<string, unknown> }>(
    entities: T[],
    kind: string,
  ): Promise<T[]> {
    const opened: T[] = [];
    for (const entity of entities) opened.push(await this.withOpenConfig(entity, kind));
    return opened;
  }

  /**
   * Seal the credential in every config-carrying node of a graph.
   *
   * Per node rather than over the graph as a whole, because a `SecretContext`
   * describes one field of one row and a graph is one row holding several
   * configs. The context is `{ kind: 'workflow', id: workflowId, field }`: two
   * source nodes that both use `url` therefore seal under the same context,
   * which is correct — they are the same field of the same row, and a provider
   * scoping by it is scoping to the graph, which is the thing a key should be
   * bound to.
   *
   * A **call** node's config takes the same path as a source's, and that is why
   * the field carries the same name. It is a parameter bag that leaves this
   * process — handed to a workflow that may be dispatched to a worker in
   * another language — which is exactly the shape a credential ends up in when
   * nobody stops it. The predicate is untouched: top-level strings, as
   * everywhere else in this file.
   */
  private async sealNodeConfigs(
    nodes: WorkflowNode[],
    id: string | undefined,
  ): Promise<WorkflowNode[]> {
    // Returns the same array when nothing is sealed, so a deployment that never
    // turned this on writes the array it was handed rather than a copy of it.
    if (!this.options?.encryptCredentials) return nodes;
    const sealed: WorkflowNode[] = [];
    for (const node of nodes) {
      if (!carriesConfig(node)) {
        sealed.push(node);
        continue;
      }
      sealed.push({ ...node, config: await this.sealCredentials(node.config, 'workflow', id) });
    }
    return sealed;
  }

  /** One graph, with every config-carrying node's config opened. */
  private async withOpenGraph(workflow: CatalogWorkflow): Promise<CatalogWorkflow> {
    let opened = false;
    const nodes: WorkflowNode[] = [];
    for (const node of workflow.nodes) {
      if (!carriesConfig(node)) {
        nodes.push(node);
        continue;
      }
      const config = await this.openCredentials(node.config, 'workflow', workflow.id);
      if (config === node.config) {
        nodes.push(node);
        continue;
      }
      opened = true;
      nodes.push({ ...node, config });
    }
    return opened ? { ...workflow, nodes } : workflow;
  }

  /** Sequentially, for the reason {@link withOpenConfigs} gives. */
  private async withOpenGraphs(workflows: CatalogWorkflow[]): Promise<CatalogWorkflow[]> {
    const opened: CatalogWorkflow[] = [];
    for (const workflow of workflows) opened.push(await this.withOpenGraph(workflow));
    return opened;
  }

  /** The refusal, applied to a graph. Off when `allowInlineCredentials` is on. */
  private assertNoNewPlaintextGraphCredential(
    nodes: WorkflowNode[],
    stored: unknown[] | undefined,
    subject: string,
  ): void {
    if (this.options?.allowInlineCredentials) return;
    assertNoNewPlaintextGraphCredential(nodes, stored, subject);
  }

  /**
   * The refusal, unless this deployment said otherwise.
   *
   * The check itself is the free function below; this only decides whether to
   * ask it. Kept as a method rather than threading the flag through every call
   * site because the flag is a property of the STORE — of which database these
   * rows land in — and not of any one save.
   *
   * `allowInlineCredentials` turns it off, and its docblock argues the trade.
   * Note what stays on either way: reads are redacted, so the password never
   * travels in an HTTP response. This flag decides only whether it may rest in
   * the catalog's own table.
   *
   * `encryptCredentials` also turns it off, and by a different route worth
   * being precise about: it does not skip the check, it removes the thing the
   * check looks for. Every caller below seals first and passes the SEALED
   * config here, so a credential arrives as an object and `hasUrlPassword`
   * never sees a string to object to. That ordering is what stops the two flags
   * from having a fourth, meaningless state — see `CatalogStoreModuleOptions`.
   */
  private assertNoNewPlaintextCredential(
    incoming: Record<string, unknown> | undefined,
    stored: Record<string, unknown> | undefined,
    subject: string,
  ): void {
    if (this.options?.allowInlineCredentials) return;
    assertNoNewPlaintextCredential(incoming, stored, subject);
  }

  async listConnectors(): Promise<CatalogConnector[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRow, {}, { orderBy: { name: 'asc' } });
    return this.withOpenConfigs(rows.map(toConnector), 'connector');
  }

  async getConnector(id: string): Promise<CatalogConnector | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ConnectorRow, { id });
    return row ? this.withOpenConfig(toConnector(row), 'connector') : undefined;
  }

  async saveConnector(
    input: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnector> {
    const em = this.em.fork();

    // Checked before anything is written, and here rather than in a controller,
    // because a connector saved by curl reaches this method and nothing else.
    if (input.transformId && input.workflowId) {
      throw new BadRequestException(
        `"${input.name}" names both a transform and a workflow. Exactly one of them decides what shapes this data — with both set the runner picks one, and which one it picked is invisible until the load comes out wrong.`,
      );
    }
    if (input.workflowId) {
      const workflow = await em.findOne(WorkflowRow, { id: input.workflowId });
      if (!workflow) {
        throw new BadRequestException(
          `"${input.name}" points at workflow ${input.workflowId}, which does not exist. A connector pointing at a graph that is not there fails on a schedule rather than at the moment somebody decided.`,
        );
      }
      // **Refused at save, not at run.** A draft is a graph nobody has declared
      // finished, and it may have no sink at all, so a connector pointing at one
      // has nothing to execute. The check could equally live in the runner, and
      // that is precisely the version worth arguing against: it would move the
      // error from the person wiring the connector — who is looking at the
      // screen and can fix it in one edit — to a scheduled window at 3am, where
      // it becomes a failed run somebody reads the next morning without the
      // context that produced it.
      if (workflow.status !== 'ready') {
        throw new BadRequestException(
          `"${input.name}" points at workflow "${workflow.name}", which is still a draft. Publish it first: a draft is a graph nobody has declared finished, and scheduling one means finding out at 3am rather than now.`,
        );
      }
      // The redundancy between a connector's target type and its workflow's sink
      // is kept honest here. It is what lets "which connectors write this type"
      // keep working unchanged now that the sink, not the connector, is what
      // actually commits.
      if (workflow.targetType !== input.targetType) {
        throw new BadRequestException(
          `"${input.name}" says it writes ${input.targetType}, but workflow "${workflow.name}" commits ${workflow.targetType}. The sink is what writes, so the connector would be advertising a type it never produces.`,
        );
      }
    }

    const existing = input.id ? await em.findOne(ConnectorRow, { id: input.id }) : null;

    // Sealed first, then checked. See `assertNoNewPlaintextCredential` above:
    // with `encryptCredentials` on, the credential is an object by the time the
    // refusal looks, which is how the two flags compose instead of colliding.
    // Minted before sealing, for the reason `saveConnection` gives.
    const id = input.id ?? randomUUID();
    const plain = { ...(input.config ?? {}) };
    const config = await this.sealCredentials(plain, 'connector', id);

    this.assertNoNewPlaintextCredential(config, existing?.config, `"${input.name}"`);

    const row =
      existing ??
      em.create(ConnectorRow, {
        id,
        name: input.name,
        kind: input.kind,
        targetType: input.targetType,
        config: {},
        enabled: true,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    row.name = input.name;
    row.description = input.description;
    row.kind = input.kind;
    row.targetType = input.targetType;
    row.config = config;
    row.secretEnvVar = input.secretEnvVar;
    row.transformId = input.transformId;
    // Validated at length above — both-transform-and-workflow refused, a
    // missing workflow refused, a mismatched target type refused — and then
    // never written, so a connector could not be attached to a graph at all. It
    // saved, reported success, and ran nothing but its own kind. Careful
    // validation of a field that is then discarded is worse than no validation:
    // it reads as proof the field works.
    row.workflowId = input.workflowId;
    row.schedule = input.schedule;
    row.connectionId = input.connectionId;
    // `state` is deliberately not taken from the input: it belongs to the
    // runner, and a save that carried it would let an edit rewind a watermark.
    row.mode = input.mode;
    row.enabled = input.enabled ?? true;

    em.persist(row);
    await em.flush();
    // The plaintext the caller just handed over, not the sealed column and not a
    // re-open of it. Returning `row.config` would answer a save with ciphertext
    // — which the controller would then redact into nothing and the console
    // would render as a blob — and re-opening it would be a vault round trip to
    // recover a value that is already in this scope.
    return { ...toConnector(row), config: plain };
  }

  /**
   * Advance a connector's watermark.
   *
   * A targeted update rather than a read-modify-write of the whole row: two
   * runs of different connectors must never be able to overwrite each other's
   * progress by way of a stale copy of the rest of the record.
   */
  async saveConnectorState(id: string, state: Record<string, unknown>): Promise<void> {
    const em = this.em.fork();
    await em.nativeUpdate(ConnectorRow, { id }, { state });
  }

  async deleteConnector(id: string): Promise<boolean> {
    const em = this.em.fork();
    return (await em.nativeDelete(ConnectorRow, { id })) > 0;
  }

  async listConnections(): Promise<CatalogConnection[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectionRow, {}, { orderBy: { name: 'asc' } });
    return this.withOpenConfigs(rows.map(toConnection), 'connection');
  }

  async getConnection(id: string): Promise<CatalogConnection | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ConnectionRow, { id });
    return row ? this.withOpenConfig(toConnection(row), 'connection') : undefined;
  }

  async saveConnection(
    input: Omit<CatalogConnection, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnection> {
    const em = this.em.fork();
    const existing = input.id ? await em.findOne(ConnectionRow, { id: input.id }) : null;

    // Sealed first, then checked — the ordering `saveConnector` explains, and
    // the one that lets `encryptCredentials` and `allowInlineCredentials` mean
    // three things between them rather than four.
    // Minted BEFORE sealing, not inside `em.create` below, so the seal context
    // can name the row. See `sealCredentials` — a context whose `id` is absent
    // on create and present on update seals and opens under two different
    // contexts, which is why both shipped providers had to leave `id` out.
    const id = input.id ?? randomUUID();
    const plain = { ...(input.config ?? {}) };
    const config = await this.sealCredentials(plain, 'connection', id);

    this.assertNoNewPlaintextCredential(config, existing?.config, `"${input.name}"`);

    const row =
      existing ??
      em.create(ConnectionRow, {
        id,
        name: input.name,
        kind: input.kind,
        config: {},
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    row.name = input.name;
    row.description = input.description;
    row.kind = input.kind;
    row.config = config;
    row.secretEnvVar = input.secretEnvVar;

    em.persist(row);
    await em.flush();
    // The plaintext the caller supplied, for the reason `saveConnector` gives:
    // answering a save with the ciphertext it just wrote would be a value the
    // console cannot render and the round trip cannot compare against.
    return { ...toConnection(row), config: plain };
  }

  async connectorsUsingConnection(id: string): Promise<CatalogConnector[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRow, { connectionId: id }, { orderBy: { name: 'asc' } });
    return this.withOpenConfigs(rows.map(toConnector), 'connector');
  }

  /**
   * Refuses while anything still reads through it.
   *
   * Checked here rather than left to a foreign key because the useful part is
   * the message: a constraint violation says a row is referenced, and an
   * operator needs to know *which connectors* so they can be pointed somewhere
   * else first.
   */
  async deleteConnection(id: string): Promise<boolean> {
    const inUse = await this.connectorsUsingConnection(id);
    if (inUse.length > 0) {
      throw new BadRequestException(
        `${inUse.length} connector(s) still read through this connection: ${inUse
          .map((connector) => connector.name)
          .join(
            ', ',
          )}. Point them elsewhere before deleting it, or their next run fails with no address.`,
      );
    }
    const em = this.em.fork();
    return (await em.nativeDelete(ConnectionRow, { id })) > 0;
  }

  async recordConnectionCheck(id: string, check: ConnectionCheck): Promise<void> {
    const em = this.em.fork();
    // A targeted update: recording a check must never carry a stale copy of the
    // configuration back over an edit made while the check was running.
    await em.nativeUpdate(
      ConnectionRow,
      { id },
      {
        lastCheckedAt: new Date(),
        lastCheckOk: check.ok,
        lastCheckError: check.error?.slice(0, 1024),
      },
    );
  }

  async listTransforms(): Promise<CatalogTransform[]> {
    const em = this.em.fork();
    const rows = await em.find(TransformRow, {}, { orderBy: { name: 'asc' } });
    return rows.map(toTransform);
  }

  async getTransform(id: string): Promise<CatalogTransform | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(TransformRow, { id });
    return row ? toTransform(row) : undefined;
  }

  /**
   * Saving bumps the version whenever the code changed, and archives the code at
   * that version.
   *
   * Only when it changed: renaming a transform is not a new version, and
   * inflating the number would make it useless for the question it exists to
   * answer. That rule is followed here rather than diverged from, and under a
   * bounded archive it earns its keep twice over — a revision per save would let
   * twenty renames evict twenty bodies that loads actually ran.
   *
   * ## What is archived, and when
   *
   * On create, the first code, as version 1. On a code change, **two**: the
   * version being superseded and the new one. The first of those is the upgrade
   * path — a transform that predates `catalog_revision` has never had a revision
   * written, and the last moment its live code is still readable is this one,
   * before the assignment below overwrites it. `recordRevision` leaves an
   * already-recorded version alone, so from the second edit onwards that call is
   * a no-op.
   *
   * Both are staged onto this fork and land in the single flush below, so a
   * version and the text it names are written together or not at all.
   */
  async saveTransform(
    input: Pick<CatalogTransform, 'name' | 'language' | 'code'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogTransform> {
    const em = this.em.fork();
    const existing = input.id ? await em.findOne(TransformRow, { id: input.id }) : null;

    const row =
      existing ??
      em.create(TransformRow, {
        id: input.id ?? randomUUID(),
        name: input.name,
        language: input.language,
        code: input.code,
        version: 1,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    // Read before the assignments below, which is the whole reason it is a copy
    // rather than a reference: `row` IS `existing`, so one line later there is
    // nowhere left to read the superseded code from.
    const superseded = existing
      ? { version: existing.version, code: existing.code, at: existing.updatedAt }
      : undefined;
    const codeChanged = existing !== null && existing.code !== input.code;
    row.name = input.name;
    row.description = input.description;
    row.language = input.language;
    row.code = input.code;
    if (codeChanged) row.version += 1;

    em.persist(row);
    if (!existing) {
      await recordRevision(em, {
        subject: 'transform',
        subjectId: row.id,
        version: row.version,
        body: row.code,
        authoredBy: createdBy,
        authoredAt: row.updatedAt,
      });
    } else if (codeChanged && superseded) {
      // Attributed to the row's `createdBy` and dated to when it was last
      // written. That is who created the transform rather than who last edited
      // it — the row keeps no second actor — and it is recorded as the one fact
      // there is rather than as the current editor, who demonstrably did not
      // write this code.
      await recordRevision(em, {
        subject: 'transform',
        subjectId: row.id,
        version: superseded.version,
        body: superseded.code,
        authoredBy: row.createdBy,
        authoredAt: superseded.at,
      });
      await recordRevision(em, {
        subject: 'transform',
        subjectId: row.id,
        version: row.version,
        body: row.code,
        authoredBy: createdBy,
        authoredAt: new Date(),
      });
    }
    await em.flush();
    // After the flush, so it counts what was just written. See `pruneRevisions`.
    if (!existing || codeChanged) await pruneRevisions(em, 'transform', row.id);

    if (!existing || codeChanged) {
      emitCatalog('transform.changed', {
        transformId: row.id,
        name: row.name,
        language: row.language,
        version: row.version,
        changedBy: createdBy,
      });
    }

    return toTransform(row);
  }

  /**
   * Deletes the transform. **Leaves its revisions.**
   *
   * Not a cascade, and not an omission. A connector run in the history still
   * records the version it executed, and throwing away the only remaining copy
   * of that code because somebody tidied up the editor would make the run
   * record's `transformVersion` mean less than it did before revisions existed.
   * They are bounded per subject either way — see `RevisionRow`, which says the
   * same thing from the schema's side.
   */
  async deleteTransform(id: string): Promise<boolean> {
    const em = this.em.fork();
    return (await em.nativeDelete(TransformRow, { id })) > 0;
  }

  /**
   * Every version of this transform's code, newest first.
   *
   * A transform that predates `catalog_revision` and has not been saved since
   * answers with one synthesised revision holding its current code — see
   * `readRevisions` for why that is not written down, and why it is identical to
   * what the next save will store.
   */
  listTransformRevisions(id: string): Promise<CatalogRevision[]> {
    const em = this.em.fork();
    return readRevisions(em, 'transform', id, async () => {
      const row = await em.findOne(TransformRow, { id });
      return row
        ? {
            version: row.version,
            body: row.code,
            authoredBy: row.createdBy,
            authoredAt: row.updatedAt,
          }
        : undefined;
    });
  }

  async listWorkflows(): Promise<CatalogWorkflow[]> {
    const em = this.em.fork();
    const rows = await em.find(WorkflowRow, {}, { orderBy: { name: 'asc' } });
    return this.withOpenGraphs(rows.map(toWorkflow));
  }

  async getWorkflow(id: string): Promise<CatalogWorkflow | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowRow, { id });
    return row ? this.withOpenGraph(toWorkflow(row)) : undefined;
  }

  /**
   * Validate, then write.
   *
   * The whole-graph checks run here and not only in the canvas. A canvas that
   * validates against its own copy of the rules and a server that does not is a
   * canvas that lies: the first graph to arrive by curl, or from a canvas one
   * release behind, would be stored as something that looks runnable and fails
   * halfway through a load instead of at the moment it was drawn. It calls the
   * same exported `validateWorkflow` the canvas does, so the two cannot drift.
   *
   * The version bumps only when the graph's behaviour changed — the same rule
   * `saveTransform` applies to code. Renaming a workflow or dragging a node is
   * not a new version, and inflating the number would make it useless for the
   * question it exists to answer.
   *
   * ## Credentials in a source node
   *
   * `WorkflowSourceNode` says it "[carries] the same vocabulary a connector
   * does — a kind, an optional named connection, a config, the *name* of an env
   * var holding the credential", and closes with "credentials stay out of the
   * catalog here exactly as they do everywhere else". That was the fourth
   * docblock in this codebase to promise it and the second to be wrong: this
   * method wrote `nodes` verbatim and asked nothing, so
   * `postgres://svc:pass@warehouse/db` in a source node's `config.url` went
   * straight into `catalog_workflow` — and `workflow-runner.service.ts` spreads
   * `node.config` into a synthesised connector, so `fetchSql` reads it from
   * exactly where it reads a connector's.
   *
   * The same rule now applies, node by node: seal if this deployment encrypts,
   * refuse if it does not, and grandfather what is already stored. The
   * *predicate* is untouched — top-level strings of a config object — which is
   * the point. A source node's `config` is not a nested config; it is another
   * config, and a graph holds several. Widening what counts as a secret would
   * have put the write side out of step with the redaction on the read side,
   * which documents that same boundary deliberately.
   *
   * A **call** node's `config` is covered by the same rule and named the same
   * way for exactly that reason — see {@link carriesConfig}. It is handed to a
   * workflow that may run in another process in another language, which is a
   * further place for a password to arrive than a source's config has, not a
   * lesser one.
   *
   * **The hash is taken from the plaintext graph, before any sealing.** A
   * fingerprint is a statement about what the graph *does*, and sealing does
   * not change that. Hashing the sealed form would bump the version on every
   * save under any vault whose ciphertext is not deterministic — which is all
   * of them worth using — and a version that increments when nothing changed is
   * exactly the uselessness the paragraph above is guarding against.
   */
  async saveWorkflow(
    input: Pick<CatalogWorkflow, 'name' | 'nodes' | 'edges'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogWorkflow> {
    const nodes = input.nodes ?? [];
    const edges = input.edges ?? [];

    const em = this.em.fork();
    const existing = input.id ? await em.findOne(WorkflowRow, { id: input.id }) : null;
    // A new graph starts as a draft. An existing one keeps the status it has —
    // a save is an edit, never a promotion, and never a demotion either.
    const status = existing ? narrowStatus(existing.status, existing.id) : 'draft';

    assertStaysRunnable(status, { nodes, edges }, input.name);

    await assertTransformsExist(em, nodes);

    const targetType = targetTypeOf(status, nodes, input.name);

    // Taken from the plaintext graph, deliberately, and before anything below
    // seals: see the note on this method. A hash of the ciphertext would make
    // every save a new version.
    const graphHash = workflowGraphHash({ nodes, edges });

    // Sealed first, then checked — the ordering `saveConnector` explains, here
    // applied per source node.
    const id = input.id ?? randomUUID();
    const sealedNodes = await this.sealNodeConfigs(nodes, id);
    this.assertNoNewPlaintextGraphCredential(sealedNodes, existing?.nodes, `"${input.name}"`);

    const row =
      existing ??
      em.create(WorkflowRow, {
        id,
        name: input.name,
        nodes: [],
        edges: [],
        status,
        version: 1,
        graphHash,
        targetType,
        // A new graph is enabled, and carries no schedule until somebody sets
        // one through `saveWorkflowSchedule`. Enabled-by-default matters more
        // than it looks: `enabled` is half the test the scheduler applies, so
        // defaulting it false would mean every graph anybody ever published
        // needed a second, undiscoverable step before it would run.
        enabled: true,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const graphChanged = existing !== null && existing.graphHash !== graphHash;
    row.name = input.name;
    row.description = input.description;
    row.nodes = sealedNodes;
    row.edges = edges;
    row.graphHash = graphHash;
    // Written from the sink, never from the input: a caller must not be able to
    // claim a workflow writes one type while its sink commits another. Empty
    // while a draft has not drawn one yet — `publishWorkflow` is what refuses to
    // let that state become runnable.
    row.targetType = targetType;
    if (graphChanged) row.version += 1;

    em.persist(row);
    await em.flush();

    if (!existing || graphChanged) {
      emitCatalog('workflow.changed', {
        workflowId: row.id,
        name: row.name,
        version: row.version,
        graphHash: row.graphHash,
        targetType: row.targetType,
        nodeCount: nodes.length,
        changedBy: createdBy,
      });
    }

    // The plaintext graph the caller drew, for the reason `saveConnector` gives:
    // a canvas that posted a graph and got ciphertext back would render a source
    // node it cannot edit, and would post the ciphertext again on the next save.
    return { ...toWorkflow(row), nodes };
  }

  /**
   * Validate, then declare it ready.
   *
   * This is where the gate that used to sit on `saveWorkflow` now lives, and
   * putting it on its own transition is what gives the refusal somewhere to go:
   * the caller asked one question — "is this finished?" — so every issue
   * `validateWorkflow` found is the answer, rather than an error on a save the
   * author thought was about something else.
   *
   * The sink check is repeated here rather than left to `validateWorkflow`
   * because `targetType` is a stored, indexed column that a draft is allowed to
   * carry empty. Publishing is the moment it stops being allowed to, and it is
   * re-derived from the graph at this instant rather than trusted from the row —
   * the row's copy was written by a save that may not have had a sink at all.
   *
   * Idempotent. Publishing something already published re-validates it and
   * returns it, because "it was already ready" is not a problem anybody needs
   * reported and an error would make a double-click a failure.
   */
  async publishWorkflow(id: string, publishedBy: string): Promise<CatalogWorkflow> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowRow, { id });
    if (!row) {
      throw new NotFoundException(`Workflow ${id} does not exist, so there is nothing to publish.`);
    }

    const workflow = toWorkflow(row);
    const issues = validateWorkflow({ nodes: workflow.nodes, edges: workflow.edges });
    if (issues.length > 0) {
      throw new BadRequestException(
        `"${row.name}" cannot run as drawn, so it cannot be published. ${issues
          .map((issue) => issue.message)
          .join(' ')}`,
      );
    }

    // Validation guarantees exactly one sink, so this cannot be absent here even
    // though it can be on the draft this was a second ago.
    const sink = workflow.nodes.find((node) => node.kind === 'sink');
    if (!sink || sink.kind !== 'sink') {
      throw new BadRequestException(
        `"${row.name}" has no sink node, so nothing would ever be committed.`,
      );
    }

    await assertTransformsExist(em, workflow.nodes);

    const wasDraft = row.status !== 'ready';
    row.status = 'ready';
    row.targetType = sink.targetType;
    em.persist(row);
    await em.flush();

    // The connector, minted or brought back into step. After the flush and not
    // before it, because the row it points at has to exist and be `ready` first
    // — `saveConnector`'s own rule, which this deliberately does not go through:
    // that method is the authored-object path and is no longer reachable from
    // any route, and routing a mint through the validation written for a person
    // filling in a form would make publishing fail on rules about a form nobody
    // saw.
    await this.mintConnectorFor(em, row, workflow.nodes, publishedBy);

    // Only on the transition. Re-publishing an unchanged graph is not a change,
    // and an event on every idempotent call would put a stream of them in front
    // of anybody watching for the one that mattered.
    if (wasDraft) {
      emitCatalog('workflow.changed', {
        workflowId: row.id,
        name: row.name,
        version: row.version,
        graphHash: row.graphHash,
        targetType: row.targetType,
        nodeCount: workflow.nodes.length,
        changedBy: publishedBy,
      });
    }

    return toWorkflow(row);
  }

  /**
   * The connector a published graph runs as: minted once, then kept in step.
   *
   * **Found by `workflowId`, never by name**, and that is the whole of what
   * makes a re-publish safe. The connector id is the mutex key, the owner of
   * every `ConnectorRun` and the holder of the watermark; minting a second row
   * because somebody renamed a graph would silently start a fresh pipeline
   * beside the old one, with an empty watermark and no history, and both would
   * be on the same cron.
   *
   * `kind` is copied off the first source node purely so the column holds
   * something true-ish. It is **not read** at run time — a connector with a
   * `workflowId` takes its sources from the graph — and the only reason it is
   * populated at all is that the column is non-null and a lie that reads
   * plausibly is better than a lie that reads like the first item of an enum.
   *
   * A brought-back connector is re-enabled from the workflow rather than left
   * as it was, because `unpublishWorkflow` disables it: publishing again with
   * the connector still disabled would report success and run nothing, which is
   * the silent no-op this whole change exists to remove.
   */
  private async mintConnectorFor(
    em: EntityManager,
    workflow: WorkflowRow,
    nodes: WorkflowNode[],
    by: string,
  ): Promise<ConnectorRow> {
    const existing = await em.findOne(ConnectorRow, { workflowId: workflow.id });
    const source = nodes.find((node): node is WorkflowSourceNode => node.kind === 'source');

    const row =
      existing ??
      em.create(ConnectorRow, {
        id: randomUUID(),
        name: workflow.name,
        kind: source?.sourceKind ?? 'inline',
        targetType: workflow.targetType,
        config: {},
        enabled: workflow.enabled,
        createdBy: by,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    row.name = workflow.name;
    row.description = workflow.description;
    row.workflowId = workflow.id;
    row.targetType = workflow.targetType;
    // The copy, written from the authority in the same transaction that changes
    // it. See `CatalogConnector.schedule`: nothing reads this, and it is here so
    // that a row adopted from before the move can still be asked what it used to
    // do.
    row.schedule = workflow.schedule;
    row.enabled = workflow.enabled;
    // Cleared rather than left, and only on a mint. A connector that reaches
    // here already carrying a `transformId` is one adoption wrapped, and its
    // transform is now a node in the graph — leaving the field set would trip
    // the both-transform-and-workflow refusal on the next `saveConnector`.
    row.transformId = undefined;
    row.updatedAt = new Date();

    em.persist(row);
    await em.flush();
    if (!existing) {
      this.logger.log(
        `Published workflow "${workflow.name}" runs as connector ${row.id}; ${by} published it.`,
      );
    }
    return row;
  }

  /**
   * Back to `draft`, and the connector it ran as goes quiet with it.
   *
   * This refused, until now, while any connector still ran the graph — and the
   * docblock argued the refusal on principle, that turning off somebody's loads
   * as a side effect of an edit to something else is a silent action. The
   * principle stands; the situation it described does not. A connector was an
   * independently authored object then, so "point them elsewhere first" was
   * advice somebody could act on. A published graph now runs as exactly one
   * connector, its own, minted by `publishWorkflow` — so the old check would
   * refuse every unpublish there has ever been, and there is nowhere else to
   * point anything.
   *
   * So it cascades, and the thing the refusal protected is protected by *how*
   * it cascades: **disabled, not deleted**. The id survives, so the run history,
   * the watermark and the mutex key are all still there and re-publishing
   * resumes the same pipeline. And it is the opposite of silent — this is a
   * transition somebody asked for by name, and the disable is what makes the
   * screen's "not running" true rather than aspirational.
   */
  async unpublishWorkflow(id: string, unpublishedBy: string): Promise<CatalogWorkflow> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowRow, { id });
    if (!row) {
      throw new NotFoundException(
        `Workflow ${id} does not exist, so there is nothing to unpublish.`,
      );
    }

    row.status = 'draft';
    em.persist(row);
    const stopped = await em.nativeUpdate(ConnectorRow, { workflowId: id }, { enabled: false });
    await em.flush();
    this.logger.log(
      `${unpublishedBy} took workflow "${row.name}" (${row.id}) back to draft; ${stopped} connector(s) disabled with it.`,
    );
    return toWorkflow(row);
  }

  /**
   * Set when this graph runs, and whether it runs at all.
   *
   * Both fields are optional and an absent one means "leave it alone", which is
   * the same merge {@link saveLoadExpectation} performs and for the same reason:
   * a form that renders only the cron must not be able to silently re-enable a
   * pipeline somebody turned off.
   *
   * The cron is **not parsed here**. That is deliberate and it is the one thing
   * about this method worth arguing: `prevCronFireMs` lives behind an optional
   * peer dependency, so a store that validated crons would refuse every schedule
   * on a deployment that simply has not installed `cron-parser` — turning a
   * missing optional dep into "you may not schedule anything", with a message
   * about syntax. The scheduler parses it, names the workflow and the
   * expression when it cannot, and keeps going for everything else.
   */
  async saveWorkflowSchedule(
    id: string,
    input: { schedule?: string; enabled?: boolean },
    changedBy: string,
  ): Promise<CatalogWorkflow> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowRow, { id });
    if (!row) {
      throw new NotFoundException(`Workflow ${id} does not exist, so it cannot be scheduled.`);
    }

    if (input.schedule !== undefined) {
      const cron = input.schedule.trim();
      row.schedule = cron.length > 0 ? cron : undefined;
    }
    if (input.enabled !== undefined) row.enabled = input.enabled;

    em.persist(row);
    // Through to the copy in the same transaction, so the two are never
    // observable disagreeing. `nativeUpdate` rather than a load-and-set because
    // there is nothing to read: these two columns are written from here and
    // from `mintConnectorFor`, and from nowhere else at all.
    await em.nativeUpdate(
      ConnectorRow,
      { workflowId: id },
      { schedule: row.schedule ?? null, enabled: row.enabled },
    );
    await em.flush();

    this.logger.log(
      `${changedBy} set workflow "${row.name}" to ${
        row.enabled ? (row.schedule ?? 'manual runs only') : 'disabled'
      }.`,
    );
    return toWorkflow(row);
  }

  async connectorsUsingWorkflow(id: string): Promise<CatalogConnector[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRow, { workflowId: id }, { orderBy: { name: 'asc' } });
    return this.withOpenConfigs(rows.map(toConnector), 'connector');
  }

  /**
   * Delete the graph, and the connector it ran as with it.
   *
   * This refused while any connector still ran the graph, on the same reasoning
   * `deleteConnection` still uses: an operator needs to know which loads would
   * start failing before they break one. That reasoning survives the change and
   * points the other way now. `deleteConnection` refuses because a connection is
   * shared — several pipelines read through one, and the operator has a real
   * choice about each. A published workflow's connector is not shared; it *is*
   * this workflow, minted by `publishWorkflow` and unable to run without it, so
   * refusing would mean no workflow could ever be deleted and the only way out
   * would be a route that deletes a connector — which is the route this change
   * removed.
   *
   * Deleted rather than disabled, unlike `unpublishWorkflow`: there is no graph
   * left for the id to resume onto, and a connector whose `workflowId` names
   * nothing is exactly the row the scheduler complains about once per boot
   * forever.
   *
   * **The run history goes too**, because it is keyed on the connector id. That
   * is the real cost of this operation and it is why it is a delete rather than
   * something softer — an operator who wants the history keeps the graph and
   * unpublishes it.
   */
  async deleteWorkflow(id: string): Promise<boolean> {
    const em = this.em.fork();
    const deleted = (await em.nativeDelete(WorkflowRow, { id })) > 0;
    if (deleted) {
      const dropped = await em.nativeDelete(ConnectorRow, { workflowId: id });
      if (dropped > 0) {
        this.logger.log(`Deleted workflow ${id} and the ${dropped} connector(s) that ran it.`);
      }
    }
    return deleted;
  }

  /**
   * Stage one node's batch.
   *
   * Keyed deterministically by `(runId, nodeId, batch)`, so a retried durable
   * step re-sending its batches replaces them rather than appending a second
   * copy. An append-only stage would silently double a node's output on every
   * retry, and the only symptom would be a row count that looks merely large.
   */
  async writeStage(input: {
    runId: string;
    nodeId: string;
    batch: number;
    rows: Array<Record<string, unknown>>;
  }): Promise<{ written: number }> {
    const em = this.em.fork();
    const id = stageKey(input.runId, input.nodeId, input.batch);
    const existing = await em.findOne(WorkflowStageRow, { id });

    const row =
      existing ??
      em.create(WorkflowStageRow, {
        id,
        runId: input.runId,
        nodeId: input.nodeId,
        batch: input.batch,
        rows: [],
        rowCount: 0,
        createdAt: new Date(),
      });

    row.rows = input.rows;
    row.rowCount = input.rows.length;
    em.persist(row);
    await em.flush();
    // Rows accepted by this call, matching what the warehouse's `write` means by
    // the same word — never a running total.
    return { written: input.rows.length };
  }

  async readStage(ref: {
    runId: string;
    nodeId: string;
    batch: number;
  }): Promise<Array<Record<string, unknown>>> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowStageRow, {
      id: stageKey(ref.runId, ref.nodeId, ref.batch),
    });
    if (!row) return [];
    // Narrowed rather than trusted. A staged batch is JSON that a transform
    // produced, and a transform can return anything; anything that is not a
    // plain object could not have been written as a row and is dropped here
    // rather than surfacing as a column named after an array index.
    return row.rows.filter(isRowRecord);
  }

  async dropStages(runId: string): Promise<number> {
    const em = this.em.fork();
    return em.nativeDelete(WorkflowStageRow, { runId });
  }

  async startRun(input: {
    connectorId: string;
    snapshotId: string;
    principalId: string;
    workflowId?: string;
    workflowVersion?: number;
    graphHash?: string;
    executionMode?: WorkflowExecutionMode;
  }): Promise<ConnectorRun> {
    const em = this.em.fork();
    const row = em.create(ConnectorRunRow, {
      id: randomUUID(),
      connectorId: input.connectorId,
      snapshotId: input.snapshotId,
      principalId: input.principalId,
      status: 'running',
      fetched: 0,
      written: 0,
      logs: [],
      // Recorded now rather than at the finish. A run that crashes hard enough
      // never to reach `finishRun` is precisely the one whose graph somebody
      // will need to identify.
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      graphHash: input.graphHash,
      executionMode: input.executionMode,
      startedAt: new Date(),
    });
    em.persist(row);

    const connector = await em.findOne(ConnectorRow, { id: input.connectorId });
    if (connector) {
      connector.lastRunAt = new Date();
      connector.lastRunStatus = 'running';
    }
    await em.flush();
    return toRun(row);
  }

  async finishRun(
    id: string,
    outcome: Partial<
      Pick<
        ConnectorRun,
        'status' | 'fetched' | 'written' | 'logs' | 'error' | 'transformVersion' | 'nodeOutcomes'
      >
    >,
  ): Promise<ConnectorRun | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ConnectorRunRow, { id });
    if (!row) return undefined;

    if (outcome.nodeOutcomes !== undefined) {
      row.nodeOutcomes = outcome.nodeOutcomes;
    }

    if (outcome.status) row.status = outcome.status;
    if (outcome.fetched !== undefined) row.fetched = outcome.fetched;
    if (outcome.written !== undefined) row.written = outcome.written;
    // Capped: a chatty transform should not be able to fill the table with logs
    // from one run.
    if (outcome.logs) row.logs = outcome.logs.slice(0, 200);
    if (outcome.error !== undefined) row.error = outcome.error?.slice(0, 4000);
    if (outcome.transformVersion !== undefined) {
      row.transformVersion = outcome.transformVersion;
    }
    row.finishedAt = new Date();

    const connector = await em.findOne(ConnectorRow, { id: row.connectorId });
    if (connector) connector.lastRunStatus = row.status;

    await em.flush();
    return toRun(row);
  }

  async listRuns(connectorId?: string, limit = 50): Promise<ConnectorRun[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRunRow, connectorId ? { connectorId } : {}, {
      orderBy: { startedAt: 'desc' },
      limit: Math.min(limit, 200),
    });
    return rows.map(toRun);
  }

  // Load expectations, as an operator set them.
  //
  // Rows, and only rows. The precedence these take part in — a host's `byType`
  // entry over one of these over the host's `default`, field by field — is
  // resolved in the pipeline package beside the functions that enforce it, and
  // deliberately not here: a store that resolved would be a second place the
  // answer is decided, and the first symptom of the two disagreeing is a load
  // that is refused in one environment and committed in another.
  //
  // Unbounded, unlike the runs and the revisions above, and that is safe for a
  // reason rather than by omission: there is one row per object type at most,
  // because the type name IS the key. A catalog with a thousand types has a
  // thousand rows.

  async listLoadExpectations(): Promise<StoredLoadExpectation[]> {
    const em = this.em.fork();
    const rows = await em.find(LoadExpectationRow, {}, { orderBy: { typeName: 'asc' } });
    return rows.map(toLoadExpectation);
  }

  async getLoadExpectation(typeName: string): Promise<StoredLoadExpectation | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(LoadExpectationRow, { typeName });
    return row ? toLoadExpectation(row) : undefined;
  }

  /**
   * Upsert one type's expectation, stamped with who set it and when.
   *
   * ## What is written is what can be read back
   *
   * Both JSON columns are normalised on the way in through the *same* functions
   * that narrow them on the way out, and a `deletes` that does not survive that
   * round trip is refused rather than stored. So the column cannot come to hold
   * a value this store would later read as "nothing was declared" — which is the
   * one failure mode that would be invisible from every side: the save returned
   * 200, the console renders the row, and the load is refused anyway with a
   * message telling the operator to declare the thing they declared.
   *
   * That refusal is *structural* — "this cannot be read back" — and is not the
   * operator-facing validation. The 400s that name a field, on an empty
   * `because`, a `periodic-full-reload` with no positive interval, a strategy
   * outside the three, or a `maxShrink` outside `(0, 1]`, live on the pipeline
   * controller where the person typing them is. Two vocabularies would be one
   * too many, so this one refuses only what it genuinely cannot persist.
   *
   * `setAt` is taken from this process's clock and never from the caller, for
   * the reason `startRun` takes its own timestamp: a stored instant a client can
   * choose is not an audit record. `setBy` and `setByActor` are arguments rather
   * than fields on `expectation` for the same reason — a caller cannot claim
   * them by putting them in a body.
   */
  async saveLoadExpectation(
    typeName: string,
    expectation: Pick<StoredLoadExpectation, 'deletes' | 'rowCount'>,
    setBy: string,
    setByActor?: string,
  ): Promise<StoredLoadExpectation> {
    const deletes = expectation.deletes
      ? toDeleteReconciliation({ ...expectation.deletes })
      : undefined;
    if (expectation.deletes && !deletes) {
      throw new BadRequestException(
        `The delete reconciliation given for ${typeName} cannot be stored: it needs a "strategy" of "accepted", "soft-deleted-at-source" or "periodic-full-reload", a "because" string, and — for "periodic-full-reload" — a numeric "withinMs". Writing it as it stands would leave a row this store reads back as declaring nothing, so the load would be refused while the console showed a policy.`,
      );
    }

    const em = this.em.fork();
    const now = new Date();
    const row =
      (await em.findOne(LoadExpectationRow, { typeName })) ??
      em.create(LoadExpectationRow, { typeName, setBy, setAt: now });

    row.deletes = deletes;
    row.rowCount = expectation.rowCount ? toRowCountBound({ ...expectation.rowCount }) : undefined;
    // Overwritten on every save, including one that changes neither policy
    // field. The attribution is a statement about the decision that is now
    // standing, and the person who re-affirmed it is the one accountable for it.
    row.setBy = setBy;
    row.setByActor = setByActor;
    row.setAt = now;

    em.persist(row);
    await em.flush();
    return toLoadExpectation(row);
  }

  /**
   * Drop the stored row. The host's `CATALOG_LOAD_EXPECTATIONS` is untouched, so
   * a type this deployment declared in code keeps that declaration and simply
   * stops having an operator layer under it.
   *
   * `false` means there was no row, which is a fact and not a failure — a
   * caller clearing a type nobody had set has got what it asked for.
   */
  async clearLoadExpectation(typeName: string): Promise<boolean> {
    const em = this.em.fork();
    return (await em.nativeDelete(LoadExpectationRow, { typeName })) > 0;
  }
}

/**
 * A stored row as the interface describes it.
 *
 * Both policy columns go through the narrowing below rather than being handed
 * over as the union they are declared to be. MikroORM returns whatever the
 * column holds, so typing them as `DeleteReconciliation` on the entity would
 * make every read an unchecked assertion about JSON written by some earlier
 * version of this package — the same rule `WorkflowRow.nodes` follows, and for
 * the same reason.
 */
function toLoadExpectation(row: LoadExpectationRow): StoredLoadExpectation {
  return {
    typeName: row.typeName,
    deletes: toDeleteReconciliation(row.deletes),
    rowCount: toRowCountBound(row.rowCount),
    setBy: row.setBy,
    setByActor: row.setByActor,
    setAt: row.setAt.toISOString(),
  };
}

/**
 * The stored JSON as a `DeleteReconciliation`, or nothing.
 *
 * **Unreadable reads as absent, and absent is the strict answer**, which is why
 * this may drop a value rather than throwing the way `isWorkflowNode` does. The
 * two are opposite cases: a dropped workflow node leaves a graph that still
 * validates and silently runs nine steps of ten, whereas a dropped delete
 * strategy means `refuseUndeclaredDeletes` sees nothing declared and stops the
 * incremental load. The failure of this column is a refused load with a message
 * that says exactly what to declare — loud, safe, and recoverable by saving the
 * expectation again.
 *
 * The literals are written out in each branch rather than passing the narrowed
 * variable through, so the object returned is typed by this function and not by
 * what the column happened to contain.
 */
function toDeleteReconciliation(
  value: Record<string, unknown> | undefined,
): DeleteReconciliation | undefined {
  if (!value) return undefined;
  const { strategy, because, column, withinMs } = value;
  if (typeof because !== 'string') return undefined;

  if (strategy === 'accepted') return { strategy: 'accepted', because };

  if (strategy === 'soft-deleted-at-source') {
    // The column is genuinely optional — a source that flips a status the
    // transform reads does not name one — so an absent or unreadable value here
    // is not a reason to lose the declaration.
    return typeof column === 'string'
      ? { strategy: 'soft-deleted-at-source', because, column }
      : { strategy: 'soft-deleted-at-source', because };
  }

  if (strategy === 'periodic-full-reload') {
    // `withinMs` is not optional on this branch: the strategy IS the interval,
    // and one without a number is a declaration that polices nothing.
    // `Number.isFinite` rather than `typeof === 'number'` alone, because a
    // column holding `null` parsed as `NaN` would otherwise become an interval
    // no comparison is ever true of.
    if (!Number.isFinite(withinMs) || typeof withinMs !== 'number') return undefined;
    return { strategy: 'periodic-full-reload', because, withinMs };
  }

  return undefined;
}

/**
 * The stored JSON as a partial bound.
 *
 * Field by field, keeping only what is a finite number, because the merge that
 * consumes this is itself field by field: a stored `maxShrink` must not carry an
 * opinion about `maxGrowth` with it, and a key that is simply absent is how that
 * is said.
 *
 * Nothing readable answers `undefined` rather than `{}`. The two mean the same
 * to the merge — neither contributes a field — and the shorter one keeps the
 * console from rendering a bound that is not there.
 */
function toRowCountBound(
  value: Record<string, unknown> | undefined,
): Partial<RowCountBound> | undefined {
  if (!value) return undefined;
  const bound: Partial<RowCountBound> = {};
  if (typeof value.maxShrink === 'number' && Number.isFinite(value.maxShrink)) {
    bound.maxShrink = value.maxShrink;
  }
  if (typeof value.maxGrowth === 'number' && Number.isFinite(value.maxGrowth)) {
    bound.maxGrowth = value.maxGrowth;
  }
  if (typeof value.minRows === 'number' && Number.isFinite(value.minRows)) {
    bound.minRows = value.minRows;
  }
  return Object.keys(bound).length > 0 ? bound : undefined;
}

/**
 * No new plaintext credential goes into `config`.
 *
 * `ConnectorRow.config` and `ConnectionRow.config` both promise, in their own
 * docblocks, that what is stored is the *name* of an environment variable and
 * "never the credential". That held for every source that authenticates with a
 * token — those really do come from `secretEnvVar` — and did not hold for SQL,
 * where `fetchSql` reads `connector.config.url` and a connection URL is a
 * password with an address attached. So `postgres://user:pass@host/db` sat in a
 * JSON column, and `GET pipeline/connections` served it under `catalog:read`.
 *
 * Refused **here**, in the store, rather than in the controller, for the reason
 * the both-transform-and-workflow check above gives: a connector saved by curl,
 * by a host's own code, or by `applyPromotion` reaches this method and nothing
 * else. The route can only close the route.
 *
 * ## What is refused, precisely
 *
 * A password-bearing URL that is **not already the value stored under that key
 * for this row**. Three consequences, all intended:
 *
 *  - A new connector carrying one is turned away. That is the point.
 *  - An existing one is grandfathered, so a deployment with such URLs already
 *    in its table keeps running and can still be renamed, re-pointed or
 *    disabled. Refusing those would break working loads to no benefit — the
 *    password is already in the database either way.
 *  - Promoting such a connector into an environment that does not have it yet
 *    is refused. `promoteConnectors` deliberately never carries `secretEnvVar`
 *    across, so that a newly promoted connector "arrive[s] with no credential to
 *    reach anything with" — this applies that same rule to the credential that
 *    was hiding inside `config`, which promotion was otherwise copying verbatim.
 *
 * Compared as exact strings rather than by re-parsing: the value being
 * grandfathered is the one that came out of this table, so byte equality is
 * both sufficient and the only comparison that cannot be argued with later.
 *
 * The URL parse duplicates a few lines of `config-secrets.ts` in the pipeline
 * package, knowingly. That package depends on this one, so the shared helper
 * cannot live there, and moving it to `@dudousxd/nestjs-catalog` to save ten
 * lines would put a rule about *storage* in the package that deliberately holds
 * no storage.
 */
function assertNoNewPlaintextCredential(
  incoming: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined,
  subject: string,
  // Where the offending key lives, for the message only. A connector's config is
  // reached as `config.url`; a graph's is `nodes["s1"].config.url`, and an
  // operator given the first when they are editing the second has to guess which
  // of six boxes on a canvas is the one.
  path = 'config',
): void {
  const offending: string[] = [];
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (typeof value !== 'string' || !hasUrlPassword(value)) continue;
    if (stored && stored[key] === value) continue;
    offending.push(key);
  }
  if (offending.length === 0) return;
  throw new BadRequestException(
    `${subject} carries a password inside ${path}.${offending.join(`, ${path}.`)}. A connection URL is the credential, and this column is read by anyone holding catalog:read — put the URL in an environment variable and name it in "Credential env var" instead, which is where every fetcher already looks first.`,
  );
}

/**
 * The same refusal, for every source node of a graph.
 *
 * Reuses `assertNoNewPlaintextCredential` node by node rather than growing a
 * second, graph-shaped rule, and that is the decision worth defending. A source
 * node's `config` is not a *nested* config — it is another config object of the
 * same kind, one level down in a row that happens to hold several. The
 * predicate stays "top-level strings of a config object", so the write side
 * still means exactly what `redactConfigSecrets` means on the read side. Had
 * this instead walked arbitrarily deep, the two would now disagree about the
 * same value: the store would refuse a header a redaction happily serves.
 *
 * ## Grandfathering, per node
 *
 * `stored` is compared **per node id**, never as a whole object. A graph is one
 * JSON column, so a whole-column comparison would break on any unrelated edit —
 * moving a box, renaming the graph — and refuse a rename over a credential
 * nobody touched, which is the failure mode the connector-level grandfathering
 * was written to avoid in the first place. Node ids are unique (validation
 * refuses `duplicate-node-id`) and stable, so they are the identity to compare
 * under.
 *
 * The stored nodes are walked permissively, without `isWorkflowNode`. A node
 * this build cannot narrow still holds bytes that are already in the column,
 * and the comparison is byte equality — so the worst a permissive walk can do
 * is grandfather a value that genuinely is already stored, which is precisely
 * what grandfathering means. Throwing here instead would make a graph written
 * by a newer release unsaveable by an older one over a credential neither of
 * them changed.
 */
function assertNoNewPlaintextGraphCredential(
  nodes: WorkflowNode[],
  stored: unknown[] | undefined,
  subject: string,
): void {
  const storedConfigs = storedNodeConfigs(stored);
  for (const node of nodes) {
    if (!carriesConfig(node)) continue;
    assertNoNewPlaintextCredential(
      node.config,
      storedConfigs.get(node.id),
      subject,
      `nodes["${node.id}"].config`,
    );
  }
}

/**
 * The node kinds that hold a `config` — the ones sealed, opened and refused.
 *
 * A predicate rather than a `kind !== 'source'` at each of the three call
 * sites, because those three have to agree exactly: a node sealed on the way in
 * and not opened on the way out is a graph that runs with ciphertext in its
 * parameters, and one refused but not sealed is a promise this file has already
 * had to fix twice.
 */
function carriesConfig(
  node: WorkflowNode,
): node is Extract<WorkflowNode, { config: Record<string, unknown> }> {
  return node.kind === 'source' || node.kind === 'call';
}

/** Each stored node's config, by node id, trusting nothing about the shape. */
function storedNodeConfigs(nodes: unknown[] | undefined): Map<string, Record<string, unknown>> {
  const configs = new Map<string, Record<string, unknown>>();
  for (const node of nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue;
    const id = Reflect.get(node, 'id');
    const config = Reflect.get(node, 'config');
    if (typeof id !== 'string') continue;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue;
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) record[key] = value;
    configs.set(id, record);
  }
  return configs;
}

/**
 * The vaults a binding names, in the order the store should use them.
 *
 * An absent binding and an empty array are the same thing — nobody bound a
 * vault — and both get the refusing default, so the message a host meets names
 * the token to bind rather than reporting that no vault answers to the name a
 * row carries. The second sentence is true and helps nobody.
 */
function toVaultList(
  vault: CatalogSecretVault | CatalogSecretVault[] | undefined,
): CatalogSecretVault[] {
  const vaults = vault === undefined ? [] : Array.isArray(vault) ? vault : [vault];
  return vaults.length > 0 ? vaults : [new RefusingSecretVault()];
}

/**
 * Seal one value, and refuse to carry on if it could not be sealed.
 *
 * The failure a reader should look for here is the one that is NOT written: no
 * catch that logs and stores the plaintext. A deployment that turned
 * `encryptCredentials` on and then wrote three passwords in the clear during a
 * vault outage would have no way afterwards to find out which three.
 *
 * A `SecretVaultNotConfiguredError` passes through unwrapped, because its
 * message already names the token to bind and wrapping it would bury that
 * behind a sentence about a vault that does not exist.
 */
async function sealOne(
  vault: CatalogSecretVault,
  plaintext: string,
  context: SecretContext,
): Promise<SealedSecret> {
  try {
    return await vault.seal(plaintext, context);
  } catch (error) {
    if (error instanceof SecretVaultNotConfiguredError) throw error;
    throw new SecretSealFailedError(
      `${context.kind}.config.${context.field} could not be sealed by the "${vault.name}" vault, so nothing was saved: ${describeCause(error)}. The credential was not written in plaintext instead.`,
      { cause: error },
    );
  }
}

/**
 * Whether waiting could not possibly help.
 *
 * Two sources, and the second is the one that matters in production.
 *
 * The first is this package's own {@link SecretVaultNotConfiguredError}:
 * nothing is bound, or nothing bound answers to the name the row carries. Both
 * are bindings rather than weather.
 *
 * The second is **the vault's own verdict**, read off the cause. Only the vault
 * can tell an `AccessDeniedException` from a `ThrottlingException`, or a Vault
 * 403 from a 412 — a key policy that will still be wrong in fifteen minutes
 * from a rate limit that will not. Both shipped providers classify exactly that
 * and put a `retryable` boolean on their own error type; without this line that
 * knowledge stopped at the provider boundary and every permanent failure burned
 * three attempts over fifteen minutes before reporting a key policy nobody was
 * going to change by waiting.
 *
 * Only an explicit `false` counts. An absent `retryable` means the vault did
 * not say, and "did not say" has to read as retryable — which is both the safe
 * direction to be wrong in (a retried permanent failure costs three attempts
 * and then reports itself; a fatal-by-default transient one turns a five-second
 * blip into a load that will not be retried) and *precisely* the rule the
 * durable engine applies one layer up: `existing.error?.retryable !== false`.
 * The two now agree by construction rather than by coincidence.
 *
 * Read with `Reflect.get` rather than by class, deliberately: a provider is a
 * separate package with its own error types, and this must not require it to
 * import anything from here to be understood.
 */
function isPermanent(error: unknown): boolean {
  if (error instanceof SecretVaultNotConfiguredError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return Reflect.get(error, 'retryable') === false;
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a string parses as a URL that carries a password. */
function hasUrlPassword(value: string): boolean {
  try {
    // WHATWG `URL` handles non-special schemes, so `postgres:` and `mysql:`
    // yield a real `password` rather than an opaque path — which is why this is
    // a parse and not a regular expression.
    return new URL(value).password.length > 0;
  } catch {
    return false;
  }
}

/**
 * Narrow a stored string, loudly.
 *
 * The previous shape here — `KINDS.find(k => k === row.kind) ?? "http"` — kept
 * its own copy of the list, and when the list grew the copy did not. A `file`
 * connector came back as an `http` one and failed complaining about a missing
 * URL, which points the reader at the connector's config instead of at this
 * line. Falling back is the whole mistake: an unrecognised value means this
 * build is older than the data, and quietly answering with a different value is
 * worse than saying so.
 */
function narrow<T extends string>(
  value: string,
  guard: (candidate: unknown) => candidate is T,
  field: string,
  id: string,
): T {
  if (guard(value)) return value;
  throw new Error(
    `${field} "${value}" on ${id} is not one this build knows about. It was most likely written by a newer version of the catalog.`,
  );
}

/**
 * A workflow's status, with an ABSENT one read as `ready`.
 *
 * Absent is not the same as unrecognised, and `narrow` is right to refuse the
 * second. A value this build does not know means the data is newer than the
 * code, and answering with a different one would point the reader at the wrong
 * line. But `undefined` means the opposite — a row hydrated from a database
 * that predates the column, because MikroORM does not run a field initialiser
 * for a column the table does not have yet, so the default governs the backfill
 * and not the window before it runs.
 *
 * `ready` for exactly the reason the column's own docblock gives: every row
 * already there passed validation to get there, and reading them as drafts
 * would stop every scheduled connector the moment the code deployed and before
 * the migration caught up. A default that turns an upgrade into an outage is
 * the wrong default even when it looks like the careful one.
 */
function narrowStatus(value: string | undefined, id: string): WorkflowStatus {
  if (value === undefined) return 'ready';
  return narrow(value, isWorkflowStatus, 'Workflow status', id);
}

function toConnector(row: ConnectorRow): CatalogConnector {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: narrow(row.kind, isConnectorKind, 'Connector kind', row.id),
    targetType: row.targetType,
    config: row.config ?? {},
    secretEnvVar: row.secretEnvVar,
    transformId: row.transformId,
    workflowId: row.workflowId,
    schedule: row.schedule,
    connectionId: row.connectionId,
    mode: row.mode === 'incremental' ? 'incremental' : 'full',
    state: row.state ?? {},
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString(),
    lastRunStatus:
      row.lastRunStatus === 'succeeded' ||
      row.lastRunStatus === 'failed' ||
      row.lastRunStatus === 'running'
        ? row.lastRunStatus
        : undefined,
  };
}

function toTransform(row: TransformRow): CatalogTransform {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    language: narrow(row.language, isTransformLanguage, 'Transform language', row.id),
    code: row.code,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRun(row: ConnectorRunRow): ConnectorRun {
  return {
    id: row.id,
    connectorId: row.connectorId,
    snapshotId: row.snapshotId,
    principalId: row.principalId,
    status: row.status === 'succeeded' || row.status === 'failed' ? row.status : 'running',
    fetched: row.fetched,
    written: row.written,
    logs: row.logs ?? [],
    error: row.error,
    transformVersion: row.transformVersion,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    graphHash: row.graphHash,
    // Narrowed with the shared guard rather than trusted. An execution mode this
    // build does not recognise means the row was written by a newer one, and
    // answering "inline" would tell an operator a checkpointed run was not.
    executionMode: isWorkflowExecutionMode(row.executionMode) ? row.executionMode : undefined,
    nodeOutcomes: toNodeOutcomes(row.nodeOutcomes),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

/**
 * The gate that used to stand in front of every save now stands in front of
 * `ready` only.
 *
 * A draft is stored exactly as drawn, unfinished nodes and all: that is what
 * makes closing the tab safe, and it is why "+ Sink" no longer answers with two
 * true and useless complaints one second after the click. What is refused is a
 * *ready* graph edited into something that cannot run — **refused rather than
 * demoted**, because a connector may only point at a ready graph, so a save that
 * silently dropped the status would stop a scheduled load with nothing said to
 * anybody. The person editing is the one who can fix it, and they are looking at
 * the screen right now.
 *
 * A free function rather than a branch inside `saveWorkflow` because that method
 * was already at the complexity ceiling, and because this is the rule the whole
 * feature turns on — it deserves somewhere to be read.
 */
function assertStaysRunnable(
  status: WorkflowStatus,
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  name: string,
): void {
  if (status !== 'ready') return;
  const issues = validateWorkflow(graph);
  if (issues.length === 0) return;
  throw new BadRequestException(
    `"${name}" is published, so it has to stay runnable, and this edit would leave it unable to run. ${issues
      .map((issue) => issue.message)
      .join(' ')} Unpublish it first if you want to park it in this state.`,
  );
}

/**
 * The type the sink commits, or the empty string while nobody has drawn one.
 *
 * Only a `ready` graph is guaranteed to have exactly one sink, because only a
 * ready graph has been validated. A draft may legitimately have none yet — that
 * is what drafting is — so this carries the empty string until there is a sink
 * to derive it from, and `publishWorkflow` is what guarantees one exists before
 * anything can run. Never taken from the caller: a client must not be able to
 * claim a workflow writes one type while its sink commits another.
 */
function targetTypeOf(status: WorkflowStatus, nodes: WorkflowNode[], name: string): string {
  const sink = nodes.find((node) => node.kind === 'sink');
  if (sink && sink.kind === 'sink') return sink.targetType;
  if (status === 'ready') {
    throw new BadRequestException(
      `"${name}" has no sink node, so nothing would ever be committed.`,
    );
  }
  return '';
}

/**
 * Every transform node points at a transform that exists.
 *
 * Kept out of `validateWorkflow` because it needs the database, and keeping the
 * validator pure is exactly what lets the canvas run the same rules in the
 * browser. Checked node by node rather than with one `IN` query so the refusal
 * can name the node the author is looking at, which is the difference between a
 * fixable message and a list of ids.
 */
async function assertTransformsExist(em: EntityManager, nodes: WorkflowNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.kind !== 'transform') continue;
    const transform = await em.findOne(TransformRow, { id: node.transformId });
    if (!transform) {
      throw new BadRequestException(
        `Node "${node.name}" (${node.id}) runs transform ${node.transformId}, which does not exist. Saving it would leave a graph that fails partway through a load rather than at the moment it was drawn.`,
      );
    }
  }
}

/**
 * Read the per-node record back, dropping anything malformed.
 *
 * The one place in this file that falls back rather than throwing, and the
 * reason is the direction the data flows: this is observability *about* a run
 * that already happened, so a garbled entry costs a line in a panel, while
 * throwing would make an entire run history unreadable because one node's
 * outcome was written by a version that shaped it differently. Everything that
 * decides what a load *does* — kinds, languages, graph nodes — still refuses.
 */
function toNodeOutcomes(
  value: Record<string, unknown> | undefined,
): Record<string, WorkflowNodeOutcome> | undefined {
  if (!value) return undefined;
  const outcomes: Record<string, WorkflowNodeOutcome> = {};
  for (const [nodeId, raw] of Object.entries(value)) {
    const outcome = toNodeOutcome(raw);
    if (outcome !== undefined) outcomes[nodeId] = outcome;
  }
  return outcomes;
}

/**
 * One node's outcome, or `undefined` if it is not one.
 *
 * `status` is the only field that can reject the entry: it is what a panel
 * groups and counts by, so an unrecognised value would show up as a fourth
 * status nobody has a colour for. Every other field degrades to a default,
 * because a missing `elapsedMs` costs a column in one row and dropping the
 * whole outcome over it would lose the status too.
 */
function toNodeOutcome(raw: unknown): WorkflowNodeOutcome | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const status = Reflect.get(raw, 'status');
  const rows = Reflect.get(raw, 'rows');
  if (status !== 'succeeded' && status !== 'failed' && status !== 'skipped') {
    return undefined;
  }
  const transformVersion = Reflect.get(raw, 'transformVersion');
  const elapsedMs = Reflect.get(raw, 'elapsedMs');
  const error = Reflect.get(raw, 'error');
  return {
    status,
    rows: typeof rows === 'number' ? rows : 0,
    transformVersion: typeof transformVersion === 'number' ? transformVersion : undefined,
    elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : undefined,
    error: typeof error === 'string' ? error : undefined,
  };
}

/**
 * The key a staged batch is stored under.
 *
 * Derived rather than random so that re-staging the same batch overwrites it.
 * `#` is safe as a separator because `WORKFLOW_NODE_ID_PATTERN` refuses a node
 * id that could contain one, which is checked before any graph is saved — if
 * that ever stopped being true, one node could read another node's rows.
 */
function stageKey(runId: string, nodeId: string, batch: number): string {
  return `${runId}#${nodeId}#${batch}`;
}

function isRowRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toWorkflow(row: WorkflowRow): CatalogWorkflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes: row.nodes.map((node, index) =>
      narrowGraphPart(node, isWorkflowNode, 'node', index, row.id),
    ),
    edges: row.edges.map((edge, index) =>
      narrowGraphPart(edge, isWorkflowEdge, 'edge', index, row.id),
    ),
    status: narrowStatus(row.status, row.id),
    version: row.version,
    graphHash: row.graphHash,
    targetType: row.targetType,
    schedule: row.schedule,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Narrow one stored node or edge, loudly — the same refusal `narrow` above makes
 * about a connector kind, for a sharper reason.
 *
 * Skipping an unrecognised node would leave a graph that still validates and
 * quietly runs nine steps of ten, committing a snapshot that is missing whatever
 * the tenth did. There is no symptom: the load succeeds, the row count is
 * plausible, and the difference only shows up in the data. An unrecognised part
 * almost always means this build is older than the one that wrote it, and saying
 * so is the only safe answer.
 */
function narrowGraphPart<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  what: 'node' | 'edge',
  index: number,
  workflowId: string,
): T {
  if (guard(value)) return value;
  throw new Error(
    `Workflow ${workflowId} has a ${what} at position ${index} this build cannot read. It was most likely written by a newer version of the catalog; running the graph without it would silently change what the load produces.`,
  );
}

function toConnection(row: ConnectionRow): CatalogConnection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: narrow(row.kind, isConnectorKind, 'Connection kind', row.id),
    config: row.config ?? {},
    secretEnvVar: row.secretEnvVar,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString(),
    lastCheckOk: row.lastCheckOk,
    lastCheckError: row.lastCheckError,
  };
}
