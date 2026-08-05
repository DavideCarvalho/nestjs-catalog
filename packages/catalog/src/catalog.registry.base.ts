import type {
  CatalogGraph,
  CatalogObjectTypeDef,
  CatalogOverlay,
  CatalogRelationDef,
  CatalogSnapshot,
} from './catalog.types';

/**
 * A key both ends of one link agree on, so the graph can draw it once.
 *
 * The owning end names the link — `Mvr.base` — and the inverse end, which knows
 * the owner's property through `mappedBy`, arrives at the same string. That is
 * the whole trick, and it is why `inverseName` is carried on the def at all.
 *
 * The fallback covers metadata that names neither end of the pair: both rows
 * then reduce to the unordered pair plus the property name, which collapses the
 * symmetric case (two `m:n` sides spelled alike) and leaves genuinely different
 * names as two links. Guessing harder than that would mean pairing links by
 * shape, and drawing one line where the schema has two is the worse error.
 */
function linkKey(holder: string, relation: CatalogRelationDef): string {
  if (relation.owner) return `${holder}.${relation.name}`;
  if (relation.inverseName) return `${relation.targetType}.${relation.inverseName}`;
  return `${[holder, relation.targetType].sort().join('::')}::${relation.name}`;
}

/**
 * The ontology, as nodes and lines. **The one implementation of the edge rule.**
 *
 * Three rules, and all three exist because the naive version of each drew a
 * picture that was wrong in a way nobody would notice:
 *
 * 1. **One edge per link.** A link declared at both ends produces two rows, and
 *    keying the de-duplication on the property name only caught the case where
 *    both ends happened to be spelled alike — so `Mvr.base` plus `Base.mvrs`,
 *    the ordinary shape of a foreign key, drew two lines between the same pair
 *    of nodes. See {@link linkKey} for how the two rows are recognised as one.
 * 2. **Drawn from the end that holds the key**, so the arrow points the way a
 *    join is written. Both ends are collected before either is chosen, because
 *    otherwise the direction depends on which type was discovered first.
 * 3. **No edge to a node that is not here.** An edge promises a node the reader
 *    can open, and a target this catalog does not hold has none.
 *
 * Hidden relations are deliberately still drawn. Hiding is a statement about a
 * table cell; a graph that quietly dropped edges would be a picture nobody could
 * read as complete, which is the only thing a graph is for.
 *
 * WHY IT LIVES HERE, ON THE BASE CLASS'S OWN MODULE
 * -------------------------------------------------
 * Both registries had a copy — one derives the model from ORM metadata, the
 * other reads it out of the database — in different packages, each carrying a
 * comment asking the next person to change them together. A comment is not a
 * mechanism, and a divergence here would be invisible: the two screens would
 * simply disagree about how many links exist, and the copy that regressed would
 * look exactly like the original bug (two edges per foreign key). The graph is a
 * pure function of the snapshot, which is the one thing every registry already
 * has to produce, so there was never anything for a subclass to decide.
 */
export function buildCatalogGraph(types: CatalogObjectTypeDef[]): CatalogGraph {
  const byLink = new Map<string, { holder: string; relation: CatalogRelationDef }>();

  for (const type of types) {
    for (const relation of type.relations) {
      if (!relation.targetPublished) continue;
      const key = linkKey(type.name, relation);
      const seen = byLink.get(key);
      // Replace only when this row is the owning one and the row already held
      // is not: anything else keeps the first, so the edge order stays the type
      // order rather than shuffling with every rebuild.
      if (seen && (seen.relation.owner || !relation.owner)) continue;
      byLink.set(key, { holder: type.name, relation });
    }
  }

  return {
    nodes: types.map((t) => ({
      id: t.name,
      label: t.displayName,
      group: t.group,
      icon: t.icon,
      propertyCount: t.properties.length,
      relationCount: t.relations.length,
    })),
    edges: [...byLink.values()].map(({ holder, relation }) => ({
      id: `${holder}.${relation.name}`,
      source: holder,
      target: relation.targetType,
      label: relation.displayName,
      kind: relation.kind,
    })),
  };
}

/**
 * What the catalog knows about your types, however it came to know it.
 *
 * An abstract class rather than an interface so it doubles as the DI token.
 *
 * Two implementations are expected and they are genuinely different: one
 * *derives* the model from an ORM in the application that owns the tables, and
 * one *stores* it because the model arrived over the wire from somewhere else.
 * A warehouse has no entity classes to reflect over — the type definitions are
 * data it was handed. Everything above this line works the same either way.
 */
export abstract class CatalogRegistry {
  abstract getSnapshot(): CatalogSnapshot;
  abstract getType(name: string): CatalogObjectTypeDef | undefined;

  /**
   * The ontology, drawn. Concrete, and the only implementation either registry
   * runs.
   *
   * Not abstract because nothing about it varies: every edge and every node is
   * read off the snapshot, and the snapshot is the abstract thing. The two
   * registries did each override it with the same forty lines, which is how the
   * edge rule came to exist twice in two packages — the failure this being a
   * concrete method prevents. Where a registry *delegates* rather than derives
   * (`RoutingCatalogRegistry` hands the whole call to whichever environment the
   * request named) overriding is still right; deriving it a second time is not.
   */
  getGraph(): CatalogGraph {
    return buildCatalogGraph(this.getSnapshot().types);
  }

  // ---------------------------------------------------------------------------
  // Curation, and who did it.
  //
  // The three methods below each take the acting principal's id as their last
  // argument, and it is required. That is a breaking change to an exported
  // abstract class, so it is worth saying what was weighed.
  //
  // **Why a parameter at all, rather than emitting one layer up.** Moving the
  // emit into `CatalogService` or the controller is the cheap fix and it is the
  // wrong one twice over. A host that injects `CatalogRegistry` and calls
  // `patchProperty` from a migration script or an admin job would then emit
  // nothing — so the trail would silently mean "curation that happened to go
  // through the bundled controller", which is the same class of gap the actor was
  // missing from. And the two implementations know things the layer above does
  // not: the stored registry decides whether the patch landed on a column or on a
  // link, and only the in-app one can summarise the overlay it is about to
  // destroy. The event belongs where the act happens.
  //
  // **Why not an ambient `AsyncLocalStorage`**, the way the environment travels
  // in `@dudousxd/nestjs-catalog-store-mikro-orm`. It would survive the routing
  // hop for free, and it would be invisible: nothing in the signature would tell
  // a host implementing this class that an actor exists to be read, and a host
  // calling it from a script would get an unattributed row with no hint that
  // there was a value to set. Worse, the store lives in a second package, so the
  // storage would be module state read across a package boundary — a duplicated
  // install of this library gives two `AsyncLocalStorage` instances, and the
  // symptom is an actor that is empty in production and fine in every test.
  //
  // **Why required rather than optional.** The same argument
  // `CatalogService.deleteSavedQuery` makes about its own `deletedBy`: a default
  // quietly attributes the act to nobody in every caller that was not updated,
  // and naming somebody is the entire value of the record. Required means the
  // compiler names the call sites; optional means the audit table does, months
  // later, in a column nobody can reconstruct.
  //
  // **What a subclassing host does.** Add the argument at every call site — the
  // compiler will point at each. Overriding implementations keep compiling even
  // if they ignore it, because TypeScript lets an override take fewer parameters
  // than it promised; what stops that being a silent regression is that
  // `CatalogEventPayloads['type.curated']` now *requires* `principalId`, so an
  // implementation that emits its own curation event fails to compile until it
  // has one to put there. Pass `curationActor(...)` if the value may be missing.
  // ---------------------------------------------------------------------------

  /**
   * Presentation-only edits. Never a schema change.
   *
   * @param curatedBy the acting principal's id, recorded on `type.curated`.
   */
  abstract patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined>;

  /** @param curatedBy the acting principal's id, recorded on `type.curated`. */
  abstract patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined>;

  /**
   * Discard every tier-0 edit at once.
   *
   * **An implementation that really discards must emit `overlay.reset`**, and
   * the reason is an asymmetry this class would otherwise have: the two patches
   * above are audited one field at a time, so a trail could say who renamed one
   * column and not who reverted every name in the catalog — while both need only
   * `catalog:curate`. The summary has to be built before the write; nothing
   * versions an overlay, so afterwards there is nothing left to read.
   *
   * **Refusing is an implementation too, and refusing emits nothing.** A
   * registry whose curated values have no derived layer underneath them has
   * nothing to fall back to, so a reset there is destruction rather than a
   * revert, and the throw is the whole answer — no act, no record of one.
   * `StoredCatalogRegistry` is that case.
   *
   * Which of those a deployment runs is why the event is worth more than the
   * call it accompanies: a registry that quietly resets without emitting looks
   * exactly like one that never ran a reset at all.
   *
   * @param resetBy the acting principal's id, recorded on `overlay.reset`. An
   * implementation that refuses is free to declare no parameter at all — an
   * override may take fewer than it was promised — and `StoredCatalogRegistry`
   * does, because an argument it accepted and never recorded would read as a
   * dropped actor rather than as a reset that never happened.
   */
  abstract resetOverlay(resetBy: string): Promise<void>;
}
