import { SetMetadata } from '@nestjs/common';
import type { CatalogScope } from './catalog.principal';

/**
 * What a route requires, as metadata a host's guard reads.
 *
 * The vocabulary lives here rather than in whichever package ships the routes,
 * because otherwise every such package would invent its own metadata key and a
 * host would need one guard per package to read them. A host writes ONE guard
 * against these two keys and it governs every catalog route it mounts, from this
 * library or any other.
 *
 * Declaring is deliberately separate from enforcing. This library has no opinion
 * about how a caller is authenticated — that is `CATALOG_PRINCIPAL_RESOLVER` and
 * the host's guard — only about what each route is asking for.
 */

/** Scopes a route needs. Absence means "authenticated is enough". */
export const REQUIRED_SCOPES = 'aviary:catalog:required-scopes';

/** Whether a route refuses machine principals. */
export const REQUIRES_HUMAN = 'aviary:catalog:requires-human';

/** Declares what a route needs. Absence means "authenticated is enough". */
export const RequireScopes = (...scopes: CatalogScope[]) => SetMetadata(REQUIRED_SCOPES, scopes);

/**
 * Declares that a route may only be taken by a person, not by an application
 * holding a key.
 *
 * Orthogonal to scopes, and needed because a scope cannot express it. Some
 * decisions want a name against them for reasons that have nothing to do with
 * permission: a machine principal holding `catalog:admin` is perfectly
 * authorised to make them and would leave an application id as the answer to
 * "who did this", which is not an answer.
 */
export const RequireHuman = () => SetMetadata(REQUIRES_HUMAN, true);
