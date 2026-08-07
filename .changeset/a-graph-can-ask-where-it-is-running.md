---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

An `if` node, so one graph can serve two deployments

The case that asked for it: a local deployment has a ClickHouse and dev does
not. Without a conditional that is two workflows, which is two things to keep in
step and one of them always drifts — so the graph gains a node that decides, at
run time, which half of itself runs.

An `if` names an **environment variable** and takes a `then` and an `else`.
Declarative rather than code, and that is the safety property rather than a
simplification: a predicate is the one expression whose answer decides which
nodes exist for a run, so an answer that can differ between a run and its replay
is a load that goes down a path nobody chose. The evaluated branch is recorded
on the node's outcome the first time it is asked and read back afterwards — the
node runs inside a durable step, whose output is a checkpoint, and the workflow
body reads that record rather than the environment. A resumed run on another pod
therefore reproduces the first run's decision instead of making a new one.

**A sink on the untaken branch does not commit.** This is the part worth reading
before upgrading. Committing is what repoints the live view of a type, so a sink
that "ran with no rows" would publish an empty snapshot over a good dataset and
report success while doing it. A skipped node is not executed at all, so nothing
reaches the publish protocol; and because "skipped" already meant "the run
stopped before here", the outcome now carries `skippedBecause` so the two can be
told apart in the data and on the run panel. A sink stood down by a branch says
so in the run's log, naming the type it did not commit and saying that whatever
was live still is.

The skip rule is reachability from the **taken** edges, not descendants of the
untaken one. The obvious version is wrong on the shape branches are most often
drawn in: where both sides converge on one node, walking down from the untaken
edge skips the join — and with it the sink behind it — on a run that otherwise
succeeded. `workflowNodeRuns` is exported so a screen can answer "would this have
run" exactly the way the runner decided it.

Nothing about an existing graph changes. `WorkflowEdge.branch` is optional and
absent on every stored edge; an unlabelled wire is unconditional, and the graph
fingerprint folds the label in only when there is one, so no stored workflow is
renumbered and no past run becomes unidentifiable. What is refused is the pair of
silent mistakes: an unlabelled wire out of an `if` (a subtree that would never
run) and a label on a wire that leaves anything else (a decision that is drawn
and never read).

Every place that decides something per node kind now fails to compile when a kind
is missing from it, rather than falling through to the last branch. Adding `if`
found two such places on the way in, which is the argument for it.

The console gets the node, an inspector, and `then`/`else` labelled and coloured
on the wires — labelled as well as coloured, because two lines leaving one box
that differ only by hue are one line to a colour-blind reader, and this
particular difference decides which half of the pipeline runs.
