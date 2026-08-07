/**
 * Taking an edit back, throwing the whole draft away, and not losing it by
 * accident.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Everything here is about the same one thing — the gap between what is on the
 * canvas and what the server has — and none of it is about drawing a graph.
 * `WorkflowCanvas.tsx` is already six thousand lines and is the file every
 * feature wants to grow, so the rule that keeps it readable is that a concern
 * with its own vocabulary gets its own module. This one has four words in it:
 * an ACTION (the unit undo steps over), the PAST (the actions still takeable
 * back), the BASELINE (the graph as the server last described it) and DIRTY
 * (whether those two differ).
 *
 * WHAT THIS DOES NOT COVER, AND SAYS SO ON SCREEN
 * ----------------------------------------------
 * Undo is about the DRAFT and nothing else. Saving, publishing, running and
 * deleting the workflow are requests the server has already answered; a control
 * that appeared to unmake one of them would be promising something no client
 * can deliver. The boundary is stated in {@link UNDO_SCOPE}, which is rendered —
 * as a tooltip for a pointer and as text for a screen reader — rather than left
 * in this comment, because a boundary somebody has to read the source to learn
 * is not a boundary they will learn.
 *
 * WHY SNAPSHOTS RATHER THAN INVERSE COMMANDS
 * ------------------------------------------
 * The alternative is an undo stack of operations that know how to reverse
 * themselves. That is smaller in memory and considerably more code, and every
 * new gesture on the canvas is a new inverse that can be written wrongly — a
 * wrong inverse is silent, and lands in a SAVED graph. A snapshot cannot be
 * wrong about what the graph was. The cost is bounded by {@link UNDO_DEPTH} and
 * by the fact that a snapshot holds the same node and edge ARRAYS the draft
 * already held: this canvas replaces arrays rather than mutating them (see the
 * copy note in `draftFrom`), so an entry costs four references, not a graph.
 */

import { RotateCcw, Undo2 } from 'lucide-react';
import { useEffect } from 'react';
import { cn } from '../cn';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Tooltip } from '../ui/tooltip';
import type { WorkflowEdge, WorkflowNode } from './model';
import { nodeName } from './model';
import { WORKFLOW_NAME } from './name';

/**
 * How many actions can be taken back.
 *
 * A cap rather than an unbounded stack, and 50 rather than 500, because the
 * promise a history makes should be one it can keep at any graph size. Fifty
 * snapshots of a hundred-node graph is fifty times four references — nothing —
 * but the honesty matters more than the arithmetic: an unbounded stack grows
 * with how long somebody has had the tab open, which is exactly the session
 * where they can least afford the tab to get slow.
 *
 * At the limit the OLDEST entry is dropped, so undo always steps back from
 * where the person is rather than refusing. What is lost is the ability to walk
 * all the way to the beginning — and that is what Reset is for, which is why the
 * two controls sit beside each other and why {@link resetDescription} says how
 * many actions are about to go.
 */
export const UNDO_DEPTH = 50;

/**
 * How long a run of edits stays open, when nothing else closes it.
 *
 * The fallback half of the granularity rule. A gesture with a real end — a drag
 * — says so through `continuing` and ignores this entirely; a gesture without
 * one — typing into a field, holding an arrow key — has only elapsed time to go
 * on. 700ms is longer than a fast typist's inter-key gap and shorter than the
 * pause somebody makes when they stop to think, which is the boundary between
 * "still writing the name" and "wrote the name, then did something else".
 */
export const RUN_WINDOW_MS = 700;

/** What undo can and cannot reach, in the words the controls use. */
export const UNDO_SCOPE = `Undo steps back through your edits to this drawing, one action at a time — up to the last ${UNDO_DEPTH}. It does not touch anything the server has already done: saving, publishing, running and deleting the ${WORKFLOW_NAME.singular} are not undone here.`;

/** Said once, when somebody reaches for a redo that deliberately does not exist. */
export const NO_REDO =
  'There is no redo on this canvas. Undo only steps backwards; Reset returns the whole drawing to the last saved version.';

/**
 * The part of a draft an edit can change.
 *
 * Deliberately not the whole draft: `id` and `version` are the server's answers
 * about which stored graph this is, and an undo that could change them would be
 * an undo that quietly retargets the next save.
 */
export interface DraftSnapshot {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** One takeable-back action: what the draft was before it, and what to call it. */
export interface HistoryEntry {
  before: DraftSnapshot;
  /**
   * A past-tense phrase, announced as `Undone: {label}.`
   *
   * Written from the CALLER's vocabulary rather than from the diff, because a
   * label derived from what changed says "two edges removed" where the person
   * pressed "delete Out" — and the whole job of this string is to be recognised
   * by somebody who cannot see what moved.
   */
  label: string;
  /** Consecutive edits sharing a run key fold into this one entry. */
  run?: string;
  at: number;
}

/**
 * What an edit says about itself.
 *
 * Every call site passes one. There is no default, on purpose: an unlabelled
 * entry is an undo that announces nothing, and the moment a default exists it is
 * what new call sites get.
 */
export interface EditAction {
  label: string;
  /**
   * Names the gesture, when this edit is one frame of a longer one. Two edits
   * fold together only when their keys match, so dragging node A and then node B
   * are always two entries even back to back.
   */
  run?: string;
  /**
   * Set while the gesture is demonstrably still happening — a pointer still
   * down. Folds into the open run however long it has been going, which is what
   * keeps a slow drag with a pause in the middle one action rather than two.
   */
  continuing?: boolean;
}

/**
 * The draft fields this module owns.
 *
 * Structural rather than an import of `Draft`, which lives in `WorkflowCanvas`
 * and would make this a cycle. The canvas's `Draft` extends it, so the two
 * cannot drift without the compiler saying so.
 */
export interface HistoricDraft extends DraftSnapshot {
  dirty: boolean;
  /** Oldest first. The last entry is the next undo. */
  past: HistoryEntry[];
  /**
   * The graph as the server last described it: the load, or the most recent
   * save in this session.
   *
   * This is what makes Reset different from undoing to the beginning. Save
   * halfway through a session and the baseline MOVES to that save — so Reset
   * afterwards returns to the saved v2, not to the v1 the tab was opened on.
   * Undoing forty times would walk past that save and back to v1, which is a
   * different and much more surprising thing to hand somebody who asked to throw
   * away their unsaved work.
   */
  baseline: DraftSnapshot;
}

export function snapshotOf(draft: DraftSnapshot): DraftSnapshot {
  return {
    name: draft.name,
    description: draft.description,
    nodes: draft.nodes,
    edges: draft.edges,
  };
}

/**
 * Whether two snapshots are the same graph.
 *
 * Reference identity on the arrays, and that is the point rather than a
 * shortcut. Nothing on this canvas mutates a node or an edge array in place —
 * every path replaces — so two identical references ARE the same graph, and the
 * comparison cannot report "unchanged" for a graph that has changed. It can
 * report "changed" for a graph that has been edited back to where it started
 * through two different arrays, and that asymmetry is the safe one: the only
 * consequence is a save button that stays live and a leave-warning that still
 * fires, which is a nuisance. The opposite error loses work.
 *
 * Undo restores the very arrays it recorded, so walking all the way back to the
 * baseline compares equal and the draft goes genuinely clean — which is what
 * makes the beforeunload guard below trustworthy enough to be worth having.
 */
export function sameSnapshot(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.nodes === b.nodes &&
    a.edges === b.edges
  );
}

/**
 * An edit, recorded.
 *
 * Pure, and it has to be: this runs inside a `setState` updater, which React is
 * free to call twice for the same input. Nothing here reads or writes anything
 * outside its arguments except the clock, and the clock only moves a timestamp
 * that two calls a microsecond apart agree about anyway.
 */
export function withEdit<T extends HistoricDraft>(before: T, after: T, action: EditAction): T {
  return { ...after, dirty: true, past: pushed(before, action) };
}

function pushed(before: HistoricDraft, action: EditAction): HistoryEntry[] {
  const past = before.past;
  const top = past.at(-1);
  const now = Date.now();

  if (top && action.run !== undefined && top.run === action.run) {
    const open = action.continuing === true || now - top.at <= RUN_WINDOW_MS;
    // The entry already holds the state from before the gesture began, so
    // folding into it is simply not pushing. Its clock moves so the run stays
    // open for as long as the gesture keeps producing frames.
    if (open) return [...past.slice(0, -1), { ...top, at: now }];
  }

  const next = [
    ...past,
    { before: snapshotOf(before), label: action.label, run: action.run, at: now },
  ];
  // Drop from the front, never refuse at the back: a person who has made
  // fifty-one edits wants the fifty-first taken back, not a message about a
  // limit.
  return next.length > UNDO_DEPTH ? next.slice(next.length - UNDO_DEPTH) : next;
}

/** The next thing undo would take back, for a control that has to name it. */
export function nextUndo(draft: HistoricDraft): HistoryEntry | undefined {
  return draft.past.at(-1);
}

/**
 * One action back.
 *
 * Returns the label as well as the draft because the announcement is half the
 * feature: undo can revert something that is scrolled off the canvas, and a
 * silent revert of an invisible thing is indistinguishable from nothing
 * happening.
 */
export function undone<T extends HistoricDraft>(draft: T): { draft: T; label: string } | null {
  const top = nextUndo(draft);
  if (!top) return null;
  const past = draft.past.slice(0, -1);
  const restored = { ...draft, ...top.before, past };
  return {
    draft: { ...restored, dirty: !sameSnapshot(top.before, draft.baseline) },
    label: top.label,
  };
}

/**
 * All the way back to the last saved version.
 *
 * The history goes with it. Keeping it would offer to undo the reset, which is
 * a redo of everything by another name — and this module does not have one.
 */
export function reverted<T extends HistoricDraft>(draft: T): T {
  return { ...draft, ...draft.baseline, past: [], dirty: false };
}

/** The ids still in the graph, for the per-node bookkeeping the canvas keeps. */
export function keepKnown(ids: ReadonlySet<string>, nodes: WorkflowNode[]): ReadonlySet<string> {
  const alive = new Set(nodes.map((node) => node.id));
  const kept = [...ids].filter((id) => alive.has(id));
  return kept.length === ids.size ? ids : new Set(kept);
}

/** How many nodes, named where naming them is short enough to be useful. */
export function namesOf(nodes: WorkflowNode[], ids: Iterable<string>): string {
  const found = [...ids].map((id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node ? `"${nodeName(node)}"` : id;
  });
  if (found.length === 0) return 'nothing';
  if (found.length === 1) return found[0];
  if (found.length === 2) return `${found[0]} and ${found[1]}`;
  return `${found.length} nodes`;
}

/**
 * One edit to a node, described by which of its fields moved.
 *
 * The run key carries the CHANGED FIELDS, not just the node, and that is the
 * difference between a useful granularity and an irritating one: typing into a
 * name box folds into one action, but typing a name and then flipping a switch
 * on the same node a moment later stays two — because the second edit touches a
 * different field and so opens a new run. Without the field in the key those two
 * would merge, and undoing the switch would silently retype the name.
 *
 * The fields are read through `Object.entries` rather than by name: a node is a
 * union of six shapes with different fields each, and a hand-written list here
 * would go quietly out of date the next time a node kind gains one — which
 * shows up as an edit that mysteriously will not undo on its own.
 */
export function nodeEditAction(before: WorkflowNode | undefined, after: WorkflowNode): EditAction {
  const label = `editing "${nodeName(before ?? after)}"`;
  if (!before) return { label };
  const was = new Map<string, unknown>(Object.entries(before));
  const now = new Map<string, unknown>(Object.entries(after));
  const fields = [...new Set([...was.keys(), ...now.keys()])]
    .filter((field) => !Object.is(was.get(field), now.get(field)))
    .sort();
  return { label, run: `node:${after.id}:${fields.join(',')}` };
}

/** What Reset is about to do, in the numbers the person can check it against. */
export function resetDescription(draft: HistoricDraft): string {
  const count = draft.past.length;
  const actions =
    count === 0
      ? 'Everything unsaved'
      : count >= UNDO_DEPTH
        ? `At least ${count} actions`
        : `${count} ${count === 1 ? 'action' : 'actions'}`;
  return `${actions} will be thrown away and the drawing goes back to the version the server last stored. This cannot be undone — Undo only steps back through edits, and Reset clears them. Nothing the server holds is touched: no run is stopped, nothing is unpublished, and the stored ${WORKFLOW_NAME.singular} stays exactly as it is.`;
}

/**
 * A tab that will not close on unsaved work without asking.
 *
 * Registered only while there IS unsaved work, which is the whole design
 * constraint: a page that always warns teaches people to dismiss the dialog
 * without reading it, and then it is not a guard, it is a habit. Cleaning up on
 * `dirty` going false is what makes a save silence it immediately.
 *
 * The wording belongs to the browser — every engine ignores whatever string a
 * page supplies here, and has for a decade — so this asks for the dialog and
 * says nothing. `returnValue` is set as well as `preventDefault` because Chrome
 * and Safari have historically disagreed about which one arms it.
 *
 * Nothing happens on a server: `useEffect` does not run there, so a host
 * rendering this canvas into HTML sees no `window`.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

/**
 * Whether a key press belongs to something being typed into.
 *
 * The reason Cmd/Ctrl+Z can be bound at all. This canvas contains a name field,
 * a description box, several config fields and a real code editor, and in every
 * one of them Cmd+Z means "undo my typing" — a canvas-level binding that fired
 * there would silently discard a graph edit instead, which is the worst possible
 * outcome for a control whose entire job is not losing work.
 *
 * `closest` rather than the target itself: a contenteditable code surface puts
 * the caret on a descendant span, so the event target is not the editable host.
 * The dialog and sheet cases are the same argument one level up — a modal over
 * the canvas is a different document with its own undo, and the canvas has no
 * business acting on keys pressed inside it.
 *
 * Narrowed with `instanceof` rather than asserted: `event.target` is typed
 * `EventTarget | null` and genuinely can be a `Window` or a text node.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
    ) !== null || target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null
  );
}

/**
 * Cmd/Ctrl+Z, on the canvas and nowhere else.
 *
 * Shift+Cmd/Ctrl+Z is caught deliberately rather than left to the browser: the
 * hands that reach for it are expecting a redo, and silence would read as a
 * broken shortcut. It says there is none, once, in the same live region
 * everything else on this canvas speaks through.
 *
 * On `window` rather than on the canvas element because the canvas is not
 * reliably focused — somebody who has just clicked a toolbar button, or closed
 * the inspector, has focus on chrome — and a shortcut that only works when the
 * right thing happens to be focused is a shortcut people stop trusting.
 */
export function useUndoShortcut({
  enabled,
  onUndo,
  onSay,
}: {
  enabled: boolean;
  onUndo: () => void;
  onSay: (message: string) => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'z') return;
      if (isTypingTarget(event.target)) return;
      // Only once the press is definitely ours: preventing the default before
      // the typing check would swallow the browser's own undo in a field.
      event.preventDefault();
      if (event.shiftKey) {
        onSay(NO_REDO);
        return;
      }
      onUndo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, onUndo, onSay]);
}

/**
 * Undo, Reset, and the fact that there is unsaved work — as one cluster.
 *
 * Together because they are one subject and answer each other: the chip says
 * something is at risk, Undo takes back the last thing, Reset gives up on all of
 * it. Split across the screen they would be three unrelated controls, and the
 * chip in particular means nothing without something to do about it.
 *
 * The unsaved chip is `role="status"`, so it is announced when it appears rather
 * than only when somebody goes looking. It appears once per clean→dirty
 * transition, because its text does not change while dirty — a status that
 * re-announced on every keystroke would be unusable.
 */
export function HistoryControls({
  draft,
  canEdit,
  reducedMotion,
  resetting,
  onResettingChange,
  onUndo,
  onReset,
}: {
  draft: HistoricDraft;
  canEdit: boolean;
  /** No pulse for somebody who has asked their machine to stop moving things. */
  reducedMotion: boolean;
  resetting: boolean;
  onResettingChange: (open: boolean) => void;
  onUndo: () => void;
  onReset: () => void;
}) {
  const top = nextUndo(draft);
  const depth = draft.past.length;

  return (
    <>
      <Tooltip
        content={
          top
            ? `Take back: ${top.label}. ${UNDO_SCOPE} ${depth === 1 ? 'This is the last one.' : `${depth} to go.`} Keyboard: Ctrl+Z, or ⌘Z.`
            : `Nothing to take back yet. ${UNDO_SCOPE}`
        }
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndo}
          disabled={!canEdit || !top}
          // Named with the action it would take back, because "Undo" alone tells
          // somebody who cannot see the canvas nothing about what is about to
          // change — and what is about to change may be off screen.
          aria-label={top ? `Undo: ${top.label}` : 'Undo — nothing to take back yet'}
        >
          <Undo2 size={12} />
          <span className="hidden md:inline">Undo</span>
        </Button>
      </Tooltip>

      <Tooltip content="Throw away every unsaved edit and go back to the version the server last stored. Not the same as undoing repeatedly: if you saved partway through, this returns to THAT save, not to where you started.">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onResettingChange(true)}
          disabled={!canEdit || !draft.dirty}
          aria-label="Reset to the last saved version, discarding every unsaved edit"
          // Coloured like the delete control beside it, and for the same reason:
          // this destroys work, and a control that destroys work should look
          // like one before it is pressed rather than after.
          className="text-zinc-400 hover:text-red-600"
        >
          <RotateCcw size={12} />
          <span className="hidden md:inline">Reset</span>
        </Button>
      </Tooltip>

      {/*
       * `<output>` rather than a `<span role="status">`: it carries the status
       * role natively, and this package already uses one for the canvas's
       * announcements — two spellings of the same thing on one screen is how a
       * live region ends up announced twice on one machine and not at all on
       * another.
       */}
      {draft.dirty && (
        <output className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500',
              // A quiet pulse, because the whole job of this dot is to be
              // noticed in peripheral vision — and nothing at all for somebody
              // who has asked their machine to stop moving things.
              !reducedMotion && 'animate-pulse',
            )}
          />
          Unsaved
        </output>
      )}

      {/*
       * The boundary, in the accessible tree rather than only in a tooltip.
       * Tooltips are a pointer affordance and are announced unevenly; this is
       * the one sentence somebody has to have read before they trust a control
       * called Undo on a screen with a Publish button on it.
       */}
      <p className="sr-only">{UNDO_SCOPE}</p>

      <ConfirmDialog
        open={resetting}
        onOpenChange={onResettingChange}
        title="Discard every unsaved edit?"
        description={resetDescription(draft)}
        confirmLabel="Discard and reset"
        onConfirm={onReset}
      />
    </>
  );
}
