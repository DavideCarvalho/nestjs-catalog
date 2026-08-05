---
"@dudousxd/nestjs-catalog-pipeline": major
---

A caller chose which environment variable the server read, and a failed URL was readable at `catalog:read`

Two holes on the same path, both of which turned an ordinary `catalog:write` grant into a read of
something it was never given.

## 1. `secretEnvVar` was an arbitrary read of the pod's environment — **breaking**

`resolveSecretEnv` did `process.env[name]`, and `name` is chosen by whoever writes the connector —
on `POST pipeline/connectors`, on `POST pipeline/connections`, and on a workflow source node. There
was no allow-list anywhere. So a principal holding `catalog:write` on one narrow object type could
point a connector at the host application's own database and read it back out of the catalog:

```
POST pipeline/connectors  {"kind":"sql","targetType":"Mvr","secretEnvVar":"DATABASE_URL",
                           "config":{"query":"SELECT * FROM users"}}
POST pipeline/connectors/<id>/discover   → the columns, writing nothing
POST pipeline/connectors/<id>/run        → the rows, into a type they may write
GET  catalog/objects/Mvr                 → read them back at catalog:read
```

Every guard on that path passed, and each of them passed honestly. The per-type write grant passed
because the sink really was a type the principal held. `assertNoNewPlaintextCredential` passed
because `config` carried no URL at all — the credential was fetched by name, which is the thing the
design was proud of. The read-only transaction in `fetchSql` prevents writes and was never about
reads. The three "credentials are never stored" docblocks were all true and all beside the point:
the catalog stores the *name*, and the name is chosen by the caller.

The error also distinguished "set" from "not set" **by name**, so any route reaching it was an
oracle for the pod's environment, one variable per request — including `discover`, which writes
nothing and leaves nothing behind.

### What a host has to do

**Bind an allow-list, or every authenticating connector stops running.** This is fail-closed on
purpose, the same stance `CATALOG_LOAD_EXPECTATIONS` and `RefusingSecretVault` already take.

```ts
CatalogPipelineModule.forRoot({
  // …em, registry, imports, expectations…
  secretEnvAllowlist: ['FLEET_DB_URL', 'DPAS_API_TOKEN', 'VENDOR_*'],
})
```

or, for an operator who owns the manifest rather than the code:

```
CATALOG_SECRET_ENV_ALLOW="FLEET_DB_URL,DPAS_API_TOKEN,VENDOR_*"
```

**The list to write is already on your screen.** Every connector and connection shows the variable
it reads, under `Credential env var`; the union of those is the whole migration. Both levers are
comma- or whitespace-separated; the module option wins when both are set, and the boot line says
which is in force, so setting the variable and seeing nothing change has an answer on screen.

An entry is an exact name, or a prefix ending in a single `*`. A `*` anywhere else is refused **at
boot, naming the entry** — `*_URL` reads like a tidy way to admit connection strings and it admits
`DATABASE_URL`.

`['*']` restores the previous behaviour wholesale — every variable in the pod readable by anyone who
can write a connector. It exists so an upgrade under time pressure has one honest, greppable line
instead of a pin to the previous release, and it warns on **every** boot.

A host that binds nothing boots and warns, once, naming both levers and what will happen. Connectors
that name no credential at all — `inline`, `file`, an S3 connector on a pod role — are unaffected.

### What a refused caller is told, and what an operator is told

One sentence, the same one whether the name was never admitted or was admitted and is not set. The
name is repeated back, because the caller supplied it; the *reason* is what leaked, so the reason
goes to the process log under the `CatalogSecretEnv` context instead. This is not less diagnosable —
it is diagnosable by the person entitled to diagnose it.

The cost, stated plainly: `POST pipeline/connections/check` gets less specific. Its whole purpose is
catching a mistyped variable name, and it now answers "no credential is available" rather than
naming the problem. That is deliberate and unavoidable — the route asks for `catalog:write`, which is
exactly the grant the attack above starts from, so it cannot be given a better answer than anybody
else. The log line has it.

## 2. Source URLs were echoed into run logs and audit payloads — no host action needed

`fetchHttp` throws `GET ${url} → ${status}` and the file source does the same. The connector runner
pushed `Failed: ${message}` into `logs` and emitted `connector.run.finished` with `error: message`;
the workflow runner did the same, plus the per-node `error` on `nodeOutcomes`. Both sinks are served
under the softest scope in the system: `GET pipeline/runs` returns `logs` and `error` unredacted at
`catalog:read`, and `GET catalog/events` returns the payload verbatim. A credential-bearing URL — a
password in the userinfo, an `?api_key=`, a signed S3 URL — needed to fail **once** to become
readable by everybody who may look at the catalog at all. `redactConnector` guarded the connector
list and nothing guarded the runs.

Redaction now happens at the sink rather than at each thrower, because a URL reaches those fields
from any fetcher, any driver and any transform — guarding the throwers means guarding the next one
somebody writes. `redactConfigSecrets` was the wrong tool and is untouched: an error message is not
a config object and never parses whole as a URL.

What goes: the URL's password, its **entire** query string, and its fragment. The whole query rather
than the parameters that look sensitive, because naming them is a deny-list and this is a fix for a
deny-list losing. What stays: scheme, host, path and username — which is what actually says *which*
source refused and *as whom*. A URL with nothing to hide is left byte for byte as it was. The
unredacted message still goes to the process log, so the operator keeps the full URL.

**Also fixed:** the connector runner folded transform logs in with `.slice(0, 50)` — a line cap with
no character cap, so one line naming every record a transform received wrote megabytes into a run
row, growing with the data. It now uses the same both-axes `capLines` the workflow runner has had
since that was measured there. `capLines` moved to a new `run-logs.ts` and is still re-exported from
`workflow-runner.service.ts`, so nothing importing it has to change.
