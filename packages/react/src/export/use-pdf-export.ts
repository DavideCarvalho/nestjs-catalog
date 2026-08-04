import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  type ChartPdfSource,
  type PdfSourceOptions,
  exportSvgAsPdf,
  getPdfExporter,
  subscribeToPdfExporter,
} from './pdf';
import { findExportableSvg } from './png';
import {
  type PngExportTarget,
  canRasterise,
  toExportError,
  unwrapExportTarget,
} from './use-png-export';

/**
 * The PDF action, as a toolbar actually needs it.
 *
 * The one thing this hook exists to get right is {@link PdfExport.available}.
 * Everything else — pending, error, a promise that resolves rather than rejects
 * — it does the same way `usePngExport` does, and for the same reasons.
 *
 * `available` is false unless ALL THREE of these hold, because each of them is
 * a way for a rendered button to be a lie:
 *
 *   1. **A host registered an exporter.** This package ships no PDF renderer
 *      (see `pdf.ts`), so with nothing registered there is no PDF to make.
 *   2. **The card has an `<svg>`.** `CssBarChart` — the no-dependency fallback —
 *      is a stack of `<div>`s, so `findExportableSvg` returns null and there is
 *      nothing to serialise or rasterise.
 *   3. **The browser can rasterise.** False during SSR, and false wherever
 *      there is no canvas.
 *
 * WHY THE TARGET IS AN ARGUMENT HERE AND NOT ON THE CALL
 * -----------------------------------------------------
 * `usePngExport` takes the target when the export runs, and reports only the
 * browser capability up front — a card with no `<svg>` finds out by clicking and
 * getting an error. That was a reasonable line to draw there and it is the wrong
 * one here: condition 2 has to be answered BEFORE anything is drawn, so the hook
 * has to be holding the target while it renders, not when it is clicked.
 *
 * Which means reading the DOM, which means after the commit — so `available`
 * is false for one paint and then becomes true. Unavoidable: the `<svg>` does
 * not exist until the renderer has mounted, and asking earlier would just be
 * guessing. It also means watching for changes, because a chart library that
 * measures its container before drawing (recharts does) inserts its `<svg>`
 * from its own state, with no re-render of the component holding this hook and
 * therefore nothing at all to prompt a second look.
 */

export interface UsePdfExportOptions extends PdfSourceOptions {
  /** Called after the host's exporter resolves, e.g. to show a toast. */
  onExported?: (source: ChartPdfSource) => void;
  /** Called instead of the error being swallowed. The error is also returned in `error`. */
  onError?: (error: Error) => void;
}

export interface PdfExport {
  /**
   * Whether to render the action AT ALL.
   *
   * Not "whether to disable it". A disabled PDF button on every card of a
   * console whose host never wired an exporter advertises a feature that does
   * not exist and cannot be made to exist by the person looking at it.
   */
  available: boolean;
  /** The host's name for its own document, when it gave one. */
  label: string | undefined;
  /**
   * Build the payload and hand it to the host's exporter.
   *
   * Resolves to the payload on success and to null on failure — it does not
   * reject, because the caller is an `onClick` and an unhandled rejection in one
   * is a console error nobody sees. `error` holds what went wrong, including
   * anything the host's own exporter threw.
   */
  exportPdf: (overrides?: PdfSourceOptions) => Promise<ChartPdfSource | null>;
  exporting: boolean;
  error: Error | null;
}

export function usePdfExport(
  target: PngExportTarget,
  options: UsePdfExportOptions = {},
): PdfExport {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasSvg, setHasSvg] = useState(false);

  // The exporter object itself is the snapshot: it only changes when somebody
  // registers, so the reference is stable between renders and
  // `useSyncExternalStore` will not loop on it.
  const exporter = useSyncExternalStore(subscribeToPdfExporter, getPdfExporter, () => undefined);

  // Target and options both read through a ref inside the callback, so
  // `exportPdf` keeps its identity when the caller passes an inline object —
  // which is every caller — and a memoised toolbar does not re-render with its
  // parent.
  const latest = useRef({ target, options });
  latest.current = { target, options };

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Deliberately no dependency array. The element is only knowable after a
  // commit, so there is no value computed during render that could key this
  // correctly: on the first render the ref is still null, and keying on that
  // null would mean never looking again. Re-running is cheap — one
  // `querySelector` and one observer — and the state write is guarded, so this
  // does not feed itself.
  useEffect(() => {
    const element = unwrapExportTarget(latest.current.target);
    const check = () => {
      const found = findExportableSvg(element) !== null;
      setHasSvg((current) => (current === found ? current : found));
    };

    check();
    if (!element || typeof MutationObserver !== 'function') return;

    const observer = new MutationObserver(check);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  const exportPdf = useCallback(
    async (overrides?: PdfSourceOptions): Promise<ChartPdfSource | null> => {
      const { target: current, options: settings } = latest.current;
      const { onExported, onError, ...base } = settings;

      setExporting(true);
      setError(null);
      try {
        const svg = findExportableSvg(unwrapExportTarget(current));
        if (!svg) {
          throw new Error(
            'Nothing to export: no <svg> was found in this card. The built-in CSS chart draws with ' +
              'elements that cannot be serialised; register a chart library to export it.',
          );
        }

        const source = await exportSvgAsPdf(svg, { ...base, ...overrides });
        onExported?.(source);
        return source;
      } catch (thrown) {
        const failure = toExportError(thrown);
        if (mounted.current) setError(failure);
        onError?.(failure);
        return null;
      } finally {
        if (mounted.current) setExporting(false);
      }
    },
    [],
  );

  return {
    available: exporter !== undefined && hasSvg && canRasterise(),
    label: exporter?.label,
    exportPdf,
    exporting,
    error,
  };
}
