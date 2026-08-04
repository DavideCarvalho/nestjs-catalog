import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogIn, ShieldHalf } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { UnauthorizedError, api, clearDevKey, getDevKey, setDevKey } from './transport';

/** The one query key for "who am I". Shared so the whole app sees one answer. */
export const IDENTITY_QUERY_KEY = ['auth', 'me'] as const;

/**
 * Establishes who is using the console before letting them use it.
 *
 * This used to ask for one application key, which everybody who opened the page
 * shared. That made every human action in the console indistinguishable from
 * every other, and from the nightly publisher — the audit trail could say a
 * column was renamed but never by whom, which is not governance, it is a log
 * line. So this is a sign-in now.
 *
 * The name of the component is unchanged deliberately, because `App.tsx` imports
 * it by name and belongs to somebody else this week. It should be renamed to
 * `SignInGate` when that file is next touched.
 *
 * The application-key path survives underneath, folded away, because a
 * developer running this against a local database has no reason to seed a user
 * before they can see a table. It is labelled for what it is: anything done
 * through it is attributed to the application, not to them.
 */
export function KeyGate({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [showDevKey, setShowDevKey] = useState(false);

  const {
    data: identity,
    isLoading,
    error,
  } = useQuery({
    queryKey: IDENTITY_QUERY_KEY,
    queryFn: () => api.me(),
    retry: false,
    // Re-asked when the tab regains focus, which is how an expired session
    // turns into the sign-in screen rather than into a page where every action
    // fails with a 401 and no explanation.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  if (identity) return <>{children}</>;

  // The very first render, before the probe has answered. Showing the sign-in
  // form here would make it flash on every reload for people who are already
  // signed in, which reads as being logged out.
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-zinc-400">
          Checking your session…
        </p>
      </div>
    );
  }

  const unrecognised = error instanceof UnauthorizedError;

  return (
    <div className="flex h-full items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-1 flex items-center gap-2 text-zinc-400">
          <ShieldHalf size={14} />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em]">Catalog console</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Everything you do here is recorded against your name, through the console&rsquo;s
          application. You never see more than both of you may.
        </p>

        <SignInForm onSignedIn={() => client.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY })} />

        {!unrecognised && error && (
          <p className="mt-3 text-xs text-amber-600">
            Could not reach the catalog: {String(error)}
          </p>
        )}

        <div className="mt-8 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setShowDevKey((open) => !open)}
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <KeyRound size={12} />
            {showDevKey ? 'Hide' : 'Use an application key instead'}
          </button>
          {showDevKey && <DevKeyPanel onApplied={() => window.location.reload()} />}
        </div>
      </div>
    </div>
  );
}

function SignInForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => api.login(email.trim(), password),
    onSuccess: () => {
      // Cleared the instant it is no longer needed. It has already been sent;
      // keeping it in component state means it stays in a React fiber, and in
      // any devtools snapshot, for as long as the tab is open.
      setPassword('');
      onSignedIn();
    },
  });

  return (
    <form
      className="mt-5 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        signIn.mutate();
      }}
    >
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="username"
        aria-label="Email"
        placeholder="you@example.com"
        // biome-ignore lint/a11y/noAutofocus: this is a gate with one field and nothing else to reach, which is the case the rule's own docs exempt
        autoFocus
        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 dark:border-zinc-800 dark:bg-zinc-900"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        aria-label="Password"
        placeholder="Password"
        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 dark:border-zinc-800 dark:bg-zinc-900"
      />

      {signIn.isError && (
        <p className="text-xs text-red-600">
          {/* The server says the same thing for a wrong password, an unknown
              account and a disabled one. Repeated verbatim rather than
              embellished — guessing which it was, on screen, would undo the
              reason it is vague. */}
          {signIn.error instanceof Error
            ? messageOf(signIn.error)
            : 'Those credentials were not accepted.'}
        </p>
      )}

      <button
        type="submit"
        disabled={signIn.isPending || email.trim().length === 0 || password.length === 0}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 py-2 text-sm text-zinc-50 transition-colors hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
      >
        <LogIn size={14} />
        {signIn.isPending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

function DevKeyPanel({ onApplied }: { onApplied: () => void }) {
  const [draft, setDraft] = useState(getDevKey() ?? '');

  return (
    <div className="mt-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        For local development. The console will act as that application, and everything you do will
        be attributed to it rather than to you.
      </p>
      <input
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Application key"
        placeholder="x-catalog-key"
        className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-amber-500 dark:border-zinc-800 dark:bg-zinc-900"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={draft.trim().length === 0}
          onClick={() => {
            setDevKey(draft.trim());
            onApplied();
          }}
          className="rounded-md border border-amber-500/40 px-3 py-1.5 text-xs text-amber-600 disabled:opacity-40"
        >
          Use this key
        </button>
        {getDevKey() && (
          <button
            type="button"
            onClick={() => {
              clearDevKey();
              onApplied();
            }}
            className="rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Forget it
          </button>
        )}
      </div>
    </div>
  );
}

const FALLBACK = 'Those credentials were not accepted.';

/**
 * Nest wraps its messages in JSON; the transport already unwrapped what it
 * could, but a 401 arrives through `UnauthorizedError` carrying the raw body.
 *
 * Narrowed rather than asserted. A parsed body is `unknown` no matter how
 * confident anyone is about the server on the other end, and the failure mode
 * of pretending otherwise here is rendering `[object Object]` at the exact
 * moment somebody is trying to work out why they cannot get in.
 */
function messageOf(error: Error): string {
  const raw = error.message.trim();
  if (!raw.startsWith('{')) return raw || FALLBACK;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      const message = Reflect.get(parsed, 'message');
      if (typeof message === 'string' && message.length > 0) return message;
    }
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}
