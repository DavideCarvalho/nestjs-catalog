/**
 * Lets a component `import "@xyflow/react/dist/style.css"`.
 *
 * The package is built with plain `tsc`, which resolves every import as a
 * module and fails on a `.css` path with TS2307. This ambient declaration
 * satisfies the compiler; the emitted JavaScript keeps the bare side-effect
 * import, which every bundler a host might use knows how to handle.
 *
 * The alternative — telling hosts to import React Flow's stylesheet themselves
 * in their app entry point — was rejected because a missing stylesheet does not
 * error. React Flow renders an unstyled pile of divs at the top-left corner
 * with no edges visible at all, which looks like a broken canvas rather than a
 * missing import, and the one host that forgets would have no way to tell.
 */
declare module '*.css';
