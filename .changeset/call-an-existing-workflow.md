---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
---

A workflow node that hands its step to a durable workflow that already exists.

A graph could do three things — read, transform, commit — and every one of them had to be written
here. A deployment that already runs durable workflows, including ones whose body is in Python, had
no way to put one in a pipeline. `call` is a fourth node kind: it names a registered workflow and a
version, and runs it as a **tracked child** of the catalog's own durable run.

- **The version is pinned, and pinned means checked.** A node stores `callName` *and* `callVersion`,
  and both are part of the graph fingerprint, so repointing a node at `foo@2` is a new version of
  the graph. The honest limit is written down where it applies: `engine.start` resolves the newest
  registered version and takes no version argument, so the child is started and then **checked** —
  `catalog.workflow.call-check` reads the child's run row, and a mismatch cancels the child and
  fails the node naming both versions. A wrong version is stopped, not prevented. The step refuses
  outright when the process running it has no engine to check against, because "unchecked" and
  "checked and fine" must not read the same.
- **Handles cross the boundary, never rows.** The child receives one documented envelope —
  `{catalog: {contract, runId, nodeId, workflowId, workflowVersion, principalId, inputs}, input}` —
  where `inputs` names the stages its inbound edges wrote, addressed by `(runId, nodeId, batch)` as
  everything else in a run is. A child that produces rows for the graph stages them under the
  calling node's id and returns `{batches, rowCount}`. There is no shared type between a catalog
  node and an arbitrary workflow and none is pretended: `readWorkflowCallOutput` reads those two
  counts, reads their absence as "called for its effect, no rows" and says so in the run log, and
  **refuses half of them** rather than turning a callee's bug into a load that came out short.
- **Nothing validates the callee's input at save time, because nothing can.** `register()` takes
  `validateInput` and `searchAttributesSchema`, but neither is reachable: the registry is private
  and no public method hands a registration out. What does happen is that `engine.start` runs the
  callee's own `validateInput`, and a refused start is delivered to the parent as a failed child —
  so a bad wiring fails at the node, naming the node, the workflow, the version and the child run.
- **A busy callee waits rather than failing.** A singleton with `maxQueueDepth` refuses a start once
  its backlog is full, which is contention and not a fault; the node retries five times over about
  seven and a half minutes, suspended at zero compute, each attempt with its own child id, and then
  fails saying it was contention and quoting the engine. Skipping was rejected: a node that quietly
  produced nothing is the failure this service exists to remove.
- **Failure and cancellation, stated:** a failed child fails the node, everything downstream is
  `skipped`, and the load is failed. Cancelling the parent cascades to the child; letting the parent
  hit its `executionTimeout` does **not**, because that sweep marks the run cancelled without going
  through `cancel`. The parent's own execution timeout is still what stops a hung child holding a
  connector's singleton slot for ever — admission counts `suspended` runs, and a timed-out parent is
  no longer one. A called workflow should carry its own `executionTimeout`; `ctx.child` takes none.
- **Serialisation belongs to the callee, and is weaker across SDKs.** Calling a workflow does not
  lend it the caller's singleton. On the convention/`attach` path a cross-SDK body is reached by,
  the synthesised registration carries no singleton, timeout or validator at all. The canvas says so
  rather than implying otherwise.
- **`expectShrink` reaches every node step and no callee.** The acknowledgement on
  `POST workflows/:id/run` stands the row-count bound down for one snapshot, and the bound is
  applied at the sink — so a call node does not forward it. Handing a one-time acknowledgement to
  an arbitrary workflow would put it somewhere nothing on this side can account for what was done
  with it.
- **A `call` node counts as something that reads**, so `call → sink` is a valid graph and
  `no-source` is no longer raised on one. A graph of transforms alone is still refused.
- **On a pod with no durable engine the run is refused up front**, naming the node and the workflow,
  instead of opening a run row and failing at the node.
- The canvas gains a Call node with a workflow field, a version field and a JSON parameter box, in
  the same node inspector that authors a source or a sink — the one screen a pipeline is now
  published, scheduled and run from, so a call node is drawn, saved and published exactly like the
  rest of the graph rather than through a surface of its own.
  **Deliberately no picker**: nothing can enumerate a deployment's workflows — `workflowBody` answers
  only for the asking process, and a missing body equally means a `registerRemote` body in another
  SDK or a group resolved against a live worker — so a list inferred from it would silently omit the
  cross-SDK workflows this node exists to call. `CallableWorkflowRef` is the shape to hand it the day
  a deployment can announce its registrations: one entry per name **and** version.
- A call node's `config` travels the same credential path a source node's does — sealed under
  `encryptCredentials`, refused in plaintext without it, redacted on the way out and restored on the
  way back in — which is why it carries the same field name.

**Calling a durable *step* is not offered, and cannot be.** A step has no global identity: it is
routed by a name a worker subscribes to and addressed within a run by its `seq`, so there is nothing
to start, await or cancel. Wrap it in a one-step workflow. This is written into `WORKFLOW_NODE_KINDS`
beside the other rejected kinds rather than left to be rediscovered.
