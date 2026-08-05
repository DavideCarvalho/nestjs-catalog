/**
 * Build-time entry point: things a host's bundler config imports, not its app.
 *
 * Kept off the package's main entry deliberately. Everything reachable from
 * `index.ts` is resolved and bundled by the host whether or not it renders it,
 * and a build plugin has no business in a browser graph — the same reason
 * `WorkflowCanvas` and the chart renderers sit on their own subpaths.
 *
 *     import { shikiSubset } from "@dudousxd/nestjs-catalog-react/bundler";
 *
 * The `.js` on the specifiers below is the one thing that differs from every
 * other file in this package, and it is not style. Everywhere else the importer
 * is a bundler, which resolves an extensionless path; here it is NODE, because
 * Vite loads `vite.config.ts` by bundling it and then importing the result, and
 * an external dependency of that config is resolved by Node's ESM rules — which
 * do not guess extensions. Without these this subpath throws ERR_MODULE_NOT_FOUND
 * inside the config file, before a single line of the build runs.
 */
export { shikiSubset, type ShikiSubsetPlugin } from './shiki-subset.js';
export {
  CATALOG_CODE_LANGUAGES,
  CATALOG_CODE_THEMES,
  type CatalogCodeLanguage,
  type CatalogCodeTheme,
} from '../ui/code-languages.js';
