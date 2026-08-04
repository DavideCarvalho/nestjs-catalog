// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Rich descriptions, and the contract underneath them.
 *
 * `description` is served raw in the `/catalog` snapshot to whatever a host
 * built on top of it, and those consumers were written against plain text. That
 * is why this field stores MARKDOWN rather than HTML: markdown degrades into
 * something a person can still read, HTML degrades into tags and creates an XSS
 * surface in every consumer that decides to render it after all.
 *
 * So the case that matters most here is not the toolbar — it is that what goes
 * out is markdown, that it round-trips, and that text which was never touched
 * comes back byte-identical. A field that silently rewrote every description
 * the first time somebody clicked into it would churn the overlay table and the
 * audit trail for nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichTextField, RichTextView } from './rich-text-field';

declare global {
  // Not declared by @types/react, and RTL manages it around its own `act` calls;
  // setting it up front keeps React from warning on the renders below.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ProseMirror measures the document to place the caret and jsdom implements
// neither method, so mounting an editor throws `target.getClientRects is not a
// function` before a single assertion runs. Stubbed to a zero rect: nothing
// here asserts on geometry, and the alternative is not testing the editor at
// all.
const EMPTY_RECT = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
Object.assign(Range.prototype, {
  getClientRects: () => [],
  getBoundingClientRect: () => ({ ...EMPTY_RECT, toJSON: () => EMPTY_RECT }),
});
Object.assign(Element.prototype, {
  getClientRects: () => [],
});

afterEach(cleanup);

/** Open the editor: the read view is a button, and clicking it swaps in TipTap. */
async function open(label = 'meaning') {
  fireEvent.click(screen.getByRole('button', { name: `Edit ${label}` }));
  return waitFor(() => screen.getByRole('button', { name: `Save ${label}` }));
}

function field(value: string, onSave = vi.fn()) {
  render(<RichTextField label="meaning" value={value} onSave={onSave} />);
  return onSave;
}

describe('RichTextField', () => {
  describe('the stored format', () => {
    it('gives back markdown, not HTML', async () => {
      // THE contract. If this ever returns `<strong>…</strong>`, every consumer
      // of the `/catalog` snapshot that renders `description` as text starts
      // showing tags, and every one that renders it as HTML gains an injection
      // point.
      //
      // Driven through `__bold__` rather than by simulating typing: it is
      // valid markdown for the same mark as `**bold**`, so the editor parses it
      // and serialises the canonical spelling — which both exercises the save
      // path without a keyboard and pins that the round-trip NORMALISES rather
      // than preserving whichever syntax arrived.
      const onSave = field('The __fleet__ it belongs to.');
      await open();

      fireEvent.click(screen.getByRole('button', { name: 'Save meaning' }));

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const saved = onSave.mock.calls[0][0];
      expect(saved).toBe('The **fleet** it belongs to.');
      expect(saved).not.toContain('<strong>');
      expect(saved).not.toContain('<p>');
    });

    it('round-trips markdown it was given', async () => {
      const onSave = field('The **fleet** it belongs to.');
      await open();

      fireEvent.click(screen.getByRole('button', { name: 'Save meaning' }));

      // Nothing was edited, so nothing should have been called at all — see the
      // next case. This asserts the parse/serialise pair agrees with itself,
      // which is what makes that possible.
      expect(onSave).not.toHaveBeenCalled();
    });

    it('does not save when nothing changed', async () => {
      // Opening a field and closing it is not an edit. Saving anyway writes an
      // overlay row that shadows the declared description with an identical
      // string, and puts a change in the audit trail that nobody made.
      const onSave = field('Plain text, no marks at all.');
      await open();

      fireEvent.click(screen.getByRole('button', { name: 'Save meaning' }));

      expect(onSave).not.toHaveBeenCalled();
    });

    it('starts from empty without inventing content', async () => {
      const onSave = field('');
      await open();

      fireEvent.click(screen.getByRole('button', { name: 'Save meaning' }));

      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe('the read view', () => {
    it('renders the markdown rather than showing its syntax', async () => {
      render(<RichTextView value="The **fleet** it belongs to." />);

      await waitFor(() => expect(document.querySelector('strong')).not.toBeNull());
      expect(document.querySelector('strong')?.textContent).toBe('fleet');
      // The asterisks were syntax, not content.
      expect(document.body.textContent).not.toContain('**');
    });

    it('shows the placeholder when nothing has been written', () => {
      render(
        <RichTextField
          label="meaning"
          value=""
          onSave={vi.fn()}
          placeholder="No one has written this down yet."
        />,
      );

      expect(screen.getByText('No one has written this down yet.')).toBeTruthy();
    });
  });

  describe('editing', () => {
    it('abandons on Escape without saving', async () => {
      const onSave = field('Original.');
      await open();

      fireEvent.keyDown(screen.getByRole('button', { name: 'Save meaning' }), { key: 'Escape' });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Edit meaning' })).toBeTruthy(),
      );
      expect(onSave).not.toHaveBeenCalled();
    });

    it('leaves plain Enter to the editor', async () => {
      // Enter makes a paragraph here. Stealing it for "save" — which is right
      // for a one-line field and is what the plain-text field did — would make
      // a multi-paragraph description impossible to write.
      const onSave = field('Original.');
      await open();

      fireEvent.keyDown(screen.getByRole('button', { name: 'Save meaning' }), { key: 'Enter' });

      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Save meaning' })).toBeTruthy();
    });

    it('reports mark state to assistive tech, not only as a colour', async () => {
      // A toggle whose only state is a background colour is a toggle a screen
      // reader cannot report.
      field('Original.');
      await open();

      expect(screen.getByRole('button', { name: 'bold' }).getAttribute('aria-pressed')).toBe(
        'false',
      );
    });

    it('says where the text ends up', async () => {
      // The field stores markdown and the person typing has no other way to
      // know that, which matters the moment they paste something formatted.
      field('Original.');
      await open();

      expect(screen.getByText('Stored as markdown')).toBeTruthy();
    });
  });
});
