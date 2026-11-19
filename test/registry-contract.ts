import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  type CatalogDirectory,
  type CatalogRegistry,
  channelNameFor,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';

/**
 * One contract for every stored registry (the catalog model read from its own
 * `object_type`, `property` and `snapshot` tables) and for the directory that
 * reads `principal` beside it.
 *
 * The rows are seeded straight into the tables by a hook each store supplies,
 * because writing the model is the warehouse's and the publisher's job, not the
 * registry's. Each case uses names unique to the run and looks only at those, so
 * the tables may hold other rows.
 */
export interface SeedProperty {
  name: string;
  displayName: string;
  type: string;
  sourceColumn: string;
  physicalColumn: string;
  position: number;
  description?: string;
  hidden?: boolean;
  primary?: boolean;
  nullable?: boolean;
  unit?: string;
  classification?: string;
}

export interface SeedRelation {
  name: string;
  kind: string;
  targetType: string;
  displayName: string;
  description?: string;
  nullable: boolean;
  hidden: boolean;
  position: number;
  owner: boolean;
}

export interface SeedType {
  name: string;
  ownerPrincipalId: string;
  displayName: string;
  pluralDisplayName: string;
  group: string;
  description?: string;
  titleProperty?: string;
  primaryKey: string[];
  physicalTable: string;
  relations?: SeedRelation[];
  properties: SeedProperty[];
}

export interface SeedSnapshot {
  id: string;
  typeName: string;
  snapshotId: string;
  principalId: string;
  rowCount: number;
  committed: boolean;
  createdAt: string;
  committedAt?: string;
}

export interface SeedPrincipal {
  id: string;
  displayName: string;
  keyHash?: string;
  scopes: string[];
  writeTypes: string[];
  readTypes?: string[];
  classifications: string[];
  active: boolean;
  lastSeenAt?: string;
}

export interface SeedModel {
  types?: SeedType[];
  snapshots?: SeedSnapshot[];
  principals?: SeedPrincipal[];
}

export interface RegistryContractStore {
  readonly name: string;
  /** A new registry over the store's tables, not yet loaded. */
  registry(options: { staleAfterMs: number }): CatalogRegistry & { reload(): Promise<void> };
  readonly directory?: CatalogDirectory;
  seed(model: SeedModel): Promise<void>;
  /** Change a type's display name out of band, as another replica's curation would. */
  rename(typeName: string, displayName: string): Promise<void>;
}

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}_${process.pid}_${Date.now().toString(36)}_${counter}`;
}

function order(group: string): { asset: SeedType; site: SeedType } {
  const asset = `asset_${group}`;
  const site = `site_${group}`;
  return {
    asset: {
      name: asset,
      ownerPrincipalId: `fleet_${group}`,
      displayName: 'Asset',
      pluralDisplayName: 'Assets',
      group,
      description: 'Something we own',
      titleProperty: 'tag',
      primaryKey: ['id'],
      physicalTable: `obj_${asset}`,
      relations: [
        {
          name: 'site',
          kind: 'm:1',
          targetType: site,
          displayName: 'Site',
          nullable: true,
          hidden: false,
          position: 1,
          owner: true,
        },
        {
          name: 'vendor',
          kind: 'm:1',
          targetType: `vendor_${group}`,
          displayName: 'Vendor',
          nullable: true,
          hidden: false,
          position: 0,
          owner: true,
        },
      ],
      properties: [
        {
          name: 'tag',
          displayName: 'Tag',
          type: 'string',
          sourceColumn: 'asset_tag',
          physicalColumn: 'tag',
          position: 1,
          unit: 'code',
        },
        {
          name: 'id',
          displayName: 'Id',
          type: 'uuid',
          sourceColumn: 'id',
          physicalColumn: 'id',
          position: 0,
          primary: true,
          nullable: false,
        },
        {
          name: 'weird',
          displayName: 'Weird',
          type: 'not-a-scalar',
          sourceColumn: 'weird',
          physicalColumn: 'weird',
          position: 2,
          hidden: true,
        },
      ],
    },
    site: {
      name: site,
      ownerPrincipalId: `fleet_${group}`,
      displayName: 'Base',
      pluralDisplayName: 'Bases',
      group,
      primaryKey: ['id'],
      physicalTable: `obj_${site}`,
      properties: [
        {
          name: 'id',
          displayName: 'Id',
          type: 'string',
          sourceColumn: 'id',
          physicalColumn: 'id',
          position: 0,
        },
      ],
    },
  };
}

export function describeRegistryContract(boot: () => RegistryContractStore): void {
  describe('the stored registry', () => {
    it('serves the model as rows describe it, in group then display-name order', async () => {
      const subject = boot();
      const group = unique('g');
      const { asset, site } = order(group);
      await subject.seed({ types: [site, asset] });
      const registry = subject.registry({ staleAfterMs: 0 });
      await registry.reload();

      const ours = registry.getSnapshot().types.filter((type) => type.group === group);
      expect(ours.map((type) => type.name)).toEqual([asset.name, site.name]);

      const def = registry.getType(asset.name.toUpperCase());
      expect(def).toMatchObject({
        name: asset.name,
        displayName: 'Asset',
        pluralDisplayName: 'Assets',
        description: 'Something we own',
        tableName: asset.physicalTable,
        group,
        titleProperty: 'tag',
        primaryKey: ['id'],
        enriched: true,
      });
      expect(def?.properties.map((p) => [p.name, p.type, p.order, p.columnName])).toEqual([
        ['id', 'uuid', 0, 'id'],
        ['tag', 'string', 1, 'asset_tag'],
        ['weird', 'unknown', 2, 'weird'],
      ]);
      expect(def?.properties[0]).toMatchObject({ primary: true, nullable: false });
      expect(def?.properties[1]).toMatchObject({ unit: 'code', enriched: true });
      expect(def?.properties[2]).toMatchObject({ hidden: true, enriched: false });
      expect(def?.relations.map((r) => [r.name, r.order, r.targetPublished])).toEqual([
        ['vendor', 0, false],
        ['site', 1, true],
      ]);
      expect(def).not.toHaveProperty('lastCommittedAt');
      expect(registry.getType(unique('missing'))).toBeUndefined();
    });

    it('reports the newest committed snapshot of each type, ignoring uncommitted ones', async () => {
      const subject = boot();
      const group = unique('g');
      const { site } = order(group);
      await subject.seed({
        types: [site],
        snapshots: [
          {
            id: `${site.name}:old`,
            typeName: site.name,
            snapshotId: 'old',
            principalId: 'p-old',
            rowCount: 10,
            committed: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            committedAt: '2026-01-01T00:01:00.000Z',
          },
          {
            id: `${site.name}:new`,
            typeName: site.name,
            snapshotId: 'new',
            principalId: 'p-new',
            rowCount: 42,
            committed: true,
            createdAt: '2026-01-02T00:00:00.000Z',
            committedAt: '2026-01-02T00:01:00.000Z',
          },
          {
            id: `${site.name}:pending`,
            typeName: site.name,
            snapshotId: 'pending',
            principalId: 'p-pending',
            rowCount: 99,
            committed: false,
            createdAt: '2026-01-03T00:00:00.000Z',
          },
        ],
      });
      const registry = subject.registry({ staleAfterMs: 0 });
      await registry.reload();
      expect(registry.getType(site.name)).toMatchObject({
        lastCommittedAt: '2026-01-02T00:01:00.000Z',
        rowCount: 42,
        lastPrincipalId: 'p-new',
      });
    });

    it('curates a type and a property on the rows, and announces it', async () => {
      const subject = boot();
      const group = unique('g');
      const { asset } = order(group);
      await subject.seed({ types: [asset] });
      const registry = subject.registry({ staleAfterMs: 0 });
      await registry.reload();

      const heard: unknown[] = [];
      const listener = (message: unknown) => heard.push(message);
      subscribe(channelNameFor('type.curated'), listener);
      try {
        const patched = await registry.patchType(
          asset.name,
          { displayName: 'Machine', group: `${group}_moved` },
          'curator@example.com',
        );
        expect(patched).toMatchObject({ displayName: 'Machine', group: `${group}_moved` });

        const withProperty = await registry.patchProperty(
          asset.name,
          'tag',
          { displayName: 'Asset tag', hidden: true, order: 9 },
          'curator@example.com',
        );
        expect(withProperty?.properties.find((p) => p.name === 'tag')).toMatchObject({
          displayName: 'Asset tag',
          hidden: true,
          order: 9,
        });

        const withRelation = await registry.patchProperty(
          asset.name,
          'site',
          { displayName: 'Home base', description: 'Where it lives' },
          '',
        );
        expect(withRelation?.relations.find((r) => r.name === 'site')).toMatchObject({
          displayName: 'Home base',
          description: 'Where it lives',
          enriched: true,
        });
      } finally {
        unsubscribe(channelNameFor('type.curated'), listener);
      }
      expect(heard).toHaveLength(3);
      expect(JSON.stringify(heard[0])).toContain('curator@example.com');

      // On the rows: a second registry over the same tables sees it.
      const other = subject.registry({ staleAfterMs: 0 });
      await other.reload();
      expect(other.getType(asset.name)?.displayName).toBe('Machine');
      expect(other.getType(asset.name)?.relations.find((r) => r.name === 'site')?.displayName).toBe(
        'Home base',
      );
    });

    it('answers undefined for a type or property that does not exist', async () => {
      const subject = boot();
      const group = unique('g');
      const { site } = order(group);
      await subject.seed({ types: [site] });
      const registry = subject.registry({ staleAfterMs: 0 });
      await registry.reload();
      expect(await registry.patchType(unique('nope'), { displayName: 'x' }, 'a')).toBeUndefined();
      expect(
        await registry.patchProperty(site.name, 'nope', { displayName: 'x' }, 'a'),
      ).toBeUndefined();
      await expect(registry.resetOverlay('a')).rejects.toThrow(/no overlay/);
    });

    it('notices a change another replica made, after staleAfterMs', async () => {
      const subject = boot();
      const group = unique('g');
      const { site } = order(group);
      await subject.seed({ types: [site] });
      const registry = subject.registry({ staleAfterMs: 50 });
      await registry.reload();
      expect(registry.getType(site.name)?.displayName).toBe('Base');

      await subject.rename(site.name, 'Depot');
      let seen = registry.getType(site.name)?.displayName;
      for (let tries = 0; tries < 60 && seen !== 'Depot'; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        seen = registry.getType(site.name)?.displayName;
      }
      expect(seen).toBe('Depot');
    });
  });

  describe('the directory', () => {
    it('lists applications with what they own and how they authenticate', async () => {
      const subject = boot();
      if (!subject.directory) return;
      const group = unique('g');
      const { asset, site } = order(group);
      const owner = asset.ownerPrincipalId;
      await subject.seed({
        types: [site, asset],
        principals: [
          {
            id: owner,
            displayName: `zz ${group} fleet`,
            keyHash: 'a'.repeat(64),
            scopes: ['catalog:write'],
            writeTypes: [asset.name],
            classifications: ['internal'],
            active: true,
            lastSeenAt: '2026-03-01T12:00:00.000Z',
          },
          {
            id: `idp_${group}`,
            displayName: `aa ${group} idp`,
            scopes: ['catalog:read'],
            writeTypes: [],
            readTypes: [site.name],
            classifications: [],
            active: false,
          },
        ],
      });
      const apps = (await subject.directory.listApplications()).filter((app) =>
        app.displayName.includes(group),
      );
      expect(apps.map((app) => app.id)).toEqual([`idp_${group}`, owner]);
      expect(apps[0]).toMatchObject({
        authMethod: 'token',
        readTypes: [site.name],
        lastSeenAt: null,
        active: false,
        ownedTypes: [],
      });
      expect(apps[1]).toMatchObject({
        authMethod: 'key',
        readTypes: null,
        lastSeenAt: '2026-03-01T12:00:00.000Z',
        scopes: ['catalog:write'],
        ownedTypes: [asset.name, site.name].sort(),
      });
      expect(JSON.stringify(apps)).not.toContain('a'.repeat(64));
    });
  });
}
