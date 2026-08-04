import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type PngExportOptions,
  defaultPngFilename,
  downloadSvgAsPng,
  findExportableSvg,
  svgToPngBlob,
} from './png';

/**
 * The export action, as a component actually needs it.
 *
 * Three things a toolbar button has to know and none of which the plain
 * functions can tell it: whether the action is possible at all, whether one is
 * in flight, and what went wrong. Rasterising is asynchronous — a chart of any
 * size takes long enough that a button with no pending state gets clicked three
 * times and produces three files.
 *
 * `supported` is the one that changes what gets rendered rather than how. A
 * card drawn by the CSS fallback renderer has no `<svg>` to serialise, so the
 * honest thing is for no export control to appear on it, exactly as the chart
 * library picker offers only the libraries somebody registered. It is
 * deliberately a value the caller reads, not something this hook enforces by
 * throwing when clicked.
 */

/** A DOM element, or a ref to one. Structural rather than `RefObject` so React's typings can move. */
export type PngExportTarget = Element | { current: Element | null } | null | undefined;

export interface UsePngExportOptions extends PngExportOptions {
  /** Fixed name, or one computed per export. Defaults to a timestamped `chart-….png`. */
  filename?: string | (() => string);
  /** Called after a successful export, e.g. to show a toast. */
  onExported?: (blob: Blob, filename: string) => void;
  /** Called instead of the error being swallowed. The error is also returned in `error`. */
  onError?: (error: Error) => void;
}

export interface PngExport {
  /**
   * Rasterise the chart inside `target` and download it.
   *
   * Resolves to the blob on success and to null on failure — it does not
   * reject, because the caller is an `onClick` and an unhandled rejection in
   * one is a console error nobody sees. `error` holds what went wrong.
   */
  exportPng: (target: PngExportTarget, overrides?: PngExportOptions) => Promise<Blob | null>;
  /** The same render, returned rather than downloaded. For a clipboard copy or an upload. */
  renderPng: (target: PngExportTarget, overrides?: PngExportOptions) => Promise<Blob | null>;
  exporting: boolean;
  error: Error | null;
  /** Whether this browser can rasterise at all. False during SSR. */
  supported: boolean;
}

function unwrapTarget(target: PngExportTarget): Element | null {
  if (!target) return null;
  if (target instanceof Element) return target;
  const current = target.current;
  return current instanceof Element ? current : null;
}

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

let rasteriseSupport: boolean | null = null;

/**
 * Whether the browser has the two things the pipeline cannot be written without.
 *
 * Cached, because it is read on every render of every card that offers the
 * action and the check allocates a canvas to ask.
 */
export function canRasterise(): boolean {
  if (rasteriseSupport !== null) return rasteriseSupport;
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const supported =
    typeof XMLSerializer === 'function' &&
    typeof document.createElement('canvas').toBlob === 'function';
  rasteriseSupport = supported;
  return supported;
}

export function usePngExport(options: UsePngExportOptions = {}): PngExport {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Every option, read through a ref inside the callbacks. Without it the
  // callbacks change identity whenever the caller passes an inline object —
  // which is every caller — and a memoised toolbar re-renders on each parent
  // render for no reason.
  const latest = useRef(options);
  latest.current = options;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (
      target: PngExportTarget,
      overrides: PngExportOptions | undefined,
      download: boolean,
    ): Promise<Blob | null> => {
      const { filename, onExported, onError, ...base } = latest.current;
      const settings = { ...base, ...overrides };

      setExporting(true);
      setError(null);
      try {
        const svg = findExportableSvg(unwrapTarget(target));
        if (!svg) {
          throw new Error(
            'Nothing to export: no <svg> was found in this card. The built-in CSS chart draws with ' +
              'elements a canvas cannot rasterise; register a chart library to export it.',
          );
        }

        const name =
          typeof filename === 'function' ? filename() : (filename ?? defaultPngFilename());
        const blob = download
          ? await downloadSvgAsPng(svg, name, settings)
          : await svgToPngBlob(svg, settings);

        onExported?.(blob, name);
        return blob;
      } catch (thrown) {
        const failure = toError(thrown);
        if (mounted.current) setError(failure);
        onError?.(failure);
        return null;
      } finally {
        if (mounted.current) setExporting(false);
      }
    },
    [],
  );

  const exportPng = useCallback(
    (target: PngExportTarget, overrides?: PngExportOptions) => run(target, overrides, true),
    [run],
  );

  const renderPng = useCallback(
    (target: PngExportTarget, overrides?: PngExportOptions) => run(target, overrides, false),
    [run],
  );

  return { exportPng, renderPng, exporting, error, supported: canRasterise() };
}
