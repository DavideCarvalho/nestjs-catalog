/**
 * Getting a chart out of the console as a file.
 *
 * PNG only, and deliberately: it needs no dependency at all, which is the same
 * argument `charts/registry.tsx` makes about chart libraries. A serialised SVG,
 * a canvas and `toBlob` are all already in the browser.
 *
 * PDF is not here. See the note at the bottom of this file for why, and for the
 * seam a host that already generates PDFs would plug into.
 */

export {
  collectCustomProperties,
  resolveCssVariables,
  THEME_CUSTOM_PROPERTIES,
} from './css-variables';
export {
  type ExportBackground,
  resolveAncestorBackground,
  resolveSvgSize,
  type SerializedSvg,
  type SerializeSvgOptions,
  serializeSvg,
  svgToDataUri,
} from './serialize';
export {
  defaultPngFilename,
  downloadSvgAsPng,
  findExportableSvg,
  type PngExportOptions,
  resolveScale,
  svgToPngBlob,
  triggerDownload,
} from './png';
export {
  canRasterise,
  type PngExport,
  type PngExportTarget,
  usePngExport,
  type UsePngExportOptions,
} from './use-png-export';

/*
 * WHY THERE IS NO PDF EXPORT HERE
 * -------------------------------
 * Because this is a library, and a PDF renderer is a dependency every consumer
 * would pay for whether or not they want the feature — the same reason recharts
 * and bklit are registered rather than imported. The applications embedding
 * this catalog that need a PDF already have a renderer of their own, wired into
 * their own document pipeline with their own fonts, header and page furniture;
 * a PDF this package produced would not match any of it.
 *
 * So the shape, when it is wanted, is a host-supplied seam like
 * `CATALOG_DIRECTORY` and `CATALOG_PRINCIPAL_RESOLVER`: the host registers
 * something that turns an exported chart into a PDF, and this package hands it
 * the PNG blob and the card's metadata. Where no host registered one, no PDF
 * action appears — the same rule `registeredChartLibraries()` already follows.
 * That is a proposal, not a decision, and the decision is not this file's.
 */
