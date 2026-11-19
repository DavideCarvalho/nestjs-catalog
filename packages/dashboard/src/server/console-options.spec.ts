import { describe, expect, it } from 'vitest';
import { CONSOLE_SCREENS } from '../client/console-config';
import { CATALOG_CONSOLE_SCREENS, resolveConsoleOptions } from './console-options.js';

/**
 * What a host may say about the console it serves, checked where it is said.
 *
 * Refusals happen at module definition, before the app listens. A misspelt
 * screen name that was merely ignored would hide a screen the host meant to
 * show, and nobody would find out until a user asked where it went.
 */
describe('resolveConsoleOptions', () => {
  it('reproduces the console as it was when nothing is said', () => {
    expect(resolveConsoleOptions()).toEqual({
      screens: [...CATALOG_CONSOLE_SCREENS],
      pipeline: true,
      hostAuthenticates: false,
    });
  });

  it('keeps the screens named, in the console order and once each', () => {
    expect(resolveConsoleOptions({ screens: ['objects', 'model', 'objects'] }).screens).toEqual([
      'model',
      'objects',
    ]);
  });

  it('refuses a screen that does not exist, naming it', () => {
    // biome-ignore lint/suspicious/noExplicitAny: a host on plain JavaScript can pass anything.
    expect(() => resolveConsoleOptions({ screens: ['model', 'modle' as any] })).toThrow(/"modle"/);
  });

  it('refuses a list with no screen that has a tab', () => {
    expect(() => resolveConsoleOptions({ screens: [] })).toThrow(/at least one/);
    expect(() => resolveConsoleOptions({ screens: ['search'] })).toThrow(/at least one/);
  });

  it('passes pipeline and hostAuthenticates through', () => {
    expect(resolveConsoleOptions({ pipeline: false, hostAuthenticates: true })).toMatchObject({
      pipeline: false,
      hostAuthenticates: true,
    });
  });

  it('names the same screens the SPA knows', () => {
    // Two builds with two roots, so the list is written twice. This is what keeps them one list.
    expect([...CATALOG_CONSOLE_SCREENS]).toEqual([...CONSOLE_SCREENS]);
  });
});
