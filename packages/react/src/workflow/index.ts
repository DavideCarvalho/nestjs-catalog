/**
 * `@dudousxd/nestjs-catalog-react/workflow` — the canvas itself.
 *
 * A subpath rather than a name on the root entry point, for the same reason the
 * chart renderers have one: this module imports `@xyflow/react`, which is an
 * **optional** peer dependency. Anything reachable from the root entry is
 * resolved by the host's bundler whether or not the host ever renders it, so a
 * root export would turn "optional" into "required to build", and every host
 * that only wants the object explorer would be installing a graph library.
 *
 * The graph model, the working name and the validation rules stay on the root
 * entry — none of them import React Flow, and a host should be able to check a
 * graph, or name one, without pulling in a canvas to do it.
 *
 * `motion` is the second optional peer this subpath needs, for the same class of
 * reason: the delete control on a selected edge animates in and out, and
 * `useReducedMotion` is how it declines to. Both are declined together —
 * anything mounting a node canvas is already installing a graph library, and a
 * host that wants neither wants the root entry point instead.
 */
export { WorkflowCanvas, type WorkflowCanvasProps } from '../WorkflowCanvas';
export {
  layout,
  layoutIfUnarranged,
  NODE_HEIGHT,
  NODE_WIDTH,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
  type WorkflowNodeData,
} from './graph';
// What happens to a graph once it is drawn. Here rather than on the root entry
// because a host reaching for these is already mounting the canvas — and
// `refusedForShrink` is here rather than nowhere because "was that failure the
// row-count bound" is a judgement a host might want to make outside a canvas.
export {
  PublishControls,
  refusedForShrink,
  RunControls,
  SchedulePanel,
  ShrinkRefusalNote,
  WorkflowStatusBadge,
} from './lifecycle';
export { RunsAsPanel } from './runs';
