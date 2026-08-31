/**
 * Give a jsdom test the `localStorage` jsdom meant to give it.
 *
 * ## What goes wrong without this
 *
 * Node ships its own `localStorage` global from v24 on, and it is a getter that
 * requires `--localstorage-file`: without that flag it emits an experimental
 * warning and evaluates to `undefined`. Vitest's jsdom environment installs
 * jsdom's window properties onto `globalThis` and leaves a key that is already
 * there alone, so on Node 24+ Node's getter stays and jsdom's `localStorage`
 * never arrives. `window` IS `globalThis` in that environment, so a spec reading
 * `window.localStorage.getItem(...)` gets `Cannot read properties of undefined`.
 *
 * `sessionStorage` is unaffected — Node's needs no file and works — which is why
 * this reads as a bug in whichever component a spec happens to touch first
 * rather than as a Node version problem. On the Node 22 that `.nvmrc` pins there
 * is no such global at all and everything below is a no-op.
 *
 * ## Why the storage is built here rather than borrowed from jsdom
 *
 * Because there is nothing to borrow. jsdom's own `localStorage` was never
 * installed, and the environment's window is the global object, so there is no
 * second window object still holding one. What is built below is the part of the
 * `Storage` interface a test can observe, and it is per-file: Vitest runs each
 * spec file in its own environment, which is the isolation jsdom's own
 * `localStorage` would have had.
 */
function webStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length(): number {
      return entries.size;
    },
    key(index: number): string | null {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return entries.get(String(key)) ?? null;
    },
    setItem(key: string, value: string): void {
      entries.set(String(key), String(value));
    },
    removeItem(key: string): void {
      entries.delete(String(key));
    },
    clear(): void {
      entries.clear();
    },
  };
}

// Guarded on the VALUE and not on the key's presence, because the key is present
// on Node 24+ and its value is the problem. Reading it here is also what emits
// Node's experimental warning, once per worker rather than once per assertion.
if (typeof globalThis.document !== 'undefined' && globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: webStorage(),
    configurable: true,
    writable: false,
    enumerable: false,
  });
}
