---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
---

A call node's version pin no longer reports a guarantee it did not obtain

`WorkflowRunSteps.checkCall` compares the version a call node pinned against the
`workflowVersion` the child run recorded. Against a convention-resolved remote —
which is how every cross-SDK callee is reached — that comparison was inert:
`engine.start` stamped `workflowVersion: '1'` before the resolver ran and the
resolver echoed it back, so a pin of `1` passed by construction and any other pin
failed by construction, whatever the callee actually was. A check that cannot
fail is worse than no check, because it reads as a guarantee.

`@dudousxd/nestjs-durable-core` **0.66.0** fixed its half: the version now comes
from the live descriptor announcement for the group being resolved, so a pin
against a callee that declares one is genuinely checked. And when nobody declares
one, the call still works and the run carries `version:undeclared` alongside the
routing default, so whoever checks a pin later can tell an assumed version from a
stated one. `checkCall` did not read that tag, and so still reported a match it
had not made.

**It reads it now, and the comparison stops being available in BOTH directions.**
Passing `1` was the defect as reported. Failing `2` is the same defect wearing
the other face — a mismatch derived from the same placeholder — and refusing on
it would make every callee on an older SDK uncallable with any pin but `1`,
remediable only by changing the callee. That is the rule durable rejected one
layer down and it is rejected here for the same reason. So an undeclared callee
is **called, not refused**, and the unverifiability travels:

- on the step's own log, where the engine and Telescope record what a step did;
- on `WorkflowCallCheckResult.versionDeclared`, which the step checkpoints, so
  the run's history states what the check was worth rather than merely that one
  happened;
- on the node's outcome log — `Nothing verified the pin on <name>@<version>: …` —
  because the line above it says `Called <name>@<version>` and would otherwise
  read as a version that was kept. Both call modes, envelope and plain.

Nothing changes for a callee that declares a version: a mismatch is still
cancelled and still fails the load, which is the case durable just made work.
`versionDeclared` is absent on a checkpoint written before this release and is
read as "declared", so an in-flight run resumes saying exactly what it said when
it suspended.

**The picker says which kind of silence it is.** `CallableWorkflowRef` gains
`evidence`, mirroring durable's `AnnouncementEvidence`: `declared` (a live worker
published a descriptor naming this workflow) or `observed` (nobody described it;
what exists is a live routing token of that name, which is what a call is routed
on and the whole of what is known). Both tiers were already refused as pins for
having no version — what they could not say is *why*, and an `observed` entry is
precisely the callee whose runs come back tagged `version:undeclared`. The
refusal message now distinguishes them, says that a heartbeat cannot even
establish the token serves a workflow rather than a step handler of the same
name, and — on both — says what a hand-typed pin against such a callee is worth,
which was the one thing an author choosing a version could not find out before a
load ran. The canvas row reads `live queue only, nothing declared` rather than
`no version announced` for the weaker tier.

Also corrected: `checkCall`'s docblock claimed the engine cannot start a
particular version at all. Since 0.66.0 `ctx.child`/`ctx.startChild` take a
`version` — and resolve the by-name@version registry and stop there, so the
routes they refuse are exactly the `registerRemote` and convention-resolved
remotes a call node lives on. The step is still the only place a pin on those can
be kept; the docblock now says so for the right reason.

`@dudousxd/nestjs-durable-core` is bumped to `>=0.66.0` in
`@dudousxd/nestjs-catalog-pipeline` and stays an `@Optional()` injection: a
deployment with no durable engine still boots, and `checkCall` still refuses
outright there rather than proceeding unchecked.
