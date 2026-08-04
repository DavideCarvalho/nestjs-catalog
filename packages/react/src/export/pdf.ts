import { type PngExportOptions, rasteriseSerializedSvg } from './png';
import { type SerializedSvg, serializeSvg } from './serialize';

/**
 * PDF export, as a seam the host fills rather than a dependency this package takes.
 *
 * WHY THERE IS NO PDF RENDERER IN HERE
 * ------------------------------------
 * The same argument `charts/registry.tsx` makes about recharts and bklit, with
 * the numbers on the other side of it. A client-side PDF means `jspdf` (109KB
 * gzipped) plus `svg2pdf.js` (19KB) — ~128KB that every consumer of this
 * library downloads so that some of them can export a chart. Meanwhile the
 * applications that actually want this already generate PDFs server-side, with
 * their own fonts, header, page furniture and pipeline; a PDF produced here
 * would match none of it and would have to be styled back out again.
 *
 * So the host registers something that turns an exported chart into a PDF:
 *
 * ```ts
 * import { registerPdfExporter } from "@dudousxd/nestjs-catalog-react";
 *
 * registerPdfExporter({
 *   label: "Save as report",
 *   async export({ png, width, height, title }) {
 *     const body = new FormData();
 *     body.append("chart", png, "chart.png");
 *     body.append("meta", JSON.stringify({ width, height, title }));
 *     await fetch("/reports/chart", { method: "POST", body });
 *   },
 * });
 * ```
 *
 * WHY BOTH THE RASTER AND THE MARKUP
 * ----------------------------------
 * A host on `@react-pdf/renderer` takes `png`, because that library draws
 * images and not arbitrary SVG. A host with a vector pipeline takes `svg` and
 * gets text that is still selectable and still sharp at print size. Handing
 * over only the raster forecloses the second; handing over only the markup
 * makes the common case do work it should not have to. Both are produced from
 * ONE serialisation, so the two always describe the same chart at the same
 * size — see {@link rasteriseSerializedSvg}.
 *
 * WHERE NOBODY REGISTERED ONE, THERE IS NO ACTION
 * -----------------------------------------------
 * Not a disabled button, not one that fails when clicked: absent. That is the
 * rule `registeredChartLibraries()` already follows, and it is the rule
 * `usePdfExport` implements — a control that claims something the code does not
 * do is a bug report filed against whoever shipped the control.
 */

/**
 * What the host is handed. One chart, in the two forms this package can produce.
 */
export interface ChartPdfSource {
  /** The rasterised chart. What an image-drawing PDF library wants. */
  png: Blob;
  /** The same chart as a standalone, self-contained SVG document, styles inlined. */
  svg: string;
  /** CSS pixels, so the host can size a page honestly. Describes both `png` and `svg`. */
  width: number;
  height: number;
  /** The card's title, when it has one. */
  title?: string;
  /** The SQL behind the chart, for a host that prints it as a caption. */
  query?: string;
}

export interface ChartPdfExporter {
  /**
   * Shown on the action, so the host names its own document.
   *
   * Absent means the caller draws whatever it calls this by default. It is here
   * because the host is the one producing the artefact: "Save as PDF" is wrong
   * for something that lands in a quarterly report template, and the component
   * offering the button cannot know which it is.
   */
  label?: string;
  export(chart: ChartPdfSource): Promise<void>;
}

/**
 * One slot, not a map by name.
 *
 * Chart renderers are keyed because a saved query names the library it wants
 * and several can be live at once. A PDF pipeline is not chosen per chart — the
 * host has one document story, and a second registration is a replacement
 * rather than an addition.
 */
let exporter: ChartPdfExporter | undefined;

/** Notified when the slot changes, so a mounted card can grow or lose the action. */
const listeners = new Set<() => void>();

/**
 * Register the host's exporter. Returns a function that removes it again.
 *
 * The disposer is deliberately not a plain `exporter = undefined`: it clears the
 * slot only if this exporter is still the one in it. A host that swaps
 * implementations — or a test that registers a second — would otherwise have
 * the older disposer wipe the newer registration, and the symptom is the action
 * silently disappearing long after the call that caused it.
 */
export function registerPdfExporter(next: ChartPdfExporter): () => void {
  exporter = next;
  for (const listener of listeners) listener();
  return () => {
    if (exporter !== next) return;
    exporter = undefined;
    for (const listener of listeners) listener();
  };
}

/** The registered exporter, or undefined when the host wired none. */
export function getPdfExporter(): ChartPdfExporter | undefined {
  return exporter;
}

/**
 * Subscribe to registration changes.
 *
 * `getChartRenderer` has no equivalent and does not need one: it is read while
 * rendering a card that re-renders whenever its query result does. This is read
 * to decide whether a control EXISTS, and the whole premise above is that a
 * host's PDF pipeline is heavy — so it is very often behind a dynamic import
 * that resolves after the console has already mounted. Without this, those
 * cards would sit there actionless until something unrelated re-rendered them.
 */
export function subscribeToPdfExporter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface PdfSourceOptions extends PngExportOptions {
  /** The card's title, passed through to the exporter. */
  title?: string;
  /** The query behind the chart, passed through to the exporter. */
  query?: string;
}

/**
 * How the raster is produced. A parameter so a test can substitute it.
 *
 * jsdom cannot rasterise — `canvas.getContext('2d')` returns null — so a test
 * that wants to check what reaches the exporter has no other way in. The
 * substitution stops at the raster: `serializeSvg` still runs for real, so the
 * markup and the dimensions a test observes are the ones a browser would see.
 */
export type SvgRasteriser = (serialized: SerializedSvg, options: PngExportOptions) => Promise<Blob>;

/**
 * Everything the host needs, from one serialisation of one chart.
 *
 * Separate from {@link exportSvgAsPdf} because it is the whole contract of the
 * seam and nothing about it is React: a host with its own toolbar can build the
 * payload and route it wherever it likes.
 */
export async function buildChartPdfSource(
  svg: SVGSVGElement,
  options: PdfSourceOptions = {},
  rasterise: SvgRasteriser = rasteriseSerializedSvg,
): Promise<ChartPdfSource> {
  const serialized = serializeSvg(svg, options);
  const png = await rasterise(serialized, options);
  return {
    png,
    svg: serialized.markup,
    width: serialized.width,
    height: serialized.height,
    title: options.title,
    query: options.query,
  };
}

/**
 * Build the payload and hand it to the registered exporter.
 *
 * Throws when nobody registered one. That is not the path a user can reach —
 * `usePdfExport` reports no action at all in that case — so reaching it means a
 * caller offered the export without checking, and a thrown error naming the
 * missing registration is far more use than a silent no-op that looks like the
 * PDF pipeline failing.
 *
 * A rejection from the host's own exporter propagates untouched. Swallowing it
 * would leave a user who clicked "export" watching nothing happen, with the
 * only evidence in a console they are not looking at.
 */
export async function exportSvgAsPdf(
  svg: SVGSVGElement,
  options: PdfSourceOptions = {},
  rasterise: SvgRasteriser = rasteriseSerializedSvg,
): Promise<ChartPdfSource> {
  const target = exporter;
  if (!target) {
    throw new Error(
      'No PDF exporter is registered, so this chart cannot be exported as a PDF. This package ' +
        'ships no PDF renderer by design; call registerPdfExporter() with one backed by your own ' +
        'document pipeline.',
    );
  }

  const source = await buildChartPdfSource(svg, options, rasterise);
  await target.export(source);
  return source;
}
