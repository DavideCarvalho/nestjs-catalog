---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
---

A Python transform's `print` goes somewhere, and `durability()` stops describing checks it never made.

## `print`

`TransformResult.logs` is documented as "Anything the code logged", and the JavaScript harness
overrides `console.*` so that it is. The Python harness captured nothing unless the author called an
undocumented `log()`: `print` went straight through to the child's real stdout, where the last-line
result parse discarded it. So the first thing anybody writes while working out what their transform
is doing produced an empty log panel and no explanation — and the conclusion that invites ("my code
never ran") is the wrong one. It costs the author their trust in the tool before they have written
anything real.

`print` is now redirected, along with `sys.stderr`, into the same list the result carries.

- **`log()` stays, and is now literally `print`.** Transforms in the wild call it and a `NameError`
  is a worse answer than a redundant helper — but it is no longer a second capture path with its own
  ordering. One buffer, one sequence.
- **stdout and stderr interleave in call order, unmarked**, which is what the JavaScript harness
  already does with `console.error`. A reader is reconstructing a sequence and two lists cannot be
  zipped back together.
- **Output written before a traceback survives it.** The redirect is a `contextlib` context manager
  around the call rather than a swap held for the whole script, so it unwinds out of an exception
  with the buffer intact. That is the case logs matter most for and the case a naive swap loses.
- **A write that never ended its line is kept** rather than being lost. It used to be worse than
  lost: it landed immediately before the result JSON on the same line, so `sys.stdout.write("x")`
  without a newline failed the whole run as unreadable.

## Bounds, in both harnesses

`logs` is user code writing whatever it likes, and it is the one thing that crosses a durable step
boundary into the run record — so an unbounded capture makes the size of a `finishRun` write a
property of somebody's source data. Both harnesses now cap at **500 lines of 2,000 characters**, the
same two numbers, applied in the child before anything is serialised. The JavaScript harness had no
bound of its own; its only ceiling was the 32MB stdout kill, which loses the whole run rather than
truncating a log.

What is dropped is said out loud, in a final line naming the count. A truncation nobody is told about
is the same failure as a log nobody is told about, moved to line 501.

The Python sink is bounded, not only its result: an unterminated write past a line's ceiling is
emitted rather than accumulated, so a transform writing megabytes with no newlines in them cannot
grow the child's memory either.

Two smaller things of the same family: **`console.debug` and `console.trace` are now captured**
(`debug` writes to stdout exactly as `log` does, so it was corrupting the very result line the
override exists to protect; `trace` writes to stderr and simply vanished), and **a failing transform's
last logged lines are folded into the error**. A failure throws, and a throw carries a message and
nothing else, so `logs` never reached the caller at all on the one path they were most wanted — the
last ten lines at 200 characters, counted so nobody reads a tail as the whole of it.

## `WorkflowLauncher.durability()`

Its docblock described three refusal checks — an engine, whether this pod serves handlers for it, and
whether that engine belongs to the environment the caller asked for — and the body performed one. An
unused `requireEnvironmentBundle` import and an uncalled `safely()` helper were left behind from the
other two.

**The prose was corrected rather than the checks rebuilt, because neither can be made correctly from
this package**, and the docblock now says that instead of implying they are covered:

- **Handlers.** `engine.workflowBody(name, version)` answers only half of it. A body means definitely
  registered; *no* body is equally a `registerRemote` worker in another SDK or a group resolved by
  convention against a live worker, both of which run the graph perfectly well. Treating that half
  answer as "no" would route a durable run inline — and an inline run carries none of the singleton
  mutex, so two workers would load one connector's type at once. That is worse than the failure it
  would guard against, and the genuinely unregistered case already fails loudly: `engine.start` throws
  and `startDurable` refuses rather than falling back.
- **Environment.** The one with real damage behind it, and the one least available from here. A
  `WorkflowEngine` carries no environment identity this package can read, so the most it could compute
  is which environment the *caller* is in — half a comparison, which is exactly why the two fossils
  were left unused rather than finished.

Both are therefore reported rather than detected, through
`CATALOG_PIPELINE_DURABILITY_DETAIL` — **which was broken in the way that matters most for that job.**
The seam is documented as something that "only ever ADDS to what the package observed" and it was
*substituting*: a host binding a true and specific sentence ("this pod registers no workflow
handlers") erased the sentence saying whether an engine had resolved at all. It now composes, with
the observation first, because that is the part that was actually checked.

`WorkflowDurability.engine` is populated for the first time. It is declared as something a console can
print and absent whenever nothing can checkpoint, and the body never set it — so the console's
`checkpointing: <engine>` label could not have rendered a name in any deployment. It is the class that
resolved, which is a weak signal named as one: it distinguishes a real engine from a host's stand-in
and says nothing about which broker or which environment is behind it.

**Still unreachable, and not fixed here:** `GET <path>/pipeline/capabilities` returns only
`{ languages, pythonPackages }`, so nothing serves `durability()` over HTTP at all. The React console
already has the banner — `describeDurability(capabilities?.durable)` in `WorkflowCanvas` — and reads
`undefined` in every deployment. Whatever a host says through the detail seam is dropped on arrival
until that route carries `durable`.
