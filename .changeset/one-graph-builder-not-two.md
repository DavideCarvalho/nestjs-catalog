---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

One graph builder, not two.

Relations shipped with the edge rule written twice: `MikroOrmCatalogRegistry` derives the ontology
from ORM metadata, `StoredCatalogRegistry` reads it out of the database, and each had its own
`linkKey` and its own edge loop, in different packages, under a comment asking whoever changed one to
change both.

A comment is not a mechanism, and this divergence would have been invisible. The rule is that a link
declared at both ends produces ONE edge, paired by a key that survives the two ends having different
property names, drawn from the end that holds the foreign key so the arrow points the way a join is
written. A copy that regressed to keying on property name alone draws two edges for every ordinary
foreign key — which is the bug this rule was written to fix, and the only place it shows up is a
picture nobody diffs.

`CatalogRegistry.getGraph()` is now **concrete** on the abstract class, built from the snapshot every
registry already has to produce. Nothing about it ever varied, so there was never anything for a
subclass to decide. Both registries drop their copy; the graph they serve is byte-for-byte what it
was.

For anyone implementing `CatalogRegistry` in a host: `getGraph` is no longer abstract, so a third
registry gets the edge rule right without writing it. Overriding is still correct where a registry
*delegates* rather than derives — `RoutingCatalogRegistry` hands the whole call to whichever
environment the request named — but deriving it a second time is not.
