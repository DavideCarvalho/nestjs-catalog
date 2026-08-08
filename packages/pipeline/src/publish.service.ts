import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CarryForwardResult,
  type CatalogObjectTypeDef,
  type CatalogPipelineStore,
  type CatalogPrincipal,
  type CatalogPropertyDef,
  type CatalogWriteStore,
  type SnapshotRef,
  mayWrite,
  supportsCarryForward,
} from '@dudousxd/nestjs-catalog';
import {
  ObjectTypeRow,
  PropertyRow,
  type PublishedRelation,
  tableFor,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { EntityManager } from '@mikro-orm/mysql';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  CATALOG_LOAD_EXPECTATIONS,
  type CatalogLoadExpectations,
  type LoadExpectation,
  LoadExpectationError,
  refuseRowCountDrift,
  refuseStaleReconciliation,
  refuseUndeclaredDeletes,
  resolveLoadExpectation,
  rowCountBoundOf,
} from './load-expectations';
import {
  describeStoredUnpublishableNames,
  refuseUnpublishablePropertyNames,
} from './property-names';
import { refuseUnusableRelations } from './relation-shape';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  type CatalogPipelineEmResolver,
  type CatalogPipelineRegistry,
} from './seams';

/** What a publisher sends to describe a type. */
export interface PublishedType {
  name: string;
  displayName?: string;
  pluralDisplayName?: string;
  description?: string;
  icon?: string;
  group?: string;
  titleProperty?: string;
  primaryKey?: string[];
  properties: Array<{
    name: string;
    displayName?: string;
    description?: string;
    type: string;
    columnName?: string;
    nullable?: boolean;
    primary?: boolean;
    hidden?: boolean;
    order?: number;
    classification?: string;
    unit?: string;
  }>;

  /**
   * The links this type declares — what makes the catalog an ontology rather
   * than a list of tables.
   *
   * Structurally optional and semantically three-valued, which is the part worth
   * reading. **Absent** means the publisher said nothing about links: an
   * application on a client that predates this field, or one that only ever
   * describes columns. **Present and empty** means it said there are none. The
   * two cannot be collapsed, because a publishing application re-publishes its
   * whole shape on every deploy — treating a missing key as "no links" would
   * wipe every link and every label a curator had put on one, on the next deploy
   * of a publisher that had simply not been upgraded. `primaryKey` above draws
   * the same distinction, for the same reason.
   *
   * `PublishedRelation` rather than `StoredRelation`: name, kind and target are
   * the link and a payload without them describes nothing, while a label is
   * something the publisher may not have and the console can supply later.
   *
   * Note that `position` is what orders these, where a property above is ordered
   * by `order`. The asymmetry is real and harmless: `mergeRelations` falls back
   * to the array index, so a host sending its `CatalogRelationDef[]` verbatim —
   * which carries `order`, not `position` — keeps the order it sent them in,
   * because that array is already sorted by it.
   */
  relations?: PublishedRelation[];
}

@Injectable()
export class PublishService {
  private readonly logger = new Logger(PublishService.name);
  /** Keys already warned about, not necessarily type names. See `warnOnce`. */
  private readonly warned = new Set<string>();

  constructor(
    // Resolved per call rather than injected as a value: a host that serves
    // several environments picks the connection from whatever scope is active,
    // and a value captured here would pin every write to the environment that
    // was current when the module booted. Writing to the wrong database is not
    // a type error, and the rows land successfully.
    @Inject(CATALOG_PIPELINE_EM)
    private readonly resolveEm: CatalogPipelineEmResolver,
    @Inject(CATALOG_PIPELINE_REGISTRY)
    private readonly registry: CatalogPipelineRegistry,
    @Inject(CATALOG_STORE) private readonly store: CatalogWriteStore,
    // Optional so that binding nothing is a boot that succeeds rather than a
    // host that cannot start after upgrading. What it is not is a host that
    // keeps its old behaviour: an unbound policy declares nothing about
    // deletes, and an incremental load of a type nobody has declared anything
    // about is refused. See `load-expectations.ts`.
    @Optional()
    @Inject(CATALOG_LOAD_EXPECTATIONS)
    private readonly expectations?: CatalogLoadExpectations,
    // The middle layer of the policy, and the only reason this service knows the
    // pipeline store exists. An operator sets a per-type expectation through
    // `PUT pipeline/expectations/:type`; it is stored here, and this is where it
    // has to be read back, because both enforcement sites are in this class and
    // a policy read anywhere else would be a second answer.
    //
    // `@Optional()`, and not defensively: a worker-only host binds the write
    // store and no pipeline store at all, and the specs in this package
    // construct this service by hand. Absent means no stored layer, which is
    // exactly the behaviour of every deployment before this existed.
    @Optional()
    @Inject(CATALOG_PIPELINE_STORE)
    private readonly pipeline?: CatalogPipelineStore,
  ) {}

  /**
   * Register or update a type, then bring its physical table in line.
   *
   * Curated fields are filled in only when absent. A publishing application
   * redeploys constantly and would otherwise reset every label a human wrote
   * on the next boot — the whole point of curating in the console is that it
   * survives the next deploy of the app that published the type.
   *
   * **A property whose `name` cannot be a SQL identifier is refused here**,
   * before anything is written, because the alternative is where that refusal
   * used to land: at the first commit, with the source read in full and every
   * row of it already stored. See `property-names.ts` — including why a name
   * this type already holds is warned about rather than refused.
   */
  async upsertType(
    principal: CatalogPrincipal,
    published: PublishedType,
  ): Promise<CatalogObjectTypeDef> {
    this.assertMayWrite(principal, published.name);
    if (!published.properties?.length) {
      throw new BadRequestException(`Type ${published.name} was published with no properties.`);
    }

    const em = this.resolveEm().fork();
    const existing = await em.findOne(
      ObjectTypeRow,
      { name: published.name },
      { populate: ['properties'] },
    );

    if (existing && existing.ownerPrincipalId !== principal.id) {
      throw new ForbiddenException(
        `${published.name} is owned by ${existing.ownerPrincipalId}. Two applications publishing one type would fight over its shape.`,
      );
    }

    // The properties this type already holds, read before anything is created
    // so that the name check below can tell a property being ADDED from one that
    // is merely being re-sent. Also the map the merge loop uses further down —
    // one reading of "what is already here", because two would be two answers.
    const known = new Map(
      (existing?.properties.getItems() ?? []).map((p): [string, PropertyRow] => [p.name, p]),
    );

    // Before the row is created, before the flush and before `ensureType`, which
    // is the whole point.
    this.assertPropertyNamesArePublishable(published, known);
    this.assertRelationsAreUsable(published);

    const row =
      existing ??
      em.create(ObjectTypeRow, {
        name: published.name,
        ownerPrincipalId: principal.id,
        displayName: published.displayName ?? published.name,
        pluralDisplayName:
          published.pluralDisplayName ?? `${published.displayName ?? published.name}s`,
        group: published.group ?? 'Ungrouped',
        primaryKey: published.primaryKey ?? [],
        physicalTable: tableFor(published.name),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    row.primaryKey = published.primaryKey ?? row.primaryKey;
    row.description ??= published.description;
    row.icon ??= published.icon;
    row.titleProperty ??= published.titleProperty;

    published.properties.forEach((property, index) => {
      const target =
        known.get(property.name) ??
        em.create(PropertyRow, {
          id: `${published.name}.${property.name}`,
          objectType: row,
          name: property.name,
          displayName: property.displayName ?? property.name,
          type: property.type,
          sourceColumn: property.columnName ?? property.name,
          physicalColumn: property.name,
          nullable: property.nullable ?? true,
          primary: property.primary ?? false,
          hidden: property.hidden ?? false,
          position: property.order ?? index,
        });

      // Structural facts always follow the publisher; curated ones do not.
      target.type = property.type;
      target.sourceColumn = property.columnName ?? property.name;
      target.nullable = property.nullable ?? true;
      target.primary = property.primary ?? false;
      target.description ??= property.description;
      target.unit ??= property.unit;
      target.classification ??= property.classification;

      em.persist(target);
    });

    // The links, through the row's own merge rule rather than by assignment
    // here: which fields follow the publisher and which stay with whoever
    // curated them is a property of the column, and a second copy of that
    // judgement in this file is a second copy that drifts. See
    // `ObjectTypeRow.mergeRelations`.
    //
    // Only when the key is there at all — see the field's docblock. A publisher
    // that says nothing about links leaves the ones already stored alone; one
    // that sends an empty array has said there are none, and the merge drops
    // them.
    //
    // Both the array guard and the per-link checks ran in
    // `assertRelationsAreUsable` above, before anything was created — so by here
    // this is an array of links that can be stored, and the merge is the only
    // decision left.
    if (published.relations !== undefined) {
      row.mergeRelations(published.relations);
    }

    em.persist(row);
    await em.flush();

    await this.registry.reload();
    const def = this.registry.getType(published.name);
    if (!def) {
      throw new Error(`Type ${published.name} vanished after being written.`);
    }

    await this.store.ensureType(def);
    // Relations in the line for the same reason the registry prints them at
    // boot: a publisher that stopped carrying links, or a wire that stopped
    // accepting them, shows up here as a zero and nowhere else until somebody
    // opens the graph and finds it bare.
    this.logger.log(
      `${principal.id} published ${def.name} (${def.properties.length} properties, ${def.relations.length} relations)`,
    );
    return def;
  }

  /**
   * Refuse a publish that would add a property whose name cannot be SQL, and
   * say out loud the ones it deliberately lets through.
   *
   * Called from `upsertType` with the type's stored properties in hand and
   * before anything is written — that ordering is the entire point and is what
   * `publish.property-names.spec.ts` asserts on, because the refusal itself was
   * always going to happen, just far too late. `property-names.ts` holds both
   * decisions and the reasoning for each; nothing is decided here.
   *
   * The warning is keyed under a prefix of its own so that it cannot silence —
   * or be silenced by — the store-capability warnings in
   * `assertRowCountIsPlausible`, which key on the bare type name and whose
   * docblock reasons about the two of them alone.
   */
  private assertPropertyNamesArePublishable(
    published: PublishedType,
    known: ReadonlyMap<string, PropertyRow>,
  ): void {
    const refusal = refuseUnpublishablePropertyNames(
      published.name,
      published.properties,
      new Set(known.keys()),
    );
    if (refusal) throw new BadRequestException(refusal);

    const stored = describeStoredUnpublishableNames(published.name, known.keys());
    if (stored) this.warnOnce(`unpublishable-names:${published.name}`, stored);
  }

  /**
   * Refuse a publish whose links cannot be stored as written.
   *
   * Beside `assertPropertyNamesArePublishable` and called in the same place for
   * the same reason: everything needed to answer is in the payload, so it is
   * answered before a row exists rather than left to surface as a picture that
   * is quietly wrong. `relation-shape.ts` holds every decision and the argument
   * for each — including the three this deliberately does NOT make.
   *
   * **A refusal, where the property check has a warning half.** There is no
   * `describeStored…` counterpart, and the asymmetry is real rather than an
   * omission: a property is additive and permanent, so a bad one already stored
   * can never be republished away and warning is all that is left. Relations are
   * replaced wholesale on every publish — `mergeRelations` drops anything the
   * publisher stopped sending — so a bad one stored before this check existed is
   * fixed by the very next publish that gets it right. Nothing is stranded, so
   * nothing needs to be tolerated.
   *
   * The array guard lives here rather than at the merge, so that the shape of
   * the field and the shape of its contents are answered together and both
   * before anything is created. It is the same guard `appendRows` puts on
   * `rows`: without it a publisher that sent `"relations": {}` gets a 500 out of
   * `.map` rather than being told what it sent wrong.
   */
  private assertRelationsAreUsable(published: PublishedType): void {
    if (published.relations === undefined) return;
    if (!Array.isArray(published.relations)) {
      throw new BadRequestException('`relations` must be an array.');
    }
    const refusal = refuseUnusableRelations(published.name, published.relations);
    if (refusal) throw new BadRequestException(refusal);
  }

  async appendRows(
    principal: CatalogPrincipal,
    typeName: string,
    snapshotId: string,
    rows: Array<Record<string, unknown>>,
    labels?: Record<string, string>,
    batch?: number,
  ): Promise<{ written: number }> {
    const def = this.requireOwnedType(principal, typeName);
    if (!Array.isArray(rows)) {
      throw new BadRequestException('`rows` must be an array.');
    }
    return this.store.write(def, rows, {
      snapshotId,
      principalId: principal.id,
      batch,
      labels,
    });
  }

  async commit(
    principal: CatalogPrincipal,
    typeName: string,
    snapshotId: string,
  ): Promise<SnapshotRef> {
    const def = this.requireOwnedType(principal, typeName);
    await this.assertRowCountIsPlausible(def, snapshotId);
    const ref = await this.store.commit(def, snapshotId);
    await this.registry.reload();
    this.logger.log(
      `${principal.id} committed ${typeName} snapshot ${snapshotId} (${ref.rowCount} rows)`,
    );
    return ref;
  }

  async listSnapshots(typeName: string): Promise<SnapshotRef[]> {
    const def = this.registry.getType(typeName);
    if (!def) throw new NotFoundException(`Unknown object type: ${typeName}`);
    return this.store.listSnapshots?.(def) ?? [];
  }

  /**
   * The append path a connector uses.
   *
   * Separate from `appendRows` because a connector run has already been
   * authorised — the principal was checked when the run was started — and it
   * carries the connector's identity rather than a request's. It still goes
   * through the same store, the same batches and the same commit, so there is
   * exactly one way rows arrive.
   */
  async appendRowsAsSystem(
    principalId: string,
    typeName: string,
    snapshotId: string,
    rows: Array<Record<string, unknown>>,
    labels: Record<string, string>,
    batch: number,
  ): Promise<{ written: number }> {
    const def = this.registry.getType(typeName);
    if (!def) {
      throw new NotFoundException(
        `${typeName} has not been published yet. A connector cannot create a type — send its schema first.`,
      );
    }
    return this.store.write(def, rows, {
      snapshotId,
      principalId,
      batch,
      labels,
    });
  }

  /**
   * Finish an incremental load into a complete snapshot.
   *
   * Called once, after the last batch and before the commit — the order is the
   * store's, not a preference of this method's, and the store refuses to commit
   * a snapshot whose batches arrived after its merge.
   *
   * The capability is checked rather than assumed. A store that cannot merge
   * has to make the run fail here: carrying on would commit whatever slice the
   * source handed over as the entire dataset, and the load would look like a
   * success while quietly deleting everything that did not change.
   *
   * **This is also the one place every incremental load passes through**, which
   * is why the delete-reconciliation gate is here and not in the connector
   * runner. A connector run, a workflow sink and anything written against this
   * service later all reach an incremental load by calling this method — the
   * merge IS the incremental load — so a check here cannot be routed around,
   * and one in the runner would have covered a third of the paths.
   * `ConnectorRunSteps` asks the same question earlier and more cheaply for a
   * scheduled run; it does not replace this.
   */
  async carryForwardAsSystem(
    principalId: string,
    typeName: string,
    snapshotId: string,
    labels: Record<string, string>,
  ): Promise<CarryForwardResult> {
    const def = this.registry.getType(typeName);
    if (!def) throw new NotFoundException(`Unknown object type: ${typeName}`);
    if (!supportsCarryForward(this.store)) {
      throw new BadRequestException(
        `The configured store cannot carry a snapshot forward, so an incremental load of ${typeName} would commit only the rows that changed as if they were the whole dataset. Run this connector in "full" mode until a store that can merge is configured.`,
      );
    }

    const expectation = await this.expectationFor(typeName);
    const undeclared = refuseUndeclaredDeletes(typeName, expectation);
    if (undeclared) throw new LoadExpectationError(typeName, 'deletes', undeclared);

    // Only asked once the declaration is in hand, and only when that
    // declaration was `periodic-full-reload` — the snapshot list costs a query,
    // and the other two strategies have nothing for it to date.
    const stale = refuseStaleReconciliation(
      typeName,
      expectation,
      await this.snapshotsOf(def),
      Date.now(),
    );
    if (stale) throw new LoadExpectationError(typeName, 'deletes', stale);

    return this.store.carryForward(def, snapshotId, { principalId, labels });
  }

  async commitAsSystem(
    principalId: string,
    typeName: string,
    snapshotId: string,
  ): Promise<SnapshotRef> {
    const def = this.registry.getType(typeName);
    if (!def) throw new NotFoundException(`Unknown object type: ${typeName}`);
    await this.assertRowCountIsPlausible(def, snapshotId);
    const ref = await this.store.commit(def, snapshotId);
    await this.registry.reload();
    this.logger.log(
      `${principalId} committed ${typeName} snapshot ${snapshotId} (${ref.rowCount} rows)`,
    );
    return ref;
  }

  /**
   * Refuse a commit that would replace the live dataset with something too far
   * from it to be an accident of the data.
   *
   * Both commit paths call it, and that is the point: an application POSTing
   * twelve rows to the publish API and a connector fetching twelve rows are the
   * same failure, and gating only the connector would leave the other half of
   * the write surface unguarded.
   *
   * Before the commit rather than after, because the commit is atomic and by
   * the time it returns the wrong data is what everybody is reading. What a
   * refusal leaves behind is exactly right on its own: the snapshot stays
   * written and uncommitted, the previously served one keeps serving, and the
   * rows are still there to be looked at while working out what the source did.
   *
   * **Skipped, loudly, when the store cannot answer.** Both `listSnapshots` and
   * `currentSnapshot` are optional on the store interface. Without the first
   * there is no count for the pending snapshot; without the second there is no
   * baseline, and `catalog.store.ts` is explicit that reconstructing one from
   * the snapshot list names the wrong row the moment somebody has rolled a bad
   * load back — which is precisely when a load is being watched. Refusing
   * instead would turn an additive safety check into a hard break for every
   * adapter compiled against an older version of that interface, including ones
   * this repository does not own, so it warns and stands aside.
   */
  private async assertRowCountIsPlausible(
    def: CatalogObjectTypeDef,
    snapshotId: string,
  ): Promise<void> {
    const listSnapshots = this.store.listSnapshots?.bind(this.store);
    const currentSnapshot = this.store.currentSnapshot?.bind(this.store);
    if (!listSnapshots || !currentSnapshot) {
      this.warnOnce(
        // Shares `def.name` with the pending-snapshot warning below, and that
        // is safe rather than sloppy: this branch fires only when the store is
        // MISSING one of the two members, and that one is reached only when it
        // has both. One instance holds one store, so the two can never both
        // fire for the same type and neither can silence the other.
        def.name,
        `The configured store cannot say ${!currentSnapshot ? 'which snapshot it is serving' : 'what it has written'}, so the row-count expectation on ${def.name} cannot be enforced and a load that collapses will commit unnoticed.`,
      );
      return;
    }

    const previous = await currentSnapshot(def);
    // Nothing has ever committed. The first load of a type IS the baseline, and
    // inventing one to measure it against would be inventing the answer.
    if (!previous) return;

    const pending = (await listSnapshots(def)).find((snapshot) => snapshot.id === snapshotId);
    if (!pending) {
      // The store does not report the snapshot about to be committed — an
      // adapter that lists only committed ones, or a window too short to reach
      // it. WHETHER IT EXISTS is still `commit`'s question, and it answers it
      // better than a guess from here would.
      //
      // But the bound standing down is this method's business, and it used to
      // happen in silence — so the other branch of this same method warned that
      // it could not enforce the expectation, and this one said nothing at all
      // while doing exactly the same thing. A host reading `maxShrink` in its
      // configuration had no way to learn it was decorative on this adapter.
      //
      // Warned rather than refused, matching the branch above and for the
      // reason its docblock gives at length: refusing here would break every
      // store that reports less than the bundled one, including adapters
      // outside this repository. Turning either branch into a refusal is one
      // decision about both, not a change smuggled into the one nobody
      // documented.
      this.warnOnce(
        def.name,
        `The configured store did not list snapshot ${snapshotId} of ${def.name} among the snapshots it reports, so there is no row count to measure and the row-count bound is standing down for this commit. An adapter that lists only committed snapshots, or whose window is shorter than a load, hits this every time.`,
      );
      return;
    }

    const refusal = refuseRowCountDrift({
      typeName: def.name,
      snapshotId,
      previous,
      pending: pending.rowCount,
      pendingLabels: pending.labels,
      bound: rowCountBoundOf(await this.expectationFor(def.name)),
    });
    if (refusal) throw new LoadExpectationError(def.name, 'row-count', refusal);
  }

  /**
   * The policy in force for a type, across all three layers.
   *
   * Both enforcement sites in this class go through it, which is the property
   * that matters: the deletes gate and the row-count bound reading the policy
   * from two different places is how a type ends up declared for one check and
   * undeclared for the other.
   *
   * Async only because the stored layer is a row somewhere. The rules it feeds
   * stay pure and synchronous — see `load-expectations.ts` — so what is awaited
   * here is the sourcing and nothing else.
   */
  private async expectationFor(typeName: string): Promise<LoadExpectation> {
    return (await resolveLoadExpectation(this.expectations, this.pipeline, typeName)).resolved;
  }

  /** Snapshots of a type, or none when the store does not keep a list. */
  private async snapshotsOf(def: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    return (await this.store.listSnapshots?.(def)) ?? [];
  }

  /**
   * One line per key per process, not one per load.
   *
   * A capability gap does not change between two loads of the same type, and a
   * warning repeated on every run of an hourly connector is a warning that gets
   * filtered out — which would lose the one reader it was written for. The same
   * holds for a property name stored years ago, which is why `upsertType` is
   * here too.
   *
   * The key is a type name in the two capability warnings and a prefixed one in
   * `upsertType`, deliberately: two unrelated things said about one type must
   * not be able to swallow each other, and a bare name for both would mean
   * whichever spoke first won.
   */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }

  private requireOwnedType(principal: CatalogPrincipal, typeName: string): CatalogObjectTypeDef {
    this.assertMayWrite(principal, typeName);
    const def = this.registry.getType(typeName);
    if (!def) {
      throw new NotFoundException(`${typeName} has not been published yet. Send its schema first.`);
    }
    return def;
  }

  private assertMayWrite(principal: CatalogPrincipal, typeName: string): void {
    if (!mayWrite(principal, typeName)) {
      throw new ForbiddenException(`${principal.id} may not write ${typeName}.`);
    }
  }
}

export type { CatalogPropertyDef };
