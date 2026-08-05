import type {
  CatalogQueryRelation,
  CatalogQueryResult,
  SavedQuery,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, History, Layers, Link2Off, Play, Sparkles, TableIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { paramFromLocation } from './ObjectExplorer';
import { SavedQueryPanel, savedQueryKeys } from './SavedQueryPanel';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { CodeEditor } from './ui/code-editor';
import { DataTable, renderUnknown } from './ui/data-table';
import { Tooltip, TooltipProvider } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const PANEL = 'bg-white dark:bg-zinc-900';
const RULE = 'border-zinc-200 dark:border-zinc-800';

const STARTER = `-- Two relations per object type, and the difference is the point:
--   <type>       the committed snapshot
--   obj_<type>   every load ever written, with _snapshot_id
--
-- Across tables:
--   SELECT v.assetId, COUNT(*) AS work_orders
--   FROM mvr v JOIN subwo s ON s.assetId = v.assetId
--   GROUP BY v.assetId ORDER BY work_orders DESC
--
-- Across versions:
--   SELECT _snapshot_id, AVG(\`Risk Score\`) FROM obj_mvr GROUP BY _snapshot_id

SELECT * FROM `;

export interface QueryConsoleProps {
  /**
   * Turns a sentence into SQL. Omit and the assistant disappears entirely —
   * the console is fully usable without it, and an button that always fails is
   * worse than no button.
   */
  onGenerate?: (prompt: string, schema: CatalogQueryRelation[]) => Promise<string>;
  maxRows?: number;
  /**
   * Which saved query to open in the editor. Omit to fall back to
   * `?savedQuery=` then to the starter SQL.
   *
   * The same shape, and the same reasoning, as `ObjectExplorer`'s `type`: the
   * host is the one that knows where its own router keeps parameters, so it
   * passes what it parsed, and {@link paramFromLocation} is the convenience for
   * a host that does not. A search result naming a saved query has been landing
   * on this screen and stopping since the box shipped, because there was no
   * prop for the id to arrive through.
   *
   * `| undefined` is spelled out rather than left to `?`, because a host
   * compiling under `exactOptionalPropertyTypes` — which the console in this
   * repo does — cannot pass `params.get('savedQuery') ?? undefined` to a bare
   * `?: string` without a spread that exists only to satisfy the compiler. "No
   * saved query named" is a value this prop genuinely takes.
   */
  savedQueryId?: string | undefined;
  /**
   * Called with whatever is now open, so the host can put it in the address.
   *
   * **Why the write is a callback and the read is not.** Reading a URL is an
   * observation and cannot surprise anybody, which is why the fallback reader
   * above is unconditional. Writing one is an act with effects outside this
   * component's box: whether a selection becomes a history entry you can press
   * Back through or replaces the current one, and whether the address may be
   * touched at all, are decisions belonging to the application that owns the
   * address bar — a console mounted at `/analytics/boards` inside somebody's
   * app should not find a library appending parameters to its URL. So this
   * screen reports, and a host that wants copyable links wires it up. Omit it
   * and nothing writes, which is exactly what every existing host gets.
   *
   * `undefined` means nothing is open — the starter SQL, or a query that was
   * just deleted — and the host should drop the parameter rather than leave it
   * naming something gone.
   */
  onSavedQueryChange?: (id: string | undefined) => void;
}

/**
 * Turn a sentence into SQL, and say what the assistant was shown.
 *
 * The note about relation and column names is not decoration: somebody typing a
 * question here is entitled to know that the rows never left the database, and
 * that what comes back is a draft to read rather than a result to trust.
 */
function AskAssistantPanel({
  prompt,
  onPromptChange,
  pending,
  error,
  onSubmit,
}: {
  prompt: string;
  onPromptChange: (value: string) => void;
  pending: boolean;
  error: unknown;
  onSubmit: () => void;
}) {
  return (
    <div className={cn('shrink-0 border-b bg-sky-50/60 px-4 py-3 dark:bg-sky-950/20', RULE)}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="Which vehicles gained the most work orders since the last load?"
          aria-label="Describe the query"
          className={cn(
            'flex-1 rounded-md border px-3 py-1.5 text-sm outline-none',
            RULE,
            PANEL,
            'focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15',
          )}
        />
        <button
          type="submit"
          disabled={pending || prompt.trim().length === 0}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {pending ? 'Writing…' : 'Write the SQL'}
        </button>
      </form>
      <p className={cn('mt-1.5 text-[11px]', MUTED)}>
        It sees the relation and column names above, never the rows. Read the SQL before running it.
      </p>
      {error ? (
        <p className="mt-1 text-[11px] text-red-600">
          {error instanceof Error ? error.message : 'The assistant could not write that.'}
        </p>
      ) : null}
    </div>
  );
}

export function QueryConsole({
  onGenerate,
  maxRows = 500,
  savedQueryId,
  onSavedQueryChange,
}: QueryConsoleProps) {
  const client = useCatalogClient();
  const [sql, setSql] = useState(STARTER);
  const [prompt, setPrompt] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  /**
   * The id somebody asked for, and the id actually in the editor.
   *
   * Two pieces of state rather than one, because the gap between them is the
   * whole point: an id that was asked for and never opened is a link naming a
   * query that is not here, and it has to be sayable. Collapsing them would
   * leave "asked for something gone" indistinguishable from "asked for
   * nothing", which is the state that renders as the starter SQL and looks
   * exactly like a click that never landed.
   */
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [openedId, setOpenedId] = useState<string | null>(null);

  // The prop wins whenever it changes, not only on the first render — a host
  // navigating from one saved query to another sets it, and guarding on "no
  // query open yet" would show the previous one under an address naming the
  // new one. `ObjectExplorer` learned this the same way.
  //
  // The one and only place either source is read. Seeding the state with
  // `savedQueryId ?? null` as well would read the prop twice, which is not just
  // redundant: it makes the first render right even when this effect is wrong,
  // so a build that stopped following the prop would still open the right query
  // on arrival and only misbehave on the second navigation — the harder half of
  // the bug, hidden behind the easier one.
  useEffect(() => {
    const requested = savedQueryId ?? paramFromLocation('savedQuery');
    if (requested) setRequestedId(requested);
  }, [savedQueryId]);

  const { data: relations = [] } = useQuery({
    queryKey: ['catalog', 'query', 'relations'],
    queryFn: () => client.queryRelations(),
    staleTime: 60_000,
  });

  /**
   * The saved list, read here as well as in the panel below.
   *
   * Same key, so this is a cache hit rather than a second request, and the
   * screen that has to resolve an id into SQL is the one that owns the SQL. The
   * alternative — fetching the single query by id — would be a second endpoint
   * answering something already on screen, and it could not tell "deleted"
   * apart from "the server refused" without reading the failure.
   */
  const { data: saved, isSuccess: savedLoaded } = useQuery({
    queryKey: savedQueryKeys.all,
    queryFn: () => client.listSavedQueries(),
  });

  function open(query: SavedQuery) {
    setSql(query.sql);
    setOpenedId(query.id);
    // Also the requested id, so the "not here" notice clears itself when you
    // pick something that is here — without needing the host to have wired the
    // callback up. A screen whose banner can only be dismissed by a host is a
    // banner that never goes away on the hosts that need it most.
    setRequestedId(query.id);
    onSavedQueryChange?.(query.id);
  }

  useEffect(() => {
    if (!requestedId || !saved) return;
    // Already in the editor. Without this, every background refetch of the
    // saved list would hand back a new array, re-run this effect and overwrite
    // whatever has been typed since — the query screen's version of losing
    // your work to a poll.
    if (openedId === requestedId) return;
    const match = saved.find((query) => query.id === requestedId);
    if (!match) return;
    setSql(match.sql);
    setOpenedId(match.id);
  }, [requestedId, saved, openedId]);

  /**
   * A link that named a saved query this catalog does not have.
   *
   * Only once the list has actually arrived: while it is in flight the id is
   * merely unresolved, and reporting that as missing would flash "not here" on
   * every correct link. Nothing is opened in its place and the address is left
   * exactly as it was — falling back to some other query is what turns a stale
   * link into a working link showing the wrong thing, and quietly rewriting the
   * URL would delete the only evidence of which link is broken.
   */
  const missingId =
    requestedId && savedLoaded && !saved.some((q) => q.id === requestedId) ? requestedId : null;

  const run = useMutation({
    mutationFn: () => client.runQuery({ sql, maxRows }),
  });

  const generate = useMutation({
    mutationFn: async () => {
      if (!onGenerate) throw new Error('No assistant is configured.');
      return onGenerate(prompt, relations);
    },
    onSuccess: (generated) => {
      setSql(generated);
      setAskOpen(false);
      setPrompt('');
    },
  });

  const grouped = useMemo(() => {
    const byType = new Map<string, CatalogQueryRelation[]>();
    for (const relation of relations) {
      const list = byType.get(relation.objectType) ?? [];
      list.push(relation);
      byType.set(relation.objectType, list);
    }
    return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [relations]);

  function insert(text: string) {
    const editor = editorRef.current;
    if (!editor) {
      setSql((current) => `${current}${text}`);
      return;
    }
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    setSql((current) => current.slice(0, start) + text + current.slice(end));
    requestAnimationFrame(() => {
      editor.focus();
      editor.selectionStart = editor.selectionEnd = start + text.length;
    });
  }

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter runs, the way every SQL console does.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      run.mutate();
    }
    // A textarea that eats Tab is a textarea nobody can leave by keyboard, so
    // Tab still moves focus; indentation is Shift-agnostic two spaces on Enter.
  }

  const error = run.error instanceof Error ? run.error.message : null;

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0">
        <aside className={cn('flex w-64 shrink-0 flex-col border-r', RULE, PANEL)}>
          <div className={cn('border-b px-3 py-2', RULE)}>
            <p className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
              Relations
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {grouped.length === 0 && (
              <p className={cn('px-2 py-6 text-center text-xs', MUTED)}>
                Nothing has been published yet.
              </p>
            )}
            {grouped.map(([objectType, list]) => (
              <div key={objectType} className="mb-3">
                <div
                  className={cn(
                    'px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em]',
                    MUTED,
                  )}
                >
                  {objectType}
                </div>
                {list.map((relation) => (
                  <RelationRow key={relation.name} relation={relation} onInsert={insert} />
                ))}
              </div>
            ))}
          </div>
          <SavedQueryPanel currentSql={sql} openId={openedId} onLoad={open} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className={cn('flex shrink-0 items-center gap-2 border-b px-4 py-2', RULE, PANEL)}>
            <button
              type="button"
              onClick={() => run.mutate()}
              disabled={run.isPending}
              className="flex items-center gap-1.5 rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-50 transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950"
            >
              <Play size={12} />
              {run.isPending ? 'Running…' : 'Run'}
            </button>
            <span className={cn('font-mono text-[10px]', MUTED)}>⌘↵</span>

            {onGenerate && (
              <button
                type="button"
                onClick={() => setAskOpen((open) => !open)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors',
                  RULE,
                  'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  askOpen && 'bg-sky-100 dark:bg-sky-950',
                )}
              >
                <Sparkles size={12} />
                Ask
              </button>
            )}

            {run.data && (
              <span className={cn('ml-auto font-mono text-[11px]', MUTED)}>
                {run.data.rowCount} rows · {run.data.cached ? 'cached' : `${run.data.elapsedMs} ms`}
                {run.data.truncated && ' · capped'}
              </span>
            )}
          </div>

          {missingId && <MissingSavedQuery id={missingId} />}

          {askOpen && onGenerate && (
            <AskAssistantPanel
              prompt={prompt}
              onPromptChange={setPrompt}
              pending={generate.isPending}
              error={generate.error}
              onSubmit={() => generate.mutate()}
            />
          )}

          <SqlEditor
            value={sql}
            onChange={setSql}
            onKeyDown={onEditorKeyDown}
            textareaRef={editorRef}
          />

          <div className="min-h-0 flex-1 overflow-auto">
            {error && (
              <div className="m-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="font-mono leading-relaxed">{error}</span>
              </div>
            )}
            {run.data && <ResultTable result={run.data} />}
            {!run.data && !error && (
              <p className={cn('p-8 text-center text-sm', MUTED)}>Results appear here.</p>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * What a link naming a query that is not here gets to say.
 *
 * Above the editor rather than inside the results pane, because it is a
 * statement about how you arrived and not about anything that ran — the results
 * pane still says "Results appear here", which is true.
 *
 * The id is quoted verbatim. It is the only part of a broken link worth
 * anything: whoever sent it can be told which one, and a person looking at two
 * environments can see at a glance that the id belongs to the other. A message
 * that said only "that query is gone" would be asking them to go and read the
 * address bar for it.
 */
function MissingSavedQuery({ id }: { id: string }) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-start gap-2 border-b bg-amber-50/70 px-4 py-2',
        'text-xs text-amber-800 dark:bg-amber-950/25 dark:text-amber-300',
        RULE,
      )}
    >
      <Link2Off size={13} className="mt-0.5 shrink-0" />
      <span className="leading-relaxed">
        This link named a saved query that is not in this catalog:{' '}
        <span className="font-mono">{id}</span>. It may have been deleted, or it may belong to a
        different environment. Nothing was opened in its place — the editor is untouched.
      </span>
    </div>
  );
}

function RelationRow({
  relation,
  onInsert,
}: {
  relation: CatalogQueryRelation;
  onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = relation.kind === 'current' ? TableIcon : History;

  return (
    <div>
      <div className="flex items-center">
        <Tooltip content={relation.description} side="right">
          <button
            type="button"
            onClick={() => onInsert(relation.name)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left',
              'hover:bg-zinc-50 dark:hover:bg-zinc-800',
            )}
          >
            <Icon
              size={12}
              className={relation.kind === 'current' ? 'text-emerald-600' : 'text-amber-600'}
            />
            <span className="truncate font-mono text-[11px]">{relation.name}</span>
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`${open ? 'Hide' : 'Show'} columns of ${relation.name}`}
          className={cn('rounded-sm px-1 py-1 text-[10px]', MUTED)}
        >
          <Layers size={11} />
        </button>
      </div>
      {open && (
        <div className="ml-4 border-l border-zinc-100 pl-2 dark:border-zinc-800">
          {relation.columns.map((column) => (
            <button
              key={column.name}
              type="button"
              onClick={() => onInsert(column.name)}
              className="flex w-full items-baseline justify-between gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <span className="truncate font-mono text-[10px]">{column.name}</span>
              <span className={cn('font-mono text-[9px] uppercase', MUTED)}>{column.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A highlighted editor built from a textarea under a `<pre>`.
 *
 * The textarea keeps every behaviour a text input is supposed to have —
 * selection, undo, IME, screen readers, native keyboard shortcuts — while the
 * highlighted copy sits behind it, transparent text, identical metrics. A
 * contenteditable would look the same and lose all of it.
 */
function SqlEditor({
  value,
  onChange,
  onKeyDown,
  textareaRef,
}: {
  value: string;
  onChange: (next: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <CodeEditor
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      textareaRef={textareaRef}
      language="sql"
      label="SQL query"
      // Roomier than the transform pane: this is the screen's primary input,
      // not a side panel.
      className={cn('h-56 shrink-0 border-b', RULE, PANEL)}
      padding="p-4"
      fontSize="text-[13px]"
    />
  );
}

function ResultTable({ result }: { result: CatalogQueryResult }) {
  // Built from the answer, because the answer decides them: a free SQL query
  // returns whatever columns it returns, and there is no type to derive them
  // from ahead of time.
  const columns = useMemo(
    () =>
      result.columns.map((column) => ({
        id: column,
        accessorFn: (row: Record<string, unknown>) => row[column],
        header: column,
        cell: (context: { getValue: () => unknown }) => renderUnknown(context.getValue()),
      })),
    [result.columns],
  );

  // Whether a column is numeric is a property of the DATA here, not of a
  // schema — the first row is the only thing available to ask.
  const numericColumns = useMemo(() => {
    const first = result.rows[0];
    return new Set(
      first ? result.columns.filter((column) => typeof first[column] === 'number') : [],
    );
  }, [result.columns, result.rows]);

  return (
    <div className="p-4">
      {result.truncated && (
        <p className="mb-2 text-[11px] text-amber-600">
          Showing the first {result.rowCount} rows. Add a LIMIT or an aggregate to see a complete
          answer.
        </p>
      )}
      <DataTable
        data={result.rows}
        columns={columns}
        numeric={(id) => numericColumns.has(id)}
        className={cn('rounded-lg border', RULE, PANEL)}
        empty={
          <p className={cn('p-8 text-center text-sm', MUTED)}>The query ran and matched nothing.</p>
        }
      />
    </div>
  );
}
