// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The launcher's React tier: the hook's state machine and the drop-in button.
 *
 * The refusal path itself — which URL is minted, which flags the request carries, why a redirect
 * is a refusal — is covered end to end in `../client/console-session.spec.ts`. What is left for
 * this file is the state around it, and in particular the two decisions in `use-open-console.ts`
 * that are surprising enough that a later refactor is likely to "clean them up":
 *
 *   1. `isPending` is NEVER cleared on success. The navigation is already underway and the page is
 *      about to be torn down; flipping the button back to idle first shows a flicker of "ready to
 *      click again" on a page that is leaving.
 *   2. Which is only safe because of the `pageshow` escape hatch. The browser's back/forward cache
 *      restores this page with React state intact, so Back would otherwise land the user on a
 *      spinner that never stops, on a button `disabled` by that very flag.
 *
 * Neither is observable without a committed render and an event-loop turn.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSessionError, type OpenConsoleOptions } from '../client/console-session.js';
import { OpenCatalogConsoleButton } from './open-console-button.js';
import { openCatalogConsoleMutationOptions, useOpenCatalogConsole } from './use-open-console.js';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  // Not declared by `@types/react`, so the flag has to be introduced before it can be set.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Testing Library manages this flag around its own `act` calls; set here as well so the flag is
// already right for the very first render rather than only from Testing Library's first wrapper.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `screen` queries `document.body`, so a launcher left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

function button(): HTMLButtonElement {
  const found = screen.getByRole('button');
  if (!(found instanceof HTMLButtonElement)) throw new Error('not a button');
  return found;
}

const ok: typeof globalThis.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
const forbidden: typeof globalThis.fetch = () =>
  Promise.resolve(new Response(null, { status: 403 }));
/** Never settles: the launcher stays in flight for as long as the test wants. */
const never: typeof globalThis.fetch = () => new Promise(() => {});

/** A bfcache restore, or an ordinary load. The only signal that tells the two apart. */
function pageShow(persisted: boolean) {
  fireEvent(window, new PageTransitionEvent('pageshow', { persisted }));
}

describe('OpenCatalogConsoleButton', () => {
  it('renders a real button with the default label and no busy state', () => {
    render(<OpenCatalogConsoleButton fetch={never} navigate={() => {}} />);

    expect(button().textContent).toBe('Open Catalog');
    // `type="button"` rather than the HTML default: dropped into a host's form, a submit button
    // that mints a session also submits the form.
    expect(button().type).toBe('button');
    expect(button().disabled).toBe(false);
    expect(button().getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('takes a custom label', () => {
    render(
      <OpenCatalogConsoleButton fetch={never} navigate={() => {}}>
        Data catalog
      </OpenCatalogConsoleButton>,
    );

    expect(button().textContent).toBe('Data catalog');
  });

  it('forwards arbitrary button props to the button itself', () => {
    // The whole reason this component is unstyled: it has to inherit the host's design system, so
    // anything a host would put on a `<button>` has to reach the `<button>`. A refactor that
    // spread props onto a wrapper instead would still render, and would silently lose the styling.
    render(
      <OpenCatalogConsoleButton
        fetch={never}
        navigate={() => {}}
        className="btn btn-primary"
        id="open-catalog"
        title="Open the catalog console"
        data-testid="launcher"
        aria-label="Open catalog"
        name="open"
      />,
    );

    expect(button().className).toBe('btn btn-primary');
    expect(button().id).toBe('open-catalog');
    expect(button().title).toBe('Open the catalog console');
    expect(button().dataset.testid).toBe('launcher');
    expect(button().getAttribute('aria-label')).toBe('Open catalog');
    expect(button().name).toBe('open');
  });

  it('does not leak the launcher options onto the DOM node', () => {
    // `basePath`, `headers`, `fetch`, `navigate`, `signal` and `pendingLabel` are the hook's
    // options, not button attributes. Spreading them through would put `basePath="/admin/catalog"`
    // in the markup and draw a React unknown-prop warning on every render.
    const { container } = render(
      <OpenCatalogConsoleButton
        basePath="/admin/catalog"
        fetch={never}
        navigate={() => {}}
        pendingLabel="Minting…"
      />,
    );

    expect(container.innerHTML).not.toContain('basePath');
    expect(container.innerHTML).not.toContain('pendingLabel');
    expect(container.innerHTML).not.toContain('Minting…');
  });

  it('honours a caller-supplied disabled', () => {
    render(<OpenCatalogConsoleButton fetch={never} navigate={() => {}} disabled />);

    expect(button().disabled).toBe(true);
    // Disabled by the caller is not the same as busy; a spinner here would be a lie.
    expect(button().getAttribute('aria-busy')).toBeNull();
  });

  it('swaps to the pending label, disables itself and announces busy while minting', () => {
    render(<OpenCatalogConsoleButton fetch={never} navigate={() => {}} />);

    fireEvent.click(button());

    expect(button().textContent).toBe('Opening…');
    // All three, not just the label: `disabled` is what stops a second mint, and `aria-busy` is
    // the only part of any of it that a screen reader gets.
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
  });

  it('takes a custom pending label', () => {
    render(<OpenCatalogConsoleButton fetch={never} navigate={() => {}} pendingLabel="Minting…" />);

    fireEvent.click(button());

    expect(button().textContent).toBe('Minting…');
  });

  it('stays busy after a successful mint, because the page is leaving', async () => {
    // The deliberate non-reset, from the button's side. A refactor that "fixes the leftover
    // spinner" by clearing the flag on success reintroduces a visible flicker of "ready to click
    // again" on a page that is already navigating away.
    const navigate = vi.fn();
    render(<OpenCatalogConsoleButton fetch={ok} navigate={navigate} />);

    fireEvent.click(button());
    await waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(button().textContent).toBe('Opening…');
    expect(button().disabled).toBe(true);
  });

  it('renders a refusal as an alert, and comes back to life', async () => {
    // A refused mint is the case a launcher most needs to surface: a button that silently does
    // nothing reads as broken rather than as forbidden. And the button has to be clickable again,
    // because unlike the success case this page is going nowhere.
    const navigate = vi.fn();
    render(<OpenCatalogConsoleButton fetch={forbidden} navigate={navigate} />);

    fireEvent.click(button());

    expect((await screen.findByRole('alert')).textContent).toContain('403');
    expect(navigate).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Open Catalog');
  });

  it('lets the host render the refusal itself', async () => {
    render(
      <OpenCatalogConsoleButton
        fetch={forbidden}
        navigate={() => {}}
        renderError={(error) => <span data-testid="mine">no: {error.message}</span>}
      />,
    );

    fireEvent.click(button());

    expect((await screen.findByTestId('mine')).textContent).toContain('no: ');
    // The host's markup REPLACES the default; rendering both would show the message twice.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing at all for a refusal when renderError is null', async () => {
    // `null` is a third answer, distinct from "not passed": the host is reading the error off the
    // hook and showing it somewhere else entirely.
    const { container } = render(
      <OpenCatalogConsoleButton fetch={forbidden} navigate={() => {}} renderError={null} />,
    );

    fireEvent.click(button());
    // The refusal has definitely landed by the time the button is clickable again.
    await waitFor(() => expect(button().disabled).toBe(false));

    expect(within(container).queryByRole('alert')).toBeNull();
    expect(container.textContent).toBe('Open Catalog');
  });

  it('clears a stale refusal when clicked again', async () => {
    // Leaving the old message under a button that is now retrying says the retry already failed.
    let refuse = true;
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: refuse ? 403 : 204 }));
    render(<OpenCatalogConsoleButton fetch={fetchImpl} navigate={() => {}} />);

    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toBeDefined();

    refuse = false;
    fireEvent.click(button());

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

/** Drives the hook directly, for the state a button does not expose. */
function HookProbe({
  onState,
  ...options
}: { onState: (state: { isPending: boolean; error: Error | null }) => void } & OpenConsoleOptions) {
  const { open, isPending, error, reset } = useOpenCatalogConsole(options);
  onState({ isPending, error });
  return (
    <>
      <button type="button" onClick={open}>
        open
      </button>
      <button type="button" onClick={reset}>
        reset
      </button>
    </>
  );
}

function probe() {
  const states: Array<{ isPending: boolean; error: Error | null }> = [];
  const latest = () => {
    const last = states.at(-1);
    if (!last) throw new Error('the probe never rendered');
    return last;
  };
  return {
    states,
    latest,
    onState: (state: { isPending: boolean; error: Error | null }) => void states.push(state),
  };
}

describe('useOpenCatalogConsole', () => {
  it('starts idle, with nothing to report', () => {
    const { latest, onState } = probe();

    render(<HookProbe onState={onState} fetch={never} navigate={() => {}} />);

    expect(latest()).toEqual({ isPending: false, error: null });
  });

  it('goes pending synchronously, so a double-click cannot be missed', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = (input) => {
      calls.push(String(input));
      return new Promise(() => {});
    };
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={fetchImpl} navigate={() => {}} />);

    fireEvent.click(screen.getByText('open'));

    // The flag is set by the click itself, BEFORE the request is on the wire — which is what lets
    // the `disabled` that follows actually stop a second click. No `waitFor` here on purpose:
    // waiting would hide a flag that only flips a turn later, which is the bug this guards.
    expect(latest().isPending).toBe(true);
    expect(calls).toHaveLength(0);

    // The request itself is a microtask behind it, because the headers are resolved first.
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('KEEPS isPending true after a successful mint', async () => {
    // The single most surprising line in the hook, and the one most likely to be "cleaned up".
    // Clearing it here puts a flicker of "ready to click again" on a page that is leaving.
    const navigate = vi.fn();
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={ok} navigate={navigate} />);

    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(navigate.mock.calls).toEqual([['/catalog']]));

    expect(latest()).toEqual({ isPending: true, error: null });
  });

  it('un-sticks isPending when the page comes back from the bfcache', async () => {
    // The counterpart to the decision above, and the reason it is safe. Pressing Back restores
    // this page from memory with React state intact, so without this the user lands on a spinner
    // that never stops, on a button `disabled` by that very flag.
    const navigate = vi.fn();
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={ok} navigate={navigate} />);

    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(latest().isPending).toBe(true);

    pageShow(true);

    expect(latest().isPending).toBe(false);
  });

  it('ignores an ordinary pageshow, which is not a restore', () => {
    // `pageshow` also fires on every normal load. Clearing the flag there would resurrect exactly
    // the flicker the hook exists to avoid, and would drop the spinner off a mint that is
    // genuinely still in flight because the user never left.
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={never} navigate={() => {}} />);

    fireEvent.click(screen.getByText('open'));
    expect(latest().isPending).toBe(true);

    pageShow(false);

    expect(latest().isPending).toBe(true);
  });

  it('stops listening for pageshow once unmounted', () => {
    // A launcher rendered inside a dialog mounts and unmounts repeatedly; a listener left behind
    // per mount is a leak that eventually calls setState on a dead component.
    const { states, onState } = probe();
    const { unmount } = render(<HookProbe onState={onState} fetch={never} navigate={() => {}} />);
    fireEvent.click(screen.getByText('open'));

    unmount();
    const rendersBefore = states.length;

    pageShow(true);

    expect(states).toHaveLength(rendersBefore);
  });

  it('surfaces a refusal as error and returns to idle', async () => {
    const navigate = vi.fn();
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={forbidden} navigate={navigate} />);

    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(latest().error).not.toBeNull());

    expect(latest().isPending).toBe(false);
    expect(latest().error).toBeInstanceOf(ConsoleSessionError);
    expect(latest().error?.message).toContain('403');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('wraps a non-Error rejection rather than storing it raw', async () => {
    // `error` is typed as `ConsoleSessionError | null`, and a caller reading `.status` off a
    // string would get `undefined` with nothing to explain why.
    const fetchImpl: typeof globalThis.fetch = () => Promise.reject('boom');
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={fetchImpl} navigate={() => {}} />);

    fireEvent.click(screen.getByText('open'));

    await waitFor(() => expect(latest().error).toBeInstanceOf(ConsoleSessionError));
  });

  it('drops a stale error on reset(), without retrying', async () => {
    // What a dialog calls when it closes. It must not mint again on the way out.
    const calls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = (input) => {
      calls.push(String(input));
      return Promise.resolve(new Response(null, { status: 403 }));
    };
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={fetchImpl} navigate={() => {}} />);

    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(latest().error).not.toBeNull());

    fireEvent.click(screen.getByText('reset'));

    expect(latest().error).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('clears the previous error when open() is called again', async () => {
    let refuse = true;
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: refuse ? 403 : 204 }));
    const { latest, onState } = probe();
    render(<HookProbe onState={onState} fetch={fetchImpl} navigate={() => {}} />);

    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(latest().error).not.toBeNull());

    refuse = false;
    fireEvent.click(screen.getByText('open'));

    expect(latest().error).toBeNull();
  });

  it('sends the mint to the configured mount, then navigates there', async () => {
    // The hook is a thin wrapper and this is the part of the wrapping that can rot: the options
    // must pass straight through, so a launcher told where the console is mounted mints and lands
    // there rather than at the `/catalog` default.
    const calls: string[] = [];
    const navigate = vi.fn();
    const fetchImpl: typeof globalThis.fetch = (input) => {
      calls.push(String(input));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const { onState } = probe();
    render(
      <HookProbe
        onState={onState}
        basePath="/admin/catalog"
        fetch={fetchImpl}
        navigate={navigate}
      />,
    );

    fireEvent.click(screen.getByText('open'));

    await waitFor(() => expect(navigate.mock.calls).toEqual([['/admin/catalog']]));
    expect(calls).toEqual(['/admin/catalog/session']);
  });

  it('reads the headers function at click time, not at wiring time', async () => {
    // What a refreshing token needs: the launcher is configured once and clicked much later.
    let token = 'stale';
    const seen: Array<HeadersInit | undefined> = [];
    const fetchImpl: typeof globalThis.fetch = (_input, init) => {
      seen.push(init?.headers);
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const { onState } = probe();
    render(
      <HookProbe
        onState={onState}
        fetch={fetchImpl}
        headers={() => ({ authorization: `Bearer ${token}` })}
        navigate={() => {}}
      />,
    );
    token = 'fresh';

    fireEvent.click(screen.getByText('open'));

    await waitFor(() => expect(seen).toEqual([{ authorization: 'Bearer fresh' }]));
  });

  it('keeps open() stable across renders, even with an inline options object', () => {
    // The reason the options live in a ref. A new `open` on every render defeats memoising
    // anything downstream, and a launcher in a list re-renders constantly.
    const seen = new Set<() => void>();
    function Probe({ tick }: { tick: number }) {
      const { open } = useOpenCatalogConsole({ fetch: never, navigate: () => {} });
      seen.add(open);
      return <span>{tick}</span>;
    }
    const { container, rerender } = render(<Probe tick={1} />);

    rerender(<Probe tick={2} />);

    expect(container.textContent).toBe('2');
    expect(seen.size).toBe(1);
  });
});

describe('openCatalogConsoleMutationOptions', () => {
  // The TanStack bridge that lets a host wire the launcher into its own cache without this package
  // depending on TanStack. Both halves matter: the key, and that the fn actually opens.
  it('keys on the mount, so two launchers pointed at different consoles do not share an entry', () => {
    expect(openCatalogConsoleMutationOptions().mutationKey).toEqual([
      'catalog',
      'console',
      'open',
      null,
    ]);
    expect(openCatalogConsoleMutationOptions({ basePath: '/admin/catalog' }).mutationKey).toEqual([
      'catalog',
      'console',
      'open',
      '/admin/catalog',
    ]);
  });

  it('mints and navigates when its mutationFn runs', async () => {
    const navigate = vi.fn();

    await openCatalogConsoleMutationOptions({
      basePath: '/admin/catalog',
      fetch: ok,
      navigate,
    }).mutationFn();

    expect(navigate.mock.calls).toEqual([['/admin/catalog']]);
  });

  it('rejects rather than navigating when the mint is refused', async () => {
    const navigate = vi.fn();

    await expect(
      openCatalogConsoleMutationOptions({ fetch: forbidden, navigate }).mutationFn(),
    ).rejects.toThrow(/403/);
    expect(navigate).not.toHaveBeenCalled();
  });
});
