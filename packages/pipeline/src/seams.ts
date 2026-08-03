import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';

/**
 * The two things this package cannot decide for itself.
 *
 * The pipeline is the same engine in every deployment, but two details are not:
 * WHICH EntityManager a write lands on, and WHICH registry object it reads the
 * model from. Both were concrete imports in the two applications this package
 * was extracted from, and they disagreed:
 *
 * | | standalone flip-catalog | flip-nestjs |
 * |---|---|---|
 * | EntityManager | `requireEnvironmentBundle().em` (per environment) | `CATALOG_STORE_ENTITY_MANAGER` (one connection) |
 * | registry | `RoutingCatalogRegistry` | `StoredCatalogRegistry` |
 *
 * Neither difference reaches the engine's logic — both registries are used only
 * for `reload()` and `getType()`, and the EntityManager is only ever forked. So
 * they are injected rather than imported, and the host binds whichever it has.
 *
 * The EntityManager is a **function**, not a value, and that is the point: a
 * multi-environment host resolves it per call from whatever scope is active, and
 * a value captured at construction would pin every write to the environment that
 * happened to be current when the module booted. Writing to the wrong database
 * is not a type error, and the rows land successfully.
 */

/** Resolves the EntityManager a write should land on, at the moment of the write. */
export const CATALOG_PIPELINE_EM = Symbol('CATALOG_PIPELINE_EM');
export type CatalogPipelineEmResolver = () => EntityManager;

/** The slice of a catalog registry the pipeline needs. */
export interface CatalogPipelineRegistry {
  reload(): Promise<void>;
  getType(name: string): CatalogObjectTypeDef | undefined;
}
export const CATALOG_PIPELINE_REGISTRY = Symbol('CATALOG_PIPELINE_REGISTRY');

/**
 * Runs a durable step's body inside whatever scope the host needs.
 *
 * A durable step arrives as a message off a queue, not a request, so it carries
 * no ambient scope. A host that routes one pipeline store across several
 * environments has to enter one before the step touches a store; a host with a
 * single connection has nothing to enter. The default is pass-through, so the
 * single-connection case configures nothing.
 */
export const CATALOG_PIPELINE_SCOPE = Symbol('CATALOG_PIPELINE_SCOPE');
export interface CatalogPipelineScope {
  /**
   * Always a promise, both in and out. Every caller here is async, and a
   * `T | Promise<T>` signature pushes an `await` into each of them for a
   * synchronous case that does not exist.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
}
export const passthroughScope: CatalogPipelineScope = { run: (fn) => fn() };
