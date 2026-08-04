// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The hook, tested for the one thing it decides: whether the action exists.
 *
 * Every test below renders the button only when `available` says so, and then asserts on the
 * button rather than on the flag. That is deliberate — the claim being pinned is not "a boolean
 * has a value", it is "a user either sees a PDF action or does not", and a test written against
 * the boolean would still pass if the rule it encodes stopped meaning anything to a toolbar.
 *
 * Nothing here rasterises, because jsdom cannot: every export that gets as far as the canvas ends
 * in the "no 2D context" failure. So the failure tests below go through a real failure of the real
 * pipeline rather than a staged one, and what they check is that a failed export leaves the
 * component coherent — not stuck pending, with an error to show, having called back rather than
 * thrown out of an `onClick`. That the host's OWN exporter rejecting is surfaced the same way is
 * pinned in `pdf.spec.ts`, where the raster can be substituted and the exporter can be reached.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { type ReactNode, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChartPdfExporter, registerPdfExporter } from './pdf';
import { type UsePdfExportOptions, usePdfExport } from './use-pdf-export';

const disposers: Array<() => void> = [];
function register(exporter: ChartPdfExporter): void {
  disposers.push(registerPdfExporter(exporter));
}

afterEach(() => {
  cleanup();
  while (disposers.length > 0) disposers.pop()?.();
});

function Card({ chart, options }: { chart?: ReactNode; options?: UsePdfExportOptions }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { available, label, exportPdf, exporting, error } = usePdfExport(ref, options);

  return (
    <div>
      <div ref={ref} data-testid="card">
        {chart}
      </div>
      {available ? (
        <button type="button" onClick={() => void exportPdf()}>
          {label ?? 'PDF'}
        </button>
      ) : null}
      <span data-testid="exporting">{String(exporting)}</span>
      <span data-testid="error">{error ? error.message : ''}</span>
    </div>
  );
}

/** An SVG-drawn chart, with a real size in its attributes since jsdom lays nothing out. */
const svgChart = (
  <svg width="400" height="200" aria-label="chart">
    <title>chart</title>
  </svg>
);

/** The CSS fallback: divs, no svg, nothing to serialise. */
const cssChart = <div className="h-3 bg-sky-500/80" />;

function pdfButton(): HTMLElement | null {
  return screen.queryByRole('button');
}

describe('whether a PDF action exists at all', () => {
  it('does not exist when no host registered an exporter', () => {
    render(<Card chart={svgChart} />);
    expect(pdfButton()).toBeNull();
  });

  it('exists once a host registered one and the card has an <svg>', () => {
    register({ export: async () => {} });
    render(<Card chart={svgChart} />);
    expect(pdfButton()).not.toBeNull();
  });

  it('does not exist on a CSS-drawn chart, which has no <svg> to export', () => {
    register({ export: async () => {} });
    render(<Card chart={cssChart} />);
    expect(pdfButton()).toBeNull();
  });

  it('does not exist on an empty card', () => {
    register({ export: async () => {} });
    render(<Card />);
    expect(pdfButton()).toBeNull();
  });

  it('appears on a card already on screen when the host registers late', async () => {
    render(<Card chart={svgChart} />);
    expect(pdfButton()).toBeNull();

    await act(async () => {
      register({ export: async () => {} });
    });

    expect(pdfButton()).not.toBeNull();
  });

  it('disappears again when the registration is withdrawn', async () => {
    register({ export: async () => {} });
    render(<Card chart={svgChart} />);
    expect(pdfButton()).not.toBeNull();

    await act(async () => {
      disposers.pop()?.();
    });

    expect(pdfButton()).toBeNull();
  });

  it('appears when a renderer inserts its <svg> after mount, with no React render to prompt it', async () => {
    register({ export: async () => {} });
    render(<Card />);
    expect(pdfButton()).toBeNull();

    // What recharts does: measure the container, then draw into it from its own
    // state. Done here without React so nothing re-renders the component holding
    // the hook — if the action only ever appears because something else did, the
    // hook is not the thing deciding.
    await act(async () => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '400');
      svg.setAttribute('height', '200');
      screen.getByTestId('card').appendChild(svg);
      await Promise.resolve();
    });

    expect(pdfButton()).not.toBeNull();
  });

  it('names the action the way the host named its document', () => {
    register({ label: 'Save as report', export: async () => {} });
    render(<Card chart={svgChart} />);
    expect(screen.getByRole('button').textContent).toBe('Save as report');
  });
});

describe('when an export fails', () => {
  it('clears the pending flag', async () => {
    register({ export: async () => {} });
    render(<Card chart={svgChart} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(screen.getByTestId('exporting').textContent).toBe('false');
  });

  it('surfaces the failure rather than throwing out of the click handler', async () => {
    register({ export: async () => {} });
    render(<Card chart={svgChart} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(screen.getByTestId('error').textContent).toMatch(/No 2D canvas context/);
  });

  it('never reaches the host exporter when the payload could not be built', async () => {
    const exporter = vi.fn(async () => {});
    register({ export: exporter });
    render(<Card chart={svgChart} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(exporter).not.toHaveBeenCalled();
  });

  it('calls onError with the failure', async () => {
    const onError = vi.fn();
    register({ export: async () => {} });
    render(<Card chart={svgChart} options={{ onError }} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('does not report a success it did not have', async () => {
    const onExported = vi.fn();
    register({ export: async () => {} });
    render(<Card chart={svgChart} options={{ onExported }} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(onExported).not.toHaveBeenCalled();
  });

  it('resolves to null instead of rejecting', async () => {
    register({ export: async () => {} });
    let outcome: unknown = 'not run';

    function ReturnHarness() {
      const ref = useRef<HTMLDivElement | null>(null);
      const { exportPdf } = usePdfExport(ref);
      return (
        <div>
          <div ref={ref}>{svgChart}</div>
          <button
            type="button"
            onClick={() => {
              exportPdf().then((source) => {
                outcome = source;
              });
            }}
          >
            export
          </button>
        </div>
      );
    }

    render(<ReturnHarness />);
    await act(async () => {
      screen.getByText('export').click();
    });

    expect(outcome).toBeNull();
  });
});
