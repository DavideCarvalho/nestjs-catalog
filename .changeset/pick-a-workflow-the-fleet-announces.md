---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
---

A call node can now be pointed at a workflow by picking it, instead of typing its name from memory.

The `call` node shipped with two typed fields and a docblock explaining why there was no picker, and
that explanation was correct: nothing could enumerate a deployment's registrations.
`workflowBody(name, version)` answers only for the process asking, and a missing body is ambiguous by
construction — "not registered here" reads identically to "registered through `registerRemote`
against another SDK" and to "a group resolved by convention against a live worker". A list inferred
from it would have differed per replica and would have omitted precisely the cross-SDK workflows the
node exists to call.

`@dudousxd/nestjs-durable-core` **0.65.0** closed that with `WorkflowEngine.announcedWorkflows()`,
which is not an inference: live workers publish what they can execute on the worker-descriptor
keyspace, and every pod folds the same published statements. `GET <base>/pipeline/callable-workflows`
serves it, and the call node's inspector offers it. The pipeline package's `@dudousxd/nestjs-durable-core`
peer range moves to `>=0.65.0` accordingly.

- **One entry per version, never per name.** A picker that listed names and resolved the version
  would undo the pin the node exists for. Choosing an entry writes `callName` **and** `callVersion`
  in one update, from the same entry — a selection that carried only the name would leave a node
  that runs whatever is newest on the day it runs, and looks configured while doing it.
- **`group` is the field that carries the most.** It is the only signal that separates "this body
  lives in another process, in another language" from "not registered at all", which is exactly what
  a missing `workflowBody` could never tell apart. It is set only when the live announcers name
  **one**; more than one is left absent and reported as a disagreement.
- **Disagreements are surfaced, not resolved.** Two workers claiming one `name@version` from two
  groups mean nobody can say which queue a run would land on, or whether the two are even the same
  code. Such an entry is **shown** — greyed, with both groups named in full under the field — and
  cannot be chosen. Neither half of that is optional: silently picking one would act on a claim
  nobody made, and silently dropping it is the "picker that hides what you are looking for" the
  original docblock refused to build. A disagreement on `origin` or `requires` is shown and is *not*
  a refusal: it does not change which queue the run goes to.
- **Silence is not a claim.** An un-upgraded worker of any SDK announces a bare name with no version
  and no group. No version is invented for it from a sibling entry, and it is offered greyed with the
  reason, because a name with no version cannot satisfy the pin — offering it as though it could
  would be a lie the node then carries. `callableWorkflowBlock` is the shared rule behind both
  refusals, exported from `@dudousxd/nestjs-catalog/client` as `validateWorkflow` is, so the picker
  and anything server-side reasoning about the same list cannot drift.
- **It is a snapshot, and says so.** Liveness is a TTL on the descriptor key, so a worker that dies
  takes its announcements with it within about one heartbeat. The route reads on demand and caches
  nothing; the client caches for ten seconds, emphatically not the `Infinity` that is right for
  `capabilities`; and the field prints the time it looked rather than presenting a moment as a
  standing fact. Hence a route of its own rather than a field on `capabilities`, whose answers cannot
  change without a redeploy.
- **"Nobody could be asked" is not "there are none".** With no durable engine — or when the read
  itself fails — the answer is `{ supported: false, workflows: [], detail }`, never a bare empty
  list. Rendering "no workflows found" over the second would tell somebody their workflow does not
  exist. A failed read is reported, not thrown: this feeds a convenience, and it must not take the
  inspector down with it.
- **The typed fields survive, and are not a fallback.** A deployment whose workers have not upgraded
  announces little or nothing, and a picker that became the only path would make the node unusable
  there. Both fields stay typeable at all times — including when the list is empty, unavailable, or
  simply does not contain what somebody is pointing at — and there is no empty select promising a
  choice it does not have.

**The pin is still checked after the start, not honoured at it.** `engine.start` takes a pinned
`version` as of durable 0.65.0 and the catalog deliberately does not pass one: a pinned start is
refused outright on the two *synthesized* registration paths — a child inheriting a remote ancestor's
routing, and convention routing to a live worker group — which are exactly how a cross-SDK workflow
is reached. Pinning at the start would break the calls this node exists for. So
`catalog.workflow.call-check` still reads the child's run row and cancels on a mismatch, and the
`CallInspector` docblock now records why rather than repeating that no version argument exists.
