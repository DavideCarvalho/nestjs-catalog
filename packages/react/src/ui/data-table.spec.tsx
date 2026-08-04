// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The shared data table.
 *
 * The case worth the most here is the one it deliberately does NOT do: sorting.
 * The object explorer sorts, pages and searches on the SERVER, because it reads
 * a warehouse table that does not fit in a browser. A table that quietly sorted
 * the fifty rows currently on screen and presented the result as the whole
 * answer would be a worse bug than no sorting at all — it looks right. So the
 * header reports clicks and nothing else, and that is asserted rather than
 * assumed.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, renderUnknown } from './data-table';

declare global {
  // Not declared by @types/react, and RTL manages it around its own `act` calls;
  // setting it up front keeps React from warning on the renders below.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

interface Row {
  name: string;
  count: number;
}

const ROWS: Row[] = [
  { name: 'charlie', count: 3 },
  { name: 'alpha', count: 100 },
  { name: 'bravo', count: 20 },
];

const COLUMNS = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'count', header: 'Count' },
];

function bodyText() {
  const rows = screen.getAllByRole('row').slice(1); // drop the header row
  return rows.map((row) =>
    within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  );
}

describe('DataTable', () => {
  it('renders the rows in the order it was given them', () => {
    // THE case. Nothing here is a sorted row model, so the order on screen is
    // the order the caller supplied — which for a server-sorted table is the
    // server's answer, and for a SQL result is the query's.
    render(<DataTable data={ROWS} columns={COLUMNS} />);

    expect(bodyText()).toEqual([
      ['charlie', '3'],
      ['alpha', '100'],
      ['bravo', '20'],
    ]);
  });

  it('reports a header click without reordering anything itself', () => {
    // If this component ever grows a sorted row model, this fails: the rows
    // would come back alphabetical and the caller would never be told.
    const onSort = vi.fn();
    render(<DataTable data={ROWS} columns={COLUMNS} sort={{ by: null, dir: 'asc', onSort }} />);

    fireEvent.click(screen.getByRole('button', { name: /name/i }));

    expect(onSort).toHaveBeenCalledWith('name');
    expect(bodyText().map((cells) => cells[0])).toEqual(['charlie', 'alpha', 'bravo']);
  });

  it('announces which column is sorted, on the header cell', () => {
    // `aria-sort` belongs to the column header, not to the button inside it —
    // on the button it reads as "this control is sorted".
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        sort={{ by: 'count', dir: 'desc', onSort: vi.fn() }}
      />,
    );

    const [nameHeader, countHeader] = screen.getAllByRole('columnheader');
    expect(countHeader.getAttribute('aria-sort')).toBe('descending');
    expect(nameHeader.getAttribute('aria-sort')).toBeNull();
  });

  it('offers no sort affordance at all when the caller does not sort', () => {
    // A header that looks clickable and is not is worse than a plain one.
    render(<DataTable data={ROWS} columns={COLUMNS} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('honours a per-column sortable predicate', () => {
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        sort={{ by: null, dir: 'asc', onSort: vi.fn(), sortable: (id) => id === 'name' }}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button').textContent).toContain('Name');
  });

  it('right-aligns and tabular-nums the numeric columns', () => {
    // Digits in a proportional font make 1,111 narrower than 8,888, so a column
    // of numbers cannot be compared at a glance without this.
    render(<DataTable data={ROWS} columns={COLUMNS} numeric={(id) => id === 'count'} />);

    const [name, count] = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(count.className).toContain('tabular-nums');
    expect(count.className).toContain('text-right');
    expect(name.className).not.toContain('text-right');
  });

  it('renders the empty node instead of an empty body', () => {
    render(<DataTable data={[]} columns={COLUMNS} empty={<p>Nothing matched.</p>} />);

    expect(screen.getByText('Nothing matched.')).toBeTruthy();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  describe('renderUnknown', () => {
    it('marks an absent value rather than leaving the cell blank', () => {
      // "No value" and "a value that happens to be blank" look identical in an
      // empty cell, and they mean very different things in a query result.
      const { container } = render(<>{renderUnknown(null)}</>);
      expect(container.textContent).toBe('—');

      const undef = render(<>{renderUnknown(undefined)}</>);
      expect(undef.container.textContent).toBe('—');
    });

    it('shows an object as JSON rather than as [object Object]', () => {
      const { container } = render(<>{renderUnknown({ a: 1 })}</>);
      expect(container.textContent).toBe('{"a":1}');
    });

    it('keeps a falsy value visible', () => {
      // `0` and `false` are answers. An implementation using `value || '—'`
      // erases both and nothing reports it.
      expect(render(<>{renderUnknown(0)}</>).container.textContent).toBe('0');
      expect(render(<>{renderUnknown(false)}</>).container.textContent).toBe('false');
      expect(render(<>{renderUnknown('')}</>).container.textContent).toBe('');
    });
  });
});
