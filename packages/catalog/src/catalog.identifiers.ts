/**
 * How a name becomes a column, and what it has to look like by the end.
 *
 * Two rules, and they are here together because neither is usable without the
 * other. {@link physicalColumn} is the *cleaning* — the lossy map from a
 * property's name to the column a store creates for it. {@link isSafeIdentifier}
 * is the *character set* the result of that cleaning has to be in. What a
 * publisher is actually promised is the composition: a name may be spelled
 * however the source spells it, and what the cleaning produces has to be
 * something a store can write.
 *
 * Identifiers themselves are *rejected*, never escaped. Every table and column
 * name a store emits arrives from another application over HTTP and ends up in
 * DDL and in SELECT lists, where no placeholder can stand in for it, so anything
 * outside this character set never becomes SQL at all.
 *
 * It is part of what the catalog promises a *publisher*. Refuse a property name
 * and the sentence explaining why is the only statement of the rule most people
 * will ever read, so it belongs to the contract rather than to whichever adapter
 * happens to be mounted.
 *
 * And for one more reason. It used to be two copies — `store-mikro-orm` and
 * `store-clickhouse` each carried this pattern and this sentence, byte for byte
 * — and the publish-time refusal in the pipeline package borrowed the MySQL one
 * so that publish-time and DDL-time could not disagree about the character set,
 * the length or the wording. That bought the guarantee for a MySQL deployment
 * and left a ClickHouse-only one trusting two files to be edited together. One
 * definition is the guarantee; two identical ones are a habit.
 *
 * ---
 *
 * **Why this is its own module, and why it imports nothing.**
 *
 * All of this used to live in `catalog.store.ts`, which is still where every
 * server-side caller reaches it from — that file re-exports all five names, so no
 * import anywhere had to change. What could not stay there is the
 * *reachability*: `catalog.store.ts` imports `BadRequestException` from
 * `@nestjs/common` at module scope, so anything importing a **value** out of it
 * drags NestJS along. That is fine on the server and disqualifying for
 * `/client`, which exists precisely so a browser can share the server's rules
 * without shipping the server.
 *
 * And a browser now has to be able to ask this question. A workflow template
 * that proposes replicating a table has to know, while somebody is still
 * choosing, whether the source's column names could be published as property
 * names — because if they could not, the graph it would draw is refused at
 * publish, or worse, gets "fixed" by a rename that commits nulls and reports
 * success. Answering that from a copy of the pattern is the one thing this
 * module's own history says not to do: the copy is what drifts, and a canvas
 * whose idea of a legal name differs from the store's by one character is a
 * canvas that promises a load the publisher then refuses.
 *
 * That is why {@link physicalColumn} had to come along rather than only
 * {@link isSafeIdentifier}. The question a publisher is refused on is
 * `isSafeIdentifier(physicalColumn(name))`, not `isSafeIdentifier(name)`, and a
 * browser holding only half the composition would answer a different question
 * from the server's — which is the same drift by another route.
 *
 * So the rule moved to a file with no imports, and is exported from both entry
 * points. `validateWorkflow` set the precedent and made the same argument.
 */

/**
 * 63 characters because it is under MySQL's 64-character ceiling and no engine
 * a store here targets refuses a name that short, and because the number is
 * quoted in the refusal below: a per-store limit would mean a publisher being
 * told a different rule depending on what is mounted, for a name the catalog
 * would then be unable to promise anything about across a fan-out.
 *
 * Not exported. A `RegExp` is mutable and shared state, and the two questions
 * anyone has of it — "may I?" and "why not?" — are {@link isSafeIdentifier} and
 * {@link UnsafeIdentifierError}.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Why a name cannot be written into SQL, in the words a publisher is given.
 *
 * One class for the whole ecosystem rather than one per adapter, so
 * `instanceof` is a usable question across packages. The publish-time check in
 * the pipeline package catches this to tell "that name cannot be an identifier"
 * from "something else failed inside the store", and with a class per adapter
 * that check would re-throw the moment the mounted store was not the one it
 * imported — turning a 400 that names the property into a 500 that names
 * nothing.
 */
export class UnsafeIdentifierError extends Error {
  constructor(value: string) {
    super(
      `Refusing to use "${value}" as a SQL identifier: letters, digits and underscore only, starting with a letter or underscore, 63 characters max.`,
    );
  }
}

/** Whether a name can be written into SQL as it stands. */
export function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER.test(value);
}

/**
 * Refuse a name that cannot be a SQL identifier.
 *
 * Throws rather than answering, because the caller's next line writes the value
 * into a statement: a boolean that can be ignored is a boolean that eventually
 * is. {@link isSafeIdentifier} is there for the callers that are asking rather
 * than about to build.
 */
export function assertSafeIdentifier(value: string): void {
  if (!isSafeIdentifier(value)) throw new UnsafeIdentifierError(value);
}

/**
 * A property's name, cleaned into the column a store can create for it.
 *
 * Here rather than in each adapter for the reason {@link assertSafeIdentifier}
 * is: this is no longer only an adapter's private repair. It decides the column
 * a load's values are written to, the column a filter is applied to, the name a
 * committed view exposes the field under, and — since it does all of that — it
 * decides whether a published name can work at all. The pipeline package refuses
 * a name at publish time by asking whether *this* produces an identifier, so the
 * refusal and the DDL have to be running the same cleaning rather than two
 * copies of it. `store-mikro-orm` and `store-clickhouse` each carried a
 * byte-identical private copy, and `store-mikro-orm` carried two of its own —
 * one in `query.ts` for the view, one in `mysql-warehouse.store.ts` for
 * everything else. Three copies of the function that decides where a column's
 * data lives is three chances for a view to point at a column no load ever
 * wrote.
 *
 * Lossy on purpose, and lossy in a way callers must handle rather than assume
 * away: `Asset Id` and `Asset/Id` both clean to `Asset_Id`, which is what
 * `assertNoColumnCollisions` exists to catch.
 *
 * 60 characters, not the 63 the identifier rule allows, and the three characters
 * of headroom are not decorative — a store that needs to derive a second name
 * from a column has room inside MySQL's 64-character ceiling to do it. Widening
 * this would silently rename the column of every property whose name is 61 to 63
 * characters long, so it stays where it is.
 *
 * Not every output is an identifier: `1 2 3` cleans to `1_2_3`, which no store
 * will quote. That is not this function's business to fix — a suggestion is
 * `toPhysicalName` in an adapter, and a refusal is `assertSafeIdentifier` on the
 * result.
 */
export function physicalColumn(propertyName: string): string {
  return propertyName
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
}

/**
 * The column name a store exposes a property under, in the committed view and
 * in the SELECT list of a read.
 *
 * **Why this is not simply the property's name.** It used to be. Every store
 * wrote `\`Asset_Id\` AS \`Asset Id\`` — the physical column reached by cleaning,
 * the alias taken verbatim — and the alias went through `ident`, which refuses
 * rather than escapes. So a property could only be named something that was
 * already a SQL identifier, which meant a source column genuinely called `Asset
 * Id` could not be published under its own spelling.
 *
 * That mattered far more than it looks. A load matches a source's record to a
 * property by property NAME — the store reads `row[property.name]` — so a
 * publisher forced to rename the property to `Asset_Id`, keeping `Asset Id` in
 * `columnName`, was publishing a type whose every read of that field returned
 * `undefined`. `columnName` is lineage; nothing consults it on the write path.
 * The loads committed, the row counts were right, and the column was NULL in
 * every row. Thirteen types were loaded that way and six of them came out with
 * most of their columns empty — 73 of 84 on the largest, across 313,833 rows.
 * The verbatim alias is what forced the rename, so the alias is what changed.
 *
 * **Why the name is still kept when it is already an identifier.** The obvious
 * fix — always alias to {@link physicalColumn} — would rename the output column
 * of every existing view whose property name is not equal to its own cleaned
 * form: a property called `Asset__Id` (two underscores collapse to one) or one
 * 61 characters long (cut to 60). Those views work today and somebody is
 * selecting from them by name. Renaming a column under a working consumer to
 * tidy up an inconsistency is not a trade worth making, so the rule is the
 * narrower one: **a name that SQL can take as it stands is kept exactly; only a
 * name SQL cannot take is cleaned.** Every view that resolves today keeps every
 * column name it has today.
 *
 * **This introduces no new way for two properties to collide.** If two distinct
 * names produce one alias then they also produce one {@link physicalColumn}, so
 * `assertNoColumnCollisions` already refuses the pair. Both unsafe: equal
 * aliases *are* equal physical columns. Both safe: equal aliases are equal
 * names, and there is only one property per name. One of each — a safe `x` and
 * an unsafe `y` with `physicalColumn(y) === x` — means `x` contains no run of
 * underscores and is at most 60 characters, so `physicalColumn(x) === x ===
 * physicalColumn(y)` and the columns collide too.
 */
export function outputAlias(propertyName: string): string {
  return isSafeIdentifier(propertyName) ? propertyName : physicalColumn(propertyName);
}
