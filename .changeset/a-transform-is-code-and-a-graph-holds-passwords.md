---
'@dudousxd/nestjs-catalog-pipeline': major
'@dudousxd/nestjs-catalog': minor
---

Two security fixes on the pipeline surface: who may execute a transform, and what a graph serves.

**`POST pipeline/transforms/try` is code execution and is now authorised as such.** It was the only
route on the controller that never called `requirePrincipal`, and it did not check that
`body.language` was a language the way `saveTransform` does. It reached `SubprocessTransformRunner`
on `catalog:write` alone — and that runner is honest in its own docblock about not being a security
boundary, because the child reads the parent's whole environment back out of `/proc/<ppid>/environ`
whatever the `env` allowlist withholds, and reads the filesystem as the service's own user. So the
softest thing on that route was the only thing holding the door.

It now requires a principal, at least one `writeTypes` grant, and a signed-in person
(`@RequireHuman()` — this is the decorator's first use anywhere; declare `REQUIRES_HUMAN` in your
guard). **Breaking for hosts** whose console calls this route with a machine principal, or with a
principal holding `catalog:write` and no per-type write grant: both now get 403.

The bar is deliberately the same one the graph path already charges rather than a higher one — a
principal that may write some type can already run the same code by saving a transform, saving a
graph and pressing Run. That residual is the trust model, and it is now written down in the pipeline
README under "Running a transform is running code" instead of only in a JSDoc, along with the
supported way to change it (bind your own `TransformRunner`).

**`GET pipeline/workflows` served source-node credentials verbatim.** A `WorkflowSourceNode` carries
the same `config` vocabulary a connector does, so a URL with a password in a graph was readable by
anyone holding `catalog:read` — the audience `redactConnector`/`redactConnection` were written for,
through the one route nobody had counted as a connector route. Source configs are now redacted on the
way out, and restored per node id on the way back in, so a console that reads a graph and posts it
back does not overwrite the credential with the placeholder. The save responses of `POST workflows`,
`POST connectors` and `POST connections` are redacted too: each returns the row it just restored, so
an unredacted response undid the read redaction in a single request.

`SubprocessTransformRunner` also gets three fixes worth having regardless of the above: `stderr` is
bounded at 64 KiB (it accumulated without any cap for the whole timeout window, growing the *parent's*
heap until the pod died), the timeout kills the child's process group rather than one pid (so a
transform that spawned anything no longer outlives it), and the child runs in a temporary directory
rather than inheriting the service's, where `readFileSync(".env")` reached the host application's
configuration.
