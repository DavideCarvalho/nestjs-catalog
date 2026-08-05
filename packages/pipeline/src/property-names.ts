/**
 * Whether a published property's name can survive the trip into SQL, decided at
 * the moment it is published rather than at the moment it is used.
 *
 * **What the name has to be.** A store derives the *physical* column by cleaning
 * the name — `Asset Id` becomes `Asset_Id` — so on that side anything goes. What
 * does not go anywhere is the name itself, and the name itself is written
 * verbatim as an identifier in two places every deployment reaches: the output
 * column of the view a commit refreshes (`… AS \`Asset Id\``), and the alias of
 * every column of every read. Both go through `ident`, which refuses rather than
 * escapes. So `name` must be a SQL identifier; `columnName` — which is only ever
 * a key looked up in the record a source handed over — is free-form by design,
 * and is the field the source's own spelling belongs in.
 *
 * **Why here and not there.** The refusal used to arrive at the first commit,
 * which is after the connector has read the entire source and written every row
 * of it: a run reported `fetched=6905, written=6905` and then discovered the
 * schema could never have worked. Everything needed to answer the question is in
 * the publish payload, so it is answered there, for nothing, before a single row
 * exists.
 *
 * **The rule is not restated here.** {@link identifierRefusal} runs the store's
 * own `ident` and hands back the error it raises, so the publish-time refusal
 * and the DDL-time one cannot disagree about the character set, the length or
 * the wording — the wording especially, because the two refusals are now two
 * things somebody may see for one payload and reading them as one rule is the
 * whole point. The two bundled adapters ship that rule character for character
 * identically; this shares the copy the package already depends on.
 *
 * **Nothing here sanitises on the caller's behalf.** {@link toPhysicalName} is
 * used to *suggest* a name, never to store one. A property name is how the
 * catalog, every query, every row a publisher sends and every rendered column
 * refer to the field, so quietly rewriting `Asset Id` to `Asset_Id` would mean
 * the caller's next batch — keyed by `Asset Id` — silently wrote nothing into
 * that column. A refusal costs a round trip; that costs a dataset that looks
 * loaded.
 */
import {
  UnsafeIdentifierError,
  ident,
  toPhysicalName,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';

/** As much of a published property as this file has an opinion about. */
export interface NamedProperty {
  name: string;
  columnName?: string;
}

/**
 * The store's own words for why a value cannot be an identifier, or nothing.
 *
 * `ident` is called for its refusal and its result thrown away, which is the
 * point: the character set, the length limit and the sentence describing them
 * all stay in one place, and this cannot drift from what the DDL will do because
 * it IS what the DDL does.
 *
 * A `string | undefined` rather than a thrown error because the callers below
 * collect several before deciding what kind of failure the batch of them is.
 * Anything that is not an {@link UnsafeIdentifierError} is re-thrown rather than
 * read as a refusal — a different failure out of `ident` is a bug, not a verdict
 * about the name.
 */
export function identifierRefusal(value: string): string | undefined {
  try {
    ident(value);
  } catch (error) {
    if (error instanceof UnsafeIdentifierError) return error.message;
    throw error;
  }
  return undefined;
}

/** Whether {@link identifierRefusal} has anything to say about a name. */
export function isUnpublishableName(value: string): boolean {
  return identifierRefusal(value) !== undefined;
}

/**
 * Refuse the properties a publish would ADD under a name that cannot be a
 * column, naming each one and what to send instead.
 *
 * **`alreadyStored` is what keeps this from being a trap.** `upsertType` is
 * additive: it adds properties it has not seen and never removes one, and there
 * is no route anywhere in this package or the catalog that deletes a property
 * row. So a type that picked up `Asset Id` before this check existed cannot be
 * repaired by publishing — and refusing every republish of it would leave a type
 * nobody can now fix, permanently unpublishable, which is worse than the bug
 * this file is about. A name already stored is therefore left alone: it is
 * already as broken as it is going to get, its loads already fail at the commit
 * exactly as they did before, and blocking the republish would only stop the
 * publisher from adding the correctly-named property beside it. New names are
 * refused, and {@link describeStoredUnpublishableNames} says the old ones out
 * loud instead of leaving them to be discovered.
 *
 * All of them, not the first: a payload describing forty columns is usually
 * wrong about several in the same way, and one refusal per round trip would make
 * fixing it a morning.
 *
 * The suggested `name` comes from `toPhysicalName`, the same cleaning a store
 * applies to reach a physical column, so it is always an identifier this would
 * accept. It is a suggestion and not a promise: two names that differ only in
 * punctuation clean to one column, and `assertNoColumnCollisions` is what says
 * so at `ensureType`. The suggested `columnName` keeps whatever the caller
 * already sent, and falls back to the original name — which is what
 * `sourceColumn` derived from it anyway, so following the suggestion changes
 * what the catalog calls the field and changes nothing about what is read out of
 * the source.
 */
export function refuseUnpublishablePropertyNames(
  typeName: string,
  properties: readonly NamedProperty[],
  alreadyStored: ReadonlySet<string>,
): string | undefined {
  const seen = new Set<string>();
  const offenders: Array<{ property: NamedProperty; rule: string }> = [];
  for (const property of properties) {
    if (alreadyStored.has(property.name) || seen.has(property.name)) continue;
    const rule = identifierRefusal(property.name);
    if (!rule) continue;
    seen.add(property.name);
    offenders.push({ property, rule });
  }
  if (offenders.length === 0) return undefined;

  const detail = offenders
    .map(({ property, rule }) => {
      const suggested = JSON.stringify(toPhysicalName(property.name));
      const source = JSON.stringify(property.columnName ?? property.name);
      return `${rule} Send it as { "name": ${suggested}, "columnName": ${source} }.`;
    })
    .join(' ');

  return `${typeName} was not published: ${
    offenders.length === 1
      ? 'one of its properties is named'
      : `${offenders.length} of its properties are named`
  } something that cannot be written as a SQL identifier, and a property name has to be one — a store cleans the name to reach the physical column, but it uses the name itself for the view's output column and for the alias of every read. ${detail} \`name\` is what the catalog, every query and every row you send call the field, so it is refused rather than rewritten for you; \`columnName\` is free-form on purpose and is only ever looked up in the record the source handed over, which is where the source's spelling belongs. Refused here because the alternative is where this used to be refused: at the commit, after the run has read the whole source and written every row of it. Nothing was stored.`;
}

/**
 * The names a type already holds that this check would now refuse, as a
 * sentence, or nothing when it holds none.
 *
 * Said out loud on every publish of such a type — see the call site for how
 * often that reaches a log — because these are the only ones the refusal above
 * deliberately lets through, and silence about them would mean the one operator
 * who could act on it hears nothing until a load fails at the commit. It does
 * not claim the property can be fixed by republishing, because it cannot: no
 * route removes a property row, so this is a database edit or a new type.
 */
export function describeStoredUnpublishableNames(
  typeName: string,
  stored: Iterable<string>,
): string | undefined {
  const offenders = [...stored].filter(isUnpublishableName);
  if (offenders.length === 0) return undefined;

  return `${typeName} already holds ${offenders.length} propert${
    offenders.length === 1 ? 'y' : 'ies'
  } whose name cannot be written as a SQL identifier: ${offenders
    .map((name) => JSON.stringify(name))
    .join(
      ', ',
    )}. They were stored before publishing checked for this, they are left alone so that this type can still be republished at all, and every commit of it will keep failing on them. Republishing cannot remove them — nothing removes a property — so fixing this means renaming them in the catalog's database, or publishing the type under a new name with \`name\` an identifier and the source's spelling in \`columnName\`.`;
}
