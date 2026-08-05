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

  /** Presentation-only edits. Never a schema change. */
  abstract patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
  ): Promise<CatalogObjectTypeDef | undefined>;

  abstract patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<CatalogObjectTypeDef | undefined>;

  abstract resetOverlay(): Promise<void>;
}
