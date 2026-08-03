/**
 * What this thing is called, in one place.
 *
 * A constant rather than the word typed into thirty JSX strings, because the
 * name is not settled: the model for this graph is being defined in
 * `@dudousxd/nestjs-catalog` in parallel, and whatever it lands on is the name
 * that should win. Renaming then is one edit here.
 *
 * It is deliberately **not** "Flow". `FlowView` in this package is a *derived*
 * picture: it reconstructs who feeds what from the audit trail, and its own
 * comment argues that inferring the graph from what publishers actually did is
 * "more truthful than a diagram someone has to remember to update". This screen
 * is the exact opposite — a graph somebody authors by hand and the server then
 * executes. Two screens sharing a name while making opposite claims about where
 * the truth lives is how people end up trusting the wrong one.
 *
 * "Workflow" is the working choice, and the overlap with the durable engine's
 * own "workflow" is intended rather than accidental: a workflow here compiles
 * to exactly one durable workflow, whose steps are this graph's nodes. The noun
 * is the same because the thing is the same, one layer up. If the model agent
 * picks something else, change these four strings.
 */
export const WORKFLOW_NAME = {
  singular: 'workflow',
  plural: 'workflows',
  title: 'Workflow',
  titlePlural: 'Workflows',
} as const;
