---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
---

Transform code gets a second parameter: `context`

A transform was a function over a batch, and a batch is not the whole of what it needs. It needs the
token for the API it enriches against; it needs to say which run it belongs to when it logs; and the
conditional node coming next has a predicate with no `records` at all, which still has to answer "did
the source return anything" — the guard that stops an empty snapshot being committed over live data.

So `records` is joined by `context`, in JavaScript, TypeScript and Python alike: the run id, the
graph and node, `rowCount`, the per-edge `inputs` (handles and counts, the same `WorkflowStageRef`
the call node already hands a callee), the host's name for this environment, and `env`. The harness
generates the parameter, so every transform stored before today keeps running unchanged.

**`env` is the credential allow-list, not `process.env`, and that is the point of the change rather
than a caveat on it.** Handing code the raw environment would have silently repealed
`secret-env-allowlist.ts`: transform code is a string saved by a `catalog:write` principal, it runs
in this pod, and it can print whatever it reads into `logs` — which cross into the run record and are
served at `catalog:read`. That is precisely the route that let a connector's `secretEnvVar` name
`DATABASE_URL`, reopened somewhere nobody would think to look. One list, one boot warning, one place
an operator looks to answer "what can code on this deployment read".

`['*']` is the one configuration where code and connectors differ, and it differs in the safe
direction: it admits **nothing** to `context.env`. The escape hatch exists so an upgrade under time
pressure has one honest line that keeps connectors reading one named variable each, visible on their
own screens. Copying a whole pod's environment into every transform's context is a bulk disclosure
nobody consented to by typing one character, and there is no compatibility argument on the other side
because code previously got nothing at all. Every case says which of the three it was in the run's
own log, where the person who can fix it is already looking.

New optional seam `CATALOG_PIPELINE_ENVIRONMENT`, bound through `forRoot({ environmentName })` as a
string or a per-call function. It surfaces as `context.environment` so that a transform behaving
differently in production reads `context.environment === 'prod'` instead of sniffing a variable.
Unbound leaves the field absent, which is a different statement from `'dev'` and the only truthful
one available.

Everything on the context is plain JSON, and everything except `env` and `environment` derives from a
durable step's checkpointed input, so it is byte-identical across replays. `allowlistedCodeEnv()` and
`namedEnvironment()` are separate, exported, impure functions and `codeContext()` is pure — so code
evaluated in a workflow body rather than in a step can resolve them inside one and let the checkpoint
carry the answer, instead of re-reading pod-local state on replay and taking a different branch.
