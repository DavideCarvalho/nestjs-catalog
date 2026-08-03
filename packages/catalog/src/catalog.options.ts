import type { DynamicModule, ForwardReference, Provider, Type } from '@nestjs/common';
import type { CatalogOverlayStore } from './catalog.overlay-store';

export const CATALOG_OPTIONS = Symbol('CATALOG_OPTIONS');

export interface CatalogModuleOptions {
  /** Only expose these entity class names. Empty/undefined means all of them. */
  include?: string[];
  /** Never expose these, whatever else says. */
  exclude?: string[];
  /** Group for types that declare none. */
  defaultGroup?: string;
  /** Where tier-0 edits are persisted. Defaults to a JSON file. */
  overlayPath?: string;
  overlayStore?: CatalogOverlayStore;
  /**
   * Route prefix for the introspection + object-read API.
   * Defaults to `api/catalog`.
   */
  path?: string;
  /**
   * Guards applied to every catalog route. The library ships none: an
   * introspection endpoint that lists every table in the system is exactly the
   * kind of thing that should never be open by default, and only the host app
   * knows what its auth looks like.
   */
  guards?: Type<unknown>[];
  /**
   * Extra class decorators applied to the generated controller — the escape
   * hatch for host-specific metadata (roles, rate limits, audit tags) that a
   * generic library has no business knowing the shape of.
   */
  decorators?: ClassDecorator[];
  /**
   * Modules this dynamic module should import.
   *
   * Needed because Nest instantiates a guard in the injector of the module that
   * *declares* the controller — which, for a library that generates its own
   * controller, is the library's module and not yours. Whatever your guards
   * inject has to be resolvable from here.
   */
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  /**
   * Where the objects live. A provider for `CATALOG_STORE`.
   *
   * Defaults to reading the host application's own tables through MikroORM,
   * which is always current and needs no infrastructure. Supply a warehouse
   * adapter instead when the catalog should hold its own copy and keep history
   * — the trade is a load to schedule and a staleness window to explain.
   */
  store?: Provider;
  /**
   * Where the type definitions come from. A provider for `CatalogRegistry`.
   *
   * Defaults to deriving them from the host's MikroORM metadata. A warehouse
   * that receives its model from other applications binds a stored
   * implementation here instead.
   */
  registry?: Provider;
  /**
   * Mount the built-in controller. Default true.
   *
   * Set false to keep the registry and reads but publish your own routes:
   * inject `CatalogService` by class and shape the HTTP surface however your
   * app already shapes it. Everything the built-in controller does is on that
   * one service.
   */
  controller?: boolean;
  /** Hard cap on generic object reads, so the explorer cannot pull a table. */
  maxPageSize?: number;
  /** Hard cap on rows an ad-hoc query may return. Default 1000. */
  maxQueryRows?: number;
  /**
   * How long a query may run. Default 15s.
   *
   * A console where anyone can write a cartesian join needs this more than it
   * needs a bigger row cap — a query that returns nothing for four minutes is
   * holding a connection the whole time.
   */
  queryTimeoutMs?: number;
}
