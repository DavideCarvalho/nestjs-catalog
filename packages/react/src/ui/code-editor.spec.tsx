// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The code editor, and the one thing about it that broke silently.
 *
 * Both copies of this component — it was written out twice before being
 * extracted — passed `themes.github`, a LIGHT Prism theme whose plain text is
 * near-black. That was invisible for as long as the console was light, and
 * turned the SQL box into dark-on-dark the moment the console became dark. No
 * test failed, nothing logged, and the editor still worked perfectly: you just
 * could not read what you were typing.
 *
 * So the colours are asserted here rather than eyeballed, against the surface
 * tokens rather than against literals, which is the property that stops the two
 * from drifting apart again.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor } from './code-editor';

declare global {
  // Not declared by @types/react, and RTL manages it around its own `act` calls;
  // setting it up front keeps React from warning on the renders below.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

function editor(props: Partial<Parameters<typeof CodeEditor>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <CodeEditor value="select 1" onChange={onChange} language="sql" label="SQL query" {...props} />,
  );
  return { onChange, view, input: screen.getByLabelText(props.label ?? 'SQL query') };
}

describe('CodeEditor', () => {
  describe('the theme', () => {
    it('paints code with the console surface tokens, not a fixed light palette', () => {
      // THE regression. `themes.github`'s plain colour is a near-black literal;
      // reading it off `var(--text)` is what makes the editor follow whatever
      // surface the console is wearing instead of assuming one.
      // Asserted on the TOKEN spans, which is where a Prism theme actually
      // lands — the `<pre>` only carries `plain`. That is also precisely where
      // the old theme was wrong: `themes.github` paints keywords a dark red and
      // strings a dark blue, both of which vanish on a near-black surface.
      const { view } = editor();
      const keyword = [...view.container.querySelectorAll('pre span')].find(
        (node) => node.textContent === 'select',
      );

      expect(keyword, 'the SQL keyword should be tokenised').toBeTruthy();
      expect(keyword?.getAttribute('style') ?? '').toContain('var(--accent');
      expect(view.container.querySelector('pre')?.getAttribute('style') ?? '').toContain(
        'var(--text',
      );
    });

    it('does not paint code in a hardcoded near-black', () => {
      // Stated as its own case because the assertion above would still pass on
      // a theme that read the token AND then overrode it further down.
      const { view } = editor();
      const styles = [...view.container.querySelectorAll('pre, pre *')]
        .map((node) => node.getAttribute('style') ?? '')
        .join(' ');

      for (const nearBlack of ['#000', '#111', '#1f2937', 'rgb(0, 0, 0)']) {
        expect(styles).not.toContain(nearBlack);
      }
    });
  });

  describe('the two layers', () => {
    it('hides the highlighted copy from assistive tech, and labels the real input', () => {
      // The `<pre>` is decoration; the textarea is the control. Announcing both
      // reads the whole query twice, once as ungrouped tokens.
      const { view, input } = editor();

      expect(view.container.querySelector('pre')?.getAttribute('aria-hidden')).toBe('true');
      expect(input.tagName).toBe('TEXTAREA');
      // The ATTRIBUTE: jsdom does not reflect this one onto a property.
      expect(input.getAttribute('spellcheck')).toBe('false');
    });

    it('keeps the metrics identical on both layers', () => {
      // Any difference in font, size, padding or line-height puts the caret a
      // little further from its glyph on every line — the failure that makes an
      // overlay editor feel broken without looking broken.
      const { view, input } = editor({ padding: 'p-4', fontSize: 'text-[13px]' });
      const pre = view.container.querySelector('pre');

      for (const metric of ['font-mono', 'leading-[1.5]', 'p-4', 'text-[13px]']) {
        expect(pre?.className).toContain(metric);
        expect(input.className).toContain(metric);
      }
    });

    it('draws a caret and a selection the transparent text cannot', () => {
      // Text is transparent so the highlighted copy shows through, which also
      // hides the caret and the selection unless they are coloured back in.
      const { input } = editor();

      expect(input.className).toContain('text-transparent');
      expect(input.className).toContain('caret-');
      expect(input.className).toContain('selection:bg-');
    });
  });

  it('reports edits through onChange', () => {
    const { onChange, input } = editor();

    // `fireEvent.change` does React's value-tracker work; assigning `.value`
    // and dispatching by hand is silently swallowed.
    fireEvent.change(input, { target: { value: 'select 2' } });

    expect(onChange).toHaveBeenCalledWith('select 2');
  });

  it('takes a language per caller, so a sample pane is not highlighted as code', () => {
    // The sample-records pane was the one that stayed a bare textarea, so the
    // JSON you debug against rendered flat while the transform beside it was
    // coloured.
    const { view } = editor({ value: '{"a": 1}', language: 'json', label: 'Sample records' });

    expect(view.container.querySelector('pre')?.textContent).toContain('"a"');
  });
});
