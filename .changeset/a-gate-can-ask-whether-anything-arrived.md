---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
---

An `if` node can branch on how many rows reached it

The case that asked for it, and it is not hypothetical: a nightly export comes
back empty because the upstream system is mid-maintenance. Nothing is broken —
so the run succeeds, the sink commits, and committing is what repoints the live
view of a type. Yesterday's good data stops being served, and the run reports
success while it happens. The `if` node already had the mechanism to prevent
that (a skipped node is never executed, so nothing reaches the publish
protocol), and it could only be pointed at an environment variable, which
answers a question about the *deployment* and not about this run.

So a gate now tests one of two things, and **the shape of the test changed to
say so**: `WorkflowIfNode` carries a `predicate` — `{kind: 'env', envVar,
equals?}` or `{kind: 'rowCount', atLeast}` — where it used to carry `envVar` and
`equals` directly. The flat alternative was to add the threshold beside them and
mark everything optional, and that types a gate as "a variable, maybe, and a
number, maybe": a node carrying both is representable, a node carrying neither
is representable, and every reader has to invent its own rule for which one
wins. A gate that runs the test its author did not choose is precisely the
failure this node exists to prevent, so the ambiguity is not representable
instead. Every decision made per predicate kind ends in
`unreachablePredicateKind`, so the `code` predicate this file has been promising
lands as a build failure listing what has to answer for it — the same treatment
node kinds got.

The threshold is one integer of at least one, compared one way. `atLeast: 1` is
"did anything arrive at all", so the common case costs nothing to express, and
"a full export is never legitimately under ten thousand rows" is the next thing
anybody asks for — it would otherwise need a second predicate kind for one
number. There is no `atMost` and no operator picker for the reason there is no
`negate` flag: the inverse is already expressible by swapping which successor is
on `then`, and two ways to say one thing is two places to look when a load takes
the branch nobody expected. A threshold of zero is refused rather than treated
as "always", because it is a gate that can only answer one way — the `else`
subtree would never run on any deployment, which is the silent half-graph
reached by typing a number rather than by mislabelling a wire.

**The count is read off the checkpoint, never by counting rows.** It is
`WorkflowStageRef.rowCount` on the step's own input — assembled by the workflow
body from an upstream step's recorded output — so the predicate stays a pure
function of what the run already wrote down, and the branch it produced is
recorded on the step's output exactly as the env predicate's is. A resumed run
on another pod reads the decision back rather than making a new one; nothing
queries the stage store on the replay path. A gate still touches no rows, and
still takes exactly one inbound edge, so "how many rows" has exactly one answer
and it is the count on the very ref the gate hands on.

Because `if` nodes have never been released, no stored graph carries the old
flat shape and nothing is migrated. A payload carrying it is refused at the HTTP
boundary and by `isWorkflowNode` rather than adapted — guessing the test from
which fields happen to be present is the ambiguity above, arrived at by being
helpful.

The console's gate inspector picks the kind first and then shows that kind's
fields, and a predicate kind added without a form there stops the build naming
the file.
