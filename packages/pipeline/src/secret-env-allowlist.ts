/**
 * Which environment variables a connector is allowed to name.
 *
 * `sources.ts` says what the catalog database holds is the *name* of a secret,
 * and treats that as the end of the argument: "a leak gives away the shape of an
 * integration, not the keys to it." The sentence is true and it answers the
 * wrong question. The name is not merely stored — it is **chosen by the
 * caller**, on `POST pipeline/connectors`, on `POST pipeline/connections`, and
 * on a workflow source node. `resolveSecretEnv` then did `process.env[name]`
 * with nothing in between.
 *
 * So a principal holding `catalog:write` on one narrow object type could point a
 * connector at `DATABASE_URL` — the host application's own database, which has
 * nothing to do with the catalog's sources — and read it:
 *
 * ```
 * POST pipeline/connectors  {"kind":"sql","targetType":"Mvr",
 *                            "secretEnvVar":"DATABASE_URL",
 *                            "config":{"query":"SELECT * FROM users"}}
 * POST pipeline/connectors/<id>/discover  → the columns, writing nothing
 * POST pipeline/connectors/<id>/run       → the rows, into a type they may write
 * GET  catalog/objects/Mvr                → read back at catalog:read
 * ```
 *
 * Every guard on that path passes, and each of them passes honestly. The
 * per-type write grant passes because the sink really is a type this principal
 * holds. `assertNoNewPlaintextCredential` passes because `config` carries no URL
 * at all — the credential is fetched by name, which is the very thing the design
 * was proud of. The read-only transaction in `fetchSql` prevents writes and was
 * never about reads. Nothing was broken; there was simply nothing here.
 *
 * ## Why an allow-list, and not a list of the names to keep out
 *
 * A deny-list has to be right about every variable a host will ever set, in
 * every deployment, forever — `DATABASE_URL`, `REDIS_URL`, `SMTP_PASSWORD`,
 * `AWS_SECRET_ACCESS_KEY`, and the one that has the host's own name in front of
 * it that this package has never heard of. It fails open, silently, the first
 * time somebody names a variable nobody thought to list. An allow-list fails
 * closed: a name nobody admitted is refused, and the refusal is visible.
 *
 * ## Why the policy lives in the environment and in the host's own module wiring
 *
 * Because it has to live somewhere the attacker in the story above cannot
 * reach. A `catalog:write` principal can write connectors, connections and
 * workflow graphs — every place a `secretEnvVar` comes from. They cannot write
 * the pod's environment and they cannot edit the host's `forRoot` call. Putting
 * the allow-list in the catalog's own tables, next to the names it governs,
 * would have made the list editable by exactly the surface it is defending
 * against.
 *
 * Two ways in, because there are two people and they do not always have the same
 * lever. {@link CatalogPipelineModuleOptions.secretEnvAllowlist} is for the
 * engineer who is already in the module wiring deciding this catalog's
 * expectations; `CATALOG_SECRET_ENV_ALLOW` is for the operator who owns the
 * deployment manifest and cannot ship code today. The module option wins when
 * both are present — and the boot line says *which one is in force*, so that
 * setting the variable and seeing nothing change has an answer on screen rather
 * than after an hour.
 *
 * ## The grammar is two rules, and stops there
 *
 * An exact name, or a name ending in `*` matching by prefix. A `*` anywhere else
 * is refused rather than interpreted, and that refusal is the point: `*_URL`
 * reads like a tidy way to admit a family of connection strings and it admits
 * `DATABASE_URL`. A prefix cannot do that. It can only widen in the direction
 * the operator was already looking, which is what makes `FLEET_*` a safe thing
 * to type at four in the afternoon.
 *
 * `*` alone is the whole-environment escape hatch and it is not a policy. It
 * exists so that a deployment being upgraded under time pressure has one honest
 * line it can add — honest because it is in the manifest, greppable, and warned
 * about at every boot — rather than pinning to the previous release, which is
 * what a fix with no escape hatch actually buys.
 *
 * ## What this does not do
 *
 * It does not say whether the *value* behind an admitted name is the right kind
 * of credential; `parseS3Credentials` still refuses one shaped wrongly. It does
 * not stop a principal who can write connectors from reading the sources this
 * catalog is *supposed* to read — that is what the write grant on the target
 * type is for, and it is a different question. And it governs the name only: a
 * credential a host has pasted into `config` is `config-secrets.ts`'s problem
 * and `allowInlineCredentials`', not this file's.
 */

/**
 * The variable the operator's copy of the policy lives in.
 *
 * Comma- or whitespace-separated. Named as a constant because it appears in the
 * boot line, in the refusal an operator reads in the log, and in the changeset —
 * three places that have to say the same string.
 */
export const SECRET_ENV_ALLOW_VAR = 'CATALOG_SECRET_ENV_ALLOW';

/** The whole-environment escape hatch. See the note above about why it exists. */
export const ALLOW_EVERY_SECRET_ENV = '*';

/**
 * The policy this process is running, or nothing if the host never installed one.
 *
 * Module-level and mutable, which is worth defending rather than apologising
 * for. `resolveSecretEnv` is a free function reached from four places — the
 * connector runner, the workflow runner, the bundled controller's discover
 * route, and `ConnectionChecker` — and threading a policy object down every one
 * of those call chains would be a change several times the size of the policy,
 * with a fifth caller one day forgetting to pass it and silently getting the
 * unguarded behaviour back. The policy is a property of the process in exactly
 * the way `process.env` is, and it is read the same way.
 *
 * `undefined` and `[]` are different: nothing installed falls through to the
 * environment variable, and an installed empty list is a host saying "no
 * connector on this deployment reads a credential", which is a real statement
 * and admits nothing.
 */
let installed: readonly string[] | undefined;

/**
 * Put the host's list in force, or take it back out.
 *
 * Called by `CatalogPipelineModule.forRoot`, and by specs restoring the process
 * between cases. `undefined` clears it, which is not the same as installing an
 * empty list — see {@link installed}.
 *
 * Validated here rather than at first use, so a deployment with a malformed
 * pattern fails at boot with the pattern named, instead of at 03:00 with every
 * connector refused for a reason that reads like the allow-list working.
 */
export function installSecretEnvAllowlist(patterns: readonly string[] | undefined): void {
  installed = patterns === undefined ? undefined : normaliseSecretEnvPatterns(patterns);
}

/**
 * The policy in force: the installed list, else the environment variable, else
 * nothing at all.
 *
 * Read on every call rather than memoised at module load. A memoised copy would
 * be captured before a host's bootstrap had a chance to set the variable, and
 * would make every spec in this file depend on the order the files ran in.
 */
export function secretEnvAllowlist(): readonly string[] {
  if (installed !== undefined) return installed;
  return normaliseSecretEnvPatterns(splitPatterns(process.env[SECRET_ENV_ALLOW_VAR]));
}

/** Where the policy in force came from, for the one line that says so at boot. */
export function secretEnvAllowlistSource(): 'module' | 'environment' | 'nothing' {
  if (installed !== undefined) return 'module';
  return splitPatterns(process.env[SECRET_ENV_ALLOW_VAR]).length > 0 ? 'environment' : 'nothing';
}

/**
 * A comma- or whitespace-separated list, as a list.
 *
 * Both separators, because a Kubernetes manifest, a `.env` file and a shell
 * export all have a different idea of which one is natural, and a policy that
 * silently admitted nothing because somebody used spaces would be the worst
 * possible failure of a list whose whole job is to be right.
 */
function splitPatterns(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/**
 * The patterns, checked and deduplicated, or a refusal naming the bad one.
 *
 * Throws rather than dropping. A pattern this file cannot interpret is a
 * sentence somebody wrote about which credentials may be read, and the two ways
 * of being wrong about it are an outage and a hole — so neither guess is
 * available, and the only honest move is to say which pattern and why.
 */
export function normaliseSecretEnvPatterns(patterns: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.length === 0) continue;
    assertUsablePattern(pattern);
    seen.add(pattern);
  }
  return [...seen];
}

function assertUsablePattern(pattern: string): void {
  if (pattern === ALLOW_EVERY_SECRET_ENV) return;

  const stars = pattern.split('*').length - 1;
  if (stars === 0) return;
  if (stars === 1 && pattern.endsWith('*') && pattern.length > 1) return;

  throw new Error(
    `"${pattern}" is not a credential allow-list entry this catalog can read. An entry is an exact variable name, or a prefix ending in a single "*" — "FLEET_*" — or the bare "*" for every variable in the environment. A "*" in the middle is refused rather than interpreted: "*_URL" reads like a tidy way to admit connection strings and it admits DATABASE_URL, which is the whole thing this list exists to keep out.`,
  );
}

/**
 * Whether the policy admits this variable name.
 *
 * Case-sensitive, matching the way a POSIX environment addresses its variables.
 * On Windows, where `process.env` folds case, this can only ever be the
 * stricter of the two: a prefix that matched is a prefix the operator wrote, and
 * a name that did not match cannot reach a variable outside the family named,
 * whatever case it was typed in.
 */
export function admitsSecretEnv(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === ALLOW_EVERY_SECRET_ENV) return true;
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
      continue;
    }
    if (name === pattern) return true;
  }
  return false;
}

/**
 * The one sentence a caller gets when a credential could not be resolved.
 *
 * **The same sentence whichever of the two it was**, and that is the whole
 * mechanism. The message it replaced named the variable and said it was "not
 * set in this environment" — which made every route that reaches this function
 * an oracle for the pod's environment, one variable at a time: name a variable,
 * read the answer, learn whether the host has it. Repeat.
 *
 * The name is repeated back because the caller supplied it and hearing it
 * confirms nothing they did not already know. The *reason* is what leaks, so the
 * reason goes to the log instead — where an operator can read it and a caller
 * cannot. That split is the point: this is not less diagnosable, it is
 * diagnosable by the person who is supposed to be diagnosing it.
 */
export function credentialUnavailable(name: string): string {
  return `No credential is available for "${name}". Whether a variable of that name exists in this deployment is not something a catalog caller is told — the two reasons this can fail (the name is not on the credential allow-list, or it is on the list and not set) are deliberately indistinguishable from here. The catalog's log records which, under the "CatalogSecretEnv" context, for whoever operates this deployment.`;
}

/**
 * What to say at boot about the policy in force.
 *
 * Modelled on `describeExpectationsBinding` in `pipeline.module.ts`, and for the
 * same reason: the refusal a misconfigured deployment produces is correct and
 * arrives far too late to be the first anybody hears of it. An operator whose
 * upgrade turned every connector off deserves to learn that from the boot log,
 * naming the two levers, rather than from a run at three in the morning being
 * told — correctly and unhelpfully — that it may not say why.
 *
 * Returned rather than logged so the sentences can be tested without reading a
 * log, exactly as its sibling is.
 */
export function describeSecretEnvAllowlist(
  patterns: readonly string[],
  source: 'module' | 'environment' | 'nothing',
): { level: 'warn' | 'log'; message: string } {
  if (patterns.length === 0) {
    return {
      level: 'warn',
      message: `No credential allow-list is in force, so every connector, connection and workflow source node that names an environment variable will be refused — a source that authenticates cannot run on this deployment until one is bound. List the variables your connectors are allowed to read, as CatalogPipelineModule.forRoot({ secretEnvAllowlist: ['FLEET_DB_URL', 'VENDOR_*'] }) or as ${SECRET_ENV_ALLOW_VAR}="FLEET_DB_URL,VENDOR_*". The names your connectors already use are on them, under "Credential env var". Setting it to "${ALLOW_EVERY_SECRET_ENV}" restores the behaviour before this release — every variable in this pod readable by anyone who can write a connector — and is warned about on every boot.`,
    };
  }

  if (patterns.includes(ALLOW_EVERY_SECRET_ENV)) {
    return {
      level: 'warn',
      message: `The credential allow-list (from ${where(source)}) contains "${ALLOW_EVERY_SECRET_ENV}", so a connector may name any environment variable this process holds — DATABASE_URL, SMTP_PASSWORD, AWS_SECRET_ACCESS_KEY — and anyone with catalog:write on a single object type can read its value back through a load. That is the behaviour this release exists to end, kept as an escape hatch for an upgrade in progress. Replace it with the variables your connectors actually read; they are listed on each connector under "Credential env var".`,
    };
  }

  // Named rather than counted, for the reason its sibling gives: the question
  // this line answers on the morning after a deploy is "did my entry take?",
  // and a number cannot answer it.
  return {
    level: 'log',
    message: `Credential allow-list in force (from ${where(source)}), admitting ${patterns.length} name(s): ${patterns.join(', ')}. A connector naming anything else is refused, and is told only that no credential is available.`,
  };
}

function where(source: 'module' | 'environment' | 'nothing'): string {
  if (source === 'module') {
    return `CatalogPipelineModule.forRoot({ secretEnvAllowlist }), which takes precedence over ${SECRET_ENV_ALLOW_VAR}`;
  }
  if (source === 'environment') return SECRET_ENV_ALLOW_VAR;
  return 'nowhere';
}
