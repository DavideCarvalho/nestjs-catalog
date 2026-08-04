/**
 * Embedding: a chart or a whole board, in an application that is not this one.
 *
 * The console's screens and these components read the same data and share the
 * same drawing code (`charts/body.tsx`), and differ in exactly one way: nothing
 * here can change anything. See `actions.ts` for what that rules out and why.
 */
export {
  EMBED_ACTIONS,
  type EmbedAction,
  type EmbedActions,
  resolveEmbedActions,
} from './actions';
export { EmbeddedChart, type EmbeddedChartProps } from './EmbeddedChart';
export { EmbeddedDashboard, type EmbeddedDashboardProps } from './EmbeddedDashboard';
export {
  chartsInLayoutOrder,
  type EmbeddedChartPayload,
  type EmbeddedDashboardPayload,
} from './payload';
export type { EmbedFailureSlot, EmbedLoadingSlot } from './slots';
