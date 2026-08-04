import {
  type SerializeSvgOptions,
  type SerializedSvg,
  serializeSvg,
  svgToDataUri,
} from './serialize';

/**
 * SVG chart → PNG, in the browser, with no dependency.
 *
 * The pipeline is: serialise the live `<svg>` with its styles inlined (see
 * `serialize.ts`, which is where the hard part is), load that as an image,
 * draw it into a canvas at a real pixel ratio, and `toBlob`. Nothing here is
 * novel; what makes it worth writing down is the list of things that silently
 * do not work, all of which are properties of `<img src="data:image/svg+xml,…">`
 * rather than of this code:
 *
 * **Fonts do not load.** An SVG loaded through `<img>` renders in what the spec
 * calls secure static mode: it fetches nothing. No stylesheet, no image, no
 * `@font-face` — including the Google Fonts link the console uses for
 * `Space Grotesk` and `JetBrains Mono`. Those are web fonts, not system fonts,
 * so the rasteriser cannot find them by name either. The exported PNG therefore
 * renders labels in the next family in the stack (`ui-sans-serif`/`system-ui`,
 * and `ui-monospace` for values), which is why `serialize.ts` inlines the whole
 * `font-family` stack rather than just the first entry: with the full stack the
 * text lands in a fallback face, without it the text could vanish. The fallback
 * face has different metrics, so a long axis label can end up a few pixels
 * wider or narrower than it is on screen. Text is present and legible; it is
 * not pixel-identical to the page. A host that needs the real faces can pass
 * `fontFaceCss` with the fonts base64'd into `data:` URIs — that is the only
 * fix, and it is the host's to make because only the host knows whether it is
 * licensed to embed them.
 *
 * **A raster image inside the chart taints the canvas.** If a renderer embeds
 * an `<image href="https://…">`, `toBlob` throws a `SecurityError` and no
 * amount of retrying helps. None of the shipped renderers do this; a custom one
 * might, and the error below says so rather than surfacing as "export failed".
 *
 * **`<foreignObject>` is not portable.** HTML inside an SVG rasterises in
 * Chromium and does not in every browser. The shipped renderers use it only for
 * hover tooltips, which are not present in a static export anyway.
 *
 * **Only SVG renderers can be exported.** `CssBarChart` — the no-dependency
 * fallback — is a stack of `<div>`s, not an `<svg>`, so there is nothing here
 * to serialise. `findExportableSvg` returns null for it and the caller is
 * expected to hide the action rather than offer one that fails.
 */

export interface PngExportOptions extends SerializeSvgOptions {
  /**
   * Pixels per CSS pixel.
   *
   * Defaults to `max(devicePixelRatio, 2)`. Not plain `devicePixelRatio`: a 1x
   * PNG is soft on every modern display and unusable the moment it is scaled up
   * in a document, and the person exporting a chart is almost always about to
   * put it in one. 2x is the floor, a Retina screen gets its own ratio, and a
   * caller who wants a specific size passes a number.
   */
  scale?: number;
  /** @default 'image/png' */
  mimeType?: string;
}

/**
 * The per-side limit every current browser enforces on a canvas.
 *
 * Chromium and Firefox both cap a dimension at 16384px (Safari caps total area
 * lower still). Past the cap `drawImage` silently produces a blank canvas — no
 * exception — so the scale is clamped instead of discovering it as an empty
 * PNG.
 */
const MAX_CANVAS_SIDE = 16384;

/** The effective scale, honouring the request but never overflowing the canvas. */
export function resolveScale(
  requested: number | undefined,
  width: number,
  height: number,
  devicePixelRatio = typeof window === 'undefined' ? 1 : (window.devicePixelRatio ?? 1),
): number {
  const wanted =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested
      : Math.max(devicePixelRatio, 2);

  const largest = Math.max(width, height);
  if (!Number.isFinite(largest) || largest <= 0) return wanted;
  return Math.min(wanted, MAX_CANVAS_SIDE / largest);
}

/**
 * The `<svg>` inside `element` that can be exported, or null if there is none.
 *
 * Null is a real answer, not a failure: the CSS fallback chart has no SVG, and
 * a toolbar should read that and not offer the action.
 */
export function findExportableSvg(element: Element | null | undefined): SVGSVGElement | null {
  if (!element) return null;
  if (element instanceof SVGSVGElement) return element;
  const found = element.querySelector('svg');
  return found instanceof SVGSVGElement ? found : null;
}

function decodeImage(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          'The browser refused to load the serialised chart as an image. This usually means the ' +
            'SVG is not well-formed XML — a renderer emitting raw HTML into the chart is the ' +
            'common cause.',
        ),
      );
    image.src = dataUri;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error(`The canvas produced no ${mimeType} data.`));
    }, mimeType);
  });
}

/**
 * A PNG from markup that has ALREADY been serialised.
 *
 * Split out of `svgToPngBlob` for the one caller that needs the serialised
 * document as well as the raster — the PDF seam in `pdf.ts` hands a host both.
 * Serialising twice would work and would be wrong in a way that only shows up
 * later: the size is measured during serialisation, so two passes over a chart
 * that resized in between produce a `width`/`height` that describes one of them
 * and a PNG that is the other. A host sizing a PDF page from those numbers then
 * gets a stretched image, and nothing in either call reported a problem.
 *
 * It is also the seam a test can stand in for. jsdom cannot rasterise at all,
 * so a test that wants to check what a caller does with the blob substitutes
 * this and leaves the serialisation real.
 */
export async function rasteriseSerializedSvg(
  serialized: SerializedSvg,
  options: PngExportOptions = {},
): Promise<Blob> {
  const { markup, width, height } = serialized;
  const scale = resolveScale(options.scale, width, height);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error(
      'No 2D canvas context is available, so the chart cannot be rasterised. PNG export needs a ' +
        'real browser canvas; there is no fallback that produces a correct image.',
    );
  }

  const image = await decodeImage(svgToDataUri(markup));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  try {
    return await canvasToBlob(canvas, options.mimeType ?? 'image/png');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      throw new Error(
        'The chart contains an image loaded from another origin, which taints the canvas and ' +
          'makes the PNG unreadable to the page. Inline that image as a data: URI to export it.',
      );
    }
    throw error;
  }
}

/** A PNG of the given chart `<svg>`, at `scale` times its on-screen size. */
export async function svgToPngBlob(
  svg: SVGSVGElement,
  options: PngExportOptions = {},
): Promise<Blob> {
  return rasteriseSerializedSvg(serializeSvg(svg, options), options);
}

/** `chart-2026-08-04T12-30-00.png` — sortable, and unique enough for a downloads folder. */
export function defaultPngFilename(now: Date = new Date()): string {
  return `chart-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
}

/** Hand a blob to the browser as a download. Separate so the blob path stays testable. */
export function triggerDownload(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') {
    throw new Error('URL.createObjectURL is unavailable, so the PNG cannot be handed to the user.');
  }
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred: revoking synchronously after `click()` races the download in
  // Safari, which has not read the blob yet and ends up saving nothing.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Rasterise the chart and download it. The whole feature, for a caller who wants one call. */
export async function downloadSvgAsPng(
  svg: SVGSVGElement,
  filename: string = defaultPngFilename(),
  options: PngExportOptions = {},
): Promise<Blob> {
  const blob = await svgToPngBlob(svg, options);
  triggerDownload(blob, filename);
  return blob;
}
