import { join } from 'node:path';
import { type DynamicModule, Module } from '@nestjs/common';
import { createAccessController } from './access.controller';
import { createCatalogController } from './catalog.controller';
import { CATALOG_OPTIONS, type CatalogModuleOptions } from './catalog.options';
import { type CatalogOverlayStore, FileCatalogOverlayStore } from './catalog.overlay-store';
import { CATALOG_OVERLAY_STORE } from './catalog.overlay-store.token';
import { MikroOrmCatalogRegistry } from './catalog.registry';
import { CatalogRegistry } from './catalog.registry.base';
import { CatalogService } from './catalog.service';
import { CATALOG_STORE } from './catalog.store';
import { MikroOrmReadStore } from './stores/mikro-orm-read.store';

@Module({})
export class CatalogModule {
  static forRoot(options: CatalogModuleOptions = {}): DynamicModule {
    const path = options.path ?? 'api/catalog';
    const mountController = options.controller !== false;
    const controllers = mountController
      ? [
          createCatalogController(path, options.guards ?? [], options.decorators ?? []),
          createAccessController(
            options.accessPath ?? siblingPath(path, 'access'),
            options.guards ?? [],
            options.decorators ?? [],
          ),
        ]
      : [];

    const overlayStore: CatalogOverlayStore =
      options.overlayStore ??
      new FileCatalogOverlayStore(
        options.overlayPath ?? join(process.cwd(), '.catalog', 'overlay.json'),
      );

    return {
      module: CatalogModule,
      imports: options.imports ?? [],
      controllers,
      providers: [
        { provide: CATALOG_OPTIONS, useValue: options },
        { provide: CATALOG_OVERLAY_STORE, useValue: overlayStore },
        // The MikroORM-backed defaults are registered only when nothing
        // overrides them. Registering them unconditionally would be worse than
        // wasteful: a provider declared in this module shadows the same token
        // exported by an imported one, so the default would quietly win over
        // the host's override and the failure would look like the override
        // never took effect.
        //
        // Derived is the right default — the model comes from the ORM of the
        // application that owns the tables, and the rows come from those same
        // tables, so nothing is stale and no infrastructure is needed. A
        // warehouse overrides both: its model arrived over the wire and there
        // are no entity classes to reflect over.
        ...(options.registry
          ? [options.registry]
          : [
              MikroOrmCatalogRegistry,
              {
                provide: CatalogRegistry,
                useExisting: MikroOrmCatalogRegistry,
              },
            ]),
        ...(options.store
          ? [options.store]
          : [MikroOrmReadStore, { provide: CATALOG_STORE, useExisting: MikroOrmReadStore }]),
        // No default. Unlike the store and the registry there is nothing
        // sensible to derive: who may reach a catalog is not a fact about its
        // model. Absent, the Access routes answer 501 naming the token, which
        // is the honest state for a host that has not decided yet.
        ...(options.directory ? [options.directory] : []),
        CatalogService,
      ],
      exports: [CatalogRegistry, CatalogService, CATALOG_STORE],
    };
  }
}

/**
 * `api/catalog` + `access` -> `api/access`.
 *
 * Replacing the last segment rather than appending, because the console builds
 * the two paths as siblings under one API root. Appending would give
 * `api/catalog/access`, which the console never asks for — and the symptom is a
 * screen that 404s while the module reports itself mounted.
 */
function siblingPath(path: string, segment: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parent = trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
  return `${parent}${segment}`;
}
