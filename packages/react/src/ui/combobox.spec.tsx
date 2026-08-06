// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The searchable combobox, on the three properties that made it worth building.
 *
 * `Combobox` exists because a `Select` cannot express a value that is not one of its rows, and the
 * lists it is used for come from a *deployment* rather than from this repository. So:
 *
 * 1. **It filters.** A fleet announcing hundreds of workflows is unusable as a scroll.
 * 2. **It shows everything again when reopened.** The box holds a committed value, so filtering by
 *    it would open the popup onto the one row already chosen.
 * 3. **It takes text nobody offered.** This is the load-bearing one: the call node has to stay
 *    usable against a deployment whose workers announce nothing.
 *
 * And a fourth, which is about honesty rather than convenience: a row that cannot be chosen is
 * still SHOWN, and pressing it commits nothing.
 *
 * `toBeDisabled` is NOT available — this repo registers no jest-dom setup, and it throws rather
 * than fails. Read the attribute instead.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type ComboOption, ComboboxField } from './combobox';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;

afterEach(cleanup);

const OPTIONS: ComboOption[] = [
  { value: 'billing.reconcile', label: 'billing.reconcile', keywords: 'group billing' },
  { value: 'orders.sync', label: 'orders.sync', keywords: 'group orders' },
  { value: 'legacy.sweep', label: 'legacy.sweep', hint: 'cannot be pinned', disabled: true },
];

/** The committed value and the picked row, both readable from the DOM. */
function Harness({ options = OPTIONS }: { options?: ComboOption[] }) {
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState('');
  return (
    <div>
      <ComboboxField
        label="Workflow"
        value={value}
        onValueChange={setValue}
        onSelect={(option) => {
          setPicked(option.value);
          setValue(option.value);
        }}
        options={options}
        placeholder="Search…"
      />
      <p data-testid="picked">{picked}</p>
    </div>
  );
}

function box() {
  return screen.getByLabelText(/^Workflow/);
}

/**
 * Open the popup the way a pointer does.
 *
 * Four events rather than one, and none of them is optional. Base UI opens on the pointer
 * sequence, not on `click` — a bare `fireEvent.click` leaves the popup shut and every assertion
 * below then fails on "no options", which reads like a filtering bug and is not one. jsdom
 * dispatches no pointer pipeline of its own, so the sequence is spelled out here.
 */
async function open() {
  const input = box();
  fireEvent.focus(input);
  fireEvent.pointerDown(input, { pointerType: 'mouse', button: 0 });
  fireEvent.mouseDown(input, { button: 0 });
  fireEvent.click(input);
  await waitFor(() => expect(screen.queryAllByRole('option').length).toBeGreaterThan(0));
}

function offered() {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

describe('a searchable combobox', () => {
  it('narrows the list to what was typed', async () => {
    render(<Harness />);
    await open();
    expect(offered().length).toBe(3);

    fireEvent.change(box(), { target: { value: 'rec' } });

    await waitFor(() => expect(offered().length).toBe(1));
    expect(offered()[0]).toContain('billing.reconcile');
  });

  it('matches on what a row said to search by, not only on its label', async () => {
    // Somebody looking for the Python side of the fleet types the group, not a name they do not
    // know yet. A search that only read the label would answer "nothing matches" to a good query.
    render(<Harness />);
    await open();

    fireEvent.change(box(), { target: { value: 'orders' } });

    await waitFor(() => expect(offered().length).toBe(1));
    expect(offered()[0]).toContain('orders.sync');
  });

  it('shows the whole list again when reopened, not just the committed row', async () => {
    // THE ONE THAT MAKES IT USABLE. The box holds a value; the query does not. Filtering by the
    // value would mean the only way to see the other rows is to delete what you already chose.
    render(<Harness />);
    await open();
    fireEvent.change(box(), { target: { value: 'billing.reconcile' } });
    await waitFor(() => expect(offered().length).toBe(1));

    fireEvent.keyDown(box(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
    await open();

    expect(offered().length).toBe(3);
  });

  it('keeps text nobody offered', async () => {
    // The property `Select` cannot have, and the reason this component exists at all.
    render(<Harness />);

    fireEvent.change(box(), { target: { value: 'nobody.announced.this' } });

    expect(box()).toHaveProperty('value', 'nobody.announced.this');
    expect(screen.getByTestId('picked').textContent).toBe('');
  });

  it('says so rather than showing an empty popup', async () => {
    render(<Harness />);
    await open();

    fireEvent.change(box(), { target: { value: 'zzz' } });

    await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
    expect(screen.getByText('Nothing here matches that.')).toBeDefined();
  });

  it('shows a row it will not accept, and accepts nothing when it is pressed', async () => {
    render(<Harness />);
    await open();

    const row = screen.getByRole('option', { name: /legacy\.sweep/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    // Shown WITH its reason: a greyed row that does not say why is worse than no row.
    expect(within(row).getByText('cannot be pinned')).toBeDefined();

    fireEvent.click(row);

    expect(screen.getByTestId('picked').textContent).toBe('');
  });

  it('hands the whole row back when one is chosen', async () => {
    render(<Harness />);
    await open();

    fireEvent.click(screen.getByRole('option', { name: /billing\.reconcile/ }));

    await waitFor(() => expect(screen.getByTestId('picked').textContent).toBe('billing.reconcile'));
    expect(box()).toHaveProperty('value', 'billing.reconcile');
  });
});
