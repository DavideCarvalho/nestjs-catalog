---
"@dudousxd/nestjs-catalog-pipeline": patch
---

A sink keeps the position it was saved at

`readNode` reads `position` once for every node, and the `sink` branch was the
one that did not return it. The read was four lines above.

The consequence was total rather than cosmetic: a sink could not be placed at
all, by any route. Drag one on the canvas, save, reload, and it is back where
the automatic layout puts it. `POST pipeline/workflows` carrying explicit
coordinates answers **201** and drops them — which is how this was found, by
rewriting thirteen adopted graphs' positions and reading one back.

The new spec is written over `Record<WorkflowNodeKind, …>` rather than about
sinks: four independent branches each remembering a field that was read for all
of them is the shape that caused this, and the fifth kind will be added by
somebody who never saw it. A kind added to the union without a fixture is now a
compile error.
