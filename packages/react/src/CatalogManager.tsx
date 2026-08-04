import type {
  CatalogObjectTypeDef,
  CatalogSnapshot,
  PropertyPatch,
  ScalarType,
  TypePatch,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Eye, EyeOff, RotateCcw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CoverageLedger } from './CoverageLedger';
import { EditableField } from './EditableField';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
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
              <Stat label="Links" value={data.stats.relations} />
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
  explorerHref?: (typeName: string) => string;
  onPatchType: (patch: TypePatch) => void;
  onPatchProperty: (property: string, patch: PropertyPatch) => void;
  onNavigate: (name: string) => void;
}

function TypeDetail({
  type,
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
        <EditableField
          label="description"
          multiline
          value={type.description ?? ''}
          placeholder="No one has written down what this type means yet."
          onSave={(description) => onPatchType({ description })}
          className={cn('text-sm leading-relaxed', SECONDARY)}
          inputClassName="text-sm leading-relaxed"
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
          <table className="w-full text-sm">
            <thead>
              <tr className={cn('border-b bg-zinc-50 text-left dark:bg-zinc-950', RULE)}>
                <Th className="w-[30%]">Label</Th>
                <Th className="w-[22%]">Column</Th>
                <Th className="w-[10%]">Type</Th>
                <Th className="w-[12%]">Unit</Th>
                <Th className="w-[20%]">Meaning</Th>
                <Th className="w-[6%] text-right">Shown</Th>
              </tr>
            </thead>
            <tbody>
              {type.properties.map((property) => (
                <tr
                  key={property.name}
                  className={cn(
                    'border-b last:border-0',
                    HAIRLINE,
                    property.hidden && 'opacity-45',
                  )}
                >
                  <td className="px-3 py-2 align-top">
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
                          <span className="ml-1.5 cursor-help text-sky-600 dark:text-sky-400">
                            pk
                          </span>
                        </Tooltip>
                      )}
                      {!property.nullable && !property.primary && (
                        <Tooltip content="NOT NULL in the database. Read from the ORM, not something this screen can change.">
                          <span className="ml-1.5 cursor-help text-amber-600">required</span>
                        </Tooltip>
                      )}
                    </div>
                  </td>
                  <td className={cn('px-3 py-2 align-top font-mono text-[11px]', SECONDARY)}>
                    {property.columnName}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <ScalarBadge type={property.type} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <EditableField
                      label={`unit for ${property.name}`}
                      value={property.unit ?? ''}
                      placeholder="—"
                      onSave={(unit) => onPatchProperty(property.name, { unit })}
                      inputClassName="text-xs"
                      className="text-xs"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <EditableField
                      label={`description for ${property.name}`}
                      multiline
                      value={property.description ?? ''}
                      placeholder="—"
                      onSave={(description) => onPatchProperty(property.name, { description })}
                      className={cn('text-xs leading-snug', SECONDARY)}
                      inputClassName="text-xs leading-snug"
                    />
                  </td>
                  <td className="px-3 py-2 text-right align-top">
                    <Tooltip
                      content={
                        property.hidden
                          ? `Hidden from tables and search. ${property.displayName} is still stored — showing it again needs no migration.`
                          : `Shown in tables and search. Hiding it only changes what is displayed; the column is untouched.`
                      }
                    >
                      <button
                        type="button"
                        aria-label={`${property.hidden ? 'Show' : 'Hide'} ${property.displayName}`}
                        onClick={() =>
                          onPatchProperty(property.name, {
                            hidden: !property.hidden,
                          })
                        }
                        className={cn(
                          'rounded-sm p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                          MUTED,
                        )}
                      >
                        {property.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10 pb-16">
        <SectionHeading title="Links" note="Read from the foreign keys." />
        {type.relations.length === 0 ? (
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
          <div className="flex flex-wrap gap-2">
            {type.relations.map((relation) => (
              <button
                key={relation.name}
                type="button"
                onClick={() => onNavigate(relation.targetType)}
                className={cn(
                  'group flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                  RULE,
                  PANEL,
                  'hover:border-sky-500 hover:bg-sky-100 dark:hover:bg-sky-950',
                )}
              >
                <span className={cn('font-mono text-[10px] uppercase tracking-wider', MUTED)}>
                  {relation.kind}
                </span>
                <span className="text-sm">{relation.displayName}</span>
                <span className={cn('font-mono text-[10px]', MUTED)}>→ {relation.targetType}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
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

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        'px-3 py-2 font-mono text-[10px] font-normal uppercase tracking-[0.12em]',
        MUTED,
        className,
      )}
    >
      {children}
    </th>
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
