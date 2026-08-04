import type { ReactNode } from 'react';
import { ChartFailed } from '../charts/skeleton';

/**
 * What an embed shows while it is fetching, and what it shows when it could not.
 *
 * Both are the host's to decide, which is why they are props at all. A host's
 * application already has a loading state — a shimmer, a spinner, a skeleton
 * built to its own type scale — and a component that insists on its own is the
 * one element on the page that looks like it came from somewhere else. The same
 * goes double for failure: whether a chart that could not load should say so,
 * disappear, or raise something to the host's error reporting is a product
 * decision, and a library that answers it has answered it for everybody.
 *
 * A node OR a function. The node form is what most callers want and reads as
 * markup; the function form exists because a failure has something to say (the
 * error) and because a loading state may be expensive enough to be worth not
 * constructing until it is needed.
 *
 * `undefined` — the prop not passed — falls back to the neutral defaults below.
 * `null` does NOT: it is a host saying "render nothing here", and collapsing
 * the two would leave no way to ask for silence.
 */
export type EmbedLoadingSlot = ReactNode | (() => ReactNode);

export type EmbedFailureSlot = ReactNode | ((error: Error) => ReactNode);

/**
 * The default is empty space of the right height, not a spinner.
 *
 * It reserves exactly what the chart will occupy, so nothing on the host's page
 * moves when the data lands, and it imposes no vocabulary of its own. A host
 * that wants the package's own placeholder passes it: `loading={<ChartSkeleton
 * kind="bar" />}`. This component cannot pick the kind for them — which chart
 * is coming is in the payload that has not arrived yet.
 */
export function renderLoading(slot: EmbedLoadingSlot | undefined, height: number): ReactNode {
  if (slot === undefined) return <div style={{ height }} aria-busy="true" />;
  return typeof slot === 'function' ? slot() : slot;
}

/**
 * The default failure says what went wrong and offers NO retry.
 *
 * `ChartFailed` can draw a "Try again" button and deliberately is not given the
 * handler that would: re-running is the console's affordance, and an embed that
 * could re-run would let any page in any application re-execute the query at
 * will, past whatever caching sits in front of it. A host that wants a retry
 * has a better one than a button in someone else's component — it owns the
 * query client, and can invalidate the key.
 */
export function renderFailure(
  slot: EmbedFailureSlot | undefined,
  error: Error,
  height: number,
): ReactNode {
  if (slot === undefined) {
    return <ChartFailed height={height} message={messageOf(error)} />;
  }
  return typeof slot === 'function' ? slot(error) : slot;
}

/**
 * React Query types its error as `Error`, but what a transport threw is
 * whatever the host's HTTP client throws — a string, a response object, a
 * rejection with no shape at all. Reading `.message` off that gives `undefined`
 * and a component that reports an empty failure, which reads as a component
 * that failed to render rather than a chart that failed to load.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'This chart could not be loaded.';
}
