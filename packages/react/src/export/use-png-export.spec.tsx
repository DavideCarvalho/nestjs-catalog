// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The hook, tested for the states a toolbar button actually renders from.
 *
 * Nothing here rasterises, because jsdom cannot: every export below ends in the "no 2D context"
 * failure. That is not a limitation being worked around — it is the point. What a component needs
 * from this hook is that a failed export leaves it in a coherent state: not stuck pending, with an
 * error it can show, having called back rather than thrown out of an `onClick`. Those are exactly
 * the properties a failing export exercises, so a real browser is not needed to check them.
 *
 * What is NOT covered here, and cannot be: that a successful export produces a correct image.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePngExport } from './use-png-export';

afterEach(cleanup);

function Harness({ onError }: { onError?: (error: Error) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { exportPng, exporting, error } = usePngExport({ onError, filename: 'chart.png' });

  return (
    <div>
      <div ref={ref} data-testid="card">
        <svg width="400" height="200" aria-label="chart">
          <title>chart</title>
        </svg>
      </div>
      <button type="button" onClick={() => void exportPng(ref)}>
        export
      </button>
      <span data-testid="exporting">{String(exporting)}</span>
      <span data-testid="error">{error ? error.message : ''}</span>
    </div>
  );
}

function EmptyCardHarness() {
  const ref = useRef<HTMLDivElement | null>(null);
  const { exportPng, error } = usePngExport();

  return (
    <div>
      {/* The CSS fallback chart: divs, no svg. */}
      <div ref={ref} data-testid="card">
        <div className="h-3 bg-sky-500/80" />
      </div>
      <button type="button" onClick={() => void exportPng(ref)}>
        export
      </button>
      <span data-testid="error">{error ? error.message : ''}</span>
    </div>
  );
}

describe('usePngExport', () => {
  it('starts idle, with nothing to report', () => {
    render(<Harness />);
    expect(screen.getByTestId('exporting').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('');
  });

  it('clears the pending flag when the export fails', async () => {
    render(<Harness />);
    await act(async () => {
      screen.getByText('export').click();
    });
    expect(screen.getByTestId('exporting').textContent).toBe('false');
  });

  it('surfaces the failure rather than throwing out of the click handler', async () => {
    render(<Harness />);
    await act(async () => {
      screen.getByText('export').click();
    });
    expect(screen.getByTestId('error').textContent).toMatch(/No 2D canvas context/);
  });

  it('calls onError with the failure', async () => {
    const onError = vi.fn();
    render(<Harness onError={onError} />);
    await act(async () => {
      screen.getByText('export').click();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('says plainly that a CSS-drawn chart has nothing to export', async () => {
    render(<EmptyCardHarness />);
    await act(async () => {
      screen.getByText('export').click();
    });
    expect(screen.getByTestId('error').textContent).toMatch(/no <svg> was found/);
  });

  it('resolves to null on failure instead of rejecting', async () => {
    let outcome: unknown = 'not run';
    function ReturnHarness() {
      const ref = useRef<HTMLDivElement | null>(null);
      const { exportPng } = usePngExport();
      return (
        <div>
          <div ref={ref}>
            <svg width="400" height="200">
              <title>chart</title>
            </svg>
          </div>
          <button
            type="button"
            onClick={() => {
              exportPng(ref).then((blob) => {
                outcome = blob;
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
