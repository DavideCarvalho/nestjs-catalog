/**
 * What the host told this console about itself, read once.
 *
 * The server writes these values into `<base>/config.js`, which `index.html`
 * loads as an ordinary script before the module bundle. A file rather than an
 * inline `<script>`, so a host whose Content-Security-Policy refuses inline
 * script can still serve the console from its own origin.
 *
 * Every value has a default that reproduces the console as it was before the
 * option existed, so a page served by an older server, or opened without the
 * file, behaves exactly as it always did.
 */

/** Every screen the console can show, in the order the strip shows them. `search` has no tab. */
export const CONSOLE_SCREENS = [
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

export type ConsoleScreen = (typeof CONSOLE_SCREENS)[number];

export interface ConsoleConfig {
  /** The screens to show. Hidden ones get no tab, no panel and no requests. */
  screens: ReadonlySet<ConsoleScreen>;
  /** Whether the Model screen shows its pipeline sections, Loaded by and Load expectation. */
  pipeline: boolean;
  /**
   * Whether the host already knows who is calling, so the console shows no
   * sign-in of its own.
   */
  hostAuth: boolean;
  /**
   * Whether the console may ask `/auth/me` who is calling. False when the host
   * owns identity and serves no such endpoint.
   */
  identity: boolean;
}

interface ConsoleWindow {
  __CATALOG_HOST_AUTH__?: boolean;
  __CATALOG_CONSOLE__?: {
    screens?: unknown;
    pipeline?: unknown;
    identity?: unknown;
  };
}

function isScreen(value: unknown): value is ConsoleScreen {
  return typeof value === 'string' && (CONSOLE_SCREENS as readonly string[]).includes(value);
}

/**
 * The config as the window carries it, with every missing or malformed value
 * replaced by its default. A list naming no screen at all is treated as absent:
 * a console with nothing to show is never what a host meant.
 */
export function readConsoleConfig(source: ConsoleWindow = window as ConsoleWindow): ConsoleConfig {
  const given = source.__CATALOG_CONSOLE__ ?? {};
  const named = Array.isArray(given.screens) ? given.screens.filter(isScreen) : [];
  const hasTab = named.some((screen) => screen !== 'search');
  return {
    screens: new Set(hasTab ? named : CONSOLE_SCREENS),
    pipeline: given.pipeline !== false,
    hostAuth: source.__CATALOG_HOST_AUTH__ === true,
    identity: given.identity !== false,
  };
}
