import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogUiController } from './catalog-ui.controller.js';
import { type CatalogConsoleOptions, resolveConsoleOptions } from './console-options.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

/**
 * How often serving the console touches the disk.
 *
 * The page and its assets are files the package build wrote, so a request has
 * nothing to read that the previous one did not — except after a rebuild, which
 * the index has to notice because it names the rebuilt bundle's hashed files.
 */

const INDEX = `<html><head><script src="/catalog/assets/app-1.js"></script></head><body></body></html>`;

let spa: string;

function controller(
  auth: unknown = null,
  options: CatalogConsoleOptions = {},
): CatalogUiController {
  const ui = new CatalogUiController(
    '/console',
    '/api/console',
    auth,
    resolveConsoleOptions(options),
  );
  Reflect.set(ui, 'dir', spa);
  return ui;
}

function readsOf(path: string): number {
  return vi.mocked(fs.readFileSync).mock.calls.filter((call) => call[0] === path).length;
}

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

beforeEach(() => {
  spa = mkdtempSync(join(tmpdir(), 'catalog-ui-'));
  mkdirSync(join(spa, 'assets'));
  writeFileSync(join(spa, 'index.html'), INDEX);
  writeFileSync(join(spa, 'assets', 'app-1.js'), 'console.log("app");');
  vi.mocked(fs.readFileSync).mockClear();
});

afterEach(() => {
  rmSync(spa, { recursive: true, force: true });
});

describe('the console page', () => {
  it('reads and rewrites index.html once, not once per request', () => {
    const ui = controller();

    const first = ui.index();
    const again = [ui.index(), ui.index(), ui.index()];

    expect(first).toContain('src="/console/assets/app-1.js"');
    expect(first).toContain('<script src="/console/config.js"></script>');
    for (const html of again) expect(html).toBe(first);
    expect(readsOf(join(spa, 'index.html'))).toBe(1);
  });

  it('renders a rebuilt index.html, which names different hashed assets', () => {
    const ui = controller();
    ui.index();

    writeFileSync(join(spa, 'index.html'), INDEX.replace('app-1.js', 'app-22.js'));
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(spa, 'index.html'), later, later);

    expect(ui.index()).toContain('src="/console/assets/app-22.js"');
    expect(readsOf(join(spa, 'index.html'))).toBe(2);
  });

  it('still answers 404 while the dashboard is not built', () => {
    rmSync(join(spa, 'index.html'));
    expect(() => controller().index()).toThrow(/not built/);
  });
});

describe('the page config', () => {
  /** Runs `config.js` the way a browser would, against a fresh object standing in for `window`. */
  function evaluate(source: string): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    new Function('window', source)(target);
    return target;
  }

  it('is a script file the page loads, never an inline script', () => {
    // A host whose Content-Security-Policy refuses inline script must still be able to serve this
    // page: every <script> in it names a src.
    const html = controller().index();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\bsrc="/);
    // Before the bundle, so the values are on `window` when the SPA reads them.
    expect(html.indexOf('/console/config.js')).toBeLessThan(html.indexOf('app-1.js'));
  });

  it('carries the paths and the defaults when nothing is configured', () => {
    expect(evaluate(controller().config())).toEqual({
      __CATALOG_BASE__: '/console',
      __CATALOG_API__: '/api/console',
      __CATALOG_HOST_AUTH__: false,
      __CATALOG_CONSOLE__: {
        screens: [
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
        ],
        pipeline: true,
        identity: true,
      },
    });
  });

  it('hides the sign-in, but keeps /auth/me, when the console has its own auth', () => {
    const config = evaluate(controller({ modes: ['login'] }).config());
    expect(config.__CATALOG_HOST_AUTH__).toBe(true);
    expect(config.__CATALOG_CONSOLE__).toMatchObject({ identity: true });
  });

  it('carries the screens, pipeline and host authentication a host chose', () => {
    const config = evaluate(
      controller(null, {
        screens: ['model', 'objects'],
        pipeline: false,
        hostAuthenticates: true,
      }).config(),
    );
    expect(config.__CATALOG_HOST_AUTH__).toBe(true);
    expect(config.__CATALOG_CONSOLE__).toEqual({
      screens: ['model', 'objects'],
      pipeline: false,
      identity: false,
    });
  });

  it('escapes a path in the page attributes, so it cannot close one', () => {
    const ui = new CatalogUiController('/a"b&c', '/api', null, resolveConsoleOptions());
    Reflect.set(ui, 'dir', spa);
    const html = ui.index();
    expect(html).toContain('<script src="/a&quot;b&amp;c/config.js"></script>');
    expect(html).toContain('src="/a&quot;b&amp;c/assets/app-1.js"');
    expect(html).not.toContain('/a"b');
  });

  it('cannot be broken out of by a path', () => {
    // The paths used to be interpolated between single quotes; a quote in one closed the string.
    const ui = new CatalogUiController(`/a'b</script>`, '/api', null, resolveConsoleOptions());
    expect(evaluate(ui.config()).__CATALOG_BASE__).toBe(`/a'b</script>`);
  });
});

describe('an asset', () => {
  it('is streamed from disk rather than read whole into memory', async () => {
    const file = controller().asset('app-1.js');

    expect(await drain(file.getStream())).toBe('console.log("app");');
    expect(file.getHeaders().length).toBe('console.log("app");'.length);
    expect(readsOf(join(spa, 'assets', 'app-1.js'))).toBe(0);
  });

  it('answers 404 for a name that is not a file there', () => {
    const ui = controller();
    expect(() => ui.asset('missing.js')).toThrow();
    expect(() => ui.asset('../index.html')).toThrow();
  });
});
