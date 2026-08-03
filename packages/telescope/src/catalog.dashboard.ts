import type { Column, DashboardSpec } from '@dudousxd/nestjs-telescope';
import { TRACE_HREF } from './catalog-trace-providers.js';
import { DEFAULT_SINCE_HOURS } from './catalog.shared.js';

/** Options for {@link catalogDashboard}. */
export interface CatalogDashboardOptions {
  /**
   * How far back the durable panels look, in hours. Default
   * {@link DEFAULT_SINCE_HOURS}.
   *
   * Twenty-four hours by default because the question this dashboard is opened
   * to answer is almost always "what happened tonight" — the overnight window
   * in which scheduled loads run and after which somebody notices a number is
   * wrong. A longer default would bury a single failure among a week of
   * successes; a shorter one would miss a load that started before midnight.
   */
  sinceHours?: number;

  /**
   * How many rows the durable tables return. Default 50.
   */
  limit?: number;

  /**
   * A URL template deep-linking a load out to the HOST's own catalog console,
   * e.g. `'/catalog/loads/{id}'`.
   *
   * Omitted by default, in which case a load row links to Telescope's OWN trace
   * waterfall at `#/traces/{id}` — which works with no host wiring at all,
   * because the watcher stamps each load's snapshot id as the entry `traceId`
   * that the waterfall groups by. Set this when the host has a richer view of a
   * load than the waterfall can give.
   */
  loadHref?: string;
}

/** A column, with the load deep-link attached. */
function linked(key: string, label: string, href: string): Column {
  // The `{id}` placeholder is filled from the ROW, not from the column, so the
  // row carries the full snapshot id whether or not any column displays it.
  // That is what lets the timestamp column be the link target while the id
  // itself stays out of the table — an opaque 26-character id in its own column
  // costs a third of the width and tells a reader nothing.
  return { key, label, link: { href } };
}

function col(key: string, label: string): Column {
  return { key, label };
}

/**
 * The "Catalog" dashboard.
 *
 * Laid out around the four questions somebody actually has when they open this
 * at 3am, in the order they have them:
 *
 *  1. **Did anything fail, and did anything half-land?** The top row. Failed,
 *     incomplete and running are three separate numbers because they are three
 *     separate situations — see the providers for why collapsing any two of
 *     them is the bug this package exists to prevent.
 *  2. **Did data actually land?** Rows committed, beside them.
 *  3. **Show me the bad ones.** A table that is empty on a good night, so "not
 *     empty" is itself the signal, rather than a failure sitting at row 31 of a
 *     table of successes.
 *  4. **What changed that could explain it?** Schema, curation and transform
 *     edits — the events that belong to no load — beside the failures.
 *
 * ## Section sizing
 * Each section's panel count is an exact multiple of its `cols`. Telescope's
 * `ExtensionDashboardPage` renders a section as a `grid-cols-N` grid with one
 * panel per cell and no `colSpan`, so an odd panel out leaves a visible hole
 * next to a lone table.
 */
export function catalogDashboard(options?: CatalogDashboardOptions): DashboardSpec {
  const sinceHours = options?.sinceHours ?? DEFAULT_SINCE_HOURS;
  const limit = options?.limit ?? 50;
  const query = { sinceHours, limit };
  const statQuery = { sinceHours };
  const href = options?.loadHref ?? TRACE_HREF;

  const loadColumns: Column[] = [
    linked('startedAt', 'Started', href),
    col('typeName', 'Type'),
    col('connectorName', 'Connector'),
    col('outcome', 'Outcome'),
    col('rows', 'Rows committed'),
    col('durationMs', 'Duration (ms)'),
    col('failures', 'Failures'),
    col('error', 'Error'),
  ];

  return {
    id: 'catalog.loads',
    label: 'Catalog',
    navGroup: 'Data',
    // `panels` is the flat back-compat layout and `sections` supersedes it in
    // any UI that understands sections. It is populated with the top row rather
    // than left empty so an older dashboard build still renders the four
    // numbers that matter instead of a blank page.
    panels: [
      {
        kind: 'stat',
        title: 'Failed loads',
        data: { provider: 'catalog.loads.failed', query: statQuery },
        format: 'number',
        // Any failure at all is worth colour. `direction: 'up-bad'` because
        // more failures is worse — the opposite of every rate metric on the
        // rest of the dashboard, and the reason this field is not optional.
        thresholds: { warn: 1, bad: 1, direction: 'up-bad' },
      },
      {
        kind: 'stat',
        title: 'Incomplete loads',
        data: { provider: 'catalog.loads.incomplete', query: statQuery },
        format: 'number',
        thresholds: { warn: 1, bad: 1, direction: 'up-bad' },
      },
      {
        kind: 'stat',
        title: 'Running now',
        data: { provider: 'catalog.loads.running', query: statQuery },
        format: 'number',
      },
      {
        kind: 'stat',
        title: 'Rows committed',
        data: { provider: 'catalog.loads.rows', query: statQuery },
        format: 'number',
      },
    ],
    sections: [
      {
        title: `Loads (last ${sinceHours}h)`,
        cols: 4,
        panels: [
          {
            kind: 'stat',
            title: 'Failed loads',
            data: { provider: 'catalog.loads.failed', query: statQuery },
            format: 'number',
            thresholds: { warn: 1, bad: 1, direction: 'up-bad' },
          },
          {
            kind: 'stat',
            title: 'Incomplete loads',
            data: { provider: 'catalog.loads.incomplete', query: statQuery },
            format: 'number',
            thresholds: { warn: 1, bad: 1, direction: 'up-bad' },
          },
          {
            // Never given thresholds. A running load is not a problem and not
            // an achievement; colouring it would make a busy pipeline look
            // either broken or healthy, and it is neither — it is unfinished.
            kind: 'stat',
            title: 'Running now',
            data: { provider: 'catalog.loads.running', query: statQuery },
            format: 'number',
          },
          {
            kind: 'stat',
            title: 'Rows committed',
            data: { provider: 'catalog.loads.rows', query: statQuery },
            format: 'number',
          },
        ],
      },
      {
        title: 'Outcomes',
        cols: 2,
        panels: [
          {
            kind: 'breakdown',
            title: 'How loads ended',
            data: { provider: 'catalog.loads.outcomes', query: statQuery },
            style: 'donut',
          },
          {
            kind: 'table',
            title: 'Recent loads',
            data: { provider: 'catalog.loads.recent', query },
            columns: loadColumns,
          },
        ],
      },
      {
        title: 'Needs attention',
        cols: 2,
        panels: [
          {
            kind: 'table',
            title: 'Failed and incomplete loads',
            data: { provider: 'catalog.loads.problems', query },
            columns: loadColumns,
          },
          {
            kind: 'table',
            title: 'Schema, curation and transform changes',
            data: { provider: 'catalog.changes.recent', query },
            columns: [
              col('occurredAt', 'When'),
              col('event', 'Change'),
              col('typeName', 'Type'),
              col('principalId', 'By'),
              col('detail', 'What'),
            ],
          },
        ],
      },
      {
        title: 'Live channel activity',
        cols: 2,
        panels: [
          {
            kind: 'breakdown',
            title: 'Events recorded',
            data: { provider: 'catalog.live.events' },
            style: 'bar',
          },
          {
            kind: 'table',
            title: 'Failures on the channel',
            data: { provider: 'catalog.live.failures' },
            columns: [
              linked('at', 'When', href),
              col('connectorName', 'Connector'),
              col('typeName', 'Type'),
              col('fetched', 'Fetched'),
              col('written', 'Written'),
              col('error', 'Error'),
            ],
          },
        ],
      },
    ],
  };
}
