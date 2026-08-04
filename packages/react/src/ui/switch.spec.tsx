// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * That the switch is reachable by its name.
 *
 * `Switch` wraps its control in a `<label>`, which biome flags as a label with
 * no control — it cannot see through Base UI's component boundary to the hidden
 * native input that makes the implicit association work. That flag is suppressed
 * in the source, and a suppression is only honest if something checks the claim
 * it makes. This is that something: if Base UI ever stops rendering the inner
 * input, the suppression becomes a lie and this fails.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Switch } from './switch';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('Switch', () => {
  it('is findable by its visible label', () => {
    render(<Switch checked={false} onCheckedChange={() => {}} label="Enable retries" />);

    expect(screen.getByRole('switch', { name: 'Enable retries' })).toBeTruthy();
  });

  it('reports its checked state, not only its colour', () => {
    // A toggle whose state is only a background colour is one a screen reader
    // cannot report.
    render(<Switch checked onCheckedChange={() => {}} label="Enable retries" />);

    expect(
      screen.getByRole('switch', { name: 'Enable retries' }).getAttribute('aria-checked'),
    ).toBe('true');
  });
});
