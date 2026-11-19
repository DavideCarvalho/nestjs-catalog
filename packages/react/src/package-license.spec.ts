/**
 * Which licence a bundler finds for this package.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The package shipped no `LICENSE` of its own, only `LICENSE-bklit` for the chart code it vendors
 * from bklit-ui. Licence collectors take the first file whose name starts with "license", so a host's
 * third-party notices listed this package under uixmat's copyright. The package's own MIT licence
 * now sits in `LICENSE`, and bklit's text sits in `THIRD_PARTY_NOTICES.md`, a name no collector
 * reads as the package licence.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string) => readFileSync(join(root, name), 'utf8');

describe('the package licence', () => {
  it('ships its own LICENSE, under its own copyright', () => {
    const license = read('LICENSE');
    expect(license).toMatch(/^MIT License/);
    expect(license).toContain('Copyright (c) 2026 Davide Carvalho');
    expect(license).not.toContain('uixmat');
  });

  it('keeps the vendored notice in a file no collector reads as the package licence', () => {
    // The rule licence collectors share: a root file whose name starts with "license" (or
    // "licence"). Only the package's own may match it.
    const matching = readdirSync(root).filter((name) => /^licen[cs]e/i.test(name));
    expect(matching).toEqual(['LICENSE']);
    expect(existsSync(join(root, 'LICENSE-bklit'))).toBe(false);

    const notices = read('THIRD_PARTY_NOTICES.md');
    expect(notices).toContain('https://github.com/bklit/bklit-ui');
    expect(notices).toContain('Copyright (c) 2026 uixmat');
  });

  it('publishes both files', () => {
    const files: string[] = JSON.parse(read('package.json')).files;
    expect(files).toEqual(expect.arrayContaining(['LICENSE', 'THIRD_PARTY_NOTICES.md']));
  });
});
