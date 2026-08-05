import type {
  CatalogObjectTypeDef,
  CatalogSnapshot,
  PropertyPatch,
  ScalarType,
  TypePatch,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Eye,
  EyeOff,
  RotateCcw,
  Search,
  Unlink,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { CoverageLedger } from './CoverageLedger';
import { EditableField } from './EditableField';
import { LoadExpectationSection } from './LoadExpectationSection';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
import { type Freshness, freshnessOf, isWorthFlagging } from './freshness';
import { DataTable } from './ui/data-table';
import { RichTextField } from './ui/rich-text-field';
import { Tooltip, TooltipProvider } from './ui/tooltip';

/**
 * Browse and label the model.
 *
 * The screen reads as a nomenclature plate: what the machine calls a thing in
 * mono, what a person calls it in prose. Wherever both exist, both are shown —
 * the gap between them is the work.
 */

const TYPE_TONE: Record<ScalarType, string> = {
  string: 'text-sky-700 dark:text-sky-300',
  number: 'text-sky-700 dark:text-sky-300',
  date: 'text-amber-700 dark:text-amber-300',
  boolean: 'text-emerald-700 dark:text-emerald-300',
  json: 'text-zinc-600 dark:text-zinc-300',
  uuid: 'text-rose-700 dark:text-rose-300',
  unknown: 'text-zinc-400',
};

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const SECONDARY = 'text-zinc-500 dark:text-zinc-400';
const PANEL = 'bg-white dark:bg-zinc-900';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const HAIRLINE = 'border-zinc-100 dark:border-zinc-900';

function ScalarBadge({ type }: { type: ScalarType }) {
  return (
    <span
      className={cn(
        'rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider dark:bg-zinc-800',
        TYPE_TONE[type],
      )}
    >
      {type}
    </span>
  );
}

export interface CatalogManagerProps {
  /**
   * Where the object explorer lives, if the host mounts one. Receives the type
   * name. Omit to hide the "Open …" button entirely.
   */
  explorerHref?: (typeName: string) => string;
  /** Heading copy, so the host can call this whatever its users call it. */
  title?: string;
  eyebrow?: string;
  intro?: string;
}

export function CatalogManager({
  explorerHref,
  title = 'Catalog',
  eyebrow = 'Semantic layer',
  intro = 'Every object type the system already holds, derived from the ORM. Names, descriptions and units are yours to change — none of it touches the database.',
}: CatalogManagerProps) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: catalogQueryKeys.snapshot,
    queryFn: () => client.snapshot(),
    staleTime: 30_000,
  });

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyUnnamed, setOnlyUnnamed] = useState(false);

  /** Presentation edits should feel like typing, not like saving. */
  function applyToSnapshot(updated: unknown) {
    if (!updated || typeof updated !== 'object' || !('name' in updated)) return;
    const next = updated as CatalogObjectTypeDef;
    queryClient.setQueryData<CatalogSnapshot>(catalogQueryKeys.snapshot, (prev) =>
      prev
        ? {
            ...prev,
            types: prev.types.map((t) => (t.name === next.name ? next : t)),
            stats: {
              ...prev.stats,
              enrichedTypes: prev.types.filter((t) =>
                t.name === next.name ? next.enriched : t.enriched,
              ).length,
            },
          }
        : prev,
    );
  }

  const typeMutation = useMutation({
    mutationFn: ({ name, patch }: { name: string; patch: TypePatch }) =>
      client.patchType(name, patch),
    onSuccess: applyToSnapshot,
  });

  const propertyMutation = useMutation({
    mutationFn: ({
      name,
      property,
      patch,
    }: {
      name: string;
      property: string;
      patch: PropertyPatch;
    }) => client.patchProperty(name, property, patch),
    onSuccess: applyToSnapshot,
  });

  const resetMutation = useMutation({
    mutationFn: () => client.reset(),
    onSuccess: (snapshot) => queryClient.setQueryData(catalogQueryKeys.snapshot, snapshot),
  });

  const types = useMemo(() => data?.types ?? [], [data]);
  const selected = useMemo(
    () => types.find((t) => t.name === selectedName) ?? types[0],
    [types, selectedName],
  );

  const grouped = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const matching = types.filter((t) => {
      if (onlyUnnamed && t.enriched) return false;
      if (!term) return true;
      return (
        t.displayName.toLowerCase().includes(term) ||
        t.name.toLowerCase().includes(term) ||
        t.tableName.toLowerCase().includes(term)
      );
    });
    const byGroup = new Map<string, CatalogObjectTypeDef[]>();
    for (const type of matching) {
      const list = byGroup.get(type.group) ?? [];
      list.push(type);
      byGroup.set(type.group, list);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [types, filter, onlyUnnamed]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className={cn('font-mono text-sm', MUTED)}>Reading the catalog…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="text-lg font-medium">The catalog did not load</h2>
          <p className={cn('mt-1 text-sm', SECONDARY)}>
            The server builds it from ORM metadata at boot. Check that the API is reachable and that
            your account may read it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950">
        <header className={cn('shrink-0 border-b px-8 py-6', RULE, PANEL)}>
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className={cn('font-mono text-[11px] uppercase tracking-[0.18em]', MUTED)}>
                {eyebrow}
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
              <p className={cn('mt-1 max-w-xl text-sm', SECONDARY)}>{intro}</p>
            </div>

            <div className="flex items-center gap-6">
              <Stat label="Types" value={data.stats.types} />
              <Stat label="Properties" value={data.stats.properties} />
              {/*
                "Relations", not "Links", and the tooltip says why: this counts
                declared relations, and a link declared at both ends contributes
                two. Calling it Links made the header disagree with the graph by
                a factor that changed per catalog.
              */}
              <Tooltip content="Relations declared across every type. A link declared at both ends counts twice — the graph draws it once.">
                <span className="cursor-help">
                  <Stat label="Relations" value={data.stats.relations} />
                </span>
              </Tooltip>
              <button
                type="button"
                onClick={() => resetMutation.mutate()}
                disabled={resetMutation.isPending}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs',
                  RULE,
                  SECONDARY,
                  'transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-800',
                )}
              >
                <RotateCcw size={13} />
                Reset edits
              </button>
            </div>
          </div>

          <div className="mt-6">
            <CoverageLedger types={types} selected={selected?.name} onSelect={setSelectedName} />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className={cn('flex w-72 shrink-0 flex-col border-r', RULE, PANEL)}>
            <div className={cn('shrink-0 space-y-2 border-b p-3', HAIRLINE)}>
              <div className="relative">
                <Search
                  size={14}
                  className={cn(
                    'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2',
                    MUTED,
                  )}
                />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Find a type or table"
                  aria-label="Filter object types"
                  className={cn(
                    'w-full rounded-md border bg-zinc-50 py-1.5 pl-8 pr-2 text-sm outline-none dark:bg-zinc-950',
                    RULE,
                    'placeholder:text-zinc-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15',
                  )}
                />
              </div>
              <label
                className={cn('flex cursor-pointer items-center gap-2 px-0.5 text-xs', SECONDARY)}
              >
                <input
                  type="checkbox"
                  checked={onlyUnnamed}
                  onChange={(e) => setOnlyUnnamed(e.target.checked)}
                  className="accent-amber-500"
                />
                Only types nobody has named
              </label>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto p-2">
              {grouped.length === 0 && (
                <p className={cn('px-2 py-6 text-center text-xs', MUTED)}>
                  Nothing matches “{filter}”.
                </p>
              )}
              {grouped.map(([group, groupTypes]) => (
                <div key={group} className="mb-3">
                  <div className="flex items-baseline justify-between px-2 py-1">
                    <span
                      className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}
                    >
                      {group}
                    </span>
                    <span className={cn('font-mono text-[10px]', MUTED)}>{groupTypes.length}</span>
                  </div>
                  {groupTypes.map((type) => (
                    <button
                      key={type.name}
                      type="button"
                      onClick={() => setSelectedName(type.name)}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                        selected?.name === type.name
                          ? 'bg-sky-100 dark:bg-sky-950'
                          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          type.enriched ? 'bg-emerald-500' : 'bg-amber-400/60',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {type.icon ? `${type.icon} ` : ''}
                          {type.displayName}
                        </span>
                        <span className={cn('block truncate font-mono text-[10px]', MUTED)}>
                          {type.tableName}
                          <FreshnessNote type={type} />
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto">
            {selected && (
              <TypeDetail
                key={selected.name}
                type={selected}
                // The whole catalog, so the detail pane can answer what points
                // AT this type. Nothing on a type records its inbound links —
                // one row per declaration, and the declaration lives on the
                // other end — so the only place that question can be answered
                // is somewhere holding every type.
                types={types}
                explorerHref={explorerHref}
                onPatchType={(patch) => typeMutation.mutate({ name: selected.name, patch })}
                onPatchProperty={(property, patch) =>
                  propertyMutation.mutate({ name: selected.name, property, patch })
                }
                onNavigate={setSelectedName}
              />
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <div className="font-mono text-xl leading-none tabular-nums">{value}</div>
      <div className={cn('mt-1 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
        {label}
      </div>
    </div>
  );
}

interface TypeDetailProps {
  type: CatalogObjectTypeDef;
  types: CatalogObjectTypeDef[];
  explorerHref?: (typeName: string) => string;
  onPatchType: (patch: TypePatch) => void;
  onPatchProperty: (property: string, patch: PropertyPatch) => void;
  onNavigate: (name: string) => void;
}

function TypeDetail({
  type,
  types,
  explorerHref,
  onPatchType,
  onPatchProperty,
  onNavigate,
}: TypeDetailProps) {
  const visible = type.properties.filter((p) => !p.hidden).length;

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl leading-none">{type.icon ?? '◈'}</span>
            <EditableField
              label="display name"
              value={type.displayName}
              onSave={(displayName) => onPatchType({ displayName })}
              className="text-2xl font-semibold tracking-tight"
              inputClassName="text-2xl font-semibold tracking-tight"
            />
          </div>
          <div
            className={cn(
              'mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 font-mono text-[11px]',
              MUTED,
            )}
          >
            <span>{type.name}</span>
            <span aria-hidden>·</span>
            <span>{type.tableName}</span>
            <span aria-hidden>·</span>
            <span>pk {type.primaryKey.join(', ') || 'none'}</span>
            <span aria-hidden>·</span>
            <span>
              {visible} of {type.properties.length} shown
            </span>
          </div>
        </div>

        {explorerHref && (
          <a
            href={explorerHref(type.name)}
            className={cn(
              'flex items-center gap-1.5 rounded-md bg-zinc-950 px-3 py-2 text-xs text-zinc-50',
              'transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-300',
            )}
          >
            Open {type.pluralDisplayName}
            <ArrowUpRight size={13} />
          </a>
        )}
      </div>

      <div className="mt-5 border-l-2 border-sky-200 pl-4 dark:border-sky-900">
        <RichTextField
          label="description"
          value={type.description ?? ''}
          placeholder="No one has written down what this type means yet."
          onSave={(description) => onPatchType({ description })}
          className={cn('text-sm leading-relaxed', SECONDARY)}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <FieldChip label="Group" value={type.group} onSave={(group) => onPatchType({ group })} />
        <FieldChip
          label="Plural"
          value={type.pluralDisplayName}
          onSave={(pluralDisplayName) => onPatchType({ pluralDisplayName })}
        />
        <FieldChip label="Icon" value={type.icon ?? ''} onSave={(icon) => onPatchType({ icon })} />
      </div>

      <section className="mt-10">
        <SectionHeading
          title="Properties"
          note="The column and its SQL type are read from the ORM. The label, description and unit are yours."
        />
        <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
          <PropertyTable properties={type.properties} onPatchProperty={onPatchProperty} />
        </div>
      </section>

      {/*
        Between the properties and the links, and on this screen rather than in
        the pipeline console, because it is a statement the catalog makes ABOUT
        a type — the same kind of thing as its description and its units — and
        because the state it exists to reveal (no strategy declared, so
        incremental loads are refused) is invisible everywhere else.
      */}
      <LoadExpectationSection typeName={type.name} displayName={type.displayName} />

      <LinkSection
        type={type}
        types={types}
        onPatchProperty={onPatchProperty}
        onNavigate={onNavigate}
      />
    </div>
  );
}

/** What each kind actually says, for people who do not read `m:n` fluently. */
const KIND_MEANING: Record<CatalogObjectTypeDef['relations'][number]['kind'], string> = {
  'm:1': 'Many of these point at one of those. The key is on this side.',
  '1:m': 'One of these has many of those. The key is on the other side.',
  '1:1': 'One of each, paired.',
  'm:n': 'Many on both sides, joined through a table of pairs.',
};

/**
 * A link this type declares, together with the one that points back at it.
 *
 * A type carries one row per link it DECLARES, which is the honest shape — the
 * declaration belongs to whoever wrote it, and inventing a mirror row on the
 * other type would double every count and hand a curator a label no publisher
 * owns. But it makes half the truth invisible: `@ManyToOne(() => Base)` on `Mvr`
 * leaves `Base` with an empty relations list, and this screen said, in as many
 * words, that nothing linked to or from it. Base is one of the most linked-to
 * types in the schema.
 *
 * So the inbound half is derived here, from the catalog the screen already has,
 * and derived is exactly what it stays: nothing about it is stored, counted or
 * editable from this end.
 */
function inboundLinks(
  type: CatalogObjectTypeDef,
  types: CatalogObjectTypeDef[],
): Array<{ from: CatalogObjectTypeDef; relation: CatalogObjectTypeDef['relations'][number] }> {
  // The other ends this type already declares. `Base.mvrs` names `Mvr.base`
  // through `inverseName`, and the two are one link — listing the second as an
  // inbound arrival would show a single foreign key as two separate links.
  const alreadyMine = new Set(
    type.relations.flatMap((relation) =>
      relation.inverseName ? [`${relation.targetType}.${relation.inverseName}`] : [],
    ),
  );

  const inbound: Array<{
    from: CatalogObjectTypeDef;
    relation: CatalogObjectTypeDef['relations'][number];
  }> = [];
  for (const from of types) {
    // A type that points at itself is already listed once, above. Showing it
    // again under "points here" says there are two links where there is one.
    if (from.name === type.name) continue;
    for (const relation of from.relations) {
      if (relation.targetType !== type.name) continue;
      if (alreadyMine.has(`${from.name}.${relation.name}`)) continue;
      inbound.push({ from, relation });
    }
  }
  return inbound;
}

function LinkSection({
  type,
  types,
  onPatchProperty,
  onNavigate,
}: {
  type: CatalogObjectTypeDef;
  types: CatalogObjectTypeDef[];
  onPatchProperty: (property: string, patch: PropertyPatch) => void;
  onNavigate: (name: string) => void;
}) {
  const inbound = useMemo(() => inboundLinks(type, types), [type, types]);
  const labelFor = useMemo(() => new Map(types.map((t) => [t.name, t.displayName])), [types]);

  return (
    <section className="mt-10 pb-16">
      <SectionHeading
        title="Links"
        note="Read from the foreign keys. What a link is called is yours to change; where it points is not."
      />

      {type.relations.length === 0 && inbound.length === 0 ? (
        <p
          className={cn(
            'rounded-lg border border-dashed px-4 py-6 text-center text-sm',
            RULE,
            MUTED,
          )}
        >
          Nothing links to or from {type.displayName} yet.
        </p>
      ) : (
        <div className="space-y-5">
          {type.relations.length > 0 && (
            <div>
              <p className={cn('mb-2 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                {type.displayName} points at
              </p>
              <ul className="space-y-1.5">
                {type.relations.map((relation) => (
                  <OutboundLink
                    key={relation.name}
                    relation={relation}
                    targetLabel={labelFor.get(relation.targetType)}
                    onPatchProperty={onPatchProperty}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </div>
          )}

          {inbound.length > 0 && (
            <div>
              <p className={cn('mb-2 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                Points at {type.displayName}
              </p>
              <ul className="space-y-1.5">
                {inbound.map(({ from, relation }) => (
                  <li key={`${from.name}.${relation.name}`}>
                    <button
                      type="button"
                      onClick={() => onNavigate(from.name)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                        RULE,
                        PANEL,
                        'hover:border-sky-500 hover:bg-sky-100 dark:hover:bg-sky-950',
                      )}
                    >
                      <ArrowLeft size={13} className={MUTED} />
                      <span className="text-sm">{from.displayName}</span>
                      <span className={cn('font-mono text-[10px]', MUTED)}>
                        {relation.kind} · {from.name}.{relation.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {/*
                Said out loud, because the asymmetry is otherwise read as a bug:
                the labels above are editable and these are not, and the reason
                is that the declaration — and therefore the label — belongs to
                the type it was written on.
              */}
              <p className={cn('mt-1.5 text-[11px]', MUTED)}>
                Declared on the other type. Open it to rename the link.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One link this type declares.
 *
 * Not a single button any more, and that is the point: the label is editable and
 * the target is navigable, so a control that was both meant the only way to
 * rename a link was to first go somewhere else. A nested interactive element is
 * also the one thing a screen reader cannot describe.
 */
function OutboundLink({
  relation,
  targetLabel,
  onPatchProperty,
  onNavigate,
}: {
  relation: CatalogObjectTypeDef['relations'][number];
  targetLabel: string | undefined;
  onPatchProperty: (property: string, patch: PropertyPatch) => void;
  onNavigate: (name: string) => void;
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-2',
        RULE,
        PANEL,
        relation.hidden && 'opacity-45',
      )}
    >
      <Tooltip content={KIND_MEANING[relation.kind]}>
        <span className={cn('cursor-help font-mono text-[10px] uppercase tracking-wider', MUTED)}>
          {relation.kind}
        </span>
      </Tooltip>

      {/* `EditableField` is `w-full`, so it needs a track of its own to grow in. */}
      <span className="min-w-0 flex-1">
        <EditableField
          label={`label for ${relation.name}`}
          value={relation.displayName}
          onSave={(displayName) => onPatchProperty(relation.name, { displayName })}
          className="text-sm"
          inputClassName="text-sm"
        />
      </span>

      <span className={cn('shrink-0 font-mono text-[10px]', MUTED)}>
        {relation.name}
        {/*
          The join column, where there is one. It is the difference between a
          link somebody can go and check in the database and a link they have to
          take on trust — and only the end that owns the key has one.
        */}
        {relation.localKey ? ` · ${relation.localKey}` : ''}
      </span>

      <span className="shrink-0">
        {relation.targetPublished ? (
          <button
            type="button"
            onClick={() => onNavigate(relation.targetType)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors',
              SECONDARY,
              'hover:bg-sky-100 dark:hover:bg-sky-950',
            )}
          >
            <ArrowRight size={13} />
            {targetLabel ?? relation.targetType}
          </button>
        ) : (
          // Kept, and marked. Dropping it would leave the type looking less
          // connected than it is; making it navigable would send the reader to
          // a type that is not there — the button used to do exactly that, and
          // silently selected whichever type happened to be first.
          <Tooltip
            content={`This catalog holds nothing called ${relation.targetType}. The link is real in the source schema; the type on the other end has been excluded, or nobody has published it here.`}
          >
            <span
              className={cn(
                'flex cursor-help items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs',
                'text-amber-700 dark:text-amber-400',
              )}
            >
              <Unlink size={13} />
              {relation.targetType}
            </span>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-3">
      <h2 className={cn('font-mono text-[11px] uppercase tracking-[0.16em]', MUTED)}>{title}</h2>
      <p className={cn('mt-1 text-xs', MUTED)}>{note}</p>
    </div>
  );
}

function FieldChip({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (next: string) => void;
}) {
  return (
    <div className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1', RULE, PANEL)}>
      <span className={cn('font-mono text-[10px] uppercase tracking-wider', MUTED)}>{label}</span>
      <EditableField
        label={label}
        value={value}
        placeholder="—"
        onSave={onSave}
        className="text-xs"
        inputClassName="text-xs"
      />
    </div>
  );
}

/**
 * The properties of one type, as a table.
 *
 * Every cell is an editor or a badge, so what TanStack contributes here is not
 * cell rendering but the column model: six columns declared once, with their
 * widths beside their contents instead of in a separate header row that has to
 * be kept in the same order by hand.
 *
 * The widths are fixed rather than content-sized, and that is the point of
 * declaring them at all: these cells contain inputs, and a column that sizes to
 * its content reflows the whole table on every keystroke.
 */
function PropertyTable({
  properties,
  onPatchProperty,
}: {
  properties: CatalogObjectTypeDef['properties'];
  onPatchProperty: (property: string, patch: PropertyPatch) => void;
}) {
  type Property = CatalogObjectTypeDef['properties'][number];

  const columns = useMemo(
    () => [
      {
        id: 'label',
        header: 'Label',
        accessorFn: (p: Property) => p.displayName,
        cell: ({ row }: { row: { original: Property } }) => (
          <PropertyLabelCell property={row.original} onPatchProperty={onPatchProperty} />
        ),
      },
      {
        id: 'column',
        header: 'Column',
        accessorFn: (p: Property) => p.columnName,
        cell: ({ row }: { row: { original: Property } }) => (
          <span className={cn('font-mono text-[11px]', SECONDARY)}>{row.original.columnName}</span>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        accessorFn: (p: Property) => p.type,
        cell: ({ row }: { row: { original: Property } }) => (
          <ScalarBadge type={row.original.type} />
        ),
      },
      {
        id: 'unit',
        header: 'Unit',
        accessorFn: (p: Property) => p.unit ?? '',
        cell: ({ row }: { row: { original: Property } }) => (
          <EditableField
            label={`unit for ${row.original.name}`}
            value={row.original.unit ?? ''}
            placeholder="—"
            onSave={(unit) => onPatchProperty(row.original.name, { unit })}
            inputClassName="text-xs"
            className="text-xs"
          />
        ),
      },
      {
        id: 'meaning',
        header: 'Meaning',
        accessorFn: (p: Property) => p.description ?? '',
        cell: ({ row }: { row: { original: Property } }) => (
          <RichTextField
            label={`description for ${row.original.name}`}
            value={row.original.description ?? ''}
            placeholder="—"
            onSave={(description) => onPatchProperty(row.original.name, { description })}
            className={cn('text-xs leading-snug', SECONDARY)}
          />
        ),
      },
      {
        id: 'shown',
        header: 'Shown',
        accessorFn: (p: Property) => !p.hidden,
        cell: ({ row }: { row: { original: Property } }) => (
          <VisibilityToggle property={row.original} onPatchProperty={onPatchProperty} />
        ),
      },
    ],
    [onPatchProperty],
  );

  return (
    <DataTable
      data={properties}
      columns={columns}
      getRowId={(property) => property.name}
      // Dimmed rather than dropped: a hidden property is still stored, and a
      // screen that simply omitted it could not tell you that showing it again
      // needs no migration.
      rowClassName={(property) => (property.hidden ? 'opacity-45' : undefined)}
      columnClassName={(id) => PROPERTY_WIDTHS[id]}
      // `align-top`, because two of these cells hold a multi-line editor and a
      // row centred on the tallest one leaves the single-line cells floating.
      cellClassName={() => 'align-top whitespace-normal py-2'}
    />
  );
}

const PROPERTY_WIDTHS: Record<string, string> = {
  label: 'w-[30%]',
  column: 'w-[22%]',
  type: 'w-[10%]',
  unit: 'w-[12%]',
  meaning: 'w-[20%]',
  shown: 'w-[6%] text-right',
};

/** The label cell: the curated name, with the physical name and its constraints beneath. */
function PropertyLabelCell({
  property,
  onPatchProperty,
}: {
  property: CatalogObjectTypeDef['properties'][number];
  onPatchProperty: (property: string, patch: PropertyPatch) => void;
}) {
  return (
    <>
      <EditableField
        label={`label for ${property.name}`}
        value={property.displayName}
        onSave={(displayName) => onPatchProperty(property.name, { displayName })}
        inputClassName="text-sm"
      />
      <div className={cn('px-1.5 font-mono text-[10px]', MUTED)}>
        {property.name}
        {property.primary && (
          <Tooltip content="Primary key. Always fetched, even when hidden, so a row keeps a stable identity.">
            <span className="ml-1.5 cursor-help text-sky-600 dark:text-sky-400">pk</span>
          </Tooltip>
        )}
        {!property.nullable && !property.primary && (
          <Tooltip content="NOT NULL in the database. Read from the ORM, not something this screen can change.">
            <span className="ml-1.5 cursor-help text-amber-600">required</span>
          </Tooltip>
        )}
      </div>
    </>
  );
}

/**
 * Hiding is presentation, not schema — the tooltip says so on both sides,
 * because "hidden" next to a database column reads as destructive until
 * somebody tells you it is not.
 */
function VisibilityToggle({
  property,
  onPatchProperty,
}: {
  property: CatalogObjectTypeDef['properties'][number];
  onPatchProperty: (property: string, patch: PropertyPatch) => void;
}) {
  return (
    <Tooltip
      content={
        property.hidden
          ? `Hidden from tables and search. ${property.displayName} is still stored — showing it again needs no migration.`
          : 'Shown in tables and search. Hiding it only changes what is displayed; the column is untouched.'
      }
    >
      <button
        type="button"
        aria-label={`${property.hidden ? 'Show' : 'Hide'} ${property.displayName}`}
        onClick={() => onPatchProperty(property.name, { hidden: !property.hidden })}
        className={cn('rounded-sm p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800', MUTED)}
      >
        {property.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </Tooltip>
  );
}

/**
 * The age of a type's data, beside its table name.
 *
 * Here rather than behind a hover or a detail pane, because the whole failure
 * this addresses is that nobody thinks to look: a type whose publisher was
 * deleted in January renders identically to one loaded ten minutes ago, and
 * somebody reads a number off it in June.
 *
 * A tooltip carries the row count and the publisher — the two questions that
 * follow "this is old" — without spending width on them for the types where
 * nobody is asking.
 */
function FreshnessNote({ type }: { type: CatalogObjectTypeDef }) {
  const freshness = freshnessOf(type);
  const flag = isWorthFlagging(freshness);

  return (
    <span
      className={cn('ml-2', flag && 'text-amber-600 dark:text-amber-400')}
      title={titleFor(type, freshness)}
    >
      {freshness.kind === 'never' ? '· never loaded' : `· ${freshness.label}`}
    </span>
  );
}

function titleFor(type: CatalogObjectTypeDef, freshness: Freshness): string {
  if (freshness.kind === 'never') {
    // Said plainly, because this is the state most often mistaken for a
    // problem: a type can be published by a schema and legitimately never
    // loaded, and that is not the same as a load that failed.
    return 'This type has a schema but no committed snapshot — nothing has ever been loaded into it.';
  }
  const rows = type.rowCount === undefined ? 'unknown rows' : `${type.rowCount} rows`;
  const who = type.lastPrincipalId ? ` by ${type.lastPrincipalId}` : '';
  return `Serving ${rows}, committed ${freshness.label}${who}.`;
}
