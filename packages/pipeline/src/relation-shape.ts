/**
 * Whether a published link is a link at all, decided at the moment it is
 * published rather than left to be discovered in a picture.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A relation drives no DDL. Nothing about it was checked on the way in, nothing
 * failed when it was wrong, and — this is the part that makes it worth a
 * refusal — every wrong shape had a *plausible-looking* rendering downstream
 * rather than an error:
 *
 * - A `kind` nothing recognises is narrowed to `m:1` on read (see
 *   `toRelationKind` in `@dudousxd/nestjs-catalog-store-mikro-orm`), so
 *   `"kind": "sometimes"` published cleanly and the graph drew a many-to-one
 *   arrow the publisher never asked for. The lenient read is right for a row
 *   already in the database; it is wrong as an answer to a payload somebody is
 *   typing right now, and this is the difference between the two.
 * - `owner: true` on a `1:m` contradicts what `owner` means — the key lives on
 *   the many side, so the one side never holds it — and the graph reads `owner`
 *   to decide which end an edge is drawn from. Both ends claiming it draws the
 *   arrow whichever way the types happened to be discovered in.
 * - Two links on one type under one name are one link as far as every consumer
 *   is concerned: `mergeRelations` keys curation on the name, the graph keys the
 *   edge id on it, and the type page keys its React list on it. The second is
 *   not drawn and cannot be labelled, and nothing said so.
 * - A link with no name, or no `targetType`, is a row in the model that
 *   describes nothing and that no consumer can render or repair.
 *
 * None of those is a failure anybody sees. They are a diagram that is quietly
 * wrong, which is the one thing a diagram must not be.
 *
 * WHAT IS DELIBERATELY NOT REFUSED, AND WHY EACH ONE LOOKS LIKE IT SHOULD BE
 * -------------------------------------------------------------------------
 * **A `targetType` this catalog does not hold.** The obvious fourth rule, and a
 * mistake twice over. It is a *designed state*: `CatalogRelationDef.targetPublished`
 * exists to carry it, the graph already omits the edge rather than promising a
 * node that cannot be opened, and `FlowView`'s cross-publisher lane treats an
 * unpublished target as its sharpest signal rather than as corruption. It is
 * also unenforceable in order — two applications that point at each other, or
 * one type published a minute before the other, would have whichever went first
 * refused for naming a type that does not exist *yet*. So an unknown target
 * stays a fact the catalog reports. What is refused is a `targetType` that is
 * missing or blank, which names nothing at all and cannot become known later.
 *
 * **A `localKey` that is not a property of this type.** This one reads as the
 * most obviously checkable rule in the whole file and it is the one that would
 * have broken the most, because the field does not hold what its name suggests.
 * `CatalogRelationDef.localKey` is documented as "property on this side holding
 * the key", but the ORM-derived registry fills it from `prop.fieldNames[0]` —
 * the physical **column** — so a `@ManyToOne(() => Base)` called `base` reports
 * `localKey: "base_id"`, and `base_id` is not a property of that type and never
 * will be: the property is the relation itself. A host forwarding its own
 * `CatalogRelationDef[]` verbatim is a case `PublishedType.relations` documents
 * as supported, so refusing that payload would refuse the supported case.
 * Checking against columns instead does not rescue it either — the FK column of
 * a derived relation belongs to no property at all. The field is genuinely
 * two-valued today; unifying it is a model change, not a validation, so this
 * checks that a `localKey` which is *present* is a non-blank string and stops
 * there.
 *
 * **A missing `localKey`.** An `m:n` link has its key in a join table and a
 * derived relation may simply not expose one. Absent is not wrong.
 *
 * WHY HERE AND NOT IN `mergeRelations`
 * ------------------------------------
 * The merge is also reached by `promoteEnvironment`, which copies types between
 * environments — and the rows it copies came through this refusal already, on
 * whichever environment they were published to. Putting the check there would
 * mean a promotion that fails on data it did not author and cannot edit, which
 * is the shape of an outage during a release rather than a message to whoever
 * typed the mistake. The publish route is where a human or a publishing
 * application states a link; that is where it is answered.
 *
 * Nothing here repairs. A kind that cannot be read is not guessed at, for the
 * reason `property-names.ts` gives about names: a quiet rewrite produces a
 * catalog that describes something other than what the publisher said, and every
 * reader downstream believes it.
 */

import { RELATION_KINDS, isRelationKind } from '@dudousxd/nestjs-catalog';
import type { PublishedRelation } from '@dudousxd/nestjs-catalog-store-mikro-orm';

/** How the four kinds are spelled, for a message that has to list them. */
const KIND_LIST = RELATION_KINDS.map((kind) => `\`${kind}\``).join(', ');

/**
 * A relation as it arrives, before anything about it is known to be true.
 *
 * Every field `unknown`, because this runs on a body that came over HTTP:
 * {@link PublishedRelation} says what a caller *should* send, and a check that
 * trusted it would be checking the one thing that is true by assumption.
 */
interface IncomingRelation {
  name?: unknown;
  kind?: unknown;
  targetType?: unknown;
  localKey?: unknown;
  owner?: unknown;
}

/** A string with something in it, which is what every required field here is. */
function named(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * How to refer to a relation in a message when it may not have a usable name.
 *
 * Positional as well as named, because a payload with four links and one
 * mistake needs the reader to know which one — and the broken one is often the
 * one whose name is the problem, so the name cannot always be the handle.
 */
function handle(relation: IncomingRelation, index: number): string {
  return named(relation.name)
    ? `\`${relation.name}\` (relations[${index}])`
    : `relations[${index}]`;
}

/**
 * Every reason this payload's links cannot be stored as written, or nothing.
 *
 * **All of them, not the first.** The same argument
 * `refuseUnpublishablePropertyNames` makes: a publisher that has misunderstood
 * `owner` has misunderstood it for every link in the payload, and one refusal
 * per round trip turns a five-minute fix into an afternoon.
 */
export function refuseUnusableRelations(
  typeName: string,
  relations: readonly PublishedRelation[],
): string | undefined {
  const problems: string[] = [];
  const seen = new Set<string>();

  relations.forEach((incoming: IncomingRelation, index) => {
    const where = handle(incoming, index);

    if (!named(incoming.name)) {
      problems.push(
        `${where} has no \`name\`. The name is how a link is referred to everywhere else — it is what curation patches, what the graph keys its edge on, and what the type page lists — so a link without one cannot be labelled, drawn or replaced.`,
      );
    } else if (seen.has(incoming.name)) {
      problems.push(
        `${where} is the second link called \`${incoming.name}\` on this type. Every consumer keys on the name, so the two would be one link: only one edge is drawn, only one can be labelled, and which one wins is whichever the merge saw last.`,
      );
    } else {
      seen.add(incoming.name);
    }

    if (!named(incoming.targetType)) {
      problems.push(
        `${where} has no \`targetType\`. A link that does not say what it points at describes nothing. It does NOT have to name a type this catalog already holds — a target published by another application, or published later, is reported as unresolved rather than refused — but it has to name one.`,
      );
    }

    if (!isRelationKind(incoming.kind)) {
      problems.push(
        `${where} has \`kind\` ${JSON.stringify(incoming.kind)}, which is not one of ${KIND_LIST}. This is refused rather than stored because it would not fail later: an unrecognised kind is read back as \`m:1\`, so the link would publish cleanly and then be drawn with an arrowhead nobody chose.`,
      );
    }

    if (incoming.kind === '1:m' && incoming.owner === true) {
      problems.push(
        `${where} is a \`1:m\` that claims \`owner: true\`. A one-to-many is never the owning end — the foreign key lives on the many side, which is the other type — and \`owner\` is what the graph reads to decide which end an edge is drawn from, so both ends claiming it points the arrow at whichever type was loaded first. Declare the owning end on the other type as \`m:1\` with \`owner: true\`, and leave this one \`owner: false\` with \`inverseName\` naming it.`,
      );
    }

    if (incoming.localKey !== undefined && !named(incoming.localKey)) {
      problems.push(
        `${where} has a \`localKey\` that is not a name: ${JSON.stringify(incoming.localKey)}. Omit it entirely if this end holds no key — an \`m:n\` through a join table legitimately has none.`,
      );
    }
  });

  if (problems.length === 0) return undefined;

  return `${typeName} was not published: ${
    problems.length === 1
      ? 'one thing about the links'
      : `${problems.length} things about the links`
  } it declares cannot be stored as written. ${problems.join(' ')} Nothing was stored — neither the links nor the properties in the same payload. A relation drives no DDL and never fails at load time, so a wrong one is not an error anybody sees; it is a diagram that is quietly wrong, which is why this is answered here.`;
}
