---
'@dudousxd/nestjs-catalog-pipeline': patch
---

Export `SubprocessTransformRunner`

A host that declares its own pipeline controllers needs it, and Nest resolves a controller's
dependencies from the module that declares the controller — so without the export the host fails at
boot with `Nest can't resolve dependencies of the PipelineController ... SubprocessTransformRunner at
index [1] is available in the ... module`.

Exported rather than left to the host to provide, because this module owns the configured instance:
it is the one built with `pythonVenv`. A host supplying a second one would be running transforms
through a runner configured somewhere else, which is the kind of difference that only shows up when a
transform cannot find its interpreter.
