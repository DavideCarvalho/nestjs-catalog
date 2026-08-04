import type { CatalogQueryRelation, CatalogQueryResult } from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, History, Layers, Play, Sparkles, TableIcon } from 'lucide-react';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { SavedQueryPanel } from './SavedQueryPanel';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { CodeEditor } from './ui/code-editor';
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
}

export function QueryConsole({ onGenerate, maxRows = 500 }: QueryConsoleProps) {
  const client = useCatalogClient();
  const [sql, setSql] = useState(STARTER);
  const [prompt, setPrompt] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const { data: relations = [] } = useQuery({
    queryKey: ['catalog', 'query', 'relations'],
    queryFn: () => client.queryRelations(),
    staleTime: 60_000,
  });

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
          <SavedQueryPanel currentSql={sql} onLoad={(query) => setSql(query.sql)} />
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

          {askOpen && onGenerate && (
            <div
              className={cn('shrink-0 border-b bg-sky-50/60 px-4 py-3 dark:bg-sky-950/20', RULE)}
            >
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  generate.mutate();
                }}
              >
                <input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
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
                  disabled={generate.isPending || prompt.trim().length === 0}
                  className="rounded-md bg-sky-600 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                >
                  {generate.isPending ? 'Writing…' : 'Write the SQL'}
                </button>
              </form>
              <p className={cn('mt-1.5 text-[11px]', MUTED)}>
                It sees the relation and column names above, never the rows. Read the SQL before
                running it.
              </p>
              {generate.error && (
                <p className="mt-1 text-[11px] text-red-600">
                  {generate.error instanceof Error
                    ? generate.error.message
                    : 'The assistant could not write that.'}
                </p>
              )}
            </div>
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
  if (result.rowCount === 0) {
    return (
      <p className={cn('p-8 text-center text-sm', MUTED)}>The query ran and matched nothing.</p>
    );
  }

  return (
    <div className="p-4">
      {result.truncated && (
        <p className="mb-2 text-[11px] text-amber-600">
          Showing the first {result.rowCount} rows. Add a LIMIT or an aggregate to see a complete
          answer.
        </p>
      )}
      <div className={cn('overflow-x-auto rounded-lg border', RULE, PANEL)}>
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className={cn('border-b bg-zinc-50 dark:bg-zinc-950', RULE)}>
              {result.columns.map((column) => (
                <th
                  key={column}
                  className={cn(
                    'whitespace-nowrap px-3 py-2 text-left font-mono text-[10px] font-normal uppercase tracking-[0.12em]',
                    MUTED,
                  )}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: arbitrary SQL has no key
              <tr
                key={index}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
              >
                {result.columns.map((column) => {
                  const value = row[column];
                  const numeric = typeof value === 'number';
                  return (
                    <td
                      key={column}
                      className={cn(
                        'whitespace-nowrap px-3 py-1.5',
                        numeric && 'text-right font-mono tabular-nums',
                        (value === null || value === undefined) && MUTED,
                      )}
                    >
                      {value === null || value === undefined
                        ? '—'
                        : typeof value === 'object'
                          ? JSON.stringify(value)
                          : String(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
