// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The seam, tested for what a host is actually promised.
 *
 * The raster is substituted, and only the raster. `serializeSvg` runs for real, so the markup and
 * the dimensions asserted below are the ones a browser would produce; what is faked is the one
 * step jsdom cannot do at all (`canvas.getContext('2d')` returns null there). That line is drawn
 * where `serialize.spec.ts` draws it and for its reason: a mocked canvas that "proves" a PNG is
 * correct proves nothing, but the question here is not whether the pixels are right — it is
 * whether both forms of the chart, and the size that describes them, reach the host's exporter.
 * That question is answerable without pixels, and the injected rasteriser is how.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChartPdfSource,
  type SvgRasteriser,
  buildChartPdfSource,
  exportSvgAsPdf,
  getPdfExporter,
  registerPdfExporter,
  subscribeToPdfExporter,
} from './pdf';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A chart with a real size in its attributes, since jsdom lays nothing out. */
function makeChart(width = 400, height = 200): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('width', '10');
  svg.appendChild(rect);
  if (!(svg instanceof SVGSVGElement)) throw new Error('jsdom did not produce an SVGSVGElement');
  return svg;
}

const fakePng: SvgRasteriser = async () => new Blob(['png-bytes'], { type: 'image/png' });

/** Registrations are module-level, so every test undoes its own. */
const disposers: Array<() => void> = [];
function register(exporter: Parameters<typeof registerPdfExporter>[0]): () => void {
  const dispose = registerPdfExporter(exporter);
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

describe('the exporter registry', () => {
  it('has nothing registered until a host registers something', () => {
    expect(getPdfExporter()).toBeUndefined();
  });

  it('hands back what was registered, label and all', () => {
    const exporter = { label: 'Save as report', export: vi.fn(async () => {}) };
    register(exporter);
    expect(getPdfExporter()).toBe(exporter);
  });

  it('replaces rather than accumulates, because a host has one document story', () => {
    const first = { export: vi.fn(async () => {}) };
    const second = { export: vi.fn(async () => {}) };
    register(first);
    register(second);
    expect(getPdfExporter()).toBe(second);
  });

  it('leaves the slot empty again after the disposer runs', () => {
    const dispose = registerPdfExporter({ export: async () => {} });
    dispose();
    expect(getPdfExporter()).toBeUndefined();
  });

  it('does not let a stale disposer wipe a newer registration', () => {
    const stale = registerPdfExporter({ export: async () => {} });
    const current = { export: vi.fn(async () => {}) };
    register(current);

    stale();

    expect(getPdfExporter()).toBe(current);
  });

  it('notifies subscribers when the slot changes, so a mounted card can grow the action', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPdfExporter(listener);

    register({ export: async () => {} });
    expect(listener).toHaveBeenCalledTimes(1);

    disposers.pop()?.();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    register({ export: async () => {} });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('what the host is handed', () => {
  it('carries both the raster and the markup', async () => {
    const source = await buildChartPdfSource(makeChart(), {}, fakePng);

    expect(source.png).toBeInstanceOf(Blob);
    expect(source.png.type).toBe('image/png');
    expect(source.svg).toContain('<svg');
    expect(source.svg).toContain('<rect');
  });

  it('reports the chart size in CSS pixels', async () => {
    const source = await buildChartPdfSource(makeChart(640, 360), {}, fakePng);

    expect(source.width).toBe(640);
    expect(source.height).toBe(360);
  });

  it('describes the same chart in both forms: the markup carries the reported size', async () => {
    const source = await buildChartPdfSource(makeChart(640, 360), {}, fakePng);

    expect(source.svg).toContain(`width="${source.width}"`);
    expect(source.svg).toContain(`height="${source.height}"`);
  });

  it('rasterises the very markup it hands over, not a second serialisation', async () => {
    const seen: string[] = [];
    const rasterise: SvgRasteriser = async (serialized) => {
      seen.push(serialized.markup);
      return new Blob([serialized.markup], { type: 'image/png' });
    };

    const source = await buildChartPdfSource(makeChart(), {}, rasterise);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(source.svg);
  });

  it('passes the card metadata through untouched', async () => {
    const source = await buildChartPdfSource(
      makeChart(),
      { title: 'Revenue by region', query: 'select region, sum(amount) from sales group by 1' },
      fakePng,
    );

    expect(source.title).toBe('Revenue by region');
    expect(source.query).toBe('select region, sum(amount) from sales group by 1');
  });

  it('leaves the metadata absent when the card had none, rather than inventing it', async () => {
    const source = await buildChartPdfSource(makeChart(), {}, fakePng);

    expect(source.title).toBeUndefined();
    expect(source.query).toBeUndefined();
  });
});

describe('exportSvgAsPdf', () => {
  it('gives the registered exporter the full payload', async () => {
    const received: ChartPdfSource[] = [];
    register({
      export: async (chart) => {
        received.push(chart);
      },
    });

    await exportSvgAsPdf(makeChart(800, 450), { title: 'Q3' }, fakePng);

    expect(received).toHaveLength(1);
    const [chart] = received;
    expect(chart?.png).toBeInstanceOf(Blob);
    expect(chart?.svg).toContain('<svg');
    expect(chart?.width).toBe(800);
    expect(chart?.height).toBe(450);
    expect(chart?.title).toBe('Q3');
  });

  it('refuses, by name, when no host registered an exporter', async () => {
    await expect(exportSvgAsPdf(makeChart(), {}, fakePng)).rejects.toThrow(
      /No PDF exporter is registered/,
    );
  });

  it('does not rasterise at all when there is nobody to hand the result to', async () => {
    const rasterise = vi.fn(fakePng);

    await expect(exportSvgAsPdf(makeChart(), {}, rasterise)).rejects.toThrow();

    expect(rasterise).not.toHaveBeenCalled();
  });

  it('surfaces a rejecting exporter instead of resolving as though it worked', async () => {
    register({
      export: async () => {
        throw new Error('the report service is down');
      },
    });

    await expect(exportSvgAsPdf(makeChart(), {}, fakePng)).rejects.toThrow(
      /the report service is down/,
    );
  });

  it('waits for the exporter rather than firing it off', async () => {
    let finished = false;
    register({
      export: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        finished = true;
      },
    });

    await exportSvgAsPdf(makeChart(), {}, fakePng);

    expect(finished).toBe(true);
  });
});
