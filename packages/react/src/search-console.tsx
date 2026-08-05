import type {
  CatalogSearchHit,
  CatalogSearchKind,
  CatalogSearchRank,
} from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
import { TextField } from './ui/field';

/**
 * One box that crosses the catalog.
 *
 * Today, finding anything means knowing which screen it lives on: object types
 * and their properties on the model screen, saved queries on the query screen,
 * boards on the dashboards screen. At two hundred types that IS the experience,
 * and the thing a person actually types is a word they half-remember.
 *
 * Everything about which rows come back, and in what order, is the server's —
 * see `search.ts` in `@dudousxd/nestjs-catalog`. This screen deliberately does
 * no ranking, no client-side filtering and no merging of its own. That is not
 * deference for its own sake: the same ranking has to hold for a host that
 * writes its own box against the same route, and a second copy of it here would
 * be a second answer to the same question the day one of them is touched.
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const SECONDARY = 'text-zinc-500 dark:text-zinc-400';
const RULE = 'border-zinc-200 dark:border-zinc-800';

/**
 * The order the groups are drawn in, matching the server's own tie-break.
 *
 * Grouping is a trade and it is worth naming: it buys scannability — four short
 * lists a reader recognises the shape of — and it costs the global ranking, so
 * an exact property match no longer sits visually above a type that merely
 * mentions the word. The `rank` chip on each row is what carries that back;
 * without it the grouping would be lying by omission.
 */
const KIND_ORDER: CatalogSearchKind[] = ['objectType', 'property', 'savedQuery', 'dashboard'];

const KIND_LABEL: Record<CatalogSearchKind, string> = {
  objectType: 'Object types',
  property: 'Properties',
  savedQuery: 'Saved queries',
  dashboard: 'Dashboards',
};

/**
 * What the rank means, in words, because "prefix" is jargon for the reader and
 * the whole argument for four named ranks over a number is that a person can
 * predict them. A tooltip would hide it behind a hover; this is four words.
 */
const RANK_LABEL: Record<CatalogSearchRank, string> = {
  exact: 'exact name',
  prefix: 'name starts with',
  name: 'in the name',
  text: 'in the text',
};

const RANK_TONE: Record<CatalogSearchRank, string> = {
  exact: 'text-emerald-700 dark:text-emerald-300',
  prefix: 'text-sky-700 dark:text-sky-300',
  name: 'text-sky-700 dark:text-sky-300',
  text: 'text-zinc-500 dark:text-zinc-400',
};

/**
 * How long to wait after a keystroke before asking.
 *
 * Half the answer is free — the registry snapshot is already in memory — and
 * half is two reads against the workspace store, so a request per keystroke
 * would put a database under a typing load for rows that were going to be
 * thrown away. 200ms is below the threshold at which a person notices the box
 * is not instant, and above the interval at which anybody types.
 */
const DEBOUNCE_MS = 200;

export interface CatalogSearchProps {
  /**
   * Where the model screen lives, given a type name. Omit and type and property
   * rows render as plain rows rather than as links.
   *
   * The same prop, the same shape and the same name as `CatalogManager`'s,
   * because it is the same navigation: the host owns its routing, and the
   * shipped console answers `#objects?type=X`. A second spelling here would
   * mean a host wiring the two screens differently for one destination.
   */
  explorerHref?: (typeName: string) => string;
  /** Where a saved query opens. Omit to render saved-query rows as plain rows. */
  savedQueryHref?: (id: string) => string;
  /** Where a dashboard opens. Omit to render dashboard rows as plain rows. */
  dashboardHref?: (id: string) => string;
  /** How many rows to ask for. The server caps whatever this says. */
  limit?: number;
  placeholder?: string;
  /** Heading copy, so the host can call this whatever its users call it. */
  title?: string;
  eyebrow?: string;
}

export function CatalogSearch({
  explorerHref,
  savedQueryHref,
  dashboardHref,
  limit,
  placeholder = 'A type, a column, a report — whatever you remember',
  title = 'Search',
  eyebrow = 'Across the catalog',
}: CatalogSearchProps) {
  const client = useCatalogClient();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(term), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [term]);

  const trimmed = debounced.trim();
  const { data, isFetching, isError } = useQuery({
    queryKey: catalogQueryKeys.search(trimmed, limit),
    queryFn: () => client.search(trimmed, limit),
    // An empty box asks nothing. The route answers an empty term with an empty
    // result rather than a 400, so this is politeness rather than protection —
    // but a request fired on mount, before anybody has typed, is a request the
    // server logs and nobody wanted.
    enabled: trimmed.length > 0,
    // The previous answer stays on screen while the next one is in flight, so
    // the list does not blank between keystrokes. `isFetching` is what says so.
    placeholderData: (previous) => previous,
    staleTime: 15_000,
  });

  const grouped = useMemo(() => {
    const hits = data?.hits ?? [];
    return KIND_ORDER.map(
      (kind) => [kind, hits.filter((hit) => hit.kind === kind)] as const,
    ).filter(([, rows]) => rows.length > 0);
  }, [data]);

  function hrefFor(hit: CatalogSearchHit): string | undefined {
    // A property navigates to the type it belongs to, not to a route of its
    // own: there is no per-property screen, and inventing an anchor the host
    // does not serve would be a link that goes nowhere.
    if (hit.kind === 'objectType' || hit.kind === 'property') {
      return hit.typeName && explorerHref ? explorerHref(hit.typeName) : undefined;
    }
    if (hit.kind === 'savedQuery') return savedQueryHref?.(hit.id);
    return dashboardHref?.(hit.id);
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-8">
      <header className="shrink-0">
        <p className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h2>
      </header>

      <div className="relative mt-5 shrink-0">
        <Search
          size={14}
          className={cn('pointer-events-none absolute right-2.5 top-[1.9rem] z-10', MUTED)}
        />
        <TextField
          label="Search the catalog"
          value={term}
          onChange={setTerm}
          placeholder={placeholder}
        />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <Status
          term={trimmed}
          isError={isError}
          isFetching={isFetching}
          total={data?.total}
          shown={data?.hits.length}
          truncated={data?.truncated}
        />

        {grouped.map(([kind, rows]) => (
          <section key={kind} className="mb-5">
            <div className={cn('flex items-baseline justify-between border-b px-1 pb-1', RULE)}>
              <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                {KIND_LABEL[kind]}
              </span>
              <span className={cn('font-mono text-[10px]', MUTED)}>{rows.length}</span>
            </div>
            {rows.map((hit) => (
              <Row
                key={`${hit.kind}:${hit.typeName ?? ''}:${hit.id}`}
                hit={hit}
                href={hrefFor(hit)}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * The line above the results, which has four things to say and must not confuse
 * two of them.
 *
 * "Nothing matched" and "we could not ask" lead a reader to opposite
 * conclusions, and a refusal rendered as an empty list is the worse one — the
 * same distinction `CatalogManager` makes, made again here because this screen
 * has its own request.
 */
function Status({
  term,
  isError,
  isFetching,
  total,
  shown,
  truncated,
}: {
  term: string;
  isError: boolean;
  isFetching: boolean;
  total?: number;
  shown?: number;
  truncated?: boolean;
}) {
  if (!term) {
    return (
      <p className={cn('px-1 py-8 text-center text-xs', MUTED)}>
        Types, properties, saved queries and dashboards, all at once.
      </p>
    );
  }
  if (isError) {
    return <p className="px-1 py-8 text-center text-xs text-rose-600">The search did not run</p>;
  }
  if (total === undefined) {
    return <p className={cn('px-1 py-8 text-center text-xs', MUTED)}>Searching…</p>;
  }
  if (total === 0) {
    return <p className={cn('px-1 py-8 text-center text-xs', MUTED)}>Nothing matches “{term}”.</p>;
  }
  return (
    <p className={cn('mb-3 px-1 font-mono text-[10px]', MUTED)}>
      {/* The cap is stated rather than implied. A list that silently stops at
          fifty reads as "there are fifty", and the next search somebody runs is
          the one they run because they did not find it in the first. */}
      {truncated ? `${shown} of ${total} matches` : `${total} ${total === 1 ? 'match' : 'matches'}`}
      {isFetching ? ' · updating' : ''}
    </p>
  );
}

/**
 * One result.
 *
 * An `<a>` when the host said where the kind lives and a `<div>` when it did
 * not — rather than a dead link or a link to `#`. A row that looks clickable and
 * is not is worse than a row that does not, and a host that mounts no dashboard
 * screen should not have this one inventing an anchor for it.
 */
function Row({ hit, href }: { hit: CatalogSearchHit; href?: string }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{hit.label}</span>
        <span className={cn('block truncate font-mono text-[10px]', MUTED)}>
          {/* The owning type, then the code name, then the context line. A
              property called "Status" is meaningless without the type it is on,
              and that is the single most common kind of hit. */}
          {hit.typeName && hit.typeName !== hit.label ? `${hit.typeName} · ` : ''}
          {hit.id}
          {hit.detail ? ` · ${hit.detail}` : ''}
        </span>
      </span>
      <span className={cn('shrink-0 font-mono text-[10px]', RANK_TONE[hit.rank])}>
        {RANK_LABEL[hit.rank]}
        {/* Which FIELD matched, next to how well. "in the text" alone leaves a
            reader guessing whether it was the description or a unit. */}
        <span className={cn('ml-1.5', SECONDARY)}>{hit.field}</span>
      </span>
      {href && <ArrowUpRight size={13} className={cn('shrink-0', MUTED)} aria-hidden />}
    </>
  );

  const className = cn(
    'flex items-center gap-3 rounded-md px-2 py-2 text-left',
    href && 'transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800',
  );

  if (!href) return <div className={className}>{body}</div>;
  return (
    <a href={href} className={className}>
      {body}
    </a>
  );
}
