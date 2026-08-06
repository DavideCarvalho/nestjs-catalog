/**
 * What a name has to look like before a store will write it into SQL.
 *
 * Identifiers are *rejected*, never escaped and never sanitised. Every table
 * and column name a store emits arrives from another application over HTTP and
 * ends up in DDL and in SELECT lists, where no placeholder can stand in for it,
 * so anything outside this character set never becomes SQL at all.
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
 * It used to live in `catalog.store.ts`, which is still where every server-side
 * caller reaches it from — that file re-exports all four names, so no import
 * anywhere had to change. What could not stay there is the *reachability*:
 * `catalog.store.ts` imports `BadRequestException` from `@nestjs/common` at
 * module scope, so anything importing a **value** out of it drags NestJS along.
 * That is fine on the server and disqualifying for `/client`, which exists
 * precisely so a browser can share the server's rules without shipping the
 * server.
 *
 * And a browser now has to be able to ask this question. A workflow template
 * that proposes replicating a table has to know, while somebody is still
 * choosing, whether the source's column names can be property names at all —
 * because if they cannot, the graph it would draw commits nulls and reports
 * success. Answering that from a copy of the pattern is the one thing this
 * module's own history says not to do: the copy is what drifts, and a canvas
 * whose idea of a legal name differs from the store's by one character is a
 * canvas that promises a load the publisher then refuses.
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
