---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
---

The catalog could not call a workflow that does not know about the catalog.

A `call` node always wrapped the author's `config` in a `WorkflowCallEnvelope`, so a durable workflow registered long before this package — one whose body reads `data["proc"]` — received `{catalog: {…}, input: {proc: …}}` and died on the first key it looked for. The only repair on offer was to edit the callee, which inverts the dependency exactly the wrong way round: every workflow anybody wanted to call would have to start depending on this package's contract, including Python workflows in other repositories.

So a call node now carries a **mode**. `WorkflowCallNode.callMode` is one of `WORKFLOW_CALL_MODES`:

- `'envelope'` — unchanged, and what an absent field means. The child gets the catalog's metadata under `catalog` and the parameters under `input`, and can stage rows back for the graph.
- `'plain'` — the child gets `config` verbatim, with nothing added and nothing wrapped.

The envelope nests for one stated reason — an author's `runId` parameter must not shadow the run id — and that reason is not weakened, because a plain call sends no catalog metadata at all and so has nothing to shadow.

**What a plain call gives up, and why the validator refuses graphs rather than documenting it.** No `runId` and no `nodeId` means the callee is told no key to stage rows under, so a plain call can never return rows to the graph. `validateWorkflow` therefore refuses a plain call node with **any outbound edge**, code `call-plain-has-output` — every node kind that can sit downstream of a call consumes rows and only rows, so "has downstream nodes expecting rows" and "has an outbound edge" are the same set. Two rules moved to make that statable: a plain call no longer counts as something that reads (so `plain call → sink` is refused by `no-source` as well), and it is exempt from `dead-end`, an exemption exactly one node wide because nothing can be behind a node that may not have an outbound edge. Without the refusal such a graph would save, publish, run, report success, and commit an empty snapshot.

A plain call's **return value is not read** — not as rows and not at all. It is the child run's output, recorded durably under the child run id the node's log line names; reading `{batches, rowCount}` off it would send the graph to a stage that cannot exist, and copying it into this run's log would put an arbitrary worker's payload somewhere this package's redaction rules never see. The cost is that a plain call can hand nothing back into the graph, not even a scalar an `if` could test on. That is the trade the two modes are.

Backward compatible in both directions that matter: every stored call node has no `callMode`, keeps sending the envelope, and `workflowGraphHash` appends a component only for `'plain'` — an explicit `'envelope'` hashes identically to an absent one, so no stored graph is renumbered by a deployment picking this up.

The version pin is untouched. Worth being accurate about what it buys against a Python callee: `durable_worker` has no version concept at all and registers everything as `'1'`, so a pin against one is satisfiable and inert.
