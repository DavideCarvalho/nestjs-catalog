/**
 * The grid a board of cards is laid out on, and the span a card takes in it.
 *
 * Shared by the console's `DashboardBoard` and by `<EmbeddedDashboard>` so that
 * the same dashboard, embedded in somebody else's app, is arranged the way its
 * author arranged it. The two halves have to travel together: the span classes
 * below are meaningless unless the parent declared exactly {@link CHART_GRID},
 * and a copy of one without the other is how a four-wide card ends up spanning
 * past the end of a two-column grid.
 *
 * Container queries, not viewport ones. A board sits beside whatever the host
 * put next to it, so how much room a card actually has is a fact about THIS box
 * and not about the window — `md:` here would give two columns on an 800px
 * screen whose board is 500px wide. The parent must therefore declare
 * `@container` itself; the console does it on its scroll region.
 */
export const CHART_GRID = 'grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-4';

/**
 * The width an author chose, applied only where there are columns to spend.
 *
 * Below `@5xl` the grid has fewer than four columns, and a `col-span-4` there
 * spans past the end — which is what put a chart's axis labels outside its own
 * card. Every card is full width on a narrow board, two-up in the middle, and
 * only honours the chosen span once four columns exist to divide.
 */
const SPAN: Record<number, string> = {
  1: '@5xl:col-span-1',
  2: '@2xl:col-span-2 @5xl:col-span-2',
  3: '@2xl:col-span-2 @5xl:col-span-3',
  4: '@2xl:col-span-2 @5xl:col-span-4',
};

/**
 * Half the board is the default for a width nobody set or one nothing can
 * honour — a stored card is JSON, so `width` arrives as whatever was written,
 * and a missing class would silently collapse the card to one column.
 */
export function chartSpan(width: number | undefined): string {
  return SPAN[width ?? 2] ?? SPAN[2];
}
