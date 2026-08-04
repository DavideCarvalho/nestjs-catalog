import type { SaveQueryInput, SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Download, Timer, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { registeredChartLibraries } from './charts/registry';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { Tooltip } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';

export const savedQueryKeys = {
  all: ['catalog', 'saved-queries'] as const,
};

/**
 * The saved-query list, and the form for adding to it.
 *
 * Saving asks for a cache TTL up front rather than defaulting to some global
 * number, because only the person writing the query knows whether a
 * five-minute-old answer is fine. Zero — never cache — is the default, so the
 * surprising behaviour is the one you have to ask for.
 */
export function SavedQueryPanel({
  currentSql,
  onLoad,
}: {
  currentSql: string;
  onLoad: (query: SavedQuery) => void;
}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<SaveQueryInput>({
    name: '',
    sql: '',
    folder: '',
    cacheTtlSeconds: 0,
  });

  const { data: saved = [] } = useQuery({
    queryKey: savedQueryKeys.all,
    queryFn: () => client.listSavedQueries(),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: savedQueryKeys.all });

  const save = useMutation({
    mutationFn: () => client.saveQuery({ ...draft, sql: currentSql }),
    onSuccess: () => {
      setSaving(false);
      setDraft({ name: '', sql: '', folder: '', cacheTtlSeconds: 0 });
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteSavedQuery(id),
    onSuccess: invalidate,
  });

  const grouped = useMemo(() => {
    const byFolder = new Map<string, SavedQuery[]>();
    for (const query of saved) {
      const key = query.folder?.trim() || 'Ungrouped';
      const list = byFolder.get(key) ?? [];
      list.push(query);
      byFolder.set(key, list);
    }
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [saved]);

  return (
    <div className={cn('border-t', RULE)}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
          Saved
        </span>
        <button
          type="button"
          onClick={() => setSaving((open) => !open)}
          disabled={currentSql.trim().length === 0}
          className={cn(
            'rounded-sm p-1 disabled:opacity-30',
            MUTED,
            'hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800',
          )}
          aria-label="Save the current query"
        >
          <Bookmark size={12} />
        </button>
      </div>

      {saving && (
        <form
          className="space-y-1.5 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Name"
            aria-label="Query name"
            className={cn(
              'w-full rounded-md border bg-white px-2 py-1 text-xs outline-none dark:bg-zinc-900',
              RULE,
              'focus:border-sky-500',
            )}
          />
          <input
            value={draft.folder ?? ''}
            onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
            placeholder="Folder (optional)"
            aria-label="Folder"
            className={cn(
              'w-full rounded-md border bg-white px-2 py-1 text-xs outline-none dark:bg-zinc-900',
              RULE,
              'focus:border-sky-500',
            )}
          />
          <div className="flex gap-1.5">
            <select
              value={draft.visualization?.kind ?? 'table'}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  visualization: {
                    ...(draft.visualization ?? {}),
                    kind: e.target.value as 'table',
                  },
                })
              }
              aria-label="Chart type"
              className={cn(
                'min-w-0 flex-1 rounded-md border bg-white px-1 py-1 text-[11px] outline-none dark:bg-zinc-900',
                RULE,
              )}
            >
              {['table', 'bar', 'line', 'area', 'number'].map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <select
              value={draft.visualization?.library ?? 'css'}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  visualization: {
                    ...(draft.visualization ?? { kind: 'table' }),
                    library: e.target.value === 'css' ? undefined : e.target.value,
                  },
                })
              }
              aria-label="Chart library"
              title="Which chart library draws this. Only libraries this app registered appear here."
              className={cn(
                'min-w-0 flex-1 rounded-md border bg-white px-1 py-1 text-[11px] outline-none dark:bg-zinc-900',
                RULE,
              )}
            >
              {registeredChartLibraries().map((library) => (
                <option key={library} value={library}>
                  {library}
                </option>
              ))}
            </select>
          </div>
          <label className={cn('flex items-center gap-1.5 text-[11px]', MUTED)}>
            <input
              type="checkbox"
              checked={draft.shared ?? false}
              onChange={(e) => setDraft({ ...draft, shared: e.target.checked })}
              className="accent-sky-500"
            />
            Let other apps embed this
          </label>
          <label className={cn('flex items-center gap-1.5 text-[11px]', MUTED)}>
            <Timer size={11} />
            Reuse the result for
            <input
              type="number"
              min={0}
              value={draft.cacheTtlSeconds ?? 0}
              onChange={(e) => setDraft({ ...draft, cacheTtlSeconds: Number(e.target.value) })}
              aria-label="Cache seconds"
              className={cn(
                'w-14 rounded-md border bg-white px-1 py-0.5 text-right text-[11px] outline-none dark:bg-zinc-900',
                RULE,
              )}
            />
            s
          </label>
          <button
            type="submit"
            disabled={save.isPending || draft.name.trim().length === 0}
            className="w-full rounded-md bg-zinc-950 px-2 py-1 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
          >
            {save.isPending ? 'Saving…' : 'Save this query'}
          </button>
          {save.error && (
            <p className="text-[11px] text-red-600">
              {save.error instanceof Error ? save.error.message : 'Could not save.'}
            </p>
          )}
        </form>
      )}

      <div className="max-h-64 overflow-y-auto px-2 pb-2">
        {saved.length === 0 && (
          <p className={cn('px-2 py-3 text-center text-[11px]', MUTED)}>Nothing saved yet.</p>
        )}
        {grouped.map(([folder, list]) => (
          <div key={folder} className="mb-2">
            <div
              className={cn('px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}
            >
              {folder}
            </div>
            {list.map((query) => (
              <div key={query.id} className="group flex items-center">
                <Tooltip
                  side="right"
                  content={
                    query.description ??
                    (query.cacheTtlSeconds > 0
                      ? `Results reused for ${query.cacheTtlSeconds}s.`
                      : 'Never cached — runs every time.')
                  }
                >
                  <button
                    type="button"
                    onClick={() => onLoad(query)}
                    className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  >
                    {query.name}
                    {query.cacheTtlSeconds > 0 && (
                      <span className={cn('ml-1 font-mono text-[9px]', MUTED)}>
                        {query.cacheTtlSeconds}s
                      </span>
                    )}
                  </button>
                </Tooltip>
                <Tooltip content="Download as CSV">
                  <a
                    href={client.exportUrl(query.id)}
                    className={cn('rounded-sm p-1 opacity-0 group-hover:opacity-100', MUTED)}
                    aria-label={`Export ${query.name}`}
                  >
                    <Download size={11} />
                  </a>
                </Tooltip>
                <button
                  type="button"
                  onClick={() => remove.mutate(query.id)}
                  className={cn(
                    'rounded-sm p-1 opacity-0 group-hover:opacity-100 hover:text-red-600',
                    MUTED,
                  )}
                  aria-label={`Delete ${query.name}`}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
