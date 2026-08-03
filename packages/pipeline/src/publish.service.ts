import {
  CATALOG_STORE,
  type CarryForwardResult,
  type CatalogObjectTypeDef,
  type CatalogPrincipal,
  type CatalogPropertyDef,
  type CatalogWriteStore,
  type SnapshotRef,
  mayWrite,
  supportsCarryForward,
} from '@dudousxd/nestjs-catalog';
import { ObjectTypeRow, PropertyRow, tableFor } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { EntityManager } from '@mikro-orm/mysql';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
}

@Injectable()
export class PublishService {
  private readonly logger = new Logger(PublishService.name);

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
  ) {}

  /**
   * Register or update a type, then bring its physical table in line.
   *
   * Curated fields are filled in only when absent. A publishing application
   * redeploys constantly and would otherwise reset every label a human wrote
   * on the next boot — the whole point of curating in the console is that it
   * survives the next deploy of the app that published the type.
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

    const known = new Map((existing ? row.properties.getItems() : []).map((p) => [p.name, p]));

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

    em.persist(row);
    await em.flush();

    await this.registry.reload();
    const def = this.registry.getType(published.name);
    if (!def) {
      throw new Error(`Type ${published.name} vanished after being written.`);
    }

    await this.store.ensureType(def);
    this.logger.log(`${principal.id} published ${def.name} (${def.properties.length} properties)`);
    return def;
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
    return this.store.carryForward(def, snapshotId, { principalId, labels });
  }

  async commitAsSystem(
    principalId: string,
    typeName: string,
    snapshotId: string,
  ): Promise<SnapshotRef> {
    const def = this.registry.getType(typeName);
    if (!def) throw new NotFoundException(`Unknown object type: ${typeName}`);
    const ref = await this.store.commit(def, snapshotId);
    await this.registry.reload();
    this.logger.log(
      `${principalId} committed ${typeName} snapshot ${snapshotId} (${ref.rowCount} rows)`,
    );
    return ref;
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
