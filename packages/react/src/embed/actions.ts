/**
 * What an embedded chart's toolbar may offer.
 *
 * OUTPUT ONLY, and the union is the enforcement. An embed is a chart in
 * somebody else's application: the board was assembled in the console, and the
 * controls that assemble it — refresh, delete, the chart-library picker, the
 * width picker, the drag handle — have no meaning in a host's page and real
 * costs there. A refresh button is the clearest case: it would run the query
 * again on demand, straight past whatever caching the host put in front of this
 * component, from a page the catalog's operators do not control.
 *
 * Only actions that exist appear here. `'png'` is deliberately absent until the
 * renderer that produces one lands; `'pdf'` is absent because nobody has
 * decided what a PDF of a chart even is. An option that does nothing is worse
 * than a missing one — a host ships it, a user clicks it, and the bug report
 * arrives against the host.
 */
export type EmbedAction = 'csv';

/**
 * Every action, in the order a toolbar draws them.
 *
 * The canonical order lives here rather than being taken from whatever a caller
 * passed, so two embeds asking for the same set look the same. This is also the
 * one place a new action is added: append it, and `'all'`, the filter below and
 * the toolbar's switch all pick it up.
 */
export const EMBED_ACTIONS: readonly EmbedAction[] = ['csv'];

/**
 * What the host asked for.
 *
 * `'none'` is the default, not `'all'` — see {@link resolveEmbedActions}.
 */
export type EmbedActions = 'all' | 'none' | EmbedAction[];

/**
 * The actions to draw, from what the host asked for.
 *
 * Defaults to NOTHING. An embed should be inert unless the host asks for a
 * control: it is rendering inside a page with its own affordances, its own
 * toolbar and its own ideas about what a user may do, and a library that adds
 * unrequested buttons to somebody else's UI is a library that has to be styled
 * back out again.
 *
 * A list is filtered against {@link EMBED_ACTIONS} rather than trusted. The
 * union makes an unknown value a compile error, but this component is exported
 * from a published package and plenty of callers are not compiling anything —
 * an untyped `['csv', 'pdf']` from a JS host must draw the CSV button and
 * silently drop the other, not render a control with no behaviour behind it.
 * Filtering in this direction also dedupes, which is why `['csv', 'csv']` gives
 * one button.
 */
export function resolveEmbedActions(actions: EmbedActions = 'none'): EmbedAction[] {
  if (actions === 'none') return [];
  if (actions === 'all') return [...EMBED_ACTIONS];
  return EMBED_ACTIONS.filter((action) => actions.includes(action));
}
