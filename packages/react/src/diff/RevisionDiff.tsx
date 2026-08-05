import { CATALOG_REVISION_LIMIT } from '@dudousxd/nestjs-catalog/client';
import { parseDiffFromFile } from '@pierre/diffs';
import { MultiFileDiff } from '@pierre/diffs/react';
import { useQuery } from '@tanstack/react-query';
import { GitCompare, History } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { cn } from '../cn';
import { type CatalogRevision, catalogQueryKeys, useCatalogClient } from '../context';
import { Button } from '../ui/button';
import { codeOptions } from '../ui/code-editor';
import type { CatalogCodeLanguage } from '../ui/code-languages';
import { useCodeThemeType } from '../ui/code-theme';
import { SelectField } from '../ui/select';
import { Sheet } from '../ui/sheet';

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
  /**
   * How this side got here, and what it is allowed to claim about itself.
   *
   * `recorded` is a revision the catalog kept. `current` is the live row, which
   * can be a version ahead of everything recorded. `buffer` is what is in the
   * editor RIGHT NOW and has never been saved — see {@link Side.version}.
   */
  origin: 'recorded' | 'current' | 'buffer';
  /**
   * Null on the buffer, and that is the honest answer rather than a gap.
   *
   * `SavedQuery` carries no version counter, so unsaved SQL has no number that
   * anything else in the system would agree with. Inventing one to make the
   * three origins look alike would put a version on text that exists in one
   * browser tab. A recorded revision and the live row both have one.
   */
  version: number | null;
  body: string;
  authoredBy: string | null;
  authoredAt: string | null;
}

/** What a side is picked by. Versions are numbers and the buffer is not. */
function keyOf(side: Side): string {
  return side.origin === 'buffer' ? 'buffer' : String(side.version);
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
   * What is in the editor right now, unsaved.
   *
   * Given one, this screen answers "what have I changed since the last save" —
   * which nothing could answer before, because the sheet only ever compared
   * RECORDED revisions against each other. It sits at the top of both pickers
   * and is the default right-hand side, since the question somebody opens
   * history with while mid-edit is almost always that one.
   *
   * Folded in only when there is at least one recorded revision to compare it
   * against. On a subject with no history the empty states below are the true
   * answer, and a diff of an unsaved buffer against nothing would replace them
   * with a screen claiming every line was added.
   */
  buffer?: { body: string } | undefined;
  /**
   * The version a connector run recorded, pinned on the left.
   *
   * The whole reason the runs list is an entry point. Given one, this opens on
   * "what changed between the code that produced that load and the code that
   * would produce one now" without anybody choosing anything from a dropdown.
   */
  ranVersion?: number | undefined;
}

export function RevisionHistory({ subject, current, buffer, ranVersion }: RevisionHistoryProps) {
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

  const sides = useMemo(
    () => sidesFrom(revisions.data ?? [], current, buffer),
    [revisions.data, current, buffer],
  );

  /**
   * Which two are on screen, as SIDE KEYS rather than indices.
   *
   * `null` means "whatever the default is", so a background refetch that adds a
   * newer revision moves the right-hand side onto it — which is what somebody
   * who has not touched the selects expects. Storing an index instead would
   * silently repoint both sides at different versions when the list grew, and an
   * index is not a thing anybody chose.
   *
   * A key rather than a version number because the buffer has no version, and a
   * `number | null` state could not tell "the unsaved buffer" apart from "no
   * choice made yet".
   */
  const [leftKey, setLeftKey] = useState<string | null>(null);
  const [rightKey, setRightKey] = useState<string | null>(null);

  const right = pick(sides, rightKey) ?? sides[0];
  const left =
    pick(sides, leftKey) ??
    pick(sides, ranVersion === undefined ? null : String(ranVersion)) ??
    sides[1];

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
          value={keyOf(left)}
          onChange={setLeftKey}
        />
        <span className={cn('pb-1.5 font-mono text-[11px]', MUTED)}>→</span>
        <SidePicker
          label="Against"
          ariaLabel="Against version"
          sides={sides}
          value={keyOf(right)}
          onChange={setRightKey}
        />
      </div>

      <Authorship left={left} right={right} />
      <DiffBody
        before={left.body}
        after={right.body}
        // A saved query is always SQL. A transform is one of three languages and
        // the sheet is not told which, so it gets none rather than a guess.
        {...(subject.kind === 'saved-query' ? { language: 'sql' } : {})}
        name={subject.name}
      />
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
  buffer: { body: string } | undefined,
): Side[] {
  const sides: Side[] = revisions
    .map((revision) => ({
      origin: 'recorded' as const,
      version: revision.version,
      body: revision.body,
      authoredBy: revision.authoredBy,
      authoredAt: revision.authoredAt,
    }))
    .sort((a, b) => b.version - a.version);

  if (current && !sides.some((side) => side.version === current.version)) {
    sides.unshift({
      origin: 'current',
      version: current.version,
      body: current.body,
      authoredBy: null,
      authoredAt: null,
    });
  }

  // Only with something to compare against — see `RevisionHistoryProps.buffer`.
  if (buffer && sides.length > 0) {
    sides.unshift({
      origin: 'buffer',
      version: null,
      body: buffer.body,
      authoredBy: null,
      authoredAt: null,
    });
  }

  return sides;
}

function pick(sides: Side[], key: string | null): Side | undefined {
  if (key === null) return undefined;
  return sides.find((side) => keyOf(side) === key);
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
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <SelectField
      label={label}
      ariaLabel={ariaLabel}
      value={value}
      // No parse. The select speaks strings and so does a side key, which is
      // half the reason the key exists: the version was `Number`-ed back out of
      // this callback, and the buffer has no number to produce.
      onValueChange={onChange}
      className="min-w-[10rem]"
      options={sides.map((side) => ({
        value: keyOf(side),
        label: labelOf(side),
        hint: hintOf(side),
      }))}
    />
  );
}

/** Who wrote each side and when, which is half of what "why did this change" means. */
function Authorship({ left, right }: { left: Side; right: Side }) {
  return (
    <p className={cn('font-mono text-[10px] leading-relaxed', MUTED)}>
      {labelOf(left)} {describeAuthor(left)} → {labelOf(right)} {describeAuthor(right)}
    </p>
  );
}

/** What a side is called. The buffer is named by what it is, having no number. */
function labelOf(side: Side): string {
  return side.origin === 'buffer' ? 'Unsaved edits' : `v${side.version}`;
}

function hintOf(side: Side): string | undefined {
  if (side.origin === 'buffer') return 'in the editor, not saved';
  if (side.origin === 'current') return 'current, not yet recorded';
  return side.authoredBy ?? undefined;
}

function describeAuthor(side: Side): string {
  if (side.origin === 'buffer') return '(this browser tab)';
  if (side.origin === 'current') return '(current)';
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
 *
 * WHY THIS IS NO LONGER HAND-ROLLED
 * ---------------------------------
 * It used to be `line-diff.ts` — forty lines of LCS, a fold, and a row
 * renderer — whose docblock argued that the two strings a catalog diffs are a
 * transform's code and somebody's SQL against military logistics data, and that
 * there was no version of this screen worth a supply-chain question mark on
 * that content, so there was no dependency at all. That argument is dead, and it
 * was not this file that killed it: `@pierre/diffs` is now the EDITOR, so it
 * already sees every one of those strings on every keystroke. Keeping a second,
 * weaker differ beside it to avoid a dependency that is already there would buy
 * nothing and cost a divergence — two components disagreeing about what changed,
 * which is the one thing a diff must not do. `line-diff.ts` and its spec are
 * gone; the argument went with them rather than being left standing next to a
 * package that refutes it.
 *
 * What is lost with it: the `coarse` fallback past `DIFF_MAX_CELLS` and the
 * explicit row cap. Both were bounds on a hand-rolled algorithm. The renderer
 * here is virtualised — it draws the rows in view and no more — so the wall of
 * paint the cap existed to prevent is not reachable the same way.
 *
 * What is gained: word-level highlighting inside a changed line, which the old
 * one explicitly could not do and which is most of the value when the answer to
 * "why did Tuesday's load differ" is one renamed column.
 */
export function DiffBody({
  before,
  after,
  /**
   * What to highlight it as.
   *
   * Optional and defaulting to nothing, because this component is reached from
   * both subjects: a transform's code could be any of three languages and the
   * sheet does not carry which, while a saved query is always SQL. Left unset,
   * the name below carries no extension and the diff renders unhighlighted —
   * which is honest, and better than colouring Python as SQL.
   *
   * Narrowed to {@link CatalogCodeLanguage} rather than left as `string`,
   * because only the grammars in `ui/code-languages.ts` are in the bundle: a
   * name outside them would render exactly like the `undefined` above, and the
   * two nothings mean opposite things.
   */
  language,
  name = 'version',
}: {
  before: string;
  after: string;
  language?: CatalogCodeLanguage | undefined;
  name?: string;
}) {
  const themeType = useCodeThemeType();

  /**
   * The counts in the header, from the same parse the renderer performs.
   *
   * Recomputed here rather than read off the rendered DOM, and that is the
   * cheap half: `parseDiffFromFile` is memoised on the two bodies, and the
   * hunks carry their own `+`/`-` line counts. `identical` is "no hunks", which
   * is the only thing that means byte-for-byte equal — see this file's header
   * for the three other nothings that must not borrow that sentence.
   */
  const summary = useMemo(() => {
    const parsed = parseDiffFromFile(
      { name, contents: before, ...(language ? { lang: language } : {}) },
      { name, contents: after, ...(language ? { lang: language } : {}) },
    );
    let added = 0;
    let removed = 0;
    for (const hunk of parsed.hunks) {
      added += hunk.additionLines;
      removed += hunk.deletionLines;
    }
    return { added, removed, identical: parsed.hunks.length === 0 };
  }, [before, after, language, name]);

  return (
    <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
      <div className={cn('flex items-center gap-3 border-b px-3 py-1.5', RULE)}>
        <GitCompare size={11} className={MUTED} />
        {summary.identical ? (
          <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            These two versions are identical.
          </span>
        ) : (
          <span className="font-mono text-[10px]">
            <span className="text-emerald-600">+{summary.added}</span>{' '}
            <span className="text-red-600">−{summary.removed}</span>
          </span>
        )}
      </div>

      <MultiFileDiff
        oldFile={{ name, contents: before, ...(language ? { lang: language } : {}) }}
        newFile={{ name, contents: after, ...(language ? { lang: language } : {}) }}
        // `unified`, not `split`: this sheet is already the width it is, and a
        // side-by-side diff of code at half of it wraps every line back into the
        // shape the editor was rewritten to escape.
        options={{ ...codeOptions(themeType), diffStyle: 'unified' }}
      />
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
        {only ? <span className="font-mono"> ({labelOf(only)})</span> : null}, so there is nothing
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
