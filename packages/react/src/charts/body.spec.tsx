// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The chart body, shared by the console's cards and by the embed components.
 *
 * One drawing, two callers, and exactly one thing they disagree about: how much of a table to
 * show. A dashboard card is a PREVIEW — five columns, six rows, the whole answer one click away
 * on the query screen. An embed has no such click: it is the only view its reader gets, so
 * quietly dropping seven of twelve columns would be hiding data with no way to ask for it back.
 *
 * That difference is a pair of optional props, which is precisely the kind of thing that gets
 * "tidied" into a single default later. These tests are what makes that tidy-up fail.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChartBody } from './body';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

/** Seven columns and eight rows: more than a card shows, less than a screen minds. */
const WIDE = {
  columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  rows: Array.from({ length: 8 }, (_, index) => ({
    a: index,
    b: index,
    c: index,
    d: index,
    e: index,
    f: index,
    g: index,
  })),
  rowCount: 8,
  truncated: false,
  elapsedMs: 1,
};

describe('the table body', () => {
  it('shows everything it was given when no cap was asked for', () => {
    // What an embed gets. A host that asked for a table and received two thirds of it has been
    // handed a broken component, and would have no way to tell.
    render(<ChartBody result={WIDE} visualization={{ kind: 'table' }} />);

    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    // The header row counts, so eight data rows are nine.
    expect(screen.getAllByRole('row')).toHaveLength(9);
  });

  it('caps to the preview the console asks for', () => {
    // What `DashboardBoard` passes, and why a card stays readable at a glance.
    render(
      <ChartBody result={WIDE} visualization={{ kind: 'table' }} maxColumns={5} maxRows={6} />,
    );

    expect(screen.getAllByRole('columnheader')).toHaveLength(5);
    expect(screen.getAllByRole('row')).toHaveLength(7);
  });
});

describe('the states that are not a chart', () => {
  it('says a query that matched nothing matched nothing', () => {
    // Never a skeleton: a chart that will never arrive must not look like one that is about to.
    render(
      <ChartBody
        result={{ columns: ['a'], rows: [], rowCount: 0, truncated: false, elapsedMs: 1 }}
        visualization={{ kind: 'bar' }}
      />,
    );

    expect(screen.getByText('The query ran and matched nothing.')).toBeTruthy();
  });

  it('draws a single number from the column the visualization named', () => {
    render(
      <ChartBody
        result={{
          columns: ['unit', 'n'],
          rows: [{ unit: '21st', n: 42 }],
          rowCount: 1,
          truncated: false,
          elapsedMs: 1,
        }}
        visualization={{ kind: 'number', valueColumns: ['n'], labelColumn: 'unit' }}
      />,
    );

    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('unit')).toBeTruthy();
  });
});
