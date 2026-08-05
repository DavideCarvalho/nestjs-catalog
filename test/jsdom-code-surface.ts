/**
 * The browser APIs `@pierre/diffs` needs and jsdom does not have.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The editor is not a `<textarea>` any more. It measures text on a canvas,
 * watches its box with a `ResizeObserver`, adopts a constructed stylesheet, and
 * asks `matchMedia` which way round to paint. jsdom has none of those, and the
 * failure mode is the quiet one: without them the component mounts, throws
 * nothing a test can see, and renders an EMPTY shadow root. Every assertion
 * about code on screen then fails for a reason that has nothing to do with the
 * code.
 *
 * So this is the cost of the dependency written down as a file: five shims that
 * a `<textarea>` never needed. It is imported by specs — never by `src` — and
 * lives in the repo-root `test/`, beside `catalog-store-contract.ts` and for the
 * same reason: two packages need it, `packages/react` because it owns the
 * editor and `packages/dashboard` because its console renders one. Nothing here
 * is inside any package's `src`, so none of it ships.
 *
 * The numbers are arbitrary but must be non-zero. A zero-width box renders zero
 * lines, which is exactly the empty shadow root above.
 */

/** A box big enough that the virtualiser renders something into it. */
const WIDTH = 800;
const HEIGHT = 400;

let installed = false;

/**
 * Idempotent, because several specs in one file may call it and Vitest reuses
 * one jsdom per file. Re-defining `getContext` is harmless; re-defining
 * `ResizeObserver` after instances exist is not.
 */
export function installCodeSurfaceDom(): void {
  if (installed) return;
  installed = true;

  // Constructed stylesheets: the `<diffs-container>` custom element adopts one
  // in its constructor, so this throws before anything renders.
  if (!('replaceSync' in CSSStyleSheet.prototype)) {
    Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', {
      value: () => {},
      writable: true,
      configurable: true,
    });
  }

  // Text metrics. The editor measures a character cell to place its caret, and
  // a monospace advance is all it needs from us — 7.8px is 13px SF Mono, which
  // is the editor's own default size.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      font: '',
      measureText: (text: string) => ({ width: text.length * 7.8 }),
      fillText: () => {},
      clearRect: () => {},
      save: () => {},
      restore: () => {},
    }),
    writable: true,
    configurable: true,
  });

  // The observer fires once, asynchronously, with a real box — which is what
  // the renderer waits for before it decides how many lines fit.
  class TestResizeObserver implements ResizeObserver {
    #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      const box: ResizeObserverSize = { inlineSize: WIDTH, blockSize: HEIGHT };
      const entry: ResizeObserverEntry = {
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: [box],
        contentBoxSize: [box],
        devicePixelContentBoxSize: [box],
      };
      setTimeout(() => this.#callback([entry], this), 0);
    }
    unobserve() {}
    disconnect() {}
  }
  // Assigned, not defaulted. Some specs already stub a no-op `ResizeObserver` for Base UI's select
  // and tooltip, and a no-op one never reports a box — which leaves the code surface unrendered
  // for a reason no assertion in those files would explain. One that fires satisfies both.
  //
  // Through `defineProperty` rather than assignment, here and below, because that is what lets a
  // shim be installed without an `as` assertion telling the compiler a partial stand-in is the
  // real interface. `matchMedia` in particular returns an overloaded `MediaQueryList` that nothing
  // short of a cast satisfies, and a cast is exactly the thing that would stop the compiler
  // checking the shims that CAN be checked.
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: TestResizeObserver,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    writable: true,
    configurable: true,
  });

  // jsdom lays nothing out, so every box is 0×0 and every line falls outside the
  // render window. This is the shim that decides whether code appears at all.
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    value: () => ({
      x: 0,
      y: 0,
      width: WIDTH,
      height: HEIGHT,
      top: 0,
      left: 0,
      right: WIDTH,
      bottom: HEIGHT,
      toJSON: () => ({}),
    }),
    writable: true,
    configurable: true,
  });
}
