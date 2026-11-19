import { describe, expect, it } from 'vitest';
import { CONSOLE_SCREENS, readConsoleConfig } from './console-config';

/**
 * How the SPA reads what `config.js` put on `window`.
 *
 * The defaults are the contract: a page served by an older server, which writes
 * no `__CATALOG_CONSOLE__` at all, must be the console it always was.
 */
describe('readConsoleConfig', () => {
  it('is the whole console when the server says nothing', () => {
    const config = readConsoleConfig({});
    expect([...config.screens]).toEqual([...CONSOLE_SCREENS]);
    expect(config).toMatchObject({ pipeline: true, hostAuth: false, identity: true });
  });

  it('shows only the screens named, and drops names it does not know', () => {
    const config = readConsoleConfig({
      __CATALOG_CONSOLE__: { screens: ['model', 'objects', 'nonsense', 7] },
    });
    expect([...config.screens]).toEqual(['model', 'objects']);
  });

  it('treats a list with no tab as absent, since an empty console is never meant', () => {
    expect(readConsoleConfig({ __CATALOG_CONSOLE__: { screens: ['search'] } }).screens.size).toBe(
      CONSOLE_SCREENS.length,
    );
    expect(readConsoleConfig({ __CATALOG_CONSOLE__: { screens: 'model' } }).screens.size).toBe(
      CONSOLE_SCREENS.length,
    );
  });

  it('turns pipeline and identity off only for an explicit false', () => {
    expect(
      readConsoleConfig({ __CATALOG_CONSOLE__: { pipeline: false, identity: false } }),
    ).toMatchObject({ pipeline: false, identity: false });
    expect(
      readConsoleConfig({ __CATALOG_CONSOLE__: { pipeline: 'no', identity: 0 } }),
    ).toMatchObject({ pipeline: true, identity: true });
  });

  it('reads host authentication from the flag the server has always written', () => {
    expect(readConsoleConfig({ __CATALOG_HOST_AUTH__: true }).hostAuth).toBe(true);
  });
});
