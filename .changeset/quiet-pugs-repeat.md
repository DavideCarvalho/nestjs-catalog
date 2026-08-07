---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-react': minor
---

A transform can now be a function over one object, so the argument list can grow

The harness wrapped an author's code as a bare body and handed it `records` and
`context` **positionally**. That fixed the set of things a transform can be given
on the day the second parameter landed: a third one changes what every signature
ever written means, including the ones sitting in a database that nobody is going
to re-read. So the supported shape is a real function taking a single object —

```js
export default function transform({ records, context }) {
  return records.map((r) => ({ mgmtCd: r['Mgmt Cd'] }));
}
```

— and a field can be added to that object later without touching a line of
anybody's stored code. That is the whole argument; the syntax is just how it is
spelled.

**Nothing stored changes.** A bare body still runs through the identical wrapper,
with the identical positional parameters and the identical interpreter flags. The
two shapes are told apart by a top-level `export` keyword, which is a *syntax
error* inside a function body — so no transform that runs today can contain one,
and backward compatibility is a property of the language rather than of how good
a guess is. The rule deliberately ignores names: a body that declares its own
helper called `transform` is still a body.

Also:

- `CatalogTransformInput` and `CatalogTransformFunction` are exported from
  `/client` for editor help. `import type` is erased before the code runs, so
  they cost nothing at run time — and buy nothing at run time either. Node's
  TypeScript support is stripping, not checking; a wrong type still runs.
- `transformShape` / `transformDeclaresModule` are exported so a UI can say which
  shape the runner will read code as, from the runner's own rule rather than a
  second copy of it.
- The transform editor opens new JavaScript and TypeScript transforms in the new
  shape, and shows which shape the current code is in. Existing transforms open
  with their own saved code, unchanged.
- Python is unchanged and stays that way on purpose: its harness writes the `def`
  itself, so a Python transform never states a signature, and a new field there
  costs one generated line rather than a migration of everybody's pandas code.
