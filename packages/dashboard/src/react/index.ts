// The React tier of `@dudousxd/nestjs-catalog-dashboard`, published at the `./react` subpath so a
// host that only mounts the NestJS module never pulls React in. Three levels, pick one:
//
//   openCatalogConsole(...)        — no React at all (`./client`), you own everything
//   useOpenCatalogConsole(...)     — state for a launcher UI, you own the markup
//   <OpenCatalogConsoleButton />   — drop-in, unstyled, forwards every button prop
//
// `openCatalogConsoleMutationOptions` wires the same call into TanStack Query without this package
// depending on TanStack.
export * from './use-open-console.js';
export * from './open-console-button.js';
// Re-exported so a React consumer needs one import path, not two.
export * from '../client/console-session.js';
