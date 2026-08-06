/**
 * What a code-bearing node is told about the run it is part of.
 *
 * `CatalogCodeContext` in the catalog package is the *shape*; this file is the
 * policy that fills it in, and the whole of the policy is one sentence: **code
 * gets the environment a source node already gets, and nothing else.**
 *
 * ## Why not `process.env`
 *
 * Because handing it over would silently repeal `secret-env-allowlist.ts`.
 * That file's argument, compressed: a `secretEnvVar` is chosen by whoever
 * writes the connector, `resolveSecretEnv` did `process.env[name]` with nothing
 * in between, and so a principal holding `catalog:write` on one narrow object
 * type could point a connector at `DATABASE_URL` and read the host
 * application's own database back out at `catalog:read`. Every deployment that
 * has not bound a list is told about it on every boot.
 *
 * Transform code is the same principal by a shorter route. It is a string that
 * principal saved; it runs in this pod; and it can print whatever it reads into
 * `logs`, which cross a durable step boundary into the run record and are
 * served to anyone with `catalog:read`. A transform handed `process.env` is
 * therefore not "a convenience for the pipeline author", it is the exact hole
 * the allow-list was built to close, reopened somewhere nobody would think to
 * look for it.
 *
 * So there is one rule, one list, one boot warning, and one place an operator
 * has to look to answer "what can code on this deployment read". A second
 * mechanism would have been a second thing to keep in step, and the release
 * where they drift is the release where the boot warning is a lie.
 *
 * ## Why `*` admits nothing here
 *
 * `["*"]` is the allow-list's escape hatch and the boot warning describes its
 * effect precisely: "every variable in this pod readable by anyone who can
 * write a connector". That sentence is about *connectors*, and it is a
 * one-value-at-a-time read by a named variable that appears on the connector's
 * own screen.
 *
 * Copying the entire environment into every transform's context is not that.
 * It is a bulk disclosure, into a place a single `console.log(context.env)`
 * publishes at `catalog:read`, on the say-so of an operator who typed one
 * character under upgrade pressure to keep their connectors running. Nobody
 * consented to that by consenting to the escape hatch, and this is new
 * behaviour — before it, code got nothing at all — so there is no compatibility
 * argument on the other side either.
 *
 * Under `*`, therefore, {@link allowlistedCodeEnv} yields `{}` and says why in
 * the run's own logs, naming the fix: list the variables. That is the *only*
 * configuration where the answer differs between a source node and a code node,
 * and it differs in the safe direction.
 *
 * ## Why the diagnosis goes in the run log
 *
 * An empty `context.env` has three quite different causes — no policy bound,
 * `*` bound, a policy bound that matches nothing in this pod — and the author
 * staring at `undefined` cannot tell them apart. `resolveSecretEnv` splits the
 * same problem by sending the reason to the process log, because there its
 * audience is an operator and the caller is a stranger. Here the audience *is*
 * the author: they hold `catalog:write`, they wrote the code, and the run log
 * is the panel they are already looking at. So the note goes there, where the
 * person who can act on it will read it, and nothing about the environment
 * leaks that the connector screens do not already show.
 *
 * ## Replay
 *
 * {@link codeContext} is pure — every field comes from its arguments — and its
 * result is plain JSON. {@link allowlistedCodeEnv} and {@link namedEnvironment}
 * are the two impure reads, and they are separate functions for exactly that
 * reason: a caller that must be replay-safe resolves them inside a durable step
 * and lets the checkpoint carry the answer, so a redeploy between the original
 * run and the replay cannot change what the code saw. A transform needs none of
 * that care, because its step's *output* is checkpointed and replay never
 * re-runs the code; a predicate evaluated in a workflow body needs all of it.
 */

import {
  CODE_CONTEXT_CONTRACT,
  type CatalogCodeContext,
  type WorkflowStageRef,
} from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import {
  ALLOW_EVERY_SECRET_ENV,
  SECRET_ENV_ALLOW_VAR,
  admitsSecretEnv,
  secretEnvAllowlist,
} from './secret-env-allowlist';

/**
 * How a host names the copy of the world this process is serving, at the moment
 * it is serving it.
 *
 * A **function**, for the reason {@link CATALOG_PIPELINE_EM} is one: a host that
 * routes several environments through one process resolves the answer from
 * whatever scope is active, and a value captured at construction would stamp
 * every run with whichever environment happened to be current when the module
 * booted. A single-environment host binds `() => 'prod'` and is done.
 *
 * Optional, and absent by default. `WorkflowLauncher` already sets out why this
 * package cannot work the answer out for itself — it has no environment
 * identity it can read, and the most it could ever compute is which environment
 * the *caller* is in, which is half a comparison. Guessing would be worse than
 * silence: `context.environment` being `undefined` says "nobody told me", and a
 * predicate can branch on that; `'dev'` invented from `NODE_ENV` says something
 * false with total confidence.
 */
export const CATALOG_PIPELINE_ENVIRONMENT = Symbol('CATALOG_PIPELINE_ENVIRONMENT');
export type CatalogEnvironmentNameResolver = () => string | undefined;

const logger = new Logger('CatalogSecretEnv');

/** The admitted environment, and what to tell the author about it. */
export interface CodeEnvResolution {
  env: Record<string, string>;
  /**
   * Lines for the run's log. Always at least one, because "which credentials
   * did this code have" is a question a run record should answer without
   * anybody having to reconstruct the deployment's configuration from memory.
   */
  notes: string[];
}

/**
 * The environment variables this deployment lets code read.
 *
 * Enumerated from `process.env` and filtered through the *same*
 * {@link admitsSecretEnv} a connector's `secretEnvVar` goes through, rather
 * than resolved name by name. Code has no `secretEnvVar` field to declare with
 * — it is a string, not a row — so the choice is between handing it the
 * admitted set and inventing a per-transform declaration, and a second
 * declaration is a second list to keep in step with the first.
 *
 * Empty values are dropped, matching `resolveSecretEnv`: a variable exported as
 * `""` cannot authenticate to anything, and offering it would only move the
 * failure into whatever the code does with it.
 *
 * Keys are sorted, so two resolutions of the same policy on the same pod
 * serialise identically. That is not tidiness — it is what lets a caller
 * checkpoint the context and compare it with the one a replay would have built.
 */
export function allowlistedCodeEnv(): CodeEnvResolution {
  const patterns = secretEnvAllowlist();

  if (patterns.length === 0) {
    return {
      env: {},
      notes: [
        `No credential allow-list is in force on this deployment, so \`context.env\` is empty. Name the variables this code may read, as CatalogPipelineModule.forRoot({ secretEnvAllowlist: ['VENDOR_TOKEN', 'FLEET_*'] }) or as ${SECRET_ENV_ALLOW_VAR}="VENDOR_TOKEN,FLEET_*". It is the same list your connectors read their credentials through.`,
      ],
    };
  }

  if (patterns.includes(ALLOW_EVERY_SECRET_ENV)) {
    return {
      env: {},
      notes: [
        `This deployment's credential allow-list is "${ALLOW_EVERY_SECRET_ENV}", and \`context.env\` is empty rather than a copy of this pod's environment. "${ALLOW_EVERY_SECRET_ENV}" is the escape hatch that keeps connectors running through an upgrade — one named variable at a time, on a connector somebody can see — and it is not a decision to hand every secret in the pod to code that can print it into this log. List the variables this code actually reads and they will appear here.`,
      ],
    };
  }

  const env: Record<string, string> = {};
  for (const name of Object.keys(process.env).sort()) {
    if (!admitsSecretEnv(name, patterns)) continue;
    const value = process.env[name];
    if (!value) continue;
    env[name] = value;
  }

  const names = Object.keys(env);
  if (names.length === 0) {
    return {
      env,
      notes: [
        `The credential allow-list in force (${patterns.join(', ')}) admits no variable that is set in this pod, so \`context.env\` is empty. The list is being applied; nothing matched it.`,
      ],
    };
  }

  // Named, never valued. The names are already on the connector screens at
  // `catalog:read` under "Credential env var", so this discloses nothing new —
  // and it turns the run record into the answer to "which credentials was this
  // code given", which is the first question asked after one leaks.
  return {
    env,
    notes: [`\`context.env\` carries ${names.length} admitted variable(s): ${names.join(', ')}.`],
  };
}

/**
 * The host's name for this environment, or nothing.
 *
 * Guarded, because a resolver is host code reached from inside a load, and a
 * host whose scope is not entered yet would otherwise turn a *diagnostic* field
 * into a failed run. Warned about rather than swallowed: silence here would
 * leave `context.environment` absent on a deployment that had bound a resolver,
 * which is indistinguishable from never having bound one.
 */
export function namedEnvironment(
  resolve: CatalogEnvironmentNameResolver | undefined,
): string | undefined {
  if (!resolve) return undefined;
  try {
    const name = resolve();
    return name === undefined || name.length === 0 ? undefined : name;
  } catch (error) {
    logger.warn(
      `The environment-name resolver bound as CATALOG_PIPELINE_ENVIRONMENT threw, so \`context.environment\` is absent for this run — code branching on it will take the "no environment declared" path. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * The context, assembled.
 *
 * Pure, and every part of it named in the parameter list rather than reached
 * for — which is the point. A builder that read `process.env` or a store would
 * be a builder no caller could checkpoint, and the conditional node coming next
 * has to be able to.
 *
 * The `env` and `environment` arguments are required even where the answer is
 * "nothing", so that a caller who forgot to resolve them fails to compile
 * rather than shipping a context that quietly admits no credential.
 */
export function codeContext(parts: {
  runId?: string;
  workflow?: { id: string; name: string; version: number };
  node?: { id: string; name: string };
  connectorId?: string;
  environment: string | undefined;
  rowCount: number;
  inputs: readonly WorkflowStageRef[];
  env: Record<string, string>;
}): CatalogCodeContext {
  const context: CatalogCodeContext = {
    contract: CODE_CONTEXT_CONTRACT,
    rowCount: parts.rowCount,
    // Copied, so that a later edit to the step's input cannot reach a context
    // a caller has already checkpointed.
    inputs: parts.inputs.map((ref) => ({ ...ref })),
    env: { ...parts.env },
  };
  // Assigned only when present, rather than written as `undefined`. The context
  // is serialised to JSON for the child and may be checkpointed by a caller,
  // and `{"runId": undefined}` and a missing key round-trip to the same thing
  // through JSON but not through a deep-equality check — which is exactly the
  // check a replay-safety test would use.
  if (parts.runId !== undefined) context.runId = parts.runId;
  if (parts.workflow !== undefined) context.workflow = { ...parts.workflow };
  if (parts.node !== undefined) context.node = { ...parts.node };
  if (parts.connectorId !== undefined) context.connectorId = parts.connectorId;
  if (parts.environment !== undefined) context.environment = parts.environment;
  return context;
}
