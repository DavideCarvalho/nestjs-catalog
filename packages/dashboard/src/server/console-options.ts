/**
 * Every screen the console can show. `search` is the one reached by `⌘K` and
 * `#search` rather than by a tab.
 *
 * The client keeps the same list in `src/client/console-config.ts`, because the
 * server and the SPA are separate builds with separate roots;
 * `console-options.spec.ts` fails if the two drift.
 */
export const CATALOG_CONSOLE_SCREENS = [
  'model',
  'objects',
  'query',
  'dashboards',
  'workflows',
  'connections',
  'lineage',
  'activity',
  'access',
  'search',
] as const;

export type CatalogConsoleScreen = (typeof CATALOG_CONSOLE_SCREENS)[number];

/** What a host may say about the console it serves. Every field is optional. */
export interface CatalogConsoleOptions {
  /**
   * The screens to show, and only these. Default: all of them.
   *
   * A hidden screen gets no tab, no panel and no requests, and an address
   * naming it lands on the first screen shown. `'search'` hides the search
   * button, `⌘K` and `#search`. Must name at least one screen other than
   * `'search'`, since search alone has no tab to come back to.
   */
  screens?: readonly CatalogConsoleScreen[];
  /**
   * Whether the Model screen shows **Loaded by** and **Load expectation**, the
   * two sections served by the host's pipeline endpoints. Default `true`. Set
   * `false` for a host that does not mount them: neither section renders and
   * neither `/pipeline/workflows` nor `/pipeline/expectations/:type` is
   * requested.
   */
  pipeline?: boolean;
  /**
   * Set `true` when the host authenticates every request itself and serves no
   * `/auth/me`. The console then shows no sign-in and never calls `/auth/me`.
   * Default `false`. Configuring `auth` already hides the sign-in, but keeps
   * asking `/auth/me` for the Access screen.
   */
  hostAuthenticates?: boolean;
}

/** What the SPA reads from `config.js`, in the shape `readConsoleConfig` expects. */
export interface ResolvedConsoleOptions {
  screens: CatalogConsoleScreen[];
  pipeline: boolean;
  hostAuthenticates: boolean;
}

/**
 * The options with their defaults, refused at module definition when they name
 * something that does not exist. A typo in `screens` would otherwise hide a
 * screen the host meant to show, silently.
 */
export function resolveConsoleOptions(options: CatalogConsoleOptions = {}): ResolvedConsoleOptions {
  const screens = options.screens ?? CATALOG_CONSOLE_SCREENS;
  const unknown = screens.filter(
    (screen) => !(CATALOG_CONSOLE_SCREENS as readonly string[]).includes(screen),
  );
  if (unknown.length > 0) {
    throw new Error(
      `CatalogDashboardModule: unknown console screen(s) ${unknown.map((s) => `"${s}"`).join(', ')}. ` +
        `Known screens: ${CATALOG_CONSOLE_SCREENS.join(', ')}.`,
    );
  }
  if (!screens.some((screen) => screen !== 'search')) {
    throw new Error(
      'CatalogDashboardModule: `screens` must name at least one screen other than "search".',
    );
  }
  return {
    // In the console's own order, whatever order the host listed them in, and once each.
    screens: CATALOG_CONSOLE_SCREENS.filter((screen) => screens.includes(screen)),
    pipeline: options.pipeline !== false,
    hostAuthenticates: options.hostAuthenticates === true,
  };
}
