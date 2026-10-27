import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogUiController } from './catalog-ui.controller.js';

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

function controller(): CatalogUiController {
  const ui = new CatalogUiController('/console', '/api/console');
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
    expect(first).toContain("window.__CATALOG_API__='/api/console'");
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
