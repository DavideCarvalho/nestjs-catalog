// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Choosing which snapshot a `catalog` source reads.
 *
 * WHAT THIS IS ABOUT
 * ------------------
 * A source node can name one snapshot by **id** — never "latest", never
 * "previous", never anything relative — because a name that resolves at run time
 * reads different data on different days while the graph's fingerprint says
 * nothing changed. The obvious objection to an id is friction: somebody has to
 * go and look one up. This control is the answer to that objection, so the cases
 * below are mostly about it doing that job:
 *
 *  - the list is offered when the caller has one, dated rather than by id;
 *  - a dropped load is SHOWN and cannot be CHOSEN, because its rows are gone and
 *    every read of it is refused — offering it and then refusing is a worse
 *    screen than one that says so up front;
 *  - a relative reference typed into the fallback field is refused where it is
 *    typed, in the same words the server would use;
 *  - and the blank field stores NOTHING rather than an empty string, which is
 *    what keeps `workflowGraphHash` from renumbering every graph somebody opens.
 *
 * `userEvent` rather than `fireEvent` for the select: it is a Base UI popup
 * driven by pointer events, and `fireEvent.click` opens one without ever
 * committing a choice.
 */
import type { SnapshotRef } from '@dudousxd/nestjs-catalog/client';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type SourceDraft, SourceFields, sourceConfigFrom, sourceDraftFrom } from './source-fields';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const SNAPSHOTS: SnapshotRef[] = [
  {
    id: 'wf-ae908b95',
    createdAt: '2026-08-07T23:28:20.000Z',
    rowCount: 44_720,
    principalId: 'loader',
  },
  {
    id: 'wf-9ff572d8',
    createdAt: '2026-08-07T23:14:44.000Z',
    rowCount: 44_720,
    principalId: 'loader',
    droppedAt: '2026-08-08T02:00:00.000Z',
  },
];

/** The form, holding its own draft, so a choice can be read back off the config. */
function Harness({
  snapshots,
  initial,
  onConfig,
}: {
  snapshots?: SnapshotRef[];
  initial?: Partial<SourceDraft>;
  onConfig?: (config: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<SourceDraft>(() => ({
    ...sourceDraftFrom({ objectType: 'SubwoReplica' }),
    ...initial,
  }));
  return (
    <SourceFields
      kind="catalog"
      draft={draft}
      viaConnection={false}
      snapshots={snapshots}
      onChange={(next) => {
        setDraft(next);
        onConfig?.(sourceConfigFrom('catalog', next, { viaConnection: false, incremental: false }));
      }}
    />
  );
}

describe('the config a catalog source stores', () => {
  it('omits the snapshot key entirely when none is named', () => {
    // The trap this exists to avoid: `objectSnapshot: ""` means the current
    // snapshot and reads as one — and it is a config key that was not there
    // before, so the graph's fingerprint moves and every graph somebody merely
    // opened is presented as edited.
    const draft = sourceDraftFrom({ objectType: 'SubwoReplica' });
    expect(
      sourceConfigFrom('catalog', draft, { viaConnection: false, incremental: false }),
    ).toEqual({ objectType: 'SubwoReplica' });
  });

  it('stores the id, trimmed, when one is named', () => {
    const draft = { ...sourceDraftFrom({ objectType: 'SubwoReplica' }), objectSnapshot: ' wf-1 ' };
    expect(
      sourceConfigFrom('catalog', draft, { viaConnection: false, incremental: false }),
    ).toEqual({ objectType: 'SubwoReplica', objectSnapshot: 'wf-1' });
  });

  it('reads an existing one back off the stored config', () => {
    expect(
      sourceDraftFrom({ objectType: 'SubwoReplica', objectSnapshot: 'wf-1' }).objectSnapshot,
    ).toBe('wf-1');
    expect(sourceDraftFrom({ objectType: 'SubwoReplica' }).objectSnapshot).toBe('');
  });
});

describe('the snapshot picker', () => {
  it('offers the loads by date, with the current one first', async () => {
    render(<Harness snapshots={SNAPSHOTS} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Which snapshot to read'));
    const options = await screen.findAllByRole('option');
    expect(options[0].textContent).toMatch(/Current load/);
    // Dated, because the id is a run id nobody can order in their head. The id
    // is still there — it is what gets stored — on the hint line.
    expect(options.map((option) => option.textContent ?? '').join(' | ')).toMatch(/44,720 rows/);
    expect(options.map((option) => option.textContent ?? '').join(' | ')).toMatch(/wf-ae908b95/);
  });

  it('shows a dropped load and refuses to let it be chosen', async () => {
    render(<Harness snapshots={SNAPSHOTS} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Which snapshot to read'));
    const options = await screen.findAllByRole('option');
    const dropped = options.find((option) => (option.textContent ?? '').includes('dropped'));
    // Shown: the record is kept on purpose and hiding it would make a load that
    // visibly happened look like one that never did.
    expect(dropped).toBeDefined();
    // …and unusable: its rows are gone, and every read of it is refused.
    expect(dropped?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('stores the id that was chosen', async () => {
    const stored: Array<Record<string, unknown>> = [];
    render(<Harness snapshots={SNAPSHOTS} onConfig={(config) => stored.push(config)} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Which snapshot to read'));
    const options = await screen.findAllByRole('option');
    const usable = options.find((option) => (option.textContent ?? '').includes('wf-ae908b95'));
    if (!usable) throw new Error('the live load was not offered');
    await user.click(usable);
    expect(stored.at(-1)).toEqual({ objectType: 'SubwoReplica', objectSnapshot: 'wf-ae908b95' });
  });

  it('falls back to a text field when there is no history to offer', () => {
    // A type typed but not yet published, or a console that cannot see this
    // catalog's history. A form that cannot list must still be a form that can
    // edit.
    render(<Harness />);
    expect(screen.getByPlaceholderText('Blank reads the current load')).toBeDefined();
    expect(screen.getByText('Snapshot (optional)')).toBeDefined();
  });

  it('refuses a relative reference where it is typed, in the server’s words', () => {
    render(<Harness initial={{ objectSnapshot: 'previous' }} />);
    expect(screen.getByText(/not a snapshot id, it is a way of describing one/)).toBeDefined();
  });

  it('keeps an id it does not recognise selectable, rather than dropping it', async () => {
    // An id older than the window the list covers, or one typed by hand. Losing
    // it on open would make choosing anything else a one-way door.
    render(<Harness snapshots={SNAPSHOTS} initial={{ objectSnapshot: 'wf-fromlastyear' }} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Which snapshot to read'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent ?? '').join(' | ')).toMatch(
      /wf-fromlastyear/,
    );
  });
});
