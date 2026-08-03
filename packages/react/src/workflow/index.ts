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
