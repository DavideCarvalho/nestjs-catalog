/**
 * Two type helpers whose only job is to make a hand-maintained list fail to
 * compile once it stops being complete.
 *
 * This package keeps three lists that have to track interfaces it does not own:
 * the optional store methods {@link import('./fanout.store').FanoutCatalogStore}
 * conditionally forwards, and the optional capability fields
 * {@link import('./capabilities').composeCapabilities} intersects. Every one of
 * those lists was written by hand against the interface as it stood that day,
 * and every one of them has already fallen behind it at least once — a store
 * method the core package added and this package silently stopped offering, a
 * capability field two adapters populate and a fan-out reported as absent.
 *
 * The failure has one shape. Nothing about adding an optional member to an
 * interface breaks a consumer that ignores it; that is the entire point of it
 * being optional, and it is why the omission survives review, survives the
 * tests, and is discovered by whoever was relying on the member being there. So
 * the omission has to be made into a compile error at the only place that can
 * see it, which is the list.
 *
 * The error a missing entry produces names the member — `Type '"foo"' does not
 * satisfy the constraint 'never'` — so it is not merely loud, it says what to
 * add.
 *
 * What this cannot do is check that a listed method is actually *bound*. That is
 * a fact about the constructor rather than about a type, and it is pinned by a
 * test that walks the list instead. Splitting it that way is deliberate: the
 * list is the thing that rots silently, and the binding is one line away from
 * the list in the same file.
 */

/**
 * The keys of `T` that may be absent.
 *
 * `object extends Pick<T, K>` is true exactly when `K` can be left off, which is
 * a different question from whether its type includes `undefined` — a required
 * `foo: string | undefined` is not optional and must not be swept up as one.
 */
export type OptionalKeyOf<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * Compiles only when handed `never`. Anything else is a member nobody listed.
 *
 * Used as `type _ = AssertNothingMissing<Exclude<Expected, Listed>>` and then
 * left alone; the alias is never referenced because its value is the compile
 * error, not the type.
 */
export type AssertNothingMissing<T extends never> = T;
