/**
 * Whether a published property's name can survive the trip into SQL, decided at
 * the moment it is published rather than at the moment it is used.
 *
 * **What the name has to be, and what it no longer has to be.** A store derives
 * the *physical* column by cleaning the name — `Asset Id` becomes `Asset_Id` —
 * and it is the cleaned form that has to be a legal identifier. The name itself
 * does not, any more. It used to: two statements every deployment reaches wrote
 * it verbatim through `ident`, which refuses rather than escapes — the output
 * column of the view a commit refreshes (`… AS \`Asset Id\``) and the alias of
 * every column of every read — so `Asset Id` was refused as a property name for
 * the sake of those two aliases.
 *
 * That refusal cost more than it saved, and the bill arrived somewhere else. A
 * load matches a source's record to a property by property NAME: the store reads
 * `row[property.name]`. `columnName` is lineage and nothing on the write path
 * consults it. So a publisher told to send `{ name: 'Asset_Id', columnName:
 * 'Asset Id' }` was publishing a type that could never be populated — every
 * batch keyed `Asset Id` wrote `undefined`, which is NULL, into every row.
 * Thirteen real types were loaded that way; six came out with most of their
 * columns empty, 313,833 rows of the largest of them, all committed, all green.
 * Both aliases now go through `outputAlias`, so the name may be the source's own
 * spelling and the check below asks what it actually needs to ask: does this
 * name *clean* to something a store can create?
 *
 * `columnName` remains free-form and remains lineage — a place to record how the
 * source spells a field when the property is called something else. It is not a
 * redirect, and treating it as one is what this whole file is now about warning
 * against.
 *
 * **Why here and not there.** The refusal used to arrive at the first commit,
 * which is after the connector has read the entire source and written every row
 * of it: a run reported `fetched=6905, written=6905` and then discovered the
 * schema could never have worked. Everything needed to answer the question is in
 * the publish payload, so it is answered there, for nothing, before a single row
 * exists.
 *
 * **Neither half of the rule is restated here.** {@link identifierRefusal} runs
 * `physicalColumn` and then `assertSafeIdentifier`, both from
 * `@dudousxd/nestjs-catalog` — the same two calls, in the same order, that every
 * store makes on the way to a column — and hands back the error raised. So the
 * publish-time refusal and the DDL-time one cannot disagree about the cleaning,
 * the character set, the length or the wording. The wording especially, because
 * the two refusals are two things somebody may see for one payload and reading
 * them as one rule is the whole point. Both halves used to be per-adapter
 * copies; there is now one definition of each and both adapters call it.
 *
 * **Nothing here sanitises on the caller's behalf.** {@link toPhysicalName} is
 * used to *suggest* a name, never to store one. A property name is how the
 * catalog, every query, every row a publisher sends and every rendered column
 * refer to the field, so quietly rewriting a name would mean the caller's next
 * batch — keyed by what they sent — silently wrote nothing into that column. A
 * refusal costs a round trip; that costs a dataset that looks loaded. It is also
 * why a refusal below says out loud that a rename needs a transform behind it:
 * the caller who cannot keep the source's spelling has the same trap in front of
 * them that this file's opening paragraph is about.
 */
import {
  UnsafeIdentifierError,
  assertSafeIdentifier,
  physicalColumn,
} from '@dudousxd/nestjs-catalog';
// `toPhysicalName` — the *repair*, not the rule — stays the adapter's. It is a
// name-shaped thing a store would accept, offered as a suggestion, and a
// suggestion is allowed to be one adapter's. `physicalColumn`, which used to sit
// beside it here, is not: it decides where a load's values land and whether a
// name can work at all, so it moved to the core package next to the character
// set. This one stays imported from here because the only caller is
// `publish.service.ts`, which reaches for `ObjectTypeRow` and an
// `@mikro-orm/mysql` EntityManager two lines further down.
import { toPhysicalName } from '@dudousxd/nestjs-catalog-store-mikro-orm';

/** As much of a published property as this file has an opinion about. */
export interface NamedProperty {
  name: string;
  columnName?: string;
}

/**
 * The catalog's own words for why a name cannot become a column, or nothing.
 *
 * The question asked is about `physicalColumn(value)`, not about `value`, and
 * that is the whole of what relaxed when the view's output alias stopped being
 * the property's name verbatim. `Asset Id` cleans to `Asset_Id` and is fine;
 * `1 2 3` cleans to `1_2_3` and is not, because no store will quote a name
 * starting with a digit. The refused *value* named in the message is therefore
 * the cleaned one — which is exactly the value `ident` will refuse if this check
 * is ever bypassed, so the two say the same sentence about the same string.
 * Callers pair it with the original; see {@link refuseUnpublishablePropertyNames}.
 *
 * `physicalColumn` and `assertSafeIdentifier` are called for their verdict and
 * nothing else, which is the point: the cleaning, the character set, the length
 * limit and the sentence describing them all live in one place, and this cannot
 * drift from what the DDL will do because it IS what the DDL does.
 *
 * A `string | undefined` rather than a thrown error because the callers below
 * collect several before deciding what kind of failure the batch of them is.
 * Anything that is not an {@link UnsafeIdentifierError} is re-thrown rather than
 * read as a refusal — a different failure out of the rule is a bug, not a
 * verdict about the name.
 */
export function identifierRefusal(value: string): string | undefined {
  try {
    assertSafeIdentifier(physicalColumn(value));
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
 * row. So a type that picked up an unusable name before this check existed
 * cannot be repaired by publishing — and refusing every republish of it would
 * leave a type nobody can now fix, permanently unpublishable, which is worse
 * than the bug this file is about. A name already stored is therefore left
 * alone: it is already as broken as it is going to get, its loads already fail
 * at the commit exactly as they did before, and blocking the republish would
 * only stop the publisher from adding the correctly-named property beside it.
 * New names are refused, and {@link describeStoredUnpublishableNames} says the
 * old ones out loud instead of leaving them to be discovered.
 *
 * All of them, not the first: a payload describing forty columns is usually
 * wrong about several in the same way, and one refusal per round trip would make
 * fixing it a morning.
 *
 * The suggested `name` comes from `toPhysicalName`, which always produces
 * something a store would accept. It is a suggestion and not a promise: two
 * names that differ only in punctuation clean to one column, and
 * `assertNoColumnCollisions` is what says so at `ensureType`.
 *
 * **And the suggestion carries a warning, because taking it is not free.** A
 * load looks every field up as `row[name]` in the record the source handed over,
 * so a property renamed away from the source's spelling loads NULL into every
 * row unless a transform renames the field in the record to match. That is not a
 * hypothetical: it is what happened when this check refused `Asset Id` outright
 * and everybody did the obvious thing. `Asset Id` is now a perfectly good name
 * and no rename is needed for it; what reaches this refusal is the narrower set
 * that cannot be a column even after cleaning, and for those the rename is
 * genuinely unavoidable — so the message says what has to go with it.
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
      const original = JSON.stringify(property.name);
      const cleaned = JSON.stringify(physicalColumn(property.name));
      const suggested = JSON.stringify(toPhysicalName(property.name));
      const source = JSON.stringify(property.columnName ?? property.name);
      return `${original} cleans to ${cleaned}, and ${rule} Send it as { "name": ${suggested}, "columnName": ${source} }.`;
    })
    .join(' ');

  return `${typeName} was not published: ${
    offenders.length === 1
      ? 'one of its properties is named'
      : `${offenders.length} of its properties are named`
  } something no store can turn into a column. A property name does NOT have to be a SQL identifier — a store cleans it by replacing anything that is not a letter, digit or underscore and collapsing the runs, so \`Asset Id\` is a perfectly good name and lands in a column called \`Asset_Id\` — but what the cleaning produces still has to be one, and ${
    offenders.length === 1 ? 'this one is not' : 'these are not'
  }. ${detail} Before you take that suggestion, know what it costs: a load looks every field up as \`row[name]\` in the record your source hands over, so a property whose name is not the key in that record loads NULL into every row and reports success. If the suggested name is not what your records are keyed by, put a transform in front that renames the field to match. \`columnName\` records how the source spells it and is lineage only — nothing on the write path reads it. Refused here because the alternative is where this used to be refused: at the commit, after the run has read the whole source and written every row of it. Nothing was stored.`;
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
 *
 * The set this describes got much smaller when the view's output alias stopped
 * being the property's name verbatim. A type stored with `Asset Id` — the exact
 * shape this function was written to complain about, and one whose every commit
 * used to fail — now cleans to a column and simply works, so it is no longer
 * listed. What is left is the narrower set that cannot become a column at all,
 * and for those the sentence below is still true word for word.
 */
export function describeStoredUnpublishableNames(
  typeName: string,
  stored: Iterable<string>,
): string | undefined {
  const offenders = [...stored].filter(isUnpublishableName);
  if (offenders.length === 0) return undefined;

  return `${typeName} already holds ${offenders.length} propert${
    offenders.length === 1 ? 'y' : 'ies'
  } whose name no store can turn into a column, even after cleaning it: ${offenders
    .map((name) => JSON.stringify(name))
    .join(
      ', ',
    )}. They were stored before publishing checked for this, they are left alone so that this type can still be republished at all, and every commit of it will keep failing on them. Republishing cannot remove them — nothing removes a property — so fixing this means renaming them in the catalog's database, or publishing the type under a new name. A renamed property also needs a transform that renames the field in the records you send, because a load looks each one up as \`row[name]\`.`;
}
