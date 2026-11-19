/**
 * The Model screen alone.
 *
 * `@dudousxd/nestjs-catalog-react/manager` exists for a host that mounts this one
 * screen and nothing else. The root entry re-exports every screen in the package,
 * and a bundler that cannot prove a module side-effect free keeps it, so a host
 * importing `CatalogManager` from the root could end up shipping the workflow
 * canvas, the diff viewer and the code editor with it. This entry reaches only
 * what the screen itself imports. The provider and client come from the root
 * entry as before; `CatalogProvider` and its hooks are one module instance either
 * way, because both entries import the same `context.js`.
 */
export { CatalogManager, type CatalogManagerProps } from './CatalogManager.js';
