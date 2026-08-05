import {
  DELETE_RECONCILIATION_STRATEGIES,
  type DeleteReconciliationStrategy,
  isDeleteReconciliationStrategy,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from './cn';
import {
  type DeleteReconciliation,
  type LoadExpectationInput,
  type ResolvedLoadExpectation,
  catalogQueryKeys,
  useCatalogClient,
} from './context';
import { Button } from './ui/button';
import { DataTable } from './ui/data-table';
import { TextAreaField, TextField } from './ui/field';
import { SelectField } from './ui/select';

/**
 * What a type promises about deletes and row counts, and the form that sets it.
 *
 * The section exists because of one state, and it is the empty one: a type with
 * no delete strategy declared has its INCREMENTAL loads refused, and until this
 * screen existed the only way to learn that was to run one and read the
 * failure — or to have an engineer put the answer in `CATALOG_LOAD_EXPECTATIONS`
 * and deploy. So the empty state is said in words rather than drawn as a blank
 * field, and it is the first thing in the section.
 *
 * The other half is attribution. `because` is a sentence somebody is
 * accountable for, so it is rendered as prose next to who wrote it and when —
 * not as a value in the provenance table beside it, which would read as
 * configuration and be skimmed like configuration.
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const SECONDARY = 'text-zinc-500 dark:text-zinc-400';
const PANEL = 'bg-white dark:bg-zinc-900';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const DANGER = 'text-rose-600 dark:text-rose-400';

/**
 * What each strategy is called on screen, and what it means in one line.
 *
 * A `Record` over the union rather than a hand-written array of options, so the
 * list of strategies has exactly one home — `DELETE_RECONCILIATION_STRATEGIES`
 * in `@dudousxd/nestjs-catalog/client`, which the server validates against too.
 * A fourth strategy added there fails to compile here until somebody writes the
 * copy for it, which is the failure worth having: the alternative is a dropdown
 * that quietly does not offer a strategy the server accepts.
 */
const STRATEGY_COPY: Record<DeleteReconciliationStrategy, { label: string; hint: string }> = {
  accepted: {
    label: 'Accepted — nothing reconciles them',
    hint: 'An append-only ledger, or a dataset where a few stale rows cost less than a nightly full read.',
  },
  'soft-deleted-at-source': {
    label: 'Soft-deleted at the source',
    hint: 'The source flips a column instead of removing the row, so the watermark sees the deletion as an ordinary change.',
  },
  'periodic-full-reload': {
    label: 'Periodic full reload',
    hint: 'Full loads reconcile. Once the newest full load is older than the interval, incremental loads stop committing.',
  },
};

/** The three, in the order the client package lists them, as a select understands them. */
export const DELETE_STRATEGIES = DELETE_RECONCILIATION_STRATEGIES.map((value) => ({
  value,
  ...STRATEGY_COPY[value],
}));

type DeleteStrategy = DeleteReconciliation['strategy'];

/**
 * A select hands back a string. Narrow it rather than promise it is a strategy.
 *
 * The empty string is a real answer and not a failure: a type may legitimately
 * have no delete strategy chosen yet, and that is the state this section exists
 * to make visible. Defaulting an unknown value to one of the three would invent
 * a decision nobody made — which is the one thing this whole mechanism is for.
 */
function toDeleteStrategy(value: string): DeleteStrategy | '' {
  return isDeleteReconciliationStrategy(value) ? value : '';
}

/**
 * Which layer a field came from.
 *
 * Derived from the answer rather than declared, so it cannot fall out of step
 * with what the route sends. `deletesFrom` is the wider of the two — it is the
 * only one with a `none` — so labelling every layer means labelling this one.
 */
type LoadExpectationSource = ResolvedLoadExpectation['deletesFrom'];

/** How each layer should be described to somebody deciding whether they may edit. */
const SOURCE_LABEL: Record<LoadExpectationSource, string> = {
  host: 'Fixed in code by this deployment',
  stored: 'Set here, by an operator',
  default: "The host's house-wide default",
  none: 'Nothing declares it',
};

interface Draft {
  strategy: DeleteStrategy | '';
  because: string;
  column: string;
  withinMs: string;
  maxShrink: string;
  maxGrowth: string;
  minRows: string;
}

/** A blank field means "say nothing about this", which is not the same as zero. */
function numberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function text(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * What the form starts as.
 *
 * The STORED row, except where the host has locked a field — there the resolved
 * value is shown instead, because the control is disabled and what a disabled
 * control must show is the value actually in force. Filling the form with the
 * host's values where it has NOT locked them would be worse than useless: it
 * would turn "the house default applies" into "this type stores this", the
 * first time anybody pressed save.
 */
function draftFrom(view: ResolvedLoadExpectation): Draft {
  const deletes = view.hostLocked.deletes ? view.resolved.deletes : view.stored?.deletes;
  const rowCount = view.hostLocked.rowCount ? view.resolved.rowCount : view.stored?.rowCount;
  return {
    strategy: deletes?.strategy ?? '',
    because: deletes?.because ?? '',
    column: deletes?.strategy === 'soft-deleted-at-source' ? (deletes.column ?? '') : '',
    withinMs: deletes?.strategy === 'periodic-full-reload' ? String(deletes.withinMs) : '',
    maxShrink: text(rowCount?.maxShrink),
    maxGrowth: text(rowCount?.maxGrowth),
    minRows: text(rowCount?.minRows),
  };
}

/**
 * Everything wrong with the draft, by field.
 *
 * A mirror of what the server refuses with a 400, and deliberately a mirror
 * rather than the authority: the server's answer always wins. What this buys is
 * that the refusal arrives beside the field that caused it while somebody is
 * typing, instead of as a message about a request they have stopped thinking
 * about.
 *
 * Locked fields are skipped, because they are not being sent.
 */
function problemsWith(draft: Draft, hostLocked: ResolvedLoadExpectation['hostLocked']): Problems {
  return {
    ...(hostLocked.deletes ? {} : deleteProblems(draft)),
    ...(hostLocked.rowCount ? {} : rowCountProblems(draft)),
  };
}

type Problems = Partial<Record<keyof Draft, string>>;

function deleteProblems(draft: Draft): Problems {
  if (draft.strategy === '') return {};

  const problems: Problems = {};
  // Required for all three, including `accepted` — especially `accepted`, which
  // is the one somebody would otherwise pick to make the refusal go away
  // without deciding anything.
  if (draft.because.trim() === '') {
    problems.because = 'Required. Say why this is the right answer for this type.';
  }
  if (draft.strategy === 'periodic-full-reload') {
    const withinMs = numberOrNull(draft.withinMs);
    if (withinMs === null || withinMs <= 0) {
      problems.withinMs = 'Required, and greater than zero: the interval is what makes this real.';
    }
  }
  return problems;
}

/**
 * A blank bound is always fine — it means "say nothing about this" — so every
 * check here is conditional on somebody having typed something.
 */
function rowCountProblems(draft: Draft): Problems {
  const problems: Problems = {};
  const maxShrink = numberOrNull(draft.maxShrink);
  if (draft.maxShrink.trim() !== '' && (maxShrink === null || maxShrink <= 0 || maxShrink > 1)) {
    problems.maxShrink = 'A fraction above 0 and up to 1. 0.5 refuses a load that halves the type.';
  }
  const maxGrowth = numberOrNull(draft.maxGrowth);
  if (draft.maxGrowth.trim() !== '' && (maxGrowth === null || maxGrowth <= 1)) {
    problems.maxGrowth = 'A ratio above 1. Leave it blank to never refuse growth.';
  }
  const minRows = numberOrNull(draft.minRows);
  if (draft.minRows.trim() !== '' && (minRows === null || minRows < 0)) {
    problems.minRows = 'A row count, zero or more.';
  }
  return problems;
}

/** The row-count fields that carry a number, as the body wants them. */
function rowCountFrom(draft: Draft): LoadExpectationInput['rowCount'] {
  const maxShrink = numberOrNull(draft.maxShrink);
  const maxGrowth = numberOrNull(draft.maxGrowth);
  const minRows = numberOrNull(draft.minRows);
  if (maxShrink === null && maxGrowth === null && minRows === null) return undefined;
  return {
    ...(maxShrink === null ? {} : { maxShrink }),
    ...(maxGrowth === null ? {} : { maxGrowth }),
    ...(minRows === null ? {} : { minRows }),
  };
}

/** The chosen strategy as the union member it is, or nothing chosen. */
function deletesFrom(draft: Draft): DeleteReconciliation | undefined {
  const because = draft.because.trim();
  if (draft.strategy === 'accepted') return { strategy: 'accepted', because };
  if (draft.strategy === 'soft-deleted-at-source') {
    const column = draft.column.trim();
    return { strategy: 'soft-deleted-at-source', because, ...(column ? { column } : {}) };
  }
  if (draft.strategy === 'periodic-full-reload') {
    const withinMs = numberOrNull(draft.withinMs);
    // Unreachable through the form — `problemsWith` disables the button first —
    // and typed rather than asserted, so it stays unreachable if it moves.
    if (withinMs === null) return undefined;
    return { strategy: 'periodic-full-reload', because, withinMs };
  }
  return undefined;
}

/**
 * What the form would send.
 *
 * A locked field is OMITTED rather than sent unchanged. The server answers 409
 * for a write to a field the host owns, and a body that echoed the host's value
 * back would turn every save of the other half into that refusal.
 */
function bodyFrom(
  draft: Draft,
  hostLocked: ResolvedLoadExpectation['hostLocked'],
): LoadExpectationInput {
  const deletes = hostLocked.deletes ? undefined : deletesFrom(draft);
  const rowCount = hostLocked.rowCount ? undefined : rowCountFrom(draft);
  return {
    ...(deletes ? { deletes } : {}),
    ...(rowCount ? { rowCount } : {}),
  };
}

/** Milliseconds, in the unit a person would have said it in. */
function describeInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms} ms`;
  const trim = (value: number) => String(Math.round(value * 10) / 10);
  const hours = ms / 3_600_000;
  if (hours >= 48) return `${trim(hours / 24)} days`;
  if (hours >= 1) return `${trim(hours)} hours`;
  return `${trim(ms / 60_000)} minutes`;
}

export interface LoadExpectationSectionProps {
  typeName: string;
  /** What a person calls the type. Used in the sentences, which are about the type. */
  displayName: string;
}

export function LoadExpectationSection({ typeName, displayName }: LoadExpectationSectionProps) {
  const client = useCatalogClient();
  const {
    data: view,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: catalogQueryKeys.loadExpectation(typeName),
    queryFn: () => client.loadExpectation(typeName),
    // Not retried. The likely failure is a host that serves no pipeline
    // endpoints at all, and four attempts at a 404 over thirty seconds is a
    // section that says nothing for half a minute before saying that.
    retry: false,
  });

  return (
    <section className="mt-10">
      <div className="mb-3">
        <h2 className={cn('font-mono text-[11px] uppercase tracking-[0.16em]', MUTED)}>
          Load expectation
        </h2>
        <p className={cn('mt-1 text-xs', MUTED)}>
          How this type reconciles rows deleted at the source, and how far one load may move its row
          count. Checked before a load is allowed to become the data everybody reads.
        </p>
      </div>

      {isPending && <p className={cn('font-mono text-xs', MUTED)}>Reading the expectation…</p>}

      {isError && (
        <div className={cn('rounded-lg border px-4 py-3', RULE, PANEL)}>
          <p className="text-sm">Could not read the load expectation.</p>
          <p className={cn('mt-1 text-xs', SECONDARY)}>
            It is served by the pipeline endpoints, which are the host's rather than this library's
            — this deployment may not mount them, or this account may not read them. Nothing here
            says whether a load of {displayName} would be refused.
          </p>
          {error instanceof Error && (
            <p className={cn('mt-1 font-mono text-[11px]', MUTED)}>{error.message}</p>
          )}
        </div>
      )}

      {view && <LoadExpectationBody view={view} displayName={displayName} />}
    </section>
  );
}

function LoadExpectationBody({
  view,
  displayName,
}: {
  view: ResolvedLoadExpectation;
  displayName: string;
}) {
  const deletes = view.resolved.deletes;

  return (
    <div className="space-y-4">
      {view.deletesFrom === 'none' ? (
        // The whole reason somebody opens this section. Said in words, and
        // said first: a blank strategy field is read as "not filled in yet",
        // which is exactly the wrong conclusion — the load is already refused.
        <div
          className={cn(
            'rounded-lg border border-amber-300 bg-amber-50 px-4 py-3',
            'dark:border-amber-900 dark:bg-amber-950/40',
          )}
        >
          <p className="text-sm text-amber-900 dark:text-amber-200">
            Nothing declares how {displayName} reconciles deletes, so an incremental load of it will
            be refused.
          </p>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300/80">
            A full load still commits — it replaces the whole type, so deletions reconcile by
            construction. What is blocked is the incremental path, until somebody chooses a strategy
            below and writes down why.
          </p>
        </div>
      ) : (
        <div className={cn('rounded-lg border px-4 py-3', RULE, PANEL)}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm">
              Deletes: <span className="font-mono">{deletes?.strategy}</span>
              {deletes?.strategy === 'periodic-full-reload' && (
                <span className={SECONDARY}>
                  {' '}
                  · reconciled every {describeInterval(deletes.withinMs)}
                </span>
              )}
              {deletes?.strategy === 'soft-deleted-at-source' && deletes.column && (
                <span className={SECONDARY}> · column {deletes.column}</span>
              )}
            </p>
            <SourceBadge source={view.deletesFrom} />
          </div>

          {deletes && (
            // Prose, and marked up as prose: this is a sentence somebody is
            // accountable for, not a config value. In the table below it would
            // be skimmed like one.
            <blockquote className="mt-2 border-l-2 border-sky-200 pl-4 dark:border-sky-900">
              <p className="text-sm leading-relaxed">{deletes.because}</p>
              <Attribution view={view} />
            </blockquote>
          )}
        </div>
      )}

      <ProvenanceTable view={view} />
      <ExpectationForm view={view} displayName={displayName} />
    </div>
  );
}

/**
 * Who wrote the sentence above, and when.
 *
 * Rendered from the STORED row only. A `because` that came from the host was
 * written in a commit, and naming the person the server happens to be running
 * as would attribute it to somebody who never saw it.
 */
function Attribution({ view }: { view: ResolvedLoadExpectation }) {
  const stored = view.stored;
  if (!stored) {
    return (
      <p className={cn('mt-1.5 text-[11px]', MUTED)}>
        Declared in this deployment's code. Its author is in the commit that set it, not here.
      </p>
    );
  }

  const who = stored.setByActor ? `${stored.setByActor}, through ${stored.setBy}` : stored.setBy;
  return (
    <p className={cn('mt-1.5 text-[11px]', MUTED)}>
      Set by {who} on {new Date(stored.setAt).toLocaleString()}
      {view.hostLocked.deletes && ' — and overridden since, by what the host declares in code.'}
    </p>
  );
}

function SourceBadge({ source }: { source: LoadExpectationSource }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-sm bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800',
        SECONDARY,
      )}
    >
      {source === 'host' && <Lock size={10} aria-hidden />}
      {SOURCE_LABEL[source]}
    </span>
  );
}

interface ProvenanceRow {
  id: string;
  field: string;
  value: string;
  source: LoadExpectationSource;
}

/**
 * Which layer won each field.
 *
 * Field by field rather than one badge for the whole expectation, because the
 * resolution IS field by field — a host that pinned a row-count bound and said
 * nothing about deletes leaves this type with two different answers to "may I
 * change this", and one badge would have to pick one of them and be wrong about
 * the other.
 */
function ProvenanceTable({ view }: { view: ResolvedLoadExpectation }) {
  const rows = useMemo<ProvenanceRow[]>(() => {
    const bound = view.resolved.rowCount;
    return [
      {
        id: 'deletes',
        field: 'Delete reconciliation',
        value: view.resolved.deletes?.strategy ?? 'not declared',
        source: view.deletesFrom,
      },
      {
        id: 'maxShrink',
        field: 'Max shrink',
        value:
          bound?.maxShrink === undefined
            ? 'not declared'
            : `${bound.maxShrink} of the served snapshot`,
        source: view.rowCountFrom,
      },
      {
        id: 'maxGrowth',
        field: 'Max growth',
        // "never refused" rather than a dash: absent is the documented
        // behaviour here, not a missing value somebody forgot to fill in.
        value: bound?.maxGrowth === undefined ? 'growth is never refused' : `${bound.maxGrowth}×`,
        source: view.rowCountFrom,
      },
      {
        id: 'minRows',
        field: 'Min rows for a ratio',
        value: bound?.minRows === undefined ? 'not declared' : `${bound.minRows} rows`,
        source: view.rowCountFrom,
      },
    ];
  }, [view]);

  const columns = useMemo(
    () => [
      {
        id: 'field',
        header: 'Field',
        accessorFn: (row: ProvenanceRow) => row.field,
        cell: ({ row }: { row: { original: ProvenanceRow } }) => (
          <span className="text-xs">{row.original.field}</span>
        ),
      },
      {
        id: 'value',
        header: 'In force',
        accessorFn: (row: ProvenanceRow) => row.value,
        cell: ({ row }: { row: { original: ProvenanceRow } }) => (
          <span className={cn('font-mono text-[11px]', SECONDARY)}>{row.original.value}</span>
        ),
      },
      {
        id: 'source',
        header: 'Where it came from',
        accessorFn: (row: ProvenanceRow) => row.source,
        cell: ({ row }: { row: { original: ProvenanceRow } }) => (
          <SourceBadge source={row.original.source} />
        ),
      },
    ],
    [],
  );

  return (
    <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        columnClassName={(id) => (id === 'source' ? 'w-[34%]' : 'w-[33%]')}
      />
    </div>
  );
}

/**
 * The editor.
 *
 * A locked field is shown and disabled rather than hidden, which is the rule
 * this section is built around: hiding it would leave a screen that cannot
 * explain why the type behaves the way it does, and leaving it enabled would
 * offer an edit the server answers 409 to — an edit that silently fails is the
 * one outcome worse than either.
 */
function ExpectationForm({
  view,
  displayName,
}: {
  view: ResolvedLoadExpectation;
  displayName: string;
}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: catalogQueryKeys.loadExpectation(view.typeName),
    });

  const save = useMutation({
    mutationFn: () => client.setLoadExpectation(view.typeName, bodyFrom(draft, view.hostLocked)),
    // Refetched rather than written from the answer: what belongs on screen is
    // the RESOLVED expectation, and resolving it against what the host declared
    // is the server's job. See `CatalogClient.setLoadExpectation`.
    onSuccess: invalidate,
  });

  const clear = useMutation({
    mutationFn: () => client.clearLoadExpectation(view.typeName),
    onSuccess: invalidate,
  });

  const problems = problemsWith(draft, view.hostLocked);
  const body = bodyFrom(draft, view.hostLocked);
  const nothingToSave = body.deletes === undefined && body.rowCount === undefined;
  const everythingLocked = view.hostLocked.deletes && view.hostLocked.rowCount;
  const blocked = Object.keys(problems).length > 0 || nothingToSave || everythingLocked;

  return (
    <form
      className={cn('space-y-4 rounded-lg border p-4', RULE, PANEL)}
      onSubmit={(event) => {
        event.preventDefault();
        // Checked here as well as on the button. A disabled button is a
        // statement about the pointer; a form still submits on Enter, and a
        // `because` this screen let through would be stored as an empty
        // sentence nobody can be held to.
        if (blocked || save.isPending) return;
        save.mutate();
      }}
    >
      <p className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
        Set it for {displayName}
      </p>

      <DeleteFields draft={draft} update={update} problems={problems} view={view} />
      <RowCountFields draft={draft} update={update} problems={problems} view={view} />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={blocked || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save expectation'}
        </Button>
        {view.stored && (
          <Button
            size="sm"
            variant="outline"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
          >
            {clear.isPending ? 'Clearing…' : 'Clear the stored one'}
          </Button>
        )}
        {everythingLocked && (
          <span className={cn('text-[11px]', SECONDARY)}>
            Every field here is fixed in code, so there is nothing this screen can store.
          </span>
        )}
      </div>

      {save.error && (
        <p className={cn('text-[11px]', DANGER)}>
          {save.error instanceof Error ? save.error.message : 'Could not save.'}
        </p>
      )}
      {clear.error && (
        <p className={cn('text-[11px]', DANGER)}>
          {clear.error instanceof Error ? clear.error.message : 'Could not clear it.'}
        </p>
      )}
    </form>
  );
}

/** A hint, or the reason the field is refused, in its place. */
function hintFor(problem: string | undefined, otherwise: string) {
  return problem ? <span className={DANGER}>{problem}</span> : otherwise;
}

interface FieldsProps {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  problems: Problems;
  view: ResolvedLoadExpectation;
}

/**
 * The strategy, its reason, and whichever one extra field the strategy needs.
 *
 * The extra field is rendered per strategy rather than always: an interval box
 * beside `accepted` is a field that does nothing, and a form full of those is
 * how somebody comes to believe a value they typed is in force.
 */
function DeleteFields({ draft, update, problems, view }: FieldsProps) {
  const locked = view.hostLocked.deletes;

  return (
    <>
      {locked && (
        <p className={cn('text-[11px]', SECONDARY)}>
          This deployment fixed the delete strategy in code, in its
          <span className="font-mono"> CATALOG_LOAD_EXPECTATIONS</span>. It is shown here and cannot
          be changed from this screen — a write would be refused.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Deletes"
          ariaLabel="Delete reconciliation strategy"
          value={draft.strategy}
          onValueChange={(value) => update({ strategy: toDeleteStrategy(value) })}
          options={[...DELETE_STRATEGIES]}
          placeholder="Nothing chosen — incremental loads refused"
          disabled={locked}
        />
        {draft.strategy === 'periodic-full-reload' && (
          <TextField
            label="Reconcile within (ms)"
            value={draft.withinMs}
            onChange={(withinMs) => update({ withinMs })}
            inputMode="numeric"
            placeholder="86400000"
            disabled={locked}
            hint={hintFor(
              problems.withinMs,
              'Once the newest full load is older than this, incremental loads stop committing.',
            )}
          />
        )}
        {draft.strategy === 'soft-deleted-at-source' && (
          <TextField
            label="Column (optional)"
            value={draft.column}
            onChange={(column) => update({ column })}
            placeholder="deleted_at"
            disabled={locked}
            hint="Which column the source flips. Recorded for the next reader; nothing here verifies it."
          />
        )}
      </div>

      <TextAreaField
        label="Because"
        value={draft.because}
        onChange={(because) => update({ because })}
        rows={3}
        placeholder="Why this is the right answer for this type."
        disabled={locked}
        hint={hintFor(
          problems.because,
          'Required for every strategy. It is signed with your name and shown to whoever reads this next.',
        )}
      />
    </>
  );
}

/** The three bounds. All optional, and a blank one says nothing rather than zero. */
function RowCountFields({ draft, update, problems, view }: FieldsProps) {
  const locked = view.hostLocked.rowCount;

  return (
    <>
      {locked && (
        <p className={cn('text-[11px]', SECONDARY)}>
          This deployment fixed the row-count bounds in code. They are shown here and cannot be
          changed from this screen.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Max shrink"
          value={draft.maxShrink}
          onChange={(maxShrink) => update({ maxShrink })}
          inputMode="numeric"
          placeholder="0.5"
          disabled={locked}
          hint={hintFor(problems.maxShrink, 'The most of the served snapshot one load may lose.')}
        />
        <TextField
          label="Max growth"
          value={draft.maxGrowth}
          onChange={(maxGrowth) => update({ maxGrowth })}
          inputMode="numeric"
          placeholder="blank — never refused"
          disabled={locked}
          hint={hintFor(
            problems.maxGrowth,
            'A backfill is usually a good day. Leave it blank unless it is not.',
          )}
        />
        <TextField
          label="Min rows"
          value={draft.minRows}
          onChange={(minRows) => update({ minRows })}
          inputMode="numeric"
          placeholder="100"
          disabled={locked}
          hint={hintFor(
            problems.minRows,
            'Below this, no ratio applies — a percentage of a small number is noise.',
          )}
        />
      </div>
    </>
  );
}
