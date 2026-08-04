/**
 * Getting a chart out of the console as a file.
 *
 * PNG is produced here, and deliberately: it needs no dependency at all, which
 * is the same argument `charts/registry.tsx` makes about chart libraries. A
 * serialised SVG, a canvas and `toBlob` are all already in the browser.
 *
 * PDF is NOT produced here, for the other half of that same argument — a PDF
 * renderer is ~128KB every consumer would pay for so that some of them can
 * export a chart, and the hosts that want one already have a document pipeline
 * of their own. So `pdf.ts` is a seam rather than an implementation: the host
 * registers an exporter, this package hands it the raster, the markup and the
 * real dimensions, and where nobody registered one there is no PDF action at
 * all — the rule `registeredChartLibraries()` already follows.
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
  rasteriseSerializedSvg,
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
export {
  buildChartPdfSource,
  type ChartPdfExporter,
  type ChartPdfSource,
  exportSvgAsPdf,
  getPdfExporter,
  type PdfSourceOptions,
  registerPdfExporter,
  subscribeToPdfExporter,
  type SvgRasteriser,
} from './pdf';
export {
  type PdfExport,
  usePdfExport,
  type UsePdfExportOptions,
} from './use-pdf-export';
