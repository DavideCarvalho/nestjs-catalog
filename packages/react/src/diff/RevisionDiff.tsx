import { CATALOG_REVISION_LIMIT } from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import { GitCompare, History } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { cn } from '../cn';
import { type CatalogRevision, catalogQueryKeys, useCatalogClient } from '../context';
import { Button } from '../ui/button';
import { SelectField } from '../ui/select';
import { Sheet } from '../ui/sheet';
import { type DiffLine, type DiffSection, diffLines, foldUnchanged } from './line-diff';

/**
 * Why a load came out different from the last one.
 *
 * THE QUESTION THIS SCREEN ANSWERS
 * --------------------------------
 * Not "show me two texts". A connector run records `transformVersion` and the
 * runs list renders it as `code v3`, so somebody looking at a surprising load
 * already has a version number in front of them — and until now that number
 * named code that existed nowhere, because `CatalogTransform.version` counts
 * saves of a row that is overwritten in place. The valuable comparison is
 * therefore the version that RAN against the version that is CURRENT, reached
 * from the run where the question occurs to somebody, and that is what
 * {@link RevisionHistory} opens on by default. The two selects are the fallback
 * for the other question, not the way in.
 *
 * WHAT IS HONEST ABOUT AN EMPTY HISTORY
 * -------------------------------------
 * Every transform and saved query that predates revisions may have one recorded
 * version or none, depending on what the store decided about backfill. Three
 * different nothings live in here and they are rendered as three different
 * things, because collapsing any pair of them tells somebody a lie about their
 * own code:
 *
 * - **Nothing recorded.** There is no history. It is NOT a claim that nothing
 *   changed — the changes happened, they were simply not kept.
 * - **One version recorded.** There is history and there is nothing before it to
 *   compare against. Also not a claim that nothing changed.
 * - **Two versions that are byte-identical.** THIS is the one that means nothing
 *   changed, and it is the only one that gets to say so.
 *
 * And a fourth, which the run entry point can produce on its own: a run naming a
 * version the recorded history does not contain. That is said out loud with the
 * number in it, because it is the difference between "the code that ran is not
 * here" and "the code that ran is the code you are looking at".
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * How many diff rows are painted before the rest go behind a control.
 *
 * The same number `QueryConsole` caps a result set at, and for the same reason:
 * past a few hundred rows a browser is painting a wall nobody reads, and the
 * screen appears frozen — which is its own kind of dishonesty about what is
 * happening. The remaining rows are one click away and the control says how many
 * there are.
 *
 * WHY THIS IS NOT `capLines`, and it is worth being precise. `capLines` in the
 * pipeline package bounds both axes — lines AND characters within a line — of
 * text on its way into a durable checkpoint and a run row, because an unbounded
 * string there makes the size of a write a property of somebody's source data.
 * Neither half of that argument reaches here. The bodies have already been
 * fetched whole, so nothing is saved by rendering fewer, and — this is the part
 * that matters — a character cap would be actively WRONG: two lines that differ
 * only past the cap would be truncated into equality and the diff would report
 * them as unchanged. A diff view must never compare anything but the whole line.
 * So long lines wrap, exactly as they do in the code editor, and the only cap is
 * on rows.
 */
const DIFF_MAX_ROWS = 500;

/** Which of the two editable things in this catalog is being compared. */
export type RevisionSubjectKind = 'transform' | 'saved-query';

export interface RevisionSubject {
  kind: RevisionSubjectKind;
  id: string;
  /** For the heading. A history sheet titled by an id helps nobody. */
  name: string;
}

/**
 * One thing that can go on either side of the comparison.
 *
 * A recorded revision, or the row as it stands right now. The second case is not
 * hypothetical: whether saving writes a revision, and whether anything was
 * backfilled, are the store's decisions, so the live row can be a version ahead
 * of everything recorded. Folding it in here — rather than pretending the newest
 * revision is what is current — is what keeps "the version that is current"
 * literally true on a deployment that has only just turned revisions on.
 */
interface Side {
  version: number;
  body: string;
  authoredBy: string | null;
  authoredAt: string | null;
  /** True for the live row, which is not (yet) in the recorded history. */
  live: boolean;
}

export interface RevisionHistoryProps {
  subject: RevisionSubject;
  /**
   * What is live right now, from the row the caller is already holding.
   *
   * Every entry point has it — the transform editor has the transform, the
   * connector card has it too, and the saved-query panel has the query — so
   * asking for it costs nobody a request, and without it this screen cannot
   * tell a history that is complete from one that stops short of the code
   * running in production.
   */
  current?: { version: number; body: string } | undefined;
  /**
   * The version a connector run recorded, pinned on the left.
   *
   * The whole reason the runs list is an entry point. Given one, this opens on
   * "what changed between the code that produced that load and the code that
   * would produce one now" without anybody choosing anything from a dropdown.
   */
  ranVersion?: number | undefined;
}

export function RevisionHistory({ subject, current, ranVersion }: RevisionHistoryProps) {
  const client = useCatalogClient();

  const revisions = useQuery({
    queryKey:
      subject.kind === 'transform'
        ? catalogQueryKeys.transformRevisions(subject.id)
        : savedQueryRevisionKey(subject.id),
    queryFn: () =>
      subject.kind === 'transform'
        ? client.listTransformRevisions(subject.id)
        : client.listSavedQueryRevisions(subject.id),
  });

  const sides = useMemo(() => sidesFrom(revisions.data ?? [], current), [revisions.data, current]);

  /**
   * Which two are on screen, as VERSION NUMBERS rather than indices.
   *
   * `null` means "whatever the default is", so a background refetch that adds a
   * newer revision moves the right-hand side onto it — which is what somebody
   * who has not touched the selects expects. Storing an index instead would
   * silently repoint both sides at different versions when the list grew, and an
   * index is not a thing anybody chose.
   */
  const [leftVersion, setLeftVersion] = useState<number | null>(null);
  const [rightVersion, setRightVersion] = useState<number | null>(null);

  const right = pick(sides, rightVersion) ?? sides[0];
  const left = pick(sides, leftVersion) ?? pick(sides, ranVersion ?? null) ?? sides[1];

  if (revisions.isPending) {
    return <Notice>Reading the history…</Notice>;
  }

  if (revisions.isError) {
    return (
      <Notice tone="bad">
        {revisions.error instanceof Error ? revisions.error.message : 'Could not read the history.'}
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={() => revisions.refetch()}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  }

  if (sides.length === 0) {
    return <NoHistory subject={subject} />;
  }

  if (sides.length === 1 || !left || !right) {
    return <OnlyOneVersion subject={subject} only={sides[0]} />;
  }

  return (
    <div className="space-y-3">
      {ranVersion !== undefined && !sides.some((side) => side.version === ranVersion) && (
        <Notice tone="warn">
          This load ran <span className="font-mono">v{ranVersion}</span>, which the recorded history
          does not contain — it predates this catalog keeping revisions, or it has been pushed out
          by the {CATALOG_REVISION_LIMIT} newer ones that are kept. Nothing below is the{' '}
          {body(subject.kind)} that produced that load.
        </Notice>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <SidePicker
          label="Compare"
          ariaLabel="Compare version"
          sides={sides}
          value={left.version}
          onChange={setLeftVersion}
        />
        <span className={cn('pb-1.5 font-mono text-[11px]', MUTED)}>→</span>
        <SidePicker
          label="Against"
          ariaLabel="Against version"
          sides={sides}
          value={right.version}
          onChange={setRightVersion}
        />
      </div>

      <Authorship left={left} right={right} />
      <DiffBody before={left.body} after={right.body} />
    </div>
  );
}

/**
 * The saved-query history key, which lives on the OTHER prefix.
 *
 * `savedQueryKeys.all` is `['catalog', 'saved-queries']` while everything in
 * `catalogQueryKeys` is under `['nestjs-catalog', …]`. That split predates this
 * screen and is not worth changing from here — what matters is that a query's
 * history sits UNDER the key its list already uses, so the invalidation the save
 * form already performs reaches the history too. Saving new SQL is exactly what
 * cuts a revision, and a history that lagged its own subject would be showing
 * yesterday's answer to today's question.
 */
function savedQueryRevisionKey(id: string) {
  return ['catalog', 'saved-queries', id, 'revisions'] as const;
}

/**
 * The recorded versions, newest first, with the live row folded in when it is
 * ahead of all of them.
 *
 * Sorted here rather than trusted from the route. The contract says newest
 * first and the bundled store will honour it; a store somebody else wrote might
 * not, and a diff screen that put v2 on the right and v7 on the left would show
 * every addition as a deletion — a comparison that is exactly backwards and
 * looks entirely plausible.
 */
function sidesFrom(
  revisions: CatalogRevision[],
  current: { version: number; body: string } | undefined,
): Side[] {
  const sides: Side[] = revisions
    .map((revision) => ({
      version: revision.version,
      body: revision.body,
      authoredBy: revision.authoredBy,
      authoredAt: revision.authoredAt,
      live: false,
    }))
    .sort((a, b) => b.version - a.version);

  if (current && !sides.some((side) => side.version === current.version)) {
    sides.unshift({
      version: current.version,
      body: current.body,
      authoredBy: null,
      authoredAt: null,
      live: true,
    });
  }

  return sides;
}

function pick(sides: Side[], version: number | null): Side | undefined {
  if (version === null) return undefined;
  return sides.find((side) => side.version === version);
}

function SidePicker({
  label,
  ariaLabel,
  sides,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  sides: Side[];
  value: number;
  onChange: (version: number) => void;
}) {
  return (
    <SelectField
      label={label}
      ariaLabel={ariaLabel}
      value={String(value)}
      // The select speaks strings and versions are numbers, so the parse happens
      // here rather than anywhere a type assertion could hide it. A value that
      // did not come from the options below cannot arrive, and if one somehow
      // did, `Number` would produce NaN, `pick` would find nothing, and the
      // default comparison would stand — rather than a blank panel.
      onValueChange={(next) => onChange(Number(next))}
      className="min-w-[10rem]"
      options={sides.map((side) => ({
        value: String(side.version),
        label: `v${side.version}`,
        hint: side.live ? 'current, not yet recorded' : (side.authoredBy ?? undefined),
      }))}
    />
  );
}

/** Who wrote each side and when, which is half of what "why did this change" means. */
function Authorship({ left, right }: { left: Side; right: Side }) {
  return (
    <p className={cn('font-mono text-[10px] leading-relaxed', MUTED)}>
      v{left.version} {describeAuthor(left)} → v{right.version} {describeAuthor(right)}
    </p>
  );
}

function describeAuthor(side: Side): string {
  if (side.live) return '(current)';
  const who = side.authoredBy ?? 'unknown';
  // The locale's own format. A console rendering an ISO string at somebody is
  // making them do arithmetic about their own timezone.
  const when = side.authoredAt ? new Date(side.authoredAt).toLocaleString() : 'unknown date';
  return `by ${who}, ${when}`;
}

/**
 * The comparison itself.
 *
 * Split out from the fetching above so it can be rendered — and tested — from
 * two plain strings, which is what the thing actually being asserted is.
 */
/**
 * One row of the rendered comparison: a line, or a collapsed run standing in for
 * several. Named rather than inferred so the fold's index — which is what the
 * expand control writes back — cannot be lost in a union the compiler widens.
 */
type DiffRowItem =
  | { kind: 'line'; line: DiffLine }
  | { kind: 'fold'; index: number; count: number };

export function DiffBody({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  const sections = useMemo(() => foldUnchanged(diff.lines), [diff.lines]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [showAllRows, setShowAllRows] = useState(false);

  const rows = useMemo(
    () =>
      sections.flatMap<DiffRowItem>((section, index) =>
        section.kind === 'shown' || expanded.has(index)
          ? section.lines.map((line) => ({ kind: 'line', line }))
          : [{ kind: 'fold', index, count: section.lines.length }],
      ),
    [sections, expanded],
  );

  const visible = showAllRows ? rows : rows.slice(0, DIFF_MAX_ROWS);
  const withheld = rows.length - visible.length;

  return (
    <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
      <div className={cn('flex items-center gap-3 border-b px-3 py-1.5', RULE)}>
        <GitCompare size={11} className={MUTED} />
        {diff.identical ? (
          // The ONLY state that gets to say nothing changed, and it earns it:
          // the two bodies are byte-for-byte the same. See this file's header
          // for the three other nothings that must not borrow this sentence.
          <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            These two versions are identical.
          </span>
        ) : (
          <span className="font-mono text-[10px]">
            <span className="text-emerald-600">+{diff.added}</span>{' '}
            <span className="text-red-600">−{diff.removed}</span>
          </span>
        )}
      </div>

      {diff.alignment === 'coarse' && (
        <p className="border-b border-amber-200 bg-amber-50/70 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-300">
          These two versions are too far apart to line up line by line, so the whole changed region
          is shown as removed and re-added. Nothing below is wrong; it is blunter than usual.
        </p>
      )}

      <div className="overflow-x-auto">
        {visible.map((row) =>
          row.kind === 'fold' ? (
            <FoldRow
              key={`fold-${row.index}`}
              count={row.count}
              onExpand={() => setExpanded((current) => new Set(current).add(row.index))}
            />
          ) : (
            <DiffRow key={rowKey(row.line)} line={row.line} />
          ),
        )}
      </div>

      {withheld > 0 && (
        <div className={cn('border-t px-3 py-2', RULE)}>
          <Button variant="outline" size="sm" onClick={() => setShowAllRows(true)}>
            Show the remaining {withheld} lines
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A stable key for a diff row, out of the numbering it already carries.
 *
 * Not the array index, which is what this looked like first. A row's pair of
 * line numbers is unique across the whole comparison and does not move when a
 * fold above it opens: two removed lines have different `before`, two added
 * lines have different `after`, and an unchanged line has both. An index key
 * would renumber every row below an expanded fold, so React would reconcile
 * hundreds of rows that did not change.
 */
function rowKey(line: DiffLine): string {
  return `${line.before ?? '-'}:${line.after ?? '-'}`;
}

/**
 * One line.
 *
 * The `+`/`−`/space gutter is not decoration and it is not a duplicate of the
 * colour: it is the only marker that survives a colourblind reader, a printout,
 * a high-contrast theme and a screen reader, all of which the background tint
 * does not. Diffs have been read this way for forty years, so it is also the
 * marker nobody has to learn.
 *
 * `whitespace-pre-wrap break-words` matches the code editor exactly, which is
 * what lets a four-hundred-character line be READ rather than truncated. See
 * `DIFF_MAX_ROWS` for why truncating a line here would make the comparison lie.
 */
function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-2 font-mono text-[11px] leading-[1.5]',
        line.op === 'added' && 'bg-emerald-50 dark:bg-emerald-950/30',
        line.op === 'removed' && 'bg-red-50 dark:bg-red-950/30',
      )}
    >
      <span className={cn('w-8 shrink-0 select-none text-right', MUTED)}>{line.before ?? ''}</span>
      <span className={cn('w-8 shrink-0 select-none text-right', MUTED)}>{line.after ?? ''}</span>
      <span
        className={cn(
          'w-3 shrink-0 select-none',
          line.op === 'added' && 'text-emerald-600',
          line.op === 'removed' && 'text-red-600',
        )}
      >
        {line.op === 'added' ? '+' : line.op === 'removed' ? '−' : ' '}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
    </div>
  );
}

/** A collapsed run of unchanged lines, and the way to see it anyway. */
function FoldRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <div className={cn('border-y bg-zinc-50/60 px-2 py-0.5 dark:bg-zinc-800/30', RULE)}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onExpand}
        className="font-mono text-[10px] font-normal"
      >
        ⋯ {count} unchanged {count === 1 ? 'line' : 'lines'}
      </Button>
    </div>
  );
}

function Notice({
  children,
  tone = 'plain',
}: {
  children: ReactNode;
  tone?: 'plain' | 'warn' | 'bad';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-[11px] leading-relaxed',
        tone === 'plain' && cn(RULE, MUTED),
        tone === 'warn' &&
          'border-amber-200 bg-amber-50/70 text-amber-800 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-300',
        tone === 'bad' &&
          'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
      )}
    >
      {children}
    </div>
  );
}

/** The word for the thing, so the empty states can be written once. */
function noun(kind: RevisionSubjectKind): string {
  return kind === 'transform' ? 'transform' : 'saved query';
}

function body(kind: RevisionSubjectKind): string {
  return kind === 'transform' ? 'code' : 'SQL';
}

/**
 * Nothing recorded — and the second sentence is the entire point of this
 * component existing separately from the one below it.
 */
function NoHistory({ subject }: { subject: RevisionSubject }) {
  return (
    <div
      className={cn('rounded-lg border border-dashed px-4 py-8 text-center text-sm', RULE, MUTED)}
    >
      <History size={16} className="mx-auto mb-2" aria-hidden />
      <p>
        No history is recorded for <span className="font-medium">{subject.name}</span>.
      </p>
      <p className="mx-auto mt-2 max-w-md text-[11px] leading-relaxed">
        That is not the same as saying nothing has changed. This {noun(subject.kind)} was last
        edited before this catalog kept revisions, so the earlier {body(subject.kind)} was
        overwritten and there is nothing left to compare against. The next save is recorded, and the{' '}
        {CATALOG_REVISION_LIMIT} most recent are kept from then on.
      </p>
    </div>
  );
}

/** One version recorded. Also not a claim that nothing changed. */
function OnlyOneVersion({ subject, only }: { subject: RevisionSubject; only: Side | undefined }) {
  return (
    <div
      className={cn('rounded-lg border border-dashed px-4 py-8 text-center text-sm', RULE, MUTED)}
    >
      <History size={16} className="mx-auto mb-2" aria-hidden />
      <p>
        One version of <span className="font-medium">{subject.name}</span> is recorded
        {only ? <span className="font-mono"> (v{only.version})</span> : null}, so there is nothing
        before it to compare against.
      </p>
      <p className="mx-auto mt-2 max-w-md text-[11px] leading-relaxed">
        Any earlier {body(subject.kind)} was overwritten before this catalog kept revisions — again,
        not a statement that it never changed. The next save gives this screen two versions to work
        with; the {CATALOG_REVISION_LIMIT} most recent are kept.
      </p>
    </div>
  );
}

export interface RevisionHistorySheetProps extends RevisionHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The history, in the panel every entry point opens it in.
 *
 * A `Sheet` rather than a route or a full-screen view, for the reason the sheet
 * was built: the screen underneath — a half-edited transform, a connector list
 * scrolled to the run somebody was reading — stays mounted, so closing this puts
 * them back exactly where the question occurred to them rather than at the top
 * of a list. `wide`, because a diff at 24rem wraps every line and stops being a
 * diff.
 */
export function RevisionHistorySheet({ open, onOpenChange, ...props }: RevisionHistorySheetProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`History · ${props.subject.name}`}
      width="wide"
      description={
        props.ranVersion === undefined
          ? 'Every version saved, newest first.'
          : `What changed between the ${body(props.subject.kind)} that ran and what would run now.`
      }
    >
      {/* Rendered only while open. The history is a request, and a sheet that
          fetched on mount would ask for the history of every transform in a list
          the moment the list rendered. */}
      {open && <RevisionHistory {...props} />}
    </Sheet>
  );
}

/**
 * The control that opens it, so the three entry points cannot drift into three
 * different affordances for one thing.
 */
export function RevisionHistoryButton({
  label = 'History',
  onClick,
  className,
}: {
  label?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} className={className}>
      <History size={12} />
      {label}
    </Button>
  );
}

export type { DiffLine, DiffSection };
