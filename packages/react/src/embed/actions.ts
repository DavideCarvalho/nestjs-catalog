import { usePdfExport } from '../export/use-pdf-export';
import { type PngExportTarget, useHasExportableSvg } from '../export/use-png-export';

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
 * Only actions that exist appear here. An option that does nothing is worse
 * than a missing one — a host ships it, a user clicks it, and the bug report
 * arrives against the host.
 *
 * Being in this union is necessary and NOT sufficient. `'png'` cannot be
 * produced from the built-in CSS bar chart, which draws with divs rather than
 * an `<svg>`; `'pdf'` needs the host to have registered an exporter, because
 * this package ships no PDF dependency. Both are decided per card at render
 * time — see {@link useAvailableEmbedActions}, which is what the toolbar
 * actually draws from.
 */
export type EmbedAction = 'csv' | 'png' | 'pdf';

/**
 * Every action, in the order a toolbar draws them.
 *
 * The canonical order lives here rather than being taken from whatever a caller
 * passed, so two embeds asking for the same set look the same. This is also the
 * one place a new action is added: append it, and `'all'`, the filter below and
 * the toolbar's switch all pick it up.
 */
export const EMBED_ACTIONS: readonly EmbedAction[] = ['csv', 'png', 'pdf'];

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

/**
 * Whether each requested action can actually be performed on THIS card.
 *
 * Asking for an action and being able to do it are different questions, and the
 * union can only answer the first. A chart drawn by the built-in renderer is
 * divs, so there is no `<svg>` to rasterise and no PNG; a PDF needs the host to
 * have registered an exporter, and most hosts never will.
 *
 * Filtering here rather than letting each control return null is what keeps the
 * toolbar's exhaustive `switch` meaningful: every action it is handed IS
 * drawable, so the `never` at the bottom still means "you added a member and
 * forgot to draw it" rather than "this one sometimes draws nothing".
 *
 * It also means an empty toolbar is a real answer. A host that asked for `'all'`
 * on a CSS-drawn chart with no PDF exporter gets the CSV link and nothing else,
 * rather than three buttons of which two apologise.
 */
export function useAvailableEmbedActions(
  actions: EmbedActions | undefined,
  target: PngExportTarget,
): EmbedAction[] {
  const requested = resolveEmbedActions(actions);
  const png = useHasExportableSvg(target);
  const pdf = usePdfExport(target);

  return requested.filter((action) => {
    if (action === 'png') return png;
    if (action === 'pdf') return pdf.available;
    return true;
  });
}
