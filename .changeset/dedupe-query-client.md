---
'@dudousxd/nestjs-catalog-dashboard': patch
---

One copy of React and react-query, so the console renders

The console died at first render with `No QueryClient set, use QueryClientProvider to set one` —
pointing at a provider that is right there in the entry.

React context is per module instance. The SPA bundled its own `@tanstack/react-query` while
`@dudousxd/nestjs-catalog-react` resolved a different one, so the provider mounted by the first was
invisible to the hooks inside the second. Two copies, two contexts, and an error that names neither.

`resolve.dedupe` for `react`, `react-dom` and `@tanstack/react-query`, plus the dev versions pinned
to what the component library develops against. The built bundle now carries one copy.
