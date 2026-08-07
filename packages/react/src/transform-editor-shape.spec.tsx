// @vitest-environment jsdom
//
// The hint must stay attached to the FIRST import in source order, and that import must be the one
// Biome's `organizeImports` would sort first — otherwise the sorter moves another import above this
// line, Vitest stops finding the environment hint, and every test here fails in the node
// environment with something that looks nothing like a missing DOM.
import type { CatalogTransform } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { TransformEditor } from './TransformEditor';
import { CatalogProvider, type CatalogTransport } from './context';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Base UI's select and tooltip observe their anchor's size, which jsdom cannot
// compute and throws about.
installCodeSurfaceDom();
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

const transport: CatalogTransport = {
  get: () => Promise.reject(new Error('no fetch expected')),
  post: () => Promise.reject(new Error('no fetch expected')),
  patch: () => Promise.reject(new Error('no fetch expected')),
  delete: () => Promise.reject(new Error('no fetch expected')),
};

function withCatalog(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

function transform(parts: Partial<CatalogTransform>): CatalogTransform {
  return {
    id: 't1',
    name: 'Fleet mapper',
    language: 'javascript',
    code: '',
    version: 1,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...parts,
  };
}

/**
 * The badge says which shape the runner will read the code as.
 *
 * Worth a test of its own because the badge's value is entirely in being
 * *right*: it is imported from the library rather than re-derived, and the
 * whole point of that is that a screen cannot reassure somebody about a run
 * that did the other thing. A copy of the rule that drifted would still render
 * a confident badge.
 */
describe('the shape badge', () => {
  it('calls a stored bare body what it is, without calling it wrong', () => {
    render(
      withCatalog(
        <TransformEditor
          transform={transform({ code: 'return records.map((r) => ({ n: r.n }));' })}
          languages={['javascript']}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
    expect(screen.getByText('bare body')).toBeTruthy();
  });

  it('calls a module what it is', () => {
    render(
      withCatalog(
        <TransformEditor
          transform={transform({ code: 'export default ({ records }) => records;' })}
          languages={['javascript']}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
    expect(screen.getByText('function')).toBeTruthy();
  });

  // The name-based rule this codebase refused, asserted from the screen: a body
  // that declares a helper called `transform` is a body, and the badge has to
  // agree with the runner about that or it is worse than no badge.
  it('is not fooled by a body that declares its own function called transform', () => {
    render(
      withCatalog(
        <TransformEditor
          transform={transform({
            code: 'function transform(r) { return r; }\nreturn records.map(transform);',
          })}
          languages={['javascript']}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
    expect(screen.getByText('bare body')).toBeTruthy();
  });

  // Python has one shape and no rule — its harness writes the `def` — so there
  // is nothing here an author could have got wrong, and a badge would only
  // suggest there was.
  it('says nothing for python', () => {
    render(
      withCatalog(
        <TransformEditor
          transform={transform({ language: 'python', code: 'return records' })}
          languages={['python']}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
    expect(screen.queryByText('bare body')).toBeNull();
    expect(screen.queryByText('function')).toBeNull();
  });

  // A new transform opens in the shape that can gain fields later, because a
  // starter is how a shape is actually adopted.
  it('opens a new javascript transform in the module shape', () => {
    render(
      withCatalog(
        <TransformEditor languages={['javascript']} onClose={() => {}} onSaved={() => {}} />,
      ),
    );
    expect(screen.getByText('function')).toBeTruthy();
  });
});
