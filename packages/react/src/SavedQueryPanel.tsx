import type { SaveQueryInput, SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Download, History, Timer, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { registeredChartLibraries } from './charts/registry';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { RevisionHistorySheet } from './diff/RevisionDiff';
import { ShareBadge, ShareControl } from './sharing';
import { Select } from './ui/select';
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
 *
 * The list also carries the sharing state and the way back out of it. "Let
 * other apps embed this" is a checkbox on the save form, which used to be the
 * ONLY place `shared` could be set: a query shared by a slip of the mouse
 * stayed shared, because no screen afterwards could reach the flag and the only
 * way to revoke the grant was deleting the query. The badge is why a mistake is
 * noticed at all — it renders without hovering, so a shared query announces
 * itself in the list rather than waiting to be discovered from the embed API.
 */
/**
 * The kinds a visualization can be, as the single list both the picker and the
 * narrowing read. A `as 'table'` cast — which is what this replaces — claims a
 * value the compiler then stops checking, and a new kind added to the union
 * would not have shown up in the dropdown.
 */
const CHART_KINDS = ['table', 'bar', 'line', 'area', 'number'] as const;

function asChartKind(value: string): (typeof CHART_KINDS)[number] {
  const found = CHART_KINDS.find((kind) => kind === value);
  // The picker only ever offers these, so the fallback is unreachable in
  // practice; it is here because narrowing a string has to end somewhere, and
  // a table is the kind that renders any result.
  return found ?? 'table';
}

export function SavedQueryPanel({
  currentSql,
  openId,
  onLoad,
}: {
  currentSql: string;
  /**
   * Which of these is in the editor right now, if any.
   *
   * The visible answer to "what is this address naming". A console that opens a
   * saved query from a link and then shows a list where every row looks
   * identical has told you the SQL came from somewhere without telling you
   * where, and the next thing that happens is somebody saving a second copy of
   * a query they already had open.
   */
  openId?: string | null;
  onLoad: (query: SavedQuery) => void;
}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  /**
   * Which query's history is open, as the query itself rather than an id.
   *
   * The whole row, because the sheet is titled by name and a panel headed with
   * an opaque id helps nobody. Looking the name back up from the id would be a
   * second read of an array this component is already holding.
   */
  const [history, setHistory] = useState<SavedQuery | null>(null);
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

  /**
   * The first call site `updateSavedQuery` has ever had.
   *
   * It was on the client, typed to take the whole of `Partial<SaveQueryInput>`
   * — `shared` included — and reachable from nothing. A method no screen calls
   * is a capability the product does not have, whatever the type says.
   */
  const share = useMutation({
    mutationFn: ({ id, shared }: { id: string; shared: boolean }) =>
      client.updateSavedQuery(id, { shared }),
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
            <Select
              value={draft.visualization?.kind ?? 'table'}
              onValueChange={(kind) =>
                setDraft({
                  ...draft,
                  visualization: { ...(draft.visualization ?? {}), kind: asChartKind(kind) },
                })
              }
              ariaLabel="Chart type"
              className="min-w-0 flex-1"
              options={CHART_KINDS.map((kind) => ({ value: kind, label: kind }))}
            />
            <Select
              value={draft.visualization?.library ?? ''}
              onValueChange={(library) =>
                setDraft({
                  ...draft,
                  visualization: {
                    ...(draft.visualization ?? { kind: 'table' }),
                    // Empty means "the built-in renderer", stored as absent.
                    ...(library ? { library } : { library: undefined }),
                  },
                })
              }
              ariaLabel="Chart library"
              className="min-w-0 flex-1"
              options={[
                { value: '', label: 'built-in', hint: 'no dependency' },
                ...registeredChartLibraries().map((library) => ({
                  value: library,
                  label: library,
                })),
              ]}
            />
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
                    aria-current={query.id === openId ? 'true' : undefined}
                    className={cn(
                      'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-[11px]',
                      query.id === openId
                        ? 'bg-sky-100 dark:bg-sky-950'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                    )}
                  >
                    {query.name}
                    {query.cacheTtlSeconds > 0 && (
                      <span className={cn('ml-1 font-mono text-[9px]', MUTED)}>
                        {query.cacheTtlSeconds}s
                      </span>
                    )}
                  </button>
                </Tooltip>
                {/*
                 * Only when shared, and never hidden behind a hover. Every
                 * other control in this row appears on hover because it is an
                 * action; this is not an action, it is the answer to "which of
                 * these can an outside application already read", and an answer
                 * you have to go looking for one row at a time is not one.
                 */}
                {query.shared && <ShareBadge shared className="mr-1" />}
                <ShareControl
                  layout="row"
                  kind="query"
                  shared={query.shared}
                  pending={share.isPending}
                  name={query.name}
                  onChange={(shared) => share.mutate({ id: query.id, shared })}
                  className={cn(
                    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                    MUTED,
                  )}
                />
                <Tooltip content="Every SQL this query has been, and what changed between two of them">
                  <button
                    type="button"
                    onClick={() => setHistory(query)}
                    className={cn(
                      'rounded-sm p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                      MUTED,
                    )}
                    aria-label={`History of ${query.name}`}
                  >
                    <History size={11} />
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
        {/*
         * A refused share, said once for the list rather than under the row.
         * The rows are a single line tall and the control is hover-revealed, so
         * a message inside one would reflow the list under the pointer that
         * asked for it — and this is the failure that must not pass unnoticed:
         * the badge does not move, so nothing else on screen would say the
         * grant was not made.
         */}
        {share.error !== null && (
          <p className="px-2 py-1 text-[11px] text-red-600">
            {share.error instanceof Error ? share.error.message : 'Could not change sharing.'}
          </p>
        )}
      </div>

      {history && (
        <RevisionHistorySheet
          open
          onOpenChange={(open) => {
            if (!open) setHistory(null);
          }}
          subject={{ kind: 'saved-query', id: history.id, name: history.name }}
          // No `current`, and the asymmetry is in the data rather than in this
          // call. `CatalogTransform` carries a `version` counter, so a transform
          // editor can hand the sheet "v5 is what is live" and have it noticed
          // when the recorded history stops at v4. `SavedQuery` has no version
          // field at all — there is no number to put beside its SQL — so the
          // newest recorded revision is the newest thing this screen can name.
          // Passing an invented number to make the two callers look alike would
          // put a version on somebody's SQL that nothing else in the system
          // agrees with.
        />
      )}
    </div>
  );
}
