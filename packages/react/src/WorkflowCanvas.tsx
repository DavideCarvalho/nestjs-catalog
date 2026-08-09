import type {
  CatalogConnection,
  CatalogTransform,
  ConnectorKind,
  TransformLanguage,
} from '@dudousxd/nestjs-catalog/client';
import {
  Background,
  BackgroundVariant,
  type Connection,
  ConnectionLineType,
  Controls,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  NodeToolbar,
  type OnConnectEnd,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
// React Flow ships its own stylesheet and renders as an unstyled pile of divs
// without it — no edges, every node at the top-left corner. Imported by the
// component that needs it rather than left to the host, because a missing
// stylesheet does not error and the host that forgets has nothing to go on.
// See src/styles.d.ts for why `tsc` tolerates this import.
import '@xyflow/react/dist/style.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Code2,
  Combine,
  Database,
  ExternalLink,
  Filter,
  GitBranch,
  Info,
  LayoutGrid,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRight,
  Play,
  Plug,
  Plus,
  Repeat,
  Save,
  Sigma,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  Unplug,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connectionOptionsFor } from './ConnectionPanel';
import { TransformEditor } from './TransformEditor';
import { cn } from './cn';
import { type WorkflowRunOptions, catalogQueryKeys, useCatalogClient } from './context';
import {
  type ConnectorSchemaDiscovery,
  type DiscoveredTypeDraft,
  type SchemaDiscoveryBridge,
  SchemaDiscoveryPanel,
  narrowDiscovery,
} from './schema-discovery';
import { SourceConnectionCreator } from './source-connection';
import {
  INLINE_CONNECTION,
  KIND_OPTIONS,
  ReadModeFields,
  type SourceDraft,
  SourceFields,
  readsIncrementally,
  sourceConfigFrom,
  sourceDraftFrom,
  toConnectorKind,
  usesConnection,
} from './source-fields';
import { Button } from './ui/button';
import { type ComboOption, ComboboxField } from './ui/combobox';
import { ConfirmDialog } from './ui/dialog';
import { FieldGroup, TextAreaField, TextField } from './ui/field';
import { Select, SelectField, type SelectOption } from './ui/select';
import { Sheet } from './ui/sheet';
import { Switch } from './ui/switch';
import { Tooltip, TooltipProvider } from './ui/tooltip';
import {
  type CanvasMenuActions,
  type CanvasMenuContext,
  type CanvasMenuSection,
  type CanvasMenuTarget,
  buildCanvasMenu,
  deleteCost,
} from './workflow/canvas-menu';
import {
  graphWithNodeBetween,
  newEdge,
  newKindsFrom,
  newNodeOfKind,
  nodeBetween,
  uniqueName,
} from './workflow/create';
import { WorkflowEdgeProvider, workflowEdgeTypes } from './workflow/edges';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type NodeDescriptions,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
  defaultLabel,
  describeFilterPredicate,
  flowingEdgeIds,
  layout,
  layoutIfUnarranged,
  nextPosition,
  toFlowEdges,
  toFlowNodes,
} from './workflow/graph';
import {
  type EditAction,
  type HistoricDraft,
  HistoryControls,
  keepKnown,
  namesOf,
  nodeEditAction,
  reverted,
  snapshotOf,
  undone,
  useUndoShortcut,
  useUnsavedGuard,
  withEdit,
} from './workflow/history';
import {
  PublishControls,
  RunControls,
  SchedulePanel,
  ShrinkRefusalNote,
  WorkflowStatusBadge,
} from './workflow/lifecycle';
import { CanvasContextMenu, type MenuAnchorRect, NodeActionsToolbar } from './workflow/menu';
import {
  type CallableWorkflowBlock,
  type CallableWorkflowRef,
  type CatalogWorkflow,
  type StorageAvailability,
  WORKFLOW_AGGREGATE_FUNCTIONS,
  WORKFLOW_AGGREGATE_MAX_AGGREGATES,
  WORKFLOW_AGGREGATE_MAX_GROUP_BY,
  WORKFLOW_BRANCH_LABELS,
  WORKFLOW_CALL_MODES,
  WORKFLOW_FILTER_MAX_DEPTH,
  WORKFLOW_FILTER_MAX_VALUES,
  WORKFLOW_FILTER_OPERATORS,
  WORKFLOW_LOOKUP_MAX_FIELDS,
  WORKFLOW_LOOKUP_MAX_REFERENCE_ROWS,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_RENAME_MAX_COLUMNS,
  type WorkflowAggregate,
  type WorkflowAggregateFunction,
  type WorkflowAggregateNode,
  type WorkflowBranchLabel,
  type WorkflowCallMode,
  type WorkflowCallNode,
  type WorkflowEdge,
  type WorkflowEnvPredicate,
  type WorkflowFilterNode,
  type WorkflowFilterOperator,
  type WorkflowFilterPredicate,
  type WorkflowFilterPredicateKind,
  type WorkflowFilterValue,
  type WorkflowGraph,
  type WorkflowIfNode,
  type WorkflowIfPredicate,
  type WorkflowLookupNode,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowPredicateKind,
  type WorkflowRenameNode,
  type WorkflowRowCountPredicate,
  type WorkflowRun,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  aggregateRefusals,
  callableWorkflowBlock,
  describeDurability,
  isWorkflowAggregateFunction,
  isWorkflowBranchLabel,
  isWorkflowFilterOperator,
  isWorkflowFilterPredicateKind,
  isWorkflowLookupUnmatched,
  isWorkflowNodeKind,
  isWorkflowPredicateKind,
  isWorkflowRenameUnnamed,
  lookupConfigRefusals,
  newLocalId,
  nodeName,
  producedTypes,
  renameColumnRefusals,
  unreachableFilterOperator,
  unreachableFilterPredicateKind,
  unreachableNodeKind,
  unreachablePredicateKind,
  workflowAggregateMaxGroups,
  workflowAggregateNeedsColumn,
  workflowAggregateOutputColumns,
  workflowCallMode,
  workflowKnownColumns,
  workflowLookupColumns,
  workflowLookupUnmatched,
  workflowNarrowedTypes,
  workflowRenameUnnamed,
} from './workflow/model';
import { WORKFLOW_NAME } from './workflow/name';
import { WorkflowNodeProvider, workflowNodeTypes } from './workflow/nodes';
import { freeSpot, placeNextTo } from './workflow/place';
import { removeNodes, wiresOn } from './workflow/removal';
import { RunsAsPanel } from './workflow/runs';
import type { ShapeKnowledge, SourceShape } from './workflow/shape';
import {
  type WorkflowProblem,
  type WorkflowProblemCode,
  canConnect,
  edgeId,
  hasBlockingProblem,
  problemsByNode,
  validateWorkflow,
} from './workflow/validate';
import {
  PendingWireLine,
  WiringHint,
  type WorkflowWiring,
  useClickWiring,
} from './workflow/wiring';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';
/**
 * A card INSIDE a floating panel.
 *
 * Deliberately not {@link PANEL}. An opaque white card on a translucent panel
 * cancels the blur it is sitting on and the rail stops reading as one surface —
 * it becomes four white boxes with a frosted gap between them.
 */
const SUBPANEL = 'bg-zinc-50/60 dark:bg-zinc-950/40';

/**
 * What a thing floating ON the canvas looks like.
 *
 * Translucent with a blur rather than opaque, and that is the whole point of the
 * layout this belongs to: a panel that blanks out what is behind it turns the
 * canvas back into a box with a border, only now the box is a worse shape. The
 * graph stays perceptible through the chrome, so the surface reads as continuous
 * and the panels read as sitting on it.
 */
const FLOATING = cn(
  'rounded-xl border shadow-lg shadow-zinc-950/5 dark:shadow-zinc-950/40',
  'border-zinc-200/80 bg-white/85 backdrop-blur-md',
  'dark:border-zinc-800/80 dark:bg-zinc-900/85',
);

/**
 * How much of the canvas the floating chrome covers, per edge, in CSS pixels.
 *
 * ONE definition, read by two things that would otherwise drift: the Tailwind
 * insets the chrome is positioned with, and the per-side `fitView` padding the
 * graph is fitted into. That second use is what makes a full-bleed canvas
 * honest — React Flow fits the graph to the *viewport*, so without this it
 * would happily centre a node underneath the action cluster and leave somebody
 * dragging a box out from under a panel to read it.
 *
 * Deliberately generous rather than measured. Measuring the real panels every
 * frame would be a ResizeObserver feeding a value into a fit that then moves
 * the panels' backdrop, and the loop that produces is worse than 20px of slack.
 */
const CHROME = {
  top: 150,
  bottom: 90,
  side: 28,
  /** The rail's width plus its gutter, when it is open. */
  rail: 336,
  /**
   * The top inset once the workflow card is collapsed to its head.
   *
   * The card is the tallest thing on this screen and the only one focus mode
   * changes the height of, so it is the only inset that moves with the mode.
   * The dock is still at the bottom and the actions are untouched, so those two
   * keep their numbers.
   */
  topFocused: 76,
};

/**
 * Per-side `fitView` padding, in the units React Flow accepts.
 *
 * Spelled as a template-literal type rather than `string` so that a value built
 * here has to be a length React Flow can parse. `string` would typecheck and
 * then be ignored at runtime, which is the failure mode this shape exists to
 * make impossible.
 */
type PaddingPx = `${number}px`;
interface FitPadding {
  top: PaddingPx;
  right: PaddingPx;
  bottom: PaddingPx;
  left: PaddingPx;
}

/**
 * {@link CHROME} as the padding `fitView` wants.
 *
 * Two sides move, and only two: the right, because the rail comes and goes, and
 * the top, because focus mode collapses the card to its head. The whole reason
 * this function exists is that a fit which ignored either would put a node under
 * a panel — so a mode that makes the chrome smaller has to say so here, or the
 * canvas it just bought would go unused.
 */
function chromeFitPadding(railOpen: boolean, cardCollapsed: boolean): FitPadding {
  return {
    top: `${cardCollapsed ? CHROME.topFocused : CHROME.top}px`,
    bottom: `${CHROME.bottom}px`,
    left: `${CHROME.side}px`,
    right: `${railOpen ? CHROME.rail : CHROME.side}px`,
  };
}

/**
 * Whether the details rail starts on screen.
 *
 * Read once, from the width at mount, rather than subscribed to. A live media
 * query would reopen a panel somebody had just closed because they turned their
 * tablet, which is worse than the panel being open on a narrow screen they can
 * shut it on.
 *
 * `typeof window` guards server rendering, where there is no width to ask about
 * and a bare `window` is a crash rather than a layout bug. Open is the right
 * answer there: it is what hydrates into on a desktop, and a panel that appears
 * after hydration is a worse first paint than one that was always there.
 */
function railOpenByWidth(): boolean {
  return typeof window === 'undefined' ? true : window.innerWidth >= 1024;
}

/**
 * Whether this is a pointer that can hover at all.
 *
 * The whole shrink-and-expand idea below is built on hover, and hover is not a
 * thing every pointer has. On a touch screen there is no state between "not
 * touching" and "touching": the first contact with a pannable minimap IS a pan,
 * so a map that expanded on touch would turn a navigation gesture into a resize
 * gesture and move the viewport while doing it. There is no version of
 * hover-to-expand that works there, so the honest answer is not to shrink at
 * all — a finger gets the map exactly as it is today.
 *
 * `pointer: fine` as well as `hover: hover`, because the pair is what excludes a
 * TV remote and a Wii-style pointer: those report `hover: hover` with a coarse
 * pointer, and a 96px target you have to wave at is worse than a 200px one.
 *
 * Every failure answers `false` — no window, no `matchMedia` (jsdom does not
 * implement it), or a throw. `false` means "do not shrink", which is the answer
 * that takes nothing away, and that is the same rule
 * {@link focusModeAtMount} follows for the same reason.
 */
const HOVER_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

function hoverCapablePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(HOVER_POINTER_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * How much of its size the overview keeps while focus mode has the screen.
 *
 * React Flow's minimap is 200×150, and 0.48 of that is 96×72 — whole pixels on
 * both axes, which a rounder-looking 0.5 would also give but 0.45 would not. A
 * fractional height puts the mask's bottom edge on a half-pixel and the
 * viewport box picks up a grey seam that reads as a border it does not have.
 *
 * WHAT SURVIVES AT THIS SIZE, which is the only question that matters — a
 * shrunk minimap that reads as decoration has taken the navigation aid away and
 * kept the pixels. At 96×72 the map still carries the one thing it is for: WHERE
 * THE VIEWPORT IS IN THE GRAPH. That is drawn as a hole in a tinted mask, so it
 * is an area rather than a detail, and area survives scaling — the box keeps its
 * position and its proportion of the whole, which is the entire "am I looking at
 * the middle of this graph or the far edge" question. The node dots keep their
 * kind colours (see {@link miniMapColor}), so a cluster and a lone box on the
 * other side of the graph are still two different pictures.
 *
 * WHAT IS SACRIFICED: reading an individual node's position precisely, and any
 * hope of telling two adjacent nodes apart. Both are recovered by hovering, and
 * neither was ever a gesture here — no `onNodeClick` is passed to the minimap,
 * so a dot has never been a target.
 *
 * A single scale rather than a smaller `style={{ width, height }}`, and that is
 * NOT a shortcut — see {@link FocusMiniMap} for why it is the only version of
 * this that cannot make a drag jump under the finger.
 *
 * SPELLED AS A LITERAL CLASS, and it has to be. This package ships as compiled
 * JS and the console's stylesheet points Tailwind at `dist/**\/*.js` to find the
 * classes in it. Tailwind emits only what it can SEE in that text, so a class
 * built as `scale-[${scale}]` survives compilation as an un-evaluated template
 * and the rule is never generated — no error, no warning, and a focus mode
 * whose minimap simply never shrinks. Hence one string, and the arithmetic in
 * this comment rather than in the code: 200×150 × 0.48 = 96×72.
 */
const MINIMAP_FOCUSED_CLASS = 'scale-[0.48]';

/* ---------------------------------------------------------------------------
 * Focus mode.
 * ------------------------------------------------------------------------- */

/**
 * The key focus mode is remembered under, and — deliberately — `sessionStorage`.
 *
 * ## Why it is remembered at all
 *
 * A mode somebody has to re-enter after every reload is a mode nobody uses. The
 * person this exists for is the one drawing a forty-node graph, and that person
 * reloads: a deploy lands, a query is retried, a tab is restored. Losing the
 * layout each time makes the gesture a novelty.
 *
 * ## Why it is not `localStorage`
 *
 * This mode HIDES things — the workflow picker, the name field, the description.
 * A preference that hides controls and is restored silently a week later is
 * somebody opening the console, finding a screen with fewer controls than they
 * remember, and having no way to connect that to a keypress from last Tuesday.
 * That is the exact confusion a persisted hiding-mode causes, and it is worse
 * than re-pressing a key.
 *
 * `sessionStorage` is the honest middle: the mode lives exactly as long as the
 * TAB that chose it. A reload keeps it, because a reload is the same working
 * session and is usually not even deliberate. A new tab, or tomorrow, starts
 * with the chrome present. Nobody inherits a hidden control from a decision they
 * cannot remember making.
 *
 * It is per-tab rather than per-workflow on purpose: focus is a statement about
 * how somebody wants to WORK, not about a particular graph, and re-entering it
 * on every switch of the picker would make it feel like a property of the
 * document.
 */
const FOCUS_STORAGE_KEY = 'catalog.workflowCanvas.focus';

/**
 * Whether focus mode was on in this tab.
 *
 * Every failure answers `false` — no window (a host rendering this on a server),
 * no storage (Safari's private mode throws on `sessionStorage` access rather
 * than returning null), or anything stored that is not exactly `'1'`. The chrome
 * being present is the state that hides nothing, so it is the only safe answer
 * to "I could not tell".
 */
function focusModeAtMount(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(FOCUS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the details rail starts on screen, once focus mode has had its say.
 *
 * A mount that restores focus (see {@link focusModeAtMount}) has to start with
 * the rail away, or a reload puts back the one panel the mode had just taken and
 * focus arrives half-applied. Measured in a browser before this existed: press
 * F, reload, and the rail was open again with the toggle still reading "Turn off
 * focus mode" — a screen making two claims about itself.
 */
function railOpenByDefault(): boolean {
  return !focusModeAtMount() && railOpenByWidth();
}

/** Remember it, or fail silently — a mode is not worth an exception. */
function rememberFocusMode(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(FOCUS_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // A browser that refuses storage still gets the mode, for this render.
  }
}

/**
 * The key that toggles focus mode.
 *
 * A bare letter rather than a chord, because this is a drawing surface and the
 * hand that would reach for a modifier is the hand on the pointer. `f` is the
 * mnemonic and nothing else on this screen claims it: React Flow binds only
 * Delete/Backspace and the arrows, and Escape already means "put the half-drawn
 * wire away" (see `workflow/wiring.tsx`), which is why this is not Escape.
 *
 * Discoverable rather than folklore: the toggle renders the letter beside its
 * icon and its tooltip names it, so the shortcut is learnable from the control
 * it duplicates instead of from a changelog.
 */
const FOCUS_SHORTCUT = 'f';

/**
 * Whether a keypress belongs to whatever the person is typing into.
 *
 * The failure this prevents is specific and would be reported as "the panels
 * vanish while I name a node": this screen is covered in text fields — the name
 * field, the inspector's config editor, the transform's code surface — and a
 * bare-letter shortcut that did not ask would fire on the `f` of "fleet".
 *
 * Narrowed with `instanceof` rather than by reading `tagName` off an `EventTarget`,
 * because a target can be a document or a window and neither has one.
 * `isContentEditable` covers the code editor, which is a `div`.
 */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * Whether the chrome is compacted so the graph gets the screen, and the one
 * gesture that changes it.
 *
 * ## What the mode does, and what it deliberately does not
 *
 * ON: the workflow card collapses to its head, the node dock drops its labels
 * (the form it already takes on a phone — see `AddButton` — rather than a second
 * compact form invented for this), and the rail goes away.
 *
 * OFF-LIMITS: the action cluster. That is not an oversight, it is the reason the
 * mode is safe. Every signal on this screen that prevents a mistake lives in that
 * cluster or hangs off it — Save doubles as the unsaved indicator, the refusal
 * notes appear beneath the button that caused them, the shrink refusal with its
 * acknowledge control is one of those notes, and the rail toggle carries the
 * problem count and its colour while the rail is away. It is also the smallest of
 * the three groups, so hiding it would buy the least canvas for the most risk.
 * What is left in focus is a graph plus the things that can tell you the graph is
 * wrong.
 *
 * ## Why one gesture rather than three
 *
 * Because the ask was "compactar os menus" for "real estate", and real estate is
 * a property of the whole screen. Three independent collapses is three decisions
 * and six states to be in; a person who wants the room wants the room. The rail
 * keeps its own toggle because it had one before this and closing it alone is a
 * legitimate smaller wish.
 *
 * ## Why the rail is passed in rather than owned here
 *
 * Because it existed first and is still operable on its own. This hook borrows
 * it for the duration of the mode and gives it back; it does not become the
 * rail's owner, which is what taking the `useState` would have meant.
 */
function useFocusMode(
  railOpen: boolean,
  setRailOpen: (open: boolean) => void,
): { focused: boolean; toggleFocus: () => void } {
  const [focused, setFocused] = useState(focusModeAtMount);

  /**
   * Whether the rail was open before focus took it away.
   *
   * A ref rather than state: nothing renders from it, and leaving focus should
   * put the screen back the way it was found rather than assert a default. A
   * person who had closed the rail themselves and then used focus would
   * otherwise get a panel they never asked for on the way out.
   *
   * Seeded from the WIDTH rather than from `railOpen`, and the two differ in
   * exactly one case: a mount that restored focus, where `railOpen` is already
   * false because focus put it there. Seeding from it would mean leaving focus
   * after a reload left the rail away too — restoring a state that focus itself
   * created rather than the one it displaced.
   */
  const railBeforeFocus = useRef(railOpenByWidth());

  const toggleFocus = useCallback(() => {
    const next = !focused;
    rememberFocusMode(next);
    if (next) railBeforeFocus.current = railOpen;
    setRailOpen(next ? false : railBeforeFocus.current);
    setFocused(next);
  }, [focused, railOpen, setRailOpen]);

  /**
   * The keyboard way in and out. See {@link FOCUS_SHORTCUT}.
   *
   * On `window` rather than on the canvas container, because the point of the
   * shortcut is that it works while the hands are on the graph — and React
   * Flow's pane is not a focusable element, so a container-scoped handler would
   * only fire after somebody had tabbed to something.
   *
   * Every modifier is refused rather than ignored: `Ctrl+F` is find, `Cmd+F` is
   * find, and a shortcut that swallowed either would be a bug reported as "the
   * browser's search is broken on this screen".
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== FOCUS_SHORTCUT) return;
      if (typingInto(event.target)) return;
      event.preventDefault();
      toggleFocus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleFocus]);

  return { focused, toggleFocus };
}

/**
 * Whether the workflow card actually folds — because focus mode REFUSES to fold
 * it while the graph has no name.
 *
 * The one place this mode could become a trap. Save is disabled on an empty name
 * (see `CanvasActions`), and the field that fills it in is inside the card — so a
 * focus mode that collapsed the card unconditionally would leave somebody who had
 * just picked "New workflow" with a dead Save button, a tooltip about a field
 * they cannot see, and no way to connect the two.
 *
 * So the card is chrome that is quiet when it has nothing to report and asserts
 * itself when it does: it stays open, in focus mode, exactly while the only
 * control that can unblock Save is the one it holds. {@link FocusToggle} says so
 * rather than appearing broken, and `WorkflowCard` additionally declines to fold
 * while the caret is still in the field.
 */
function focusCollapsesTheCard(focused: boolean, draftName: string): boolean {
  return focused && draftName.trim().length > 0;
}

/**
 * Every kind of node, and how it is offered.
 *
 * A `Record` over `WorkflowNodeKind` rather than a hand-written row of buttons,
 * and that is a bug fix rather than a tidy-up: `filter` shipped complete — model,
 * validator, executor, inspector, its own colour on the canvas — and could not be
 * added from this screen at all, because the row that offers the kinds was six
 * JSX elements somebody had typed out and only five of them had been typed. Every
 * other exhaustiveness guard in this file caught its case; none of them could
 * catch a list maintained by hand.
 *
 * So the row maps {@link WORKFLOW_NODE_KINDS} and looks each kind up here. A new
 * kind now fails to compile in this file until somebody says how it is offered,
 * which is the only way a palette stays complete.
 *
 * The icons match `KIND_STYLE` in `workflow/nodes.tsx` on purpose — the thing you
 * press to make a box should wear the box's own mark — and `if` and `filter` keep
 * the distinction that file argues for: a fork decides which boxes run, a funnel
 * takes rows away. They are the two that must never be confused at a glance, so
 * they never share an icon or a sentence.
 */
const ADD_NODE: Record<WorkflowNodeKind, { icon: typeof Plug; label: string; hint: string }> = {
  source: {
    icon: Plug,
    label: 'Source',
    hint: 'Reads records out of a system: a kind, an optional named connection, and a config.',
  },
  transform: {
    icon: Repeat,
    label: 'Transform',
    hint: 'Code that reshapes whatever is wired into it.',
  },
  sink: {
    icon: Database,
    label: 'Sink',
    hint: 'Writes and commits one object type. Several are fine — each commits independently.',
  },
  call: {
    icon: ExternalLink,
    label: 'Call',
    hint: 'Hands this step to a durable workflow that already exists, by name and pinned version. It runs as a child of this load, with its own retries.',
  },
  if: {
    icon: GitBranch,
    label: 'If',
    hint: 'Sends the rows down one of two branches, depending on an environment variable where the load runs. The other branch is skipped — a sink on it commits nothing and leaves what is published alone.',
  },
  filter: {
    icon: Filter,
    label: 'Filter',
    hint: 'Drops the rows that fail a test you write here. Unlike an If, every box still runs — there are simply fewer rows in them from this point on.',
  },
  rename: {
    icon: TextCursorInput,
    label: 'Rename',
    hint: 'Renames columns, and nothing else. No code, no child process — a pure rename rewrites the staged column list and leaves every row exactly where it is. It can also drop the columns you do not name, which does cost a pass over the rows.',
  },
  aggregate: {
    icon: Sigma,
    label: 'Aggregate',
    hint: 'Groups the rows and summarises each group — count, sum, average, min, max, or the values joined together. No code, and it holds only the groups rather than the rows, so a 44,720-row grouping into 16,119 groups never has more than one batch of records in memory. It refuses loudly if the grouping turns out to hold nearly everything.',
  },
  lookup: {
    icon: Combine,
    label: 'Lookup',
    hint: 'Brings fields across from a reference dataset, matched by key. Wire two things into it and say which one is the reference: that side is held in memory as a map, the other streams past it. The run says how many rows matched and how many did not, which is the difference between a working join and one that silently filled a column with nulls.',
  },
};

/**
 * The value the workflow picker uses for "start a fresh one".
 *
 * A sentinel rather than a null option, because Base UI's select hands back the
 * item's value and a null there is indistinguishable from a cleared select.
 */
const NEW_WORKFLOW = '__new__';

/**
 * React Flow's own theme, expressed as overrides of its CSS variables.
 *
 * Driven by the host's `dark:` class rather than by React Flow's `colorMode`
 * prop, and that is the whole point. `colorMode="system"` follows the operating
 * system, which is not the same thing as the app's theme: a host whose user has
 * chosen light inside an app on a dark desktop would get a dark canvas embedded
 * in a light page. Tying the variables to `dark:` means the canvas is dark
 * exactly when everything around it is.
 */
const CANVAS_THEME = cn(
  '[--xy-background-color:#fafafa] dark:[--xy-background-color:#09090b]',
  '[--xy-background-pattern-color:#d4d4d8] dark:[--xy-background-pattern-color:#3f3f46]',
  '[--xy-edge-stroke:#a1a1aa] dark:[--xy-edge-stroke:#52525b]',
  '[--xy-edge-stroke-selected:#8b5cf6] dark:[--xy-edge-stroke-selected:#a78bfa]',
  '[--xy-connectionline-stroke:#8b5cf6] dark:[--xy-connectionline-stroke:#a78bfa]',
  '[--xy-controls-button-background-color:#ffffff] dark:[--xy-controls-button-background-color:#18181b]',
  '[--xy-controls-button-background-color-hover:#f4f4f5] dark:[--xy-controls-button-background-color-hover:#27272a]',
  '[--xy-controls-button-color:#52525b] dark:[--xy-controls-button-color:#a1a1aa]',
  '[--xy-controls-button-border-color:#e4e4e7] dark:[--xy-controls-button-border-color:#27272a]',
  '[--xy-minimap-background-color:#ffffff] dark:[--xy-minimap-background-color:#18181b]',
  '[--xy-minimap-node-background-color:#d4d4d8] dark:[--xy-minimap-node-background-color:#52525b]',
  '[--xy-minimap-mask-background-color:rgba(244,244,245,0.7)] dark:[--xy-minimap-mask-background-color:rgba(24,24,27,0.7)]',
  '[--xy-attribution-background-color:transparent]',
  '[--xy-selection-background-color:rgba(139,92,246,0.08)]',
  '[--xy-selection-border:1px_dotted_#8b5cf6]',
);

/**
 * React Flow's built-in screen-reader copy, replaced with copy that says what
 * the keys actually do here.
 *
 * The default node description talks about arrow keys and nothing else, which
 * leaves the one thing a keyboard user cannot discover — that wiring is done
 * from the inspector, not from the canvas — entirely unsaid.
 */
const ARIA_LABELS = {
  'node.a11yDescription.default':
    "Press Enter to open this node's inspector, where it can be renamed, wired to another node and deleted. Press the arrow keys to move it. Press Delete to remove it.",
  'controls.ariaLabel': 'Canvas controls',
  'minimap.ariaLabel': `Overview of the ${WORKFLOW_NAME.singular}`,
};

/**
 * The graph being edited, and everything the screen knows about it that the
 * server does not.
 *
 * `dirty`, `past` and `baseline` come from {@link HistoricDraft} — the three
 * fields that describe the gap between this drawing and the stored one. They
 * live in `workflow/history.tsx` with the functions that maintain them, so that
 * "what counts as one undoable action" is answered in one file rather than
 * spread across every call site that edits a node.
 */
interface Draft extends HistoricDraft {
  /** Absent until the server has stored it once. */
  id?: string;
  /** Which stored version this was loaded from, for the "v2 next" hint. */
  version?: number;
}

function blankDraft(): Draft {
  const empty = { name: '', description: '', nodes: [], edges: [] };
  // A blank canvas has a baseline too, and it is the blank canvas: Reset on a
  // never-saved graph means "clear it", which is exactly what going back to
  // "nothing has been stored" should mean.
  return { ...empty, dirty: false, past: [], baseline: snapshotOf(empty) };
}

function draftFrom(workflow: CatalogWorkflow): Draft {
  const loaded = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? '',
    // Copied rather than referenced: the query cache owns the objects it
    // returned, and mutating a node's position in place would edit the cached
    // workflow, so a background refetch would silently "confirm" edits that
    // were never saved.
    //
    // Arranged on the way in, when nothing has arranged it. A graph created
    // through the API — by a scheduler, by a promotion, by a script — carries no
    // positions, and drawing those at the origin stacks every node on the first
    // one and makes a perfectly ordinary DAG read as a loop. See
    // `layoutIfUnarranged`.
    nodes: layoutIfUnarranged(
      workflow.nodes.map((node) => ({
        ...node,
        position: node.position ? { ...node.position } : undefined,
      })),
      workflow.edges,
    ),
    edges: workflow.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    version: workflow.version,
    dirty: false,
    past: [],
  };
  // The baseline holds the SAME arrays the draft starts with, which is what
  // makes undoing all the way back compare equal to it and go genuinely clean.
  // See `sameSnapshot`.
  return { ...loaded, baseline: snapshotOf(loaded) };
}

export interface WorkflowCanvasProps {
  /** Heading copy, so the host can call this whatever its users call it. */
  title?: string;
  eyebrow?: string;
  intro?: string;
  /**
   * Set false where the viewer is known to be read-only. The endpoints refuse
   * regardless; this only stops the canvas offering controls that always 403.
   */
  canEdit?: boolean;
  /**
   * Where the model screen lives, if the host mounts one. Receives the object
   * type name.
   *
   * The mirror of `CatalogManager`'s `explorerHref`, and it exists for the
   * question a sink node could always answer and never act on: a sink says
   * exactly which type it commits, and there was nothing on this screen that
   * would take you to it. Omit it and the sink inspector shows the type and no
   * link, which is what a host that mounts no model screen should get.
   *
   * Given to the **sink inspector only**. A source reads a system this catalog
   * knows nothing about, a transform is code, and a call node hands its step to
   * a workflow that owns its own outputs — the sink is the one node whose
   * configuration names a type in this catalog.
   */
  modelHref?: (typeName: string) => string;
}

/**
 * Transforms wired to each other, ending at one or more sinks.
 *
 * Deliberately **not** called Flow. `FlowView` in this package is a *derived*
 * picture — it reconstructs who feeds what from the audit trail, and argues in
 * its own comment that inferring the graph from what publishers actually did is
 * more truthful than a diagram somebody maintains. This screen is the opposite
 * claim: a graph a person authors and the server then executes. Sharing a name
 * would leave two screens making opposite promises about where the truth is.
 * See `workflow/name.ts`.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <TooltipProvider>
      {/*
       * The provider is here rather than inside the canvas component because
       * `useReactFlow` — which the inspector's fit-view needs — only works
       * under it, and putting it inside would mean the hook and the provider
       * are in the same component, which React Flow refuses.
       */}
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </TooltipProvider>
  );
}

/**
 * The selection after a batch of React Flow `select` changes.
 *
 * React Flow reports selection one id at a time, and both nodes and edges use
 * the same shape for it, so folding the batch here keeps one description of what
 * selecting means. Returns the array it was given when nothing selected,
 * so an unrelated batch of changes does not re-render the canvas.
 */
function nextSelection(
  current: string[],
  changes: (NodeChange<WorkflowFlowNode> | EdgeChange<WorkflowFlowEdge>)[],
): string[] {
  let next = current;
  for (const change of changes) {
    if (change.type !== 'select') continue;
    next = change.selected
      ? [...new Set([...next, change.id])]
      : next.filter((id) => id !== change.id);
  }
  return next;
}

/** The same graph with one wire moved onto the other side of its gate. */
function edgeOnBranch(
  edges: WorkflowEdge[],
  moving: WorkflowEdge,
  branch: WorkflowBranchLabel,
): WorkflowEdge[] {
  const id = edgeId(moving);
  return edges.map((edge) => (edgeId(edge) === id ? { ...edge, branch } : edge));
}

/**
 * The code a transform created from this canvas starts as: the batch, unchanged.
 *
 * Keyed by the language union rather than by `string`, so a language added to
 * the library without a line here is a type error rather than a transform that
 * saves empty and fails at run time.
 *
 * Deliberately the identity and not a worked example. `TransformEditor` ships
 * starters that teach the shape of a mapping, and they belong there — somebody
 * who opened the editor came to write a transform. Somebody who pressed this
 * button came to get *past* an empty picker, and the useful default is the
 * smallest thing that actually runs: the graph is now complete, it commits what
 * the source produced, and the mapping is an edit rather than a prerequisite.
 */
const IDENTITY_TRANSFORM: Record<TransformLanguage, string> = {
  javascript: '// Whatever is wired into this step arrives as `records`.\nreturn records;',
  typescript: '// Whatever is wired into this step arrives as `records`.\nreturn records;',
  python: '# Whatever is wired into this step arrives as `records`.\nreturn records',
};

/**
 * The transform to create for a node that has none, ready to send.
 *
 * Named after the node, so the two are findable from each other in a Transforms
 * list that knows nothing about graphs. In the deployment's own first language,
 * because offering one the image cannot execute turns a deployment difference
 * into a traceback the author cannot act on — the same reason `TransformEditor`
 * takes its languages from `pipelineCapabilities()` rather than listing all
 * three.
 */
function starterTransform(
  node: WorkflowNode | undefined,
  languages: TransformLanguage[] | undefined,
): { name: string; language: TransformLanguage; code: string } {
  const language = languages?.[0] ?? 'javascript';
  return {
    name: node ? nodeName(node) : defaultLabel('transform'),
    language,
    code: IDENTITY_TRANSFORM[language],
  };
}

/**
 * The node a "make one and wire it" action would create, and whether it is legal.
 *
 * Pure, and separate from the state update it feeds, so the decision can be
 * described in one place and tested without a canvas. The verdict is asked even
 * though the menu only offers kinds `newKindsFrom` already approved: the menu
 * asking one question and the action taking a different answer is the class of
 * bug that puts an illegal edge into a saved graph.
 *
 * `reason: null` distinguishes "that node is not on this canvas" — nothing
 * happened, and there is nothing to say about it — from a refusal somebody
 * should hear.
 */
function nodeWiredFrom(
  draft: Draft,
  fromId: string,
  kind: WorkflowNodeKind,
): { ok: true; node: WorkflowNode; from: WorkflowNode } | { ok: false; reason: string | null } {
  const from = draft.nodes.find((node) => node.id === fromId);
  if (!from) return { ok: false, reason: null };
  const node = newNodeOfKind(
    kind,
    newLocalId(kind),
    placeNextTo(from, draft.nodes),
    uniqueName(draft.nodes, kind),
  );
  const verdict = canConnect([...draft.nodes, node], draft.edges, fromId, node.id);
  return verdict.ok ? { ok: true, node, from } : { ok: false, reason: verdict.reason };
}

/** The graph with one transform node pointed at the code it now runs. */
function runningTransform(
  nodes: WorkflowNode[],
  nodeId: string,
  transformId: string,
): WorkflowNode[] {
  return nodes.map((node) =>
    node.id === nodeId && node.kind === 'transform' ? { ...node, transformId } : node,
  );
}

/**
 * Problems about a node nobody has finished, held back from the error list.
 *
 * THE DISTINCTION THIS DRAWS
 * --------------------------
 * A node that has just been added is unwired and unconfigured *by construction*.
 * Clicking "+ Sink" and being told, in the same instant, that the sink "is not
 * reachable from any source, so it would never run" and "does not say which
 * object type it writes" is true and useless: nobody has had the chance to do
 * either yet. Worse, it is expensive. That prose was written for somebody about
 * to save a graph that would silently do nothing, and firing it at somebody
 * mid-click is how a validator becomes something people learn to scroll past —
 * which is the exact failure `workflow/validate.ts` opens by describing.
 *
 * So the split is between INCOMPLETE and WRONG. A node the author has not
 * finished is a to-do. A node the author *thinks* is finished and is not is a
 * problem, and only that deserves the checks' own language.
 *
 * WHAT COUNTS AS "NOT FINISHED"
 * -----------------------------
 * The only honest signal a browser has is: the node was created in this editing
 * session and nothing has happened to it since. `unstarted` is that set. It is
 * component state, so it survives re-render and dies on reload — which is right,
 * because a node that came back from the server is one somebody saved and walked
 * away from, and is therefore finished as far as its author was concerned.
 *
 * A node touched once and abandoned — renamed, or wired, and then left — is
 * removed from the set and reports in full. That is not a gap in the rule, it is
 * the rule: acting on a node and stopping is precisely "I think this is done".
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not suppress anything. `hasBlockingProblem` is still asked about every
 * problem, held back or not, so the save button is coloured as blocked from the
 * moment the graph would not run; the held-back items are listed on screen the
 * whole time as work outstanding; and pressing Save clears `unstarted` outright,
 * so a save attempt promotes every one of them to a full error before the
 * request is even answered. A graph that would silently do nothing cannot be
 * saved unnoticed, which is what these checks exist for.
 *
 * A problem naming several nodes is held back only when *every* node it names is
 * unstarted. Two sinks writing the same type, one old and one new, is a fact
 * about the old one too.
 *
 * Worth being honest about: under the touch rule above, `every` and `some`
 * currently cannot disagree. The only check that names two nodes is
 * `duplicate-sink-type`, and reaching it means setting a type on the new sink,
 * which starts it. `every` is written anyway because it is the rule that is
 * *correct* — if "touched" is ever loosened, `some` would start holding back
 * complaints about nodes somebody finished months ago, and it would do it
 * silently.
 */
function partitionProblems(
  problems: WorkflowProblem[],
  unstarted: ReadonlySet<string>,
): { live: WorkflowProblem[]; pending: WorkflowProblem[] } {
  const live: WorkflowProblem[] = [];
  const pending: WorkflowProblem[] = [];
  for (const problem of problems) {
    // A problem with no node ids is about the graph, not about a box somebody is
    // half-way through — nothing is "not finished yet" about an empty workflow.
    const held = problem.nodeIds.length > 0 && problem.nodeIds.every((id) => unstarted.has(id));
    (held ? pending : live).push(problem);
  }
  return { live, pending };
}

/**
 * The same fact, said as work rather than as failure.
 *
 * Deliberately **not** the checks' own messages. Those are long, and they are
 * long on purpose — they argue why the shape is refused, for a reader who
 * believes their graph is finished. Repeating them under a friendlier heading
 * would keep every word that makes them premature and change only the colour.
 *
 * A verb phrase instead, one per code. Which codes appear is still entirely the
 * validators' decision; all this supplies is the imperative form, and the
 * fallback means a code added later shows up as outstanding work rather than
 * vanishing from this list.
 */
const TODO_FOR: Partial<Record<WorkflowProblemCode, string>> = {
  unreachable: 'wire something into it',
  'dead-end': 'wire it into something that ends at a sink',
  'sink-has-no-type': 'choose the object type it commits',
  'transform-not-named': 'choose the transform it runs',
  'call-not-named': 'name the workflow it calls, and the version to pin',
  'missing-transform': 'choose a transform that still exists',
  'source-has-input': 'unwire whatever feeds it — a source reads, it is not fed',
  'sink-has-output': 'unwire what it feeds — nothing runs after a sink',
  'if-not-named': 'name the environment variable it decides on',
  'if-threshold-invalid': 'give it a whole number of rows, 1 or more, to branch on',
  'if-needs-one-input': 'leave it one input — a gate carries one stream through',
  'branch-not-labelled': 'say whether that wire is the "then" or the "else"',
  'branch-on-plain-edge': 'remove the branch label — only an if node branches',
};

function todoFor(problem: WorkflowProblem): string {
  return TODO_FOR[problem.code] ?? 'finish setting it up';
}

/**
 * A set with some ids taken out, and the same set back when none were in it.
 *
 * The identity return is what stops `unstarted` becoming a new object on every
 * edit to an unrelated node, which would re-run `partitionProblems` and rebuild
 * every React Flow node for nothing.
 */
function without(set: ReadonlySet<string>, ids: string[]): ReadonlySet<string> {
  if (!ids.some((id) => set.has(id))) return set;
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
}

/** The nodes named by held-back checks, by the name the reader sees. */
function unfinishedNames(pending: WorkflowProblem[], nodes: WorkflowNode[]): string[] {
  const ids = new Set(pending.flatMap((problem) => problem.nodeIds));
  return [...ids].map((id) => nodeLabelIn(nodes, id));
}

/**
 * A server refusal, verbatim.
 *
 * The server knows things this canvas does not — which types exist, who may
 * write to them, whether a transform's output fits the sink — so its wording is
 * the useful one, not a generic "could not save".
 */
function RefusalNote({ lead, error }: { lead: string; error: unknown }) {
  return (
    <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      {lead} {error instanceof Error ? error.message : 'no reason given.'}
    </p>
  );
}

/**
 * What pressing Save will do, in the three states it can be in.
 *
 * The middle case is the one that had to be added. "There are errors listed
 * beside the canvas" is exactly wrong when the list beside the canvas is empty
 * and the only thing standing in the way is a node nobody has finished — it
 * sends somebody looking for a message that is not there. So that case names the
 * nodes instead, and says the thing they most need to know: pressing Save is
 * what stops the checks being held back.
 *
 * None of these say the server will refuse the graph any more, and that is a
 * correction rather than a softening. Saving an unfinished graph SUCCEEDS — it
 * is stored as a draft, which is the whole point of drafts existing. The
 * refusal moved to publishing, so a hint that still promised one would be
 * confidently wrong about the case it fires most often in.
 */
function saveHint(blocked: boolean, unfinished: string[]): string {
  if (unfinished.length > 0) {
    const one = unfinished.length === 1;
    return `Nothing is wrong yet, but ${one ? 'one node is' : `${unfinished.length} nodes are`} not finished: ${unfinished.join(', ')}. Saving keeps ${one ? 'it' : 'them'} exactly as ${one ? 'it is' : 'they are'} — the graph is stored as a draft, and the checks stop being held back the moment you press it.`;
  }
  if (blocked) {
    return 'There are errors listed beside the canvas. Saving still works — the graph is kept as a draft, which is what a draft is for. It will not run until it is finished and published, and publishing is where these checks are answered for real.';
  }
  return "Store it. Publishing is what validates it, and the server's answer there is the one that counts.";
}

/**
 * Save, run, delete.
 *
 * Save is deliberately **not** disabled when the local checks fail. Disabling
 * would make this screen the gate, and the checks beside the canvas cannot see
 * everything the server sees — a rule that is subtly wrong here would become a
 * graph nobody can save at all, with no error to read. The button is coloured to
 * warn and the tooltip says what will happen; the refusal, when it comes, comes
 * from the server with its reasons.
 *
 * `blocked` is asked about every check, including the ones held back from the
 * error list while their node is still being worked on — so the colour never
 * lags behind the graph. What `unfinished` changes is only what the tooltip
 * *says*: "there are errors listed beside the canvas" would be a lie when the
 * list beside the canvas is empty and the real answer is "two boxes are not
 * finished", so that case gets its own sentence and names them.
 */
function CanvasActions({
  draft,
  stored,
  canEdit,
  blocked,
  unfinished,
  saving,
  running,
  durabilityDetail,
  acknowledging,
  reducedMotion,
  resetting,
  onAcknowledgingChange,
  onResettingChange,
  onUndo,
  onReset,
  onSave,
  onRun,
  onLifecycleChange,
  onAskDelete,
}: {
  draft: Draft;
  /**
   * The graph as the server last described it, when there is one.
   *
   * Separate from `draft` because publishing, scheduling and running all act on
   * what is STORED — the status, the cron and the enabled flag are the server's
   * answers, not fields of the thing being edited — and folding them into the
   * draft would let a canvas full of unsaved edits claim a status it does not
   * have.
   */
  stored: CatalogWorkflow | undefined;
  canEdit: boolean;
  blocked: boolean;
  unfinished: string[];
  saving: boolean;
  running: boolean;
  durabilityDetail: string;
  acknowledging: boolean;
  reducedMotion: boolean;
  resetting: boolean;
  onAcknowledgingChange: (open: boolean) => void;
  onResettingChange: (open: boolean) => void;
  onUndo: () => void;
  onReset: () => void;
  onSave: () => void;
  onRun: (options?: WorkflowRunOptions) => void;
  onLifecycleChange: (workflow: CatalogWorkflow) => void;
  onAskDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/*
       * Before Save, and in this order, because they are the three answers to
       * one question — "what about the work I have not saved?". Take back the
       * last bit of it, throw all of it away, or commit it. The unsaved chip
       * sits at the end of the group, directly against the button that resolves
       * it.
       */}
      <HistoryControls
        draft={draft}
        canEdit={canEdit}
        reducedMotion={reducedMotion}
        resetting={resetting}
        onResettingChange={onResettingChange}
        onUndo={onUndo}
        onReset={onReset}
      />
      <Tooltip content={saveHint(blocked, unfinished)}>
        <Button
          size="sm"
          onClick={onSave}
          disabled={
            !canEdit ||
            saving ||
            draft.name.trim().length === 0 ||
            (!draft.dirty && Boolean(draft.id))
          }
          // The amber is the whole signal — a graph that would never run says so
          // on the button before it is pressed — so it has to survive the
          // variant's own background. `cn` is tailwind-merge, so the later
          // `bg-*` wins rather than fighting.
          className={cn(
            'shrink-0',
            blocked
              ? 'bg-amber-600 text-white hover:bg-amber-500 dark:bg-amber-600 dark:text-white dark:hover:bg-amber-500'
              : 'bg-zinc-950 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200',
          )}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {draft.dirty ? 'Save' : 'Saved'}
        </Button>
      </Tooltip>
      {stored && (
        <PublishControls
          workflow={stored}
          dirty={draft.dirty}
          canEdit={canEdit}
          onPublished={onLifecycleChange}
        />
      )}
      <RunControls
        workflowId={draft.id}
        dirty={draft.dirty}
        canEdit={canEdit}
        running={running}
        durabilityDetail={durabilityDetail}
        acknowledging={acknowledging}
        onAcknowledgingChange={onAcknowledgingChange}
        onRun={onRun}
      />
      {draft.id && canEdit && (
        <Tooltip
          content={`Delete this ${WORKFLOW_NAME.singular}, and the connector it runs as with it.`}
        >
          <Button
            variant="outline"
            size="icon"
            onClick={onAskDelete}
            aria-label={`Delete this ${WORKFLOW_NAME.singular}`}
            className="text-zinc-400 hover:text-red-600"
          >
            <Trash2 size={12} />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * The tool dock: every kind that can be put on the canvas, and the tidy control.
 *
 * Bottom centre, floating, because it is the one piece of chrome somebody
 * touches continuously while drawing and the bottom edge is where every canvas
 * tool that has ever been good keeps its tools. It is also the only corner React
 * Flow's own overlays do not claim.
 *
 * The kinds come from {@link WORKFLOW_NODE_KINDS} through {@link ADD_NODE}, so
 * the dock cannot fall behind the model — see the note on `ADD_NODE` for the bug
 * that made that necessary.
 */
function AddNodeBar({
  refreshing,
  compact,
  onAdd,
  onTidy,
}: {
  refreshing: boolean;
  /**
   * The icons-only form, asked for rather than measured.
   *
   * Deliberately the SAME form the dock already takes below `md`, rather than a
   * second compact layout invented for focus mode: this row has one way of
   * being small, and two would drift the moment somebody changed one of them.
   * All focus does is ask for it at any width — see `AddButton`.
   */
  compact: boolean;
  onAdd: (kind: WorkflowNodeKind) => void;
  onTidy: () => void;
}) {
  return (
    <div
      className={cn(
        'pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto p-1.5',
        FLOATING,
      )}
    >
      {WORKFLOW_NODE_KINDS.map((kind) => (
        <AddButton key={kind} kind={kind} compact={compact} onClick={() => onAdd(kind)} />
      ))}

      <span className={cn('mx-1 h-6 w-px shrink-0 bg-zinc-200 dark:bg-zinc-800')} aria-hidden />

      <Tooltip content="Lay the nodes out left to right by dependency, with every sink in the last column.">
        <Button
          variant="ghost"
          size="sm"
          onClick={onTidy}
          aria-label="Tidy the layout"
          className="shrink-0"
        >
          <LayoutGrid size={12} />
          {/* The word goes when the dock has to fit a phone, and when focus mode
              asks for the room. The accessible name above is unconditional, so
              nothing is lost to a screen reader either way. */}
          <span className={compact ? 'hidden' : 'hidden md:inline'}>Tidy</span>
        </Button>
      </Tooltip>

      {refreshing && (
        // A background refetch says so without replacing anything: the graph on
        // screen stays exactly where it is.
        <span className={cn('shrink-0 px-1 font-mono text-[10px]', MUTED)}>refreshing…</span>
      )}
    </div>
  );
}

/**
 * Which workflow the screen should be showing.
 *
 * Falls through to the first stored one so an empty picker opens on something
 * rather than on a blank canvas, and to the new-workflow sentinel when there is
 * nothing stored at all.
 */
function wantedWorkflowId(list: CatalogWorkflow[], selected: string): string {
  return selected || list[0]?.id || NEW_WORKFLOW;
}

/** The draft for a chosen id: the stored graph, or a blank one if there is none. */
function draftForId(list: CatalogWorkflow[], wanted: string): Draft {
  if (wanted === NEW_WORKFLOW) return blankDraft();
  const found = list.find((workflow) => workflow.id === wanted);
  return found ? draftFrom(found) : blankDraft();
}

/**
 * The minimap dot colour for a node, by kind.
 *
 * Narrowed rather than asserted: MiniMap types `data` as an open record, and a
 * bad `kind` here would be a thrown error inside React Flow's own render rather
 * than a mis-coloured dot.
 */
function miniMapColor(data: { kind?: unknown } | undefined): string {
  const kind = data?.kind;
  if (!isWorkflowNodeKind(kind)) return '#a1a1aa';
  if (kind === 'source') return '#0ea5e9';
  if (kind === 'sink') return '#10b981';
  // The same amber the node itself draws (see `KIND_STYLE`), so the overview
  // and the canvas agree about which boxes are somebody else's workflow.
  if (kind === 'call') return '#f59e0b';
  // Fuchsia-500, the gate's own accent, and deliberately not the violet a
  // transform gets: the overview is where somebody looks to find the branch in
  // a graph too big to read, so it is the one place the two must not blur.
  if (kind === 'if') return '#d946ef';
  // Rose-500, the filter's own accent (see `KIND_STYLE`), and specifically not
  // the fuchsia beside it: the overview is where somebody looks for "where do
  // rows disappear in this graph", and a gate and a filter are the two boxes
  // that answer that question in completely different ways.
  if (kind === 'filter') return '#f43f5e';
  // Teal-500, the rename's own accent. Deliberately not the violet a transform
  // gets: a rename is the node that is *provably* cheap, and an overview where
  // it reads as another piece of user code hides the one thing worth seeing.
  if (kind === 'rename') return '#14b8a6';
  // Amber-500. The one node where the number of rows changes shape rather than
  // merely shrinking, and the one worth spotting from the overview: a grouping
  // that holds nearly every row it read is the failure this node exists to
  // avoid, and the box on the map is where somebody notices there is one.
  if (kind === 'aggregate') return '#f59e0b';
  // Indigo-500, the lookup's own accent (see `KIND_STYLE`). The overview is where
  // somebody looks for the shape of a graph, and a lookup is the one box where
  // two lines meet for different reasons — so it must not read as a source, which
  // is what the wire feeding it usually is.
  if (kind === 'lookup') return '#6366f1';
  return '#8b5cf6';
}

/**
 * The overview, and the one thing focus mode does to it.
 *
 * WHY IT SHRINKS RATHER THAN GOES
 * -------------------------------
 * Focus mode's argument everywhere else is that the chrome it hides is chrome
 * you do not need while drawing. The minimap is the exception: it is a
 * navigation aid for exactly the big graph that made somebody want the room in
 * the first place, so taking it away is taking away the thing the mode is FOR.
 * It shrinks to the size at which it still answers "where am I", and hovering
 * it brings the rest back. See {@link MINIMAP_FOCUSED_CLASS} for what survives
 * at that size and what does not.
 *
 * WHY A TRANSFORM AND NOT A SMALLER MINIMAP
 * -----------------------------------------
 * React Flow sizes the minimap from `style.width`/`style.height` (defaulting to
 * 200×150) and derives `viewScale` from them — `boundingRect.width /
 * elementWidth`. Its pan handler then moves the viewport by `rawClientDelta *
 * viewScale`, reading `viewScale` LIVE from a ref on every mousemove.
 *
 * So shrinking the honest way — passing a smaller width and height — would
 * change the pan gain, and change it on every frame of an animation between the
 * two sizes. A drag that started while the map was small and expanded mid-
 * gesture would have the viewport accelerate under the finger, continuously,
 * for the length of the animation. That is the exact failure worth avoiding.
 *
 * Scaling has none of it: `style.width` stays 200 in both states, so `viewScale`
 * is a constant and the pan gain is IDENTICAL small, large, and every frame in
 * between. Scale is a compositor property, so the animation never touches
 * layout, never re-renders React Flow, and never resolves against `height:
 * auto` — which is the shape of animation that never settled under jsdom and
 * left the card body mounted forever in a test. There is nothing here for that
 * to happen to: the element is always mounted, always 200×150 in layout, and
 * the only thing moving is one compositor property.
 *
 * (Tailwind v4 emits `scale-*` as the INDEPENDENT `scale` property rather than
 * as `transform: scale(...)`, so the computed `transform` here reads `none` and
 * the size lives in `scale`. It honours `transform-origin` exactly the same
 * way, and `transition-transform` in v4 expands to `transform, translate,
 * scale, rotate` — so the transition below does cover it. Both checked in a
 * browser rather than assumed, because a transition that silently covers
 * nothing is a snap that looks like a missing animation.)
 *
 * The residue is that while shrunk the pan gain is calibrated for the large map
 * — a drag would move the viewport less than the small drawing suggests. On a
 * fine pointer that state is unreachable: a drag needs a press, a press needs
 * the pointer over the element, and the pointer being over the element is what
 * expands it. Every drag begins on a settled, full-size map. On a touch screen
 * there is no shrinking at all ({@link hoverCapablePointer}), so it cannot
 * arise there either. Expand-then-pan, arrived at by geometry rather than by
 * disabling anything.
 *
 * WHY IT CANNOT FLICKER
 * ---------------------
 * Both states are anchored at the same bottom-left corner and the transform
 * origin is that corner, so the small box is a strict sub-rectangle of the
 * large one. A pointer that enters the small box is therefore still inside the
 * large box once it expands, and expansion can never move the element out from
 * under the pointer that caused it. The one geometry that oscillates — expand,
 * pointer now outside, collapse, repeat — needs the two boxes to disagree about
 * a region, and containment is what rules that out.
 *
 * It also cannot collide with the zoom controls above it, because the expanded
 * size is the size the minimap already is today: the gap the shrink opens up is
 * space that was always reserved for this element, so growing back into it
 * covers nothing that was not already covered.
 */
function FocusMiniMap({ focused }: { focused: boolean }) {
  /*
   * Read once at mount rather than subscribed to, which is the same call
   * `railOpenByWidth` makes and for the same reason: a live query would re-shrink
   * the map under a pointer that is resting on it because a tablet was docked.
   * The cost of being wrong is one session on the size it booted with.
   */
  const [canHover] = useState(hoverCapablePointer);
  const shrinks = focused && canHover;

  return (
    /*
     * React Flow's own `Panel`, so this wrapper IS the panel: it takes the
     * absolute positioning, the 15px margin, the z-index and — the reason it is
     * `Panel` rather than a hand-rolled div — the rule that switches
     * `pointer-events` off while a box-selection is being dragged across the
     * canvas. The minimap inside is switched to `static` so it stops being the
     * positioned element and becomes this one's content; without that there
     * would be two absolutely-positioned boxes fighting over one corner.
     */
    <Panel
      position="bottom-left"
      /*
       * THE KEYBOARD PATH, and it exists only while the map is shrunk.
       *
       * A minimap that expands on hover cannot be expanded by somebody who has
       * no pointer, and `focus-within` is only an answer if something in here
       * can hold a caret — React Flow's minimap is an `svg` with `role="img"`,
       * which cannot. So the panel itself becomes the focus stop.
       *
       * Conditional on `shrinks`, and that is the whole reason this is safe:
       * outside focus mode the tab order is byte-for-byte the one the previous
       * round measured and settled — app nav, card, actions, rail toggle, dock,
       * rail, canvas — because `undefined` puts no stop here at all. Inside
       * focus mode there is one extra stop, at the end, on the element that
       * needs it. That is a net gain for a keyboard: the minimap was never
       * reachable before, in either mode.
       */
      tabIndex={shrinks ? 0 : undefined}
      role={shrinks ? 'group' : undefined}
      aria-label={
        shrinks
          ? 'Graph overview, reduced. Hold focus here, or hover it, to see it full size.'
          : undefined
      }
      className={cn(
        // An overview is worth least on the screen with least room for it:
        // below `lg` it would cover a sixth of the canvas to describe the other
        // five. Moved here from the minimap itself along with the positioning.
        'hidden lg:block',
        // The corner both states share. `scale` alone would shrink about the
        // centre and unpin the map from the corner it is anchored to, which is
        // also what makes the containment argument above hold.
        'origin-bottom-left',
        /*
         * A tween on a transform, matching the duration and the curve the card
         * body folds on, so the two halves of one gesture move as one gesture.
         *
         * `prefers-reduced-motion` gets the same end state and no transition —
         * a CSS variant rather than the `useReducedMotion()` hook the motion
         * components here use, because this animation is CSS and the media
         * query is the direct expression of it. There is no state to keep in
         * step and nothing to settle.
         */
        'transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
        'motion-reduce:transition-none',
        // `focus` as well as `focus-within`: the stop is on this element, so it
        // is `focus` that fires today. `focus-within` is here so that a control
        // added inside later expands the map rather than being drawn at half
        // size under somebody's caret.
        shrinks && MINIMAP_FOCUSED_CLASS,
        shrinks && 'hover:scale-100 focus:scale-100 focus-within:scale-100',
        // The focus ring goes on the panel, because the panel is the focus stop.
        shrinks && 'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
      )}
    >
      <MiniMap
        pannable
        zoomable
        // Positioning now belongs to the panel above, so the minimap stops
        // claiming a corner and just draws in the box it is given.
        position="bottom-left"
        nodeColor={(node) => miniMapColor(node.data)}
        className={cn(
          '!static !m-0',
          '!overflow-hidden !rounded-lg !border !border-zinc-200 !shadow-sm dark:!border-zinc-800',
        )}
      />
    </Panel>
  );
}

/**
 * What the hover toolbar's delete button says it will do.
 *
 * The whole warning, on the tooltip, because that button is an unlabelled icon
 * and the gesture behind it does not stop to ask. It names the node, counts the
 * wires that go with it, adds the published-graph consequence where there is
 * one, and points at the undo that makes the whole trade defensible.
 */
function deleteHint(
  node: WorkflowNode | null,
  draft: Draft,
  stored: CatalogWorkflow | undefined,
): string {
  if (!node) return 'Remove this node';
  const cost =
    deleteCost(wiresOn(draft.edges, [node.id]), stored?.status === 'ready') ??
    'Nothing is wired to it.';
  return `Delete "${nodeName(node)}". ${cost} Ctrl+Z takes it back.`;
}

/**
 * The menu for a target, or nothing at all when there is no target.
 *
 * A free function rather than a ternary in the canvas, and the same for
 * {@link nodeTarget} and {@link idsOf} below. Each of them replaces one branch
 * inside a component that is the largest thing in this package and is held to a
 * complexity ceiling for exactly that reason — and each reads better as a named
 * thing than as a `?:` in the middle of a render.
 */
function sectionsFor(
  target: CanvasMenuTarget | undefined,
  context: CanvasMenuContext,
): CanvasMenuSection[] {
  return target ? buildCanvasMenu(target, context) : [];
}

/** The hovered or selected node as a menu target, when there is one. */
function nodeTarget(node: WorkflowNode | null): CanvasMenuTarget | undefined {
  return node ? { kind: 'node', nodeId: node.id } : undefined;
}

/** One node's id as a list, or an empty list. What `dropNodes` wants either way. */
function idsOf(node: WorkflowNode | null): string[] {
  return node ? [node.id] : [];
}

/**
 * A menu about to open, with a wire turned back into the graph's own edge.
 *
 * React Flow's edge carries `source`/`target` and no branch, and the branch is
 * the one thing an edge menu has to know: offering "move it to the else branch"
 * on a wire that is on no branch would be offering a change `validateWorkflow`
 * refuses, and offering nothing on a wire that IS on one would hide the largest
 * single change anybody can make from a menu.
 *
 * `null` when the wire is not in the draft at all — a stale click, which happens
 * when a menu is opened on the frame a graph is being replaced. Nothing is a
 * better answer there than a menu about an edge that no longer exists.
 */
function menuOpening(
  target: CanvasMenuTarget,
  anchor: MenuAnchorRect,
  edges: WorkflowEdge[],
): { target: CanvasMenuTarget; anchor: MenuAnchorRect } | null {
  if (target.kind !== 'edge') return { target, anchor };
  const found = edges.find((edge) => edge.from === target.edge.from && edge.to === target.edge.to);
  return found ? { target: { kind: 'edge', edge: found }, anchor } : null;
}

/**
 * What the menu is about, said for somebody who cannot see where it opened.
 *
 * A context menu is normally identified by the thing under the pointer, and a
 * screen reader user has no pointer — so "Menu" would be the whole of what they
 * were told about a popup with fourteen items in it. Every branch names the node
 * or nodes in the words that are on the canvas.
 */
function describeMenuTarget(target: CanvasMenuTarget | undefined, nodes: WorkflowNode[]): string {
  if (!target) return 'Canvas menu';
  if (target.kind === 'node') return `Actions for ${nodeLabelIn(nodes, target.nodeId)}`;
  if (target.kind === 'edge') {
    const from = nodeLabelIn(nodes, target.edge.from);
    return `Actions for the connection from ${from} to ${nodeLabelIn(nodes, target.edge.to)}`;
  }
  if (target.kind === 'selection') return `Actions for ${target.nodeIds.length} selected nodes`;
  return 'Canvas menu';
}

/**
 * Where a context menu should hang, given the event that asked for one.
 *
 * A `contextmenu` event is not always a right-click. Pressing the dedicated
 * context-menu key, or Shift+F10, makes the browser dispatch exactly the same
 * event type at whatever has focus — which is what gives this canvas keyboard
 * parity for free, and is also the case that goes wrong if the coordinates on
 * the event are trusted.
 *
 * So a pointer is detected rather than assumed, and when there is not one the
 * anchor is the focused element's own box. That is better than a corner and
 * better than the viewport centre: the menu appears attached to the thing it
 * acts on, which is the same promise the pointer version makes.
 *
 * `currentTarget` is read synchronously, inside the dispatch, which is the only
 * time React guarantees it is set.
 */
function anchorFor(event: ReactMouseEvent | MouseEvent): MenuAnchorRect {
  // `button === 2` and nothing else, which is a correction made in a browser
  // rather than a guess. The first version of this also accepted "the
  // coordinates are not (0, 0)" as evidence of a pointer, on the theory that a
  // keyboard-fired event carries none — and Chrome carries the LAST MOUSE
  // POSITION instead, measured: Shift+F10 on a node at (28, 443) produced a
  // `contextmenu` with `button: -1` and `clientX/Y` of (188, 500), left over
  // from a right-click somewhere else entirely. A keyboard user would have got
  // the menu wherever they last happened to click.
  if (event.button === 2) return { x: event.clientX, y: event.clientY, width: 0, height: 0 };
  const on = event.currentTarget;
  if (on instanceof Element) {
    const box = on.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * The graph itself, and the two states in which there is no graph to draw.
 *
 * Loading and failure are drawn inside the canvas's own frame rather than in
 * place of the screen, so the header and its controls stay put while a refetch
 * resolves — and a failed read never looks like an empty workflow.
 */
function GraphSurface({
  loading,
  failed,
  error,
  onRetry,
  canEdit,
  draft,
  flowNodes,
  flowEdges,
  onInspect,
  onEditCode,
  onNodesChange,
  onEdgesChange,
  onConnect,
  isValidConnection,
  onConnectEnd,
  onNodeEnter,
  onNodeLeave,
  onPaneClick,
  onDisconnect,
  onOpenMenu,
  wiring,
  wiringRefusal,
  nodeMenu,
  fitPadding,
  focused,
}: {
  loading: boolean;
  failed: boolean;
  error: unknown;
  onRetry: () => void;
  canEdit: boolean;
  draft: Draft;
  flowNodes: WorkflowFlowNode[];
  flowEdges: WorkflowFlowEdge[];
  onInspect: (id: string) => void;
  onEditCode: (id: string) => void;
  onNodesChange: (changes: NodeChange<WorkflowFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WorkflowFlowEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  isValidConnection: (candidate: { source: string | null; target: string | null }) => boolean;
  onConnectEnd: OnConnectEnd;
  onNodeEnter: (id: string) => void;
  onNodeLeave: () => void;
  onPaneClick: () => void;
  /** Reached from the × on a selected edge. The same callback the rail uses. */
  onDisconnect: (edge: WorkflowEdge) => void;
  /**
   * Something on the canvas was right-clicked — or the context-menu key was
   * pressed on it, which is the same event.
   *
   * The anchor travels with the target because only this component can work it
   * out: it is the pointer for a right-click and the focused element's box for a
   * keypress, and by the time the canvas has state to render from, the event is
   * gone.
   */
  onOpenMenu: (target: CanvasMenuTarget, anchor: MenuAnchorRect) => void;
  /** Click-to-click wiring, handed to the nodes and to the line that follows. */
  wiring: WorkflowWiring;
  /** Why the last click was not allowed to close a connection, if it was not. */
  wiringRefusal: string | null;
  /** The wiring menu, which has to be a child of `ReactFlow` to be placed. */
  nodeMenu: ReactNode;
  /**
   * The region the graph is fitted into, as per-side padding.
   *
   * See {@link CHROME}. Without it, `fitView` fits to the whole viewport and
   * puts nodes under the floating panels.
   */
  fitPadding: FitPadding;
  /**
   * Whether focus mode has the screen — read here only by the minimap.
   *
   * Deliberately the MODE and not `cardCollapsed`. The card refuses to fold
   * while the graph has no name, because the field that fixes that is inside
   * it; the overview has no such dependency, so tying it to the refusal would
   * leave the minimap full size for a reason that has nothing to do with it.
   */
  focused: boolean;
}) {
  /*
   * Memoised because they are context values read by every node and every edge
   * on the canvas. Written inline, as they were, each of these was a fresh
   * object on every render of the screen — and this screen now re-renders for
   * things the graph does not care about, like opening the rail. A new context
   * value re-renders every consumer, which on a large graph is every box and
   * every wire, for a panel sliding in at the side.
   */
  const nodeHandlers = useMemo(
    () => ({ onInspect, onEditCode, canEdit, wiring }),
    [onInspect, onEditCode, canEdit, wiring],
  );
  const edgeHandlers = useMemo(() => ({ onDisconnect, canEdit }), [onDisconnect, canEdit]);

  const { screenToFlowPosition } = useReactFlow();

  /**
   * One place that turns a `contextmenu` event into "this thing, anchored here".
   *
   * `preventDefault` is what takes the browser's own menu off the table, and it
   * is called ONLY from the four React Flow handlers below — a node, a wire, a
   * selection, and the pane. Every other right-click on the screen, including
   * every text field in the chrome floating over this canvas, is left entirely
   * alone, because a canvas has nothing better than cut/copy/paste to offer
   * inside an input.
   */
  const openMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent, target: CanvasMenuTarget) => {
      event.preventDefault();
      onOpenMenu(target, anchorFor(event));
    },
    [onOpenMenu],
  );

  return (
    /*
     * The surface IS the screen: pinned to all four edges, with the chrome
     * layered over it by a sibling. Nothing here is a box in a column any more,
     * so there is no border and no rounded corner — a full-bleed canvas that
     * draws its own frame is a canvas pretending to still be a widget.
     */
    <div className="absolute inset-0">
      {loading && <CanvasSkeleton />}

      {failed && <CanvasFailure error={error} onRetry={onRetry} />}

      {!loading && !failed && (
        <WorkflowNodeProvider handlers={nodeHandlers}>
          <WorkflowEdgeProvider handlers={edgeHandlers}>
            <ReactFlow
              className={CANVAS_THEME}
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={workflowNodeTypes}
              edgeTypes={workflowEdgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onConnectEnd={onConnectEnd}
              onNodeMouseEnter={(_event, node) => onNodeEnter(node.id)}
              onNodeMouseLeave={onNodeLeave}
              onPaneClick={onPaneClick}
              onNodeContextMenu={(event, node) =>
                openMenu(event, { kind: 'node', nodeId: node.id })
              }
              onEdgeContextMenu={(event, edge) =>
                openMenu(event, { kind: 'edge', edge: { from: edge.source, to: edge.target } })
              }
              // Several nodes at once gets its own target rather than falling
              // through to whichever node happened to be under the pointer: a
              // menu offering "send its output to" against five boxes would be
              // offering an action whose "its" has no referent.
              onSelectionContextMenu={(event, nodes) =>
                openMenu(event, { kind: 'selection', nodeIds: nodes.map((node) => node.id) })
              }
              // The point is converted to GRAPH coordinates here and not later,
              // because "here" is only meaningful while the viewport is what it
              // was when the click happened — and a menu can sit open across a
              // pan. What the menu carries is the spot, not the pixel.
              onPaneContextMenu={(event) =>
                openMenu(event, {
                  kind: 'pane',
                  at: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
                })
              }
              connectionLineType={ConnectionLineType.SmoothStep}
              // Off, so there is exactly ONE click path through a handle and it
              // is the one in `workflow/wiring.tsx`. React Flow's own click
              // wiring connects but draws nothing while it is open and cannot
              // say why it refused — running both would mean two states
              // disagreeing about whether a wire is in flight.
              connectOnClick={false}
              nodesDraggable={canEdit}
              nodesConnectable={canEdit}
              elementsSelectable
              nodesFocusable
              edgesFocusable
              deleteKeyCode={canEdit ? ['Delete', 'Backspace'] : null}
              // A wider drop zone than the 20px default, because these handles are
              // the only drop target on the screen and missing one reads as the
              // canvas ignoring you.
              connectionRadius={28}
              proOptions={{ hideAttribution: false }}
              ariaLabelConfig={ARIA_LABELS}
              aria-label={`${WORKFLOW_NAME.title} canvas. ${draft.nodes.length} nodes, ${draft.edges.length} connections.`}
              fitView
              fitViewOptions={{ padding: fitPadding }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              {/* Both of React Flow's own overlays moved to the bottom-left
                  corner, stacked. The right edge belongs to the rail now and the
                  bottom centre to the dock, so a minimap left in its default
                  bottom-right corner would sit underneath a panel. Rounded and
                  lifted to match everything else floating here; the colours are
                  still React Flow's variables, which `CANVAS_THEME` themes both
                  ways. */}
              <Controls
                showInteractive={false}
                position="bottom-left"
                className={cn(
                  '!bottom-[9.5rem] !overflow-hidden !rounded-lg !border !border-zinc-200',
                  '!shadow-sm dark:!border-zinc-800 [&>button]:!border-none',
                  // Below `lg` the minimap is gone, so the zoom controls drop
                  // back down into the corner it vacated.
                  '!bottom-0 lg:!bottom-[9.5rem]',
                )}
              />
              <FocusMiniMap focused={focused} />
              <PendingWireLine pending={wiring.pending} />
              <WiringHint
                pending={wiring.pending}
                refusal={wiringRefusal}
                nodes={draft.nodes}
                onCancel={wiring.cancel}
              />
              {nodeMenu}
            </ReactFlow>
          </WorkflowEdgeProvider>
        </WorkflowNodeProvider>
      )}
    </div>
  );
}

/**
 * Which node the wiring control is attached to right now.
 *
 * Three sources, in falling order of intent. An open menu wins outright — it was
 * opened deliberately and must not close because the pointer moved. Then the
 * node under the pointer, which is what makes the control discoverable at all.
 * Then a single selected node, so the control is reachable without a pointer:
 * hover-only affordances are invisible to anybody driving from the keyboard.
 *
 * A single selection only. Several selected nodes would mean several toolbars
 * and a "wire this" offered against an ambiguous "this".
 */
function wiringAnchor(
  nodes: WorkflowNode[],
  menuFor: string | null,
  hovered: string | null,
  selected: string[],
): WorkflowNode | null {
  const wanted = menuFor ?? hovered ?? (selected.length === 1 ? selected[0] : null);
  return nodes.find((node) => node.id === wanted) ?? null;
}

/**
 * Which node the wiring control is on, and everything that moves it.
 *
 * Two pieces of state and not one, and that is the whole subtlety. `hovered` is
 * what makes the control discoverable — a small button appearing on the node
 * under the pointer is the ordinary affordance for this kind of editor, and its
 * absence is the entire reason this canvas felt like it needed prior knowledge
 * of React Flow. `openFor` is what keeps the menu open once it has been opened,
 * because the pointer has to leave the node to reach the menu's own items, and a
 * menu that closed on the way to itself would be unusable.
 *
 * A hook rather than four `useState` calls in the canvas, because these five
 * handlers only make sense together: every one of them is "and therefore the
 * anchor is now …", and split across a 700-line component they read as five
 * unrelated setters.
 */
function useWiringMenu(nodes: WorkflowNode[], selectedNodeIds: string[]) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);

  const anchor = wiringAnchor(nodes, openFor, hovered, selectedNodeIds);
  const anchorId = anchor?.id ?? null;

  const onNodeLeave = useCallback(() => setHovered(null), []);
  const close = useCallback(() => setOpenFor(null), []);
  const reset = useCallback(() => {
    setOpenFor(null);
    setHovered(null);
  }, []);

  return {
    anchor,
    open: openFor !== null && openFor === anchorId,
    onNodeEnter: setHovered,
    onNodeLeave,
    close,
    reset,
    onOpenChange: (next: boolean) => setOpenFor(next ? anchorId : null),
    onHoverChange: (hovering: boolean) => setHovered(hovering ? anchorId : null),
  };
}

/** The problems naming one node, or none when no node is open. */
function problemsOf(
  byNode: Map<string, WorkflowProblem[]>,
  node: WorkflowNode | null,
): WorkflowProblem[] {
  return node ? (byNode.get(node.id) ?? []) : [];
}

/** A node's display name, falling back to its id when it is not in the graph. */
function nodeLabelIn(nodes: WorkflowNode[], id: string): string {
  const found = nodes.find((candidate) => candidate.id === id);
  return found ? nodeName(found) : id;
}

/**
 * What this graph commits, read off the sinks.
 *
 * A summary and never a control. The type is set on the sink that commits it,
 * because a graph may have several sinks writing several types and a single
 * field at the top of the screen could only ever name one of them.
 */
function CommitsBadge({ produces }: { produces: string[] }) {
  if (produces.length === 0) return null;
  return (
    <Tooltip
      content={`Read off the sinks. Each one commits its own type independently — a run that writes ${produces[0]} and fails on another is a failed run that committed ${produces[0]}, not a success.`}
    >
      <span className={cn('font-mono text-[10px]', MUTED)}>commits {produces.join(', ')}</span>
    </Tooltip>
  );
}

/** Where React Flow moved nodes to, and which it removed, out of one batch. */
function nodeMovesAndRemovals(changes: NodeChange<WorkflowFlowNode>[]): {
  positions: Map<string, { x: number; y: number }>;
  removed: Set<string>;
} {
  const positions = new Map<string, { x: number; y: number }>();
  const removed = new Set<string>();
  for (const change of changes) {
    if (change.type === 'position' && change.position) {
      positions.set(change.id, change.position);
    }
    if (change.type === 'remove') removed.add(change.id);
  }
  return { positions, removed };
}

/**
 * The transforms a graph actually names.
 *
 * Only these, because the run history's `code v3` can be turned into a
 * comparison only when there is exactly one candidate: a run records ONE
 * transform version, a graph may run three in a row, and picking whichever the
 * screen loaded first would offer a diff against the wrong code.
 */
function transformsNamedBy(
  nodes: WorkflowNode[],
  transforms: CatalogTransform[],
): CatalogTransform[] {
  const named = new Set(
    nodes.flatMap((node) =>
      node.kind === 'transform' && node.transformId ? [node.transformId] : [],
    ),
  );
  return transforms.filter((transform) => named.has(transform.id));
}

/**
 * What a run did, said out loud once.
 *
 * Not "succeeded or failed": a graph may commit several types at several sinks,
 * each independently, so the overall status is only the headline and the reader
 * is sent to the per-sink list for what actually landed.
 */
function runAnnouncement(result: WorkflowRun): string {
  if (result.status === 'succeeded') {
    return 'The run finished. Check each sink below for what it committed.';
  }
  return `The run ${result.status}. ${result.error ?? ''}`;
}

/** What a publish or an unpublish changed, for somebody who cannot see the badge. */
function lifecycleAnnouncement(saved: CatalogWorkflow): string {
  return saved.status === 'ready'
    ? 'Published. It is now ready, and runs as a connector of its own.'
    : 'Back to draft. Nothing runs it until it is published again.';
}

/**
 * The stored graph behind a draft, when the draft has been stored at all.
 *
 * A lookup rather than state of its own, so that publishing — which changes the
 * status and mints the connector everything else is keyed on — reaches the
 * badge, the schedule panel and the "Runs as" panel through one path instead of
 * three copies going out of step.
 */
function storedWorkflow(
  list: CatalogWorkflow[] | undefined,
  id: string | undefined,
): CatalogWorkflow | undefined {
  if (!id) return undefined;
  return list?.find((workflow) => workflow.id === id);
}

/**
 * Whether a source node can be asked what its columns are, and why not.
 *
 * Discovery reads the node the SERVER has, so the two states it cannot run in
 * are "never saved" and "saved, but not like this". **Neither of them is
 * "unpublished"**, and that is the whole point of the route: a sink cannot
 * commit into a type that does not exist, so requiring a published graph would
 * require publishing a graph whose target type cannot be created until it is.
 * The reasons therefore name saving and never publishing — a reader told to
 * publish first would go and do it, and find they cannot.
 */
type DiscoveryTarget = { workflowId: string } | { workflowId?: undefined; because: string };

/**
 * The refusal, and the way out of it, travelling together.
 *
 * They are one prop rather than three because they are one thought: both reasons
 * discovery can be refused are "save it first", and a panel that states the
 * condition without carrying the remedy is what produced the report that started
 * this — the sentence said "Save first" while the save control was in a header
 * behind the side sheet the sentence was printed in.
 */
type DiscoveryOffer = DiscoveryTarget & {
  /** Save the draft from wherever the refusal is being shown. */
  onSave: () => void;
  /** Whether that save is in flight. */
  saving: boolean;
};

function discoveryTarget(draft: Draft): DiscoveryTarget {
  if (!draft.id) {
    return {
      because: `Save this ${WORKFLOW_NAME.singular} first — discovery reads the stored node, and there is nothing stored yet. It does not need to be published.`,
    };
  }
  if (draft.dirty) {
    return {
      because:
        'Save first — discovery reads the stored node, so it would describe the source as it was before these edits.',
    };
  }
  return { workflowId: draft.id };
}

/**
 * Whether an edit changed where this node reads from, or only what it is
 * called.
 *
 * The question a discovered shape's shelf life turns on. Everything compared
 * here is part of the address the server would dial — the kind of system, the
 * connection it borrows, whether it reads the lot or from a watermark, and the
 * config that holds the URL or the statement. A name, a position and a
 * selection are none of those, and dropping the columns for one of them would
 * make the check disappear for the most ordinary edit there is.
 *
 * `config` is compared as JSON because it is an open record — both sides are
 * built by `sourceConfigFrom`, so the key order is stable, and the failure mode
 * of a false difference is silence rather than a wrong answer.
 */
function readsDifferently(before: WorkflowNode | undefined, after: WorkflowNode): boolean {
  if (before?.kind !== 'source' || after.kind !== 'source') return false;
  return (
    before.sourceKind !== after.sourceKind ||
    before.connectionId !== after.connectionId ||
    before.mode !== after.mode ||
    JSON.stringify(before.config ?? {}) !== JSON.stringify(after.config ?? {})
  );
}

function Canvas({
  title = WORKFLOW_NAME.titlePlural,
  eyebrow = 'Ingestion',
  intro = 'Wire sources through transforms into sinks. Each sink commits its own object type independently, so one expensive read can feed several outputs.',
  canEdit = true,
  modelHref,
}: WorkflowCanvasProps) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const { fitView } = useReactFlow();

  const workflows = useQuery({
    queryKey: catalogQueryKeys.workflows,
    queryFn: () => client.listWorkflows(),
  });
  const { data: transforms = [] } = useQuery({
    queryKey: catalogQueryKeys.transforms,
    queryFn: () => client.listTransforms(),
    staleTime: 30_000,
  });
  const { data: connections = [] } = useQuery({
    queryKey: catalogQueryKeys.connections,
    queryFn: () => client.listConnections(),
    staleTime: 30_000,
  });
  const { data: capabilities } = useQuery({
    queryKey: catalogQueryKeys.capabilities,
    queryFn: () => client.pipelineCapabilities(),
    // Which languages an image can execute, and whether a durable engine is
    // wired up, cannot change without a redeploy — and a redeploy reloads the
    // page. Refetching would be a request that can only return the same answer.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const { data: snapshot } = useQuery({
    queryKey: catalogQueryKeys.snapshot,
    queryFn: () => client.snapshot(),
    staleTime: 30_000,
  });

  const [selected, setSelected] = useState<string>('');
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [editingCodeFor, setEditingCodeFor] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /**
   * Whether the "throw away every unsaved edit" dialog is open.
   *
   * Held here rather than inside the controls because Reset is destructive of
   * work in exactly the way deleting the workflow is destructive of the
   * workflow, and this screen keeps every "are you sure" at the level that owns
   * the thing being destroyed.
   */
  const [resetting, setResetting] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  /**
   * Whether the details rail is on screen.
   *
   * Open by default where there is room for it, and that default is the answer
   * to "the problems have to stay visible": they are visible, in full, from the
   * first paint on any screen that can afford 19rem. Closing it is a choice
   * somebody makes to get the room back, and the toggle then carries the problem
   * count so the *fact* of a problem never depends on the panel being open.
   *
   * Read once, from the width at mount, rather than subscribed to. A live media
   * query would reopen a panel somebody had just closed because they turned
   * their tablet, which is worse than the panel being open on a narrow screen
   * they can shut it on. `globalThis.innerWidth` guards the case where there is
   * no window at all — this component is rendered on a server by anybody using
   * SSR, and a bare `window` there is a crash rather than a layout bug.
   */
  const [railOpen, setRailOpen] = useState(railOpenByDefault);

  const { focused, toggleFocus } = useFocusMode(railOpen, setRailOpen);
  const cardCollapsed = focusCollapsesTheCard(focused, draft.name);

  /**
   * The region of the viewport the graph should be fitted into.
   *
   * See {@link CHROME}. Two sides move: the right with the rail, the top with
   * the card's collapse.
   *
   * Declared up here with the state rather than beside its use, because both
   * `fitView` call sites below name it in a dependency array — and a `const` read
   * by a hook that runs earlier in the body is a temporal-dead-zone crash, not a
   * lint warning.
   *
   * Toggling the rail deliberately does NOT re-fit, and neither does entering
   * focus. That would throw away a viewport somebody had panned to, in response
   * to an action about a panel; the new padding applies at the next fit that was
   * going to happen anyway — opening a graph, or pressing Tidy. Focus is the
   * stronger case for the same rule: somebody who has just asked for room is
   * looking at a particular part of the graph, and jumping the viewport is the
   * one thing that would lose it.
   */
  const fitPadding = useMemo<FitPadding>(
    () => chromeFitPadding(railOpen, cardCollapsed),
    [railOpen, cardCollapsed],
  );
  /**
   * Whether the "this load is expected to shrink" dialog is open.
   *
   * Here rather than inside `RunControls` because there are two ways in and only
   * one of them is a button in that row: the other is the refusal note under the
   * canvas, which is where somebody who has just watched a load be turned away is
   * actually looking.
   */
  const [acknowledging, setAcknowledging] = useState(false);
  /**
   * Nodes added in this session that nobody has done anything to yet.
   *
   * The whole argument is on `partitionProblems`. What matters here is that this
   * is component state and nothing else: it is not saved, not sent, and not
   * restored, because a node that arrives from the server is by definition one
   * somebody finished with.
   */
  const [unstarted, setUnstarted] = useState<ReadonlySet<string>>(() => new Set<string>());
  /**
   * What discovery said each source node reads, for the source nodes somebody
   * has actually asked about in this session.
   *
   * Component state for the same reason `unstarted` is, and kept HERE rather
   * than inside `SchemaDiscoveryPanel` because that panel is unmounted with the
   * inspector: the columns somebody just read would be gone by the time they
   * looked at the Problems rail, which is where the comparison in
   * `workflow/shape.ts` is drawn. The panel tells this through `onDiscovered`.
   *
   * Empty is the state every graph starts in, and it means "nobody asked" — not
   * "nothing to report". That distinction is the whole basis of the column
   * checks, and it survives here because the map is only ever written by a
   * discovery somebody ran.
   */
  const [shapesByNode, setShapesByNode] = useState<ReadonlyMap<string, SourceShape>>(
    () => new Map(),
  );

  /**
   * The last thing the canvas refused, and the last thing it did.
   *
   * One string, announced politely, because a canvas gives no other feedback to
   * somebody who cannot see it: a refused drag is silence, and a node added off
   * screen is silence too.
   */
  const [announcement, setAnnouncement] = useState('');

  /**
   * What was right-clicked, and where the menu should hang.
   *
   * One piece of state for both, because they are one event: the anchor is the
   * pointer for a right-click and the focused element's box for the context-menu
   * key, and neither survives the event that carried it.
   */
  const [contextMenu, setContextMenu] = useState<{
    target: CanvasMenuTarget;
    anchor: MenuAnchorRect;
  } | null>(null);

  const menu = useWiringMenu(draft.nodes, selectedNodeIds);

  /**
   * Which workflow the draft was built from.
   *
   * A ref rather than state so that a background refetch — which produces a new
   * array with the same ids — does not re-enter the load branch and throw away
   * everything somebody has moved since.
   */
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    const list = workflows.data;
    if (!list) return;
    const wanted = wantedWorkflowId(list, selected);
    if (loadedRef.current === wanted) return;
    loadedRef.current = wanted;
    if (selected !== wanted) setSelected(wanted);
    setDraft(draftForId(list, wanted));
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setInspecting(null);
    setRun(null);
    // Everything in a freshly loaded draft came off the server, so nothing in it
    // is "not finished yet" — see `partitionProblems`.
    setUnstarted(new Set<string>());
    // A discovered shape belongs to the node it was read for, and node ids do
    // not cross graphs. Keeping the map would be this screen holding one graph's
    // columns while drawing another's — silence is the right state on arrival.
    setShapesByNode(new Map());
    // A menu is about something in the graph that was on screen. Left open
    // across a swap it would offer to disconnect wires that no longer exist.
    setContextMenu(null);
    menu.reset();
  }, [workflows.data, selected, menu.reset]);

  // Fit after the graph swaps, on the frame after the new nodes have been laid
  // out. Calling it in the same tick fits an empty canvas, because React Flow
  // has not measured anything yet.
  const draftId = draft.id;
  // `draftId` is the trigger, not a value the body reads — which is exactly why
  // the rule calls it unnecessary. Dropping it would fit the view once on mount
  // and never again, leaving every workflow opened afterwards off-screen.
  // `fitPadding` is read by the body but deliberately kept OUT of the deps: it
  // changes when the rail is toggled, and re-fitting there would yank the
  // viewport away from wherever somebody had panned to, as the side effect of
  // opening a panel. The padding it fits with is whatever is current at the next
  // graph swap, which is the moment a fit is wanted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftId is what the effect watches for, not something its body uses; fitPadding is read but must not re-trigger it
  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      fitView({ padding: fitPadding, duration: 200 }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [draftId, fitView]);

  /**
   * Every change to the drawing, through one door — and every one of them
   * recorded so it can be taken back.
   *
   * The action is REQUIRED rather than optional, which is the only thing keeping
   * the undo announcement honest: a default would let a new call site add an
   * entry that reverts something and says nothing about what.
   *
   * It may be a function of the current draft, for the labels that need to name
   * a node. Computing those here would mean this callback depends on
   * `draft.nodes` and is rebuilt on every graph change, which React Flow feels;
   * computing them inside the updater keeps the dependency list empty and keeps
   * the whole thing pure.
   */
  const edit = useCallback(
    (change: (current: Draft) => Draft, action: EditAction | ((current: Draft) => EditAction)) => {
      setDraft((current) =>
        withEdit(current, change(current), typeof action === 'function' ? action(current) : action),
      );
    },
    [],
  );

  const transformIds = useMemo(
    () => new Set(transforms.map((transform) => transform.id)),
    [transforms],
  );

  /**
   * The two halves of the column check, or nothing at all.
   *
   * `undefined` until a discovery has actually been run on this graph, and that
   * is the load-bearing part rather than an optimisation: an implementation
   * whose `sourceShape` always answered `undefined` would look like an answer
   * and report the same silence, and `shape.ts` is written on the assumption
   * that being handed a {@link ShapeKnowledge} means somebody can answer with
   * it. An empty map is "nobody asked", and it says so by being absent.
   *
   * The types come from the snapshot this screen already holds, so the catalog
   * half costs no request. A snapshot that has not arrived yet answers nothing,
   * which reads as "this console cannot see that type" for the one render
   * before it does — a warning, never an error, which is exactly the outcome a
   * momentarily-unknown type deserves.
   */
  const shapes = useMemo<ShapeKnowledge | undefined>(() => {
    if (shapesByNode.size === 0) return undefined;
    const types = new Map((snapshot?.types ?? []).map((type) => [type.name, type]));
    return {
      sourceShape: (nodeId) => shapesByNode.get(nodeId),
      targetShape: (typeName) => types.get(typeName),
    };
  }, [shapesByNode, snapshot]);

  const problems = useMemo(
    () => validateWorkflow({ nodes: draft.nodes, edges: draft.edges }, { transformIds, shapes }),
    [draft.nodes, draft.edges, transformIds, shapes],
  );
  /**
   * The same checks, split by whether the node they name is finished.
   *
   * `live` is what the canvas draws in red and what the Problems list says.
   * `pending` is the same data presented as outstanding work. Nothing is thrown
   * away — see `partitionProblems`, and note that `blocked` below is still
   * computed from `problems`, not from `live`.
   */
  const { live, pending } = useMemo(
    () => partitionProblems(problems, unstarted),
    [problems, unstarted],
  );
  const problemsFor = useMemo(() => problemsByNode(live), [live]);
  const pendingFor = useMemo(() => problemsByNode(pending), [pending]);
  const brokenEdgeIds = useMemo(() => new Set(live.flatMap((problem) => problem.edgeIds)), [live]);
  const runFor = useMemo(
    () => new Map((run?.nodes ?? []).map((node) => [node.nodeId, node])),
    [run],
  );

  const describe = useMemo<NodeDescriptions>(
    () => ({
      transformName: (id) => (id ? transforms.find((t) => t.id === id)?.name : undefined),
      connectionName: (id) => (id ? connections.find((c) => c.id === id)?.name : undefined),
    }),
    [transforms, connections],
  );

  const flowNodes = useMemo<WorkflowFlowNode[]>(() => {
    const selectedIds = new Set(selectedNodeIds);
    return toFlowNodes(draft.nodes, draft.edges, describe, problemsFor, runFor).map((node) => ({
      ...node,
      selected: selectedIds.has(node.id),
    }));
  }, [draft.nodes, draft.edges, describe, problemsFor, runFor, selectedNodeIds]);

  // `useReducedMotion` returns null until it has asked, which is neither yes nor
  // no; coerced here because every consumer of it wants the boolean, and the
  // safe reading of "has not answered yet" is "do not animate".
  const reducedMotion = useReducedMotion() !== false;
  const flowing = useMemo(
    () => flowingEdgeIds(draft.edges, run?.nodes ?? [], { reducedMotion }),
    [draft.edges, run, reducedMotion],
  );

  const flowEdges = useMemo<WorkflowFlowEdge[]>(() => {
    const selectedIds = new Set(selectedEdgeIds);
    return toFlowEdges(draft.edges, draft.nodes, brokenEdgeIds, flowing).map((edge) => ({
      ...edge,
      selected: selectedIds.has(edge.id),
    }));
  }, [draft.edges, draft.nodes, brokenEdgeIds, selectedEdgeIds, flowing]);

  /**
   * React Flow's changes, applied to the stored model rather than to a second
   * copy of the graph.
   *
   * The alternative — `useNodesState` holding React Flow's own nodes as the
   * source of truth — means two representations of the same graph that have to
   * be kept in step, and the bug that produces is a saved workflow whose wiring
   * does not match what was on screen.
   */
  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      setSelectedNodeIds((current) => nextSelection(current, changes));

      const { positions, removed } = nodeMovesAndRemovals(changes);
      if (positions.size === 0 && removed.size === 0) return;

      // The drag's own answer to "is this still one gesture". React Flow sets it
      // on every frame while the pointer is down and clears it on the frame that
      // drops the node, so a drag across the canvas is one undo step however
      // many hundred position changes it emitted and however long it took.
      const dragging = changes.some(
        (change) => change.type === 'position' && change.dragging === true,
      );

      edit(
        (current) => ({
          ...current,
          nodes: current.nodes
            .filter((node) => !removed.has(node.id))
            .map((node) => {
              const position = positions.get(node.id);
              return position ? { ...node, position } : node;
            }),
          // A removed node takes its wiring with it. Leaving the edges behind
          // would produce edges pointing at nothing, which React Flow silently
          // drops from the canvas while the save still sends them.
          edges: current.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
        }),
        (current) =>
          removed.size > 0
            ? // A deletion is never folded into a move: it is the one change on
              // this canvas somebody is most likely to want back, and it must
              // not disappear into the drag that happened just before it.
              { label: `deleting ${namesOf(current.nodes, removed)}` }
            : {
                label: `moving ${namesOf(current.nodes, positions.keys())}`,
                run: 'move',
                continuing: dragging,
              },
      );

      if (removed.size > 0) {
        // Housekeeping, not a rule: a node that no longer exists cannot be
        // unfinished, and leaving its id behind would hold back a later node
        // that happened to be given the same one.
        setUnstarted((current) => without(current, [...removed]));
        setAnnouncement(
          `${removed.size} node${removed.size === 1 ? '' : 's'} removed, along with their connections.`,
        );
      }
    },
    [edit],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowFlowEdge>[]) => {
      setSelectedEdgeIds((current) => nextSelection(current, changes));
      const removed = new Set(
        changes.filter((change) => change.type === 'remove').map((c) => c.id),
      );
      if (removed.size === 0) return;
      edit(
        (current) => ({
          ...current,
          edges: current.edges.filter((edge) => !removed.has(edgeId(edge))),
        }),
        {
          label: `removing ${removed.size} connection${removed.size === 1 ? '' : 's'}`,
        },
      );
      setAnnouncement(`${removed.size} connection${removed.size === 1 ? '' : 's'} removed.`);
    },
    [edit],
  );

  /**
   * Somebody has acted on these nodes, so their checks stop being held back.
   *
   * Called from every path that changes a node or its wiring *after* it exists.
   * Deliberately not called for a position change: dragging a box arranges the
   * picture and says nothing about whether its author is done with it, and none
   * of the checks read a position anyway.
   */
  const markStarted = useCallback((...ids: string[]) => {
    setUnstarted((current) => without(current, ids));
  }, []);

  /**
   * A discovery landed, so the column check has something to say about this
   * node.
   *
   * The response is stored as-is: `ConnectorSchemaDiscovery` already IS a
   * {@link SourceShape} — same `columns`, same `basis`, same `sampled` — and
   * that is not a coincidence worth papering over with a conversion. The two
   * were written against the same route. A mapping function here would be a
   * place for the two to quietly drift, and would have to invent an answer for
   * every field it did not copy.
   */
  const rememberShape = useCallback((nodeId: string, shape: SourceShape) => {
    setShapesByNode((current) => new Map(current).set(nodeId, shape));
  }, []);

  /** The columns on file stop describing this node. See the caller. */
  const forgetShape = useCallback((nodeId: string) => {
    setShapesByNode((current) => {
      if (!current.has(nodeId)) return current;
      const next = new Map(current);
      next.delete(nodeId);
      return next;
    });
  }, []);

  const disconnect = useCallback(
    (edge: WorkflowEdge) => {
      const id = edgeId(edge);
      edit(
        (current) => ({
          ...current,
          edges: current.edges.filter((candidate) => edgeId(candidate) !== id),
        }),
        (current) => ({
          label: `disconnecting ${namesOf(current.nodes, [edge.from])} from ${namesOf(
            current.nodes,
            [edge.to],
          )}`,
        }),
      );
      markStarted(edge.from, edge.to);
      setAnnouncement('Connection removed.');
    },
    [edit, markStarted],
  );

  /**
   * Take nodes out, and say what went with them.
   *
   * The one path every deliberate node removal goes through — the hover
   * toolbar's button, the context menu's item, the selection menu, and the
   * inspector's "Remove this node". The Delete key reaches the same graph change
   * through React Flow's own change stream above, which labels its undo entry
   * the same way.
   *
   * The label is the FUNCTION form so it can name the node out of `current`, and
   * a deletion always opens its own entry rather than folding into whatever came
   * before it — it is the change somebody is most likely to want back, and it
   * must not disappear into the drag that happened a moment earlier.
   *
   * What this adds over the graph change itself is the sentence. Undo makes a
   * removal recoverable; it does not make it *visible* that a node took two
   * other nodes' wiring with it, and nothing else on the screen says so.
   */
  const dropNodes = useCallback(
    (ids: string[]) => {
      const { said } = removeNodes(draft.nodes, draft.edges, ids);
      if (ids.length === 0) return;
      edit(
        (current) => {
          const after = removeNodes(current.nodes, current.edges, ids);
          return { ...current, nodes: after.nodes, edges: after.edges };
        },
        (current) => ({ label: `deleting ${namesOf(current.nodes, ids)}` }),
      );
      setUnstarted((current) => without(current, ids));
      setAnnouncement(`${said} Ctrl+Z takes it back.`);
    },
    [draft.nodes, draft.edges, edit],
  );

  const forgetMenu = useCallback(() => setContextMenu(null), []);

  /**
   * Put a wire on the other side of its gate.
   *
   * Announced, like every other wiring change on this screen, because the only
   * visible effect is a word on a line the reader may not be looking at — and
   * moving a wire from `then` to `else` is one of the largest changes anybody
   * can make here: it inverts which half of the pipeline runs.
   */
  const setBranch = useCallback(
    (edge: WorkflowEdge, branch: WorkflowBranchLabel) => {
      edit(
        (current) => ({ ...current, edges: edgeOnBranch(current.edges, edge, branch) }),
        (current) => ({
          label: `putting ${namesOf(current.nodes, [edge.to])} on the "${branch}" branch`,
        }),
      );
      markStarted(edge.from, edge.to);
      setAnnouncement(
        `${nodeLabelIn(draft.nodes, edge.to)} is now on the "${branch}" branch of ${nodeLabelIn(
          draft.nodes,
          edge.from,
        )}.`,
      );
    },
    [draft.nodes, edit, markStarted],
  );

  const connect = useCallback(
    (from: string, to: string) => {
      const verdict = canConnect(draft.nodes, draft.edges, from, to);
      if (!verdict.ok) {
        setAnnouncement(verdict.reason);
        return;
      }
      // Appended rather than inserted anywhere else: a node with several inbound
      // edges receives its inputs in the order the edges appear in this array,
      // and that order is part of what the graph produces.
      edit(
        (current) => ({
          ...current,
          edges: [...current.edges, newEdge(current.nodes, current.edges, from, to)],
        }),
        (current) => ({
          label: `connecting ${namesOf(current.nodes, [from])} to ${namesOf(current.nodes, [to])}`,
        }),
      );
      markStarted(from, to);
      setAnnouncement(
        `${nodeLabelIn(draft.nodes, from)} now feeds ${nodeLabelIn(draft.nodes, to)}.`,
      );
    },
    [draft.nodes, draft.edges, edit, markStarted],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // Narrowed rather than trusted: React Flow types both ends as `string`
      // but a connection dropped on empty canvas arrives with no target on
      // some paths, and an edge with an empty id renders as a line to nowhere.
      if (!connection.source || !connection.target) return;
      connect(connection.source, connection.target);
    },
    [connect],
  );

  /**
   * Why a drag was refused, said once at the end of it.
   *
   * At the end rather than on every pointer move, which would set state dozens
   * of times a second while somebody is still deciding where to drop. The
   * boolean half of this lives in `isValidConnection` below.
   */
  const announceRefusedDrop = useCallback<OnConnectEnd>(
    (_event, state) => {
      if (state.isValid !== false) return;
      const from = state.fromNode?.id;
      const to = state.toNode?.id;
      if (!from || !to) return;
      const verdict = canConnect(draft.nodes, draft.edges, from, to);
      if (!verdict.ok) setAnnouncement(verdict.reason);
    },
    [draft.nodes, draft.edges],
  );

  /**
   * The while-drawing check.
   *
   * Boolean only, and asked on every pointer move, so it cannot be where the
   * explanation lives — React Flow uses the answer to put a valid/invalid class
   * on the handle under the cursor, which is what makes an illegal drop refuse
   * itself visibly before the mouse is released. The sentence comes from
   * `onConnectEnd`, below, using the same function.
   */
  const isValidConnection = useCallback(
    (candidate: { source: string | null; target: string | null }) => {
      if (!candidate.source || !candidate.target) return false;
      return canConnect(draft.nodes, draft.edges, candidate.source, candidate.target).ok;
    },
    [draft.nodes, draft.edges],
  );

  /**
   * Wiring by clicking twice, which is the gesture people actually reach for.
   *
   * Built on the same `connect` the menu, the rail and the drag all end in, so
   * there is one place a connection is made and one place it is refused. Why
   * React Flow's own `connectOnClick` is turned off in favour of this — it
   * connects but draws nothing, and cannot say why it refused — is written out
   * at the top of `workflow/wiring.tsx`.
   */
  const { wiring, refusal: wiringRefusal } = useClickWiring({
    canEdit,
    nodes: draft.nodes,
    edges: draft.edges,
    onConnect: connect,
    onSay: setAnnouncement,
  });

  const save = useMutation({
    mutationFn: () =>
      client.saveWorkflow({
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        nodes: draft.nodes,
        edges: draft.edges,
      }),
    onSuccess: (saved) => {
      loadedRef.current = saved.id;
      setSelected(saved.id);
      setDraft(draftFrom(saved));
      setAnnouncement(`Saved. This is now v${saved.version}.`);
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
    },
  });

  const runIt = useMutation({
    // The options are the run's, not the graph's, and `expectShrink` is the one
    // that matters: it is the acknowledgement that lets a deliberately
    // collapsing load past the row-count bound, it reaches the server only
    // through this route, and it is stored nowhere — which is the only reliable
    // way to keep a one-time acknowledgement from becoming a standing one.
    mutationFn: ({ id, options }: { id: string; options: WorkflowRunOptions | undefined }) =>
      client.runWorkflow(id, options),
    onSuccess: (result) => {
      setRun(result);
      // The answer to a run is written in the rail, so a run that finishes while
      // the rail is put away would report itself into a panel nobody can see.
      // Pressing Run is the clearest possible statement that somebody wants the
      // outcome, so this is the one place the screen opens it on their behalf.
      setRailOpen(true);
      // A run writes rows, so the catalog snapshot every other screen reads is
      // now stale. Invalidating it here is what stops the object explorer
      // showing yesterday's counts beside a run that just finished.
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.snapshot });
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
      // The run is recorded against the connector, which is where the history
      // and the last-run fields live. Left stale, the "Runs as" panel shows a
      // pipeline that has never run beside a run that just finished.
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.runs() });
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connectors });
      setAnnouncement(runAnnouncement(result));
    },
  });

  // `id` is narrowed by the controls, which are disabled without one — the empty
  // string here is unreachable and is what keeps this a plain call rather than a
  // second guard the button already applies.
  const runNow = useCallback(
    (options?: WorkflowRunOptions) => {
      runIt.mutate({ id: draft.id ?? '', options });
    },
    [draft.id, runIt.mutate],
  );

  /**
   * Write the first transform without leaving the canvas.
   *
   * The detour this removes: leave the graph, go to Transforms, write one, come
   * back, find the node again, pick it. On a deployment with no transforms at
   * all that detour was not a convenience problem — the picker offered a choice
   * that did not exist and the screen gave no hint that the way out was on
   * another tab.
   *
   * Created here rather than by opening `TransformEditor` empty, because the
   * editor reports that it saved and not *what* it saved: its `onSaved` takes no
   * argument, so the canvas would have no id to put on the node and the person
   * would come back to the same empty picker. One `saveTransform` gives an id,
   * which goes on the node, and the editor then opens on a transform that
   * exists.
   *
   * The new transform is named after the node so the two are findable from each
   * other, and its code is the identity — return the batch unchanged. That runs,
   * commits, and is the smallest thing that is not a placeholder;
   * `TransformEditor`'s own starters teach the shape of a mapping and belong
   * where somebody chose to write one, not where somebody clicked past a dead
   * end.
   */
  const createTransform = useMutation({
    mutationFn: async (nodeId: string) => {
      const created = await client.saveTransform(
        starterTransform(
          draft.nodes.find((candidate) => candidate.id === nodeId),
          capabilities?.languages,
        ),
      );
      return { nodeId, created };
    },
    onSuccess: ({ nodeId, created }) => {
      edit(
        (current) => ({
          ...current,
          nodes: runningTransform(current.nodes, nodeId, created.id),
        }),
        // Only the half of this that lives in the draft. The transform itself
        // was created on the server and stays there — undoing this unpicks the
        // node from it, which is the part of the act this canvas owns.
        (current) => ({
          label: `pointing ${namesOf(current.nodes, [nodeId])} at "${created.name}"`,
        }),
      );
      markStarted(nodeId);
      // Written into the cache as well as invalidated: the code sheet below
      // resolves the transform out of this list, and opening it before the
      // refetch lands would tell somebody the node names no transform one click
      // after they created one.
      queryClient.setQueryData<CatalogTransform[]>(catalogQueryKeys.transforms, (current) => [
        ...(current ?? []),
        created,
      ]);
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.transforms });
      setEditingCodeFor(nodeId);
      setAnnouncement(
        `"${created.name}" was created and this node now runs it. Its code is open — it returns the batch unchanged until you change it.`,
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteWorkflow(id),
    onSuccess: () => {
      setConfirmingDelete(false);
      loadedRef.current = null;
      setSelected('');
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
    },
  });

  /**
   * Add a node, somewhere.
   *
   * `at` is what the right-click menu supplies and the dock does not, and the
   * difference is the whole reason "add a node here" is worth having: the dock's
   * buttons have no idea where anybody is looking, so `nextPosition` correctly
   * puts a node past the right-hand edge of everything that exists. Somebody who
   * has just pointed at a patch of empty canvas has said exactly where they want
   * it, and putting it anywhere else reads as the menu ignoring them.
   *
   * `freeSpot` still applies to the pointer position, so a click on a spot that
   * is already occupied — easy to do at low zoom — drops the node below it
   * rather than on top of it.
   */
  const addNode = useCallback(
    (kind: WorkflowNodeKind, at?: { x: number; y: number }) => {
      const id = newLocalId(kind);
      edit(
        (current) => {
          const node = newNodeOfKind(
            kind,
            id,
            at ? freeSpot(current.nodes, at) : nextPosition(current.nodes),
            uniqueName(current.nodes, kind),
          );
          return { ...current, nodes: [...current.nodes, node] };
        },
        { label: `adding a ${kind} node` },
      );
      setUnstarted((current) => new Set([...current, id]));
      setInspecting(id);
      setAnnouncement(`A ${kind} node was added. Its inspector is open.`);
    },
    [edit],
  );

  /**
   * Make the next node and wire it in, as one action.
   *
   * The thing the canvas could not do. Adding a node and connecting it were two
   * separate gestures, the second of which was a drag between two handles — an
   * interaction that is perfectly discoverable to somebody who already knows it
   * is there, and invisible to everybody else.
   *
   * The edge made here is part of the node's *creation*, which is why the new
   * node still goes into `unstarted`: nobody has acted on it, they have only
   * brought it into being. Wiring it *afterwards* is what counts as acting on
   * it, and that path goes through `connect`.
   *
   * The verdict is asked even though the menu only offers legal kinds, because
   * the menu asking one question and the action taking another answer is the
   * class of bug that puts an illegal edge in a saved graph.
   */
  const connectToNew = useCallback(
    (fromId: string, kind: WorkflowNodeKind) => {
      const made = nodeWiredFrom(draft, fromId, kind);
      if (!made.ok) {
        if (made.reason) setAnnouncement(made.reason);
        return;
      }
      const { node, from } = made;
      edit(
        (current) => ({
          ...current,
          nodes: [...current.nodes, node],
          edges: [...current.edges, newEdge(current.nodes, current.edges, fromId, node.id)],
        }),
        // ONE entry, for two graph changes. The node and the wire are a single
        // gesture — "put the next box here" — and undoing them separately would
        // leave a node somebody never asked for on its own on the canvas.
        { label: `adding ${nodeName(node)} wired from ${nodeName(from)}` },
      );
      setUnstarted((current) => new Set([...current, node.id]));
      menu.close();
      setInspecting(node.id);
      setAnnouncement(
        `${nodeName(node)} was added and ${nodeName(from)} now feeds it. Its inspector is open.`,
      );
    },
    [draft, edit, menu.close],
  );

  /**
   * Put a node in the middle of a wire that already exists.
   *
   * `A → B` becomes `A → new → B` in one action. Four gestures before this, one
   * of which was undoing the connection you already had — and the graph passed
   * through a state in which it was broken, so the checks fired at somebody
   * halfway through a perfectly ordinary edit.
   *
   * All the care lives in `graphWithNodeBetween`: the branch label travels with
   * the first half, and the two new wires go in at the index the old one held so
   * the order of a join's inputs is not silently swapped. ONE undo entry, for
   * three graph changes, on the argument `connectToNew` already makes — it is
   * one gesture, and taking the pieces back separately would leave a node
   * nobody asked for stranded on a wire that no longer exists.
   */
  const insertBetween = useCallback(
    (edge: WorkflowEdge, kind: WorkflowNodeKind) => {
      // Made once, out here. An updater React chose to replay would otherwise
      // mint a second node with a second id, and the one this function then
      // announced and opened would not be the one on the canvas.
      const node = nodeBetween(edge, kind, draft.nodes);
      edit(
        (current) => {
          const next = graphWithNodeBetween(edge, node, current.nodes, current.edges);
          return { ...current, nodes: next.nodes, edges: next.edges };
        },
        (current) => ({
          label: `putting ${nodeName(node)} between ${namesOf(current.nodes, [
            edge.from,
          ])} and ${namesOf(current.nodes, [edge.to])}`,
        }),
      );
      setUnstarted((current) => new Set([...current, node.id]));
      markStarted(edge.from, edge.to);
      setInspecting(node.id);
      setAnnouncement(
        `${nodeName(node)} was put between ${nodeLabelIn(draft.nodes, edge.from)} and ${nodeLabelIn(
          draft.nodes,
          edge.to,
        )}. Its inspector is open.`,
      );
    },
    [draft.nodes, edit, markStarted],
  );

  const tidy = useCallback(() => {
    edit(
      (current) => ({
        ...current,
        nodes: layout(current.nodes, current.edges),
      }),
      // One entry, and a big one: Tidy moves every node at once, and it is
      // precisely the control somebody presses on a layout they had arranged by
      // hand and then wants back.
      { label: 'tidying the layout' },
    );
    window.requestAnimationFrame(() => fitView({ padding: fitPadding, duration: 200 }));
    setAnnouncement(
      'The nodes were laid out left to right by dependency, with every sink in the last column.',
    );
  }, [edit, fitView, fitPadding]);

  /**
   * One action back.
   *
   * Announced with the name of what it took back, because undo is the one
   * control here whose effect is routinely invisible: the node it just put back
   * may be off screen, and a revert nobody can see is indistinguishable from a
   * button that did nothing.
   *
   * The step is computed out here rather than inside the updater so the label is
   * available to say — and so nothing sets state from inside a `setState`
   * updater, which React is free to replay.
   */
  const undo = useCallback(() => {
    const step = undone(draft);
    if (!step) {
      setAnnouncement('There is nothing to take back — this drawing is as it was loaded.');
      return;
    }
    setDraft(step.draft);
    // The inspector is open on a node that may have just stopped existing, and
    // a sheet describing a deleted node is worse than no sheet.
    setInspecting((current) =>
      current && step.draft.nodes.some((node) => node.id === current) ? current : null,
    );
    setUnstarted((current) => keepKnown(current, step.draft.nodes));
    const left = step.draft.past.length;
    setAnnouncement(
      `Undone: ${step.label}. ${left === 0 ? 'Nothing left to take back.' : `${left} ${left === 1 ? 'action' : 'actions'} left to take back.`}`,
    );
  }, [draft]);

  /**
   * All the way back to the version the server last stored.
   *
   * Deliberately NOT "undo until the stack is empty". Save halfway through a
   * session and the baseline moves to that save, so this returns to the saved
   * v2 — whereas undoing forty times would walk straight past it back to the v1
   * the tab was opened on. Which of the two somebody means by "reset" is not in
   * doubt, and the confirmation says which one this is.
   */
  const reset = useCallback(() => {
    const back = reverted(draft);
    setDraft(back);
    setResetting(false);
    setInspecting(null);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setUnstarted(new Set<string>());
    setAnnouncement(
      draft.id
        ? `Reset. The drawing is back to v${draft.version ?? 1}, as the server stored it. Nothing on the server was changed.`
        : 'Reset. The canvas is empty again, which is where this unsaved workflow started.',
    );
  }, [draft]);

  useUndoShortcut({ enabled: canEdit, onUndo: undo, onSay: setAnnouncement });
  useUnsavedGuard(draft.dirty);

  const durability = describeDurability(capabilities?.durable);
  // Threaded to the source inspector rather than read there, so the one query
  // for `capabilities` serves both the canvas banner and the disk picker.
  const storage = capabilities?.storage;
  // Asked about EVERY problem, not about `live`. This is the guarantee: a graph
  // that would silently do nothing is coloured as unsaveable from the moment it
  // becomes one, whether or not the node responsible is still being worked on.
  const blocked = hasBlockingProblem(problems);
  /**
   * The nodes standing between this graph and a save that would be accepted,
   * where the only thing wrong with them is that they are not finished.
   *
   * Named so the save tooltip can point at them. A button that goes amber
   * without saying which box to go and look at is the same failure as a message
   * that names an id.
   */
  const unfinished = useMemo(() => unfinishedNames(pending, draft.nodes), [pending, draft.nodes]);

  /**
   * Save says "I think this is finished", so nothing is held back after it.
   *
   * Cleared before the request rather than in `onSuccess` or `onError`, because
   * the point is not what the server answers — it is that the person has
   * declared the graph done, which is exactly the condition under which every
   * check's own wording becomes the right wording. If the server refuses, the
   * reasons are already on screen in full beside its refusal.
   */
  const saveNow = useCallback(() => {
    setUnstarted(new Set<string>());
    save.mutate();
  }, [save]);

  /**
   * The stored graph behind the draft on screen, when there is one.
   *
   * Read out of the list rather than held in state of its own, so that
   * publishing — which changes `status`, and mints the connector everything
   * else here is keyed on — reaches the badge, the schedule panel and the
   * "Runs as" panel through one path instead of three copies going out of step.
   *
   * `loadedRef` is what makes this safe: the load effect returns early once the
   * draft has been built for an id, so a fresher list arriving here cannot throw
   * away nodes somebody has moved since.
   */
  const stored = useMemo(
    () => storedWorkflow(workflows.data, draft.id),
    [workflows.data, draft.id],
  );

  /**
   * Everything the menus can ask for, in one object.
   *
   * Every entry is a callback that already exists on this screen with its own
   * announcement, its own undo label and its own `markStarted` bookkeeping. A
   * menu that reimplemented any of them would be a second path with one of those
   * steps quietly missing — which is exactly the class of bug that produced a
   * canvas with two things called "wire".
   *
   * Deliberately NOT memoised, along with the two lists below it. Everything
   * here is already a `useCallback`, so a dependency array would be ten entries
   * long and would say nothing a re-render does not; what it would buy is
   * skipping `buildCanvasMenu`, which is six `canConnect` probes over a graph
   * with tens of nodes in it. The memo would cost more to keep right than the
   * work it saves.
   */
  const menuActions: CanvasMenuActions = {
    inspect: setInspecting,
    editCode: setEditingCodeFor,
    connect,
    connectToNew,
    insertBetween,
    setBranch,
    disconnect,
    removeNodes: dropNodes,
    addAt: addNode,
    tidy,
    fitAll: () => fitView({ padding: fitPadding, duration: 200 }),
    // Fitted to the selection rather than to the graph, which is the only useful
    // reading of "bring these into view" when the reason somebody selected them
    // is that the graph is too big to see at once.
    fitNodes: (ids) =>
      fitView({ nodes: ids.map((id) => ({ id })), padding: fitPadding, duration: 200 }),
  };

  const menuContext: CanvasMenuContext = {
    nodes: draft.nodes,
    edges: draft.edges,
    // Core's list, never a copy. See the note on `ADD_NODE` for the kind that
    // shipped complete and could not be added from this screen at all.
    kinds: WORKFLOW_NODE_KINDS,
    canEdit,
    published: stored?.status === 'ready',
    actions: menuActions,
  };

  /**
   * What the right-click menu is showing, and what the hover pill's menu is.
   *
   * Two lists built by one function from one model, which is the point: the pill
   * used to own a bespoke dropdown, and the moment a context menu existed the
   * two would have started answering "what can this node do" differently.
   */
  const contextSections = sectionsFor(contextMenu?.target, menuContext);
  const toolbarSections = sectionsFor(nodeTarget(menu.anchor), menuContext);
  const contextLabel = describeMenuTarget(contextMenu?.target, draft.nodes);

  /** Open the menu on whatever was right-clicked. See {@link menuOpening}. */
  const openMenuFor = useCallback(
    (target: CanvasMenuTarget, anchor: MenuAnchorRect) => {
      setContextMenu(menuOpening(target, anchor, draft.edges));
    },
    [draft.edges],
  );

  /**
   * A publish, an unpublish or a schedule, written straight into the list.
   *
   * Written as well as invalidated, because the status badge is the whole
   * feedback for those actions: waiting for a refetch means pressing Publish
   * and watching nothing happen for as long as the round trip takes, which is
   * exactly how somebody presses it twice.
   */
  const onLifecycleChange = useCallback(
    (saved: CatalogWorkflow) => {
      queryClient.setQueryData<CatalogWorkflow[]>(catalogQueryKeys.workflows, (current) =>
        (current ?? []).map((workflow) => (workflow.id === saved.id ? saved : workflow)),
      );
      setAnnouncement(lifecycleAnnouncement(saved));
    },
    [queryClient],
  );

  const inspectingNode = draft.nodes.find((node) => node.id === inspecting) ?? null;
  const editingNode = draft.nodes.find((node) => node.id === editingCodeFor);
  const editingTransform: CatalogTransform | undefined =
    editingNode?.kind === 'transform'
      ? transforms.find((transform) => transform.id === editingNode.transformId)
      : undefined;

  const graphTransforms = useMemo(
    () => transformsNamedBy(draft.nodes, transforms),
    [draft.nodes, transforms],
  );

  const typeOptions = useMemo<SelectOption[]>(
    () =>
      (snapshot?.types ?? []).map((type) => ({
        value: type.name,
        label: type.displayName,
        hint: type.name,
      })),
    [snapshot],
  );

  const workflowOptions = useMemo<SelectOption[]>(
    () => [
      ...(workflows.data ?? []).map((workflow) => ({
        value: workflow.id,
        label: workflow.name,
        hint: `${workflow.nodes.length} nodes → ${producedTypes(workflow.nodes).join(', ') || 'nothing yet'}`,
      })),
      { value: NEW_WORKFLOW, label: `New ${WORKFLOW_NAME.singular}` },
    ],
    [workflows.data],
  );

  const produces = producedTypes(draft.nodes);

  /**
   * Asking a source what its columns are, and creating the type from the answer.
   *
   * Built from the client rather than taken as a prop, and the prop that used to
   * carry it is gone with the screen it lived on. Two calls, and the second is
   * the only write: discovery reads and reports, `PUT /publish/:type/schema`
   * creates. A pipeline that created the type it loads into would grow the
   * catalog by accident, and the names it invented would come from the shape of
   * a query rather than from somebody who meant them.
   */
  const discovery = useMemo<SchemaDiscoveryBridge>(
    () => ({
      discover: async (workflowId, nodeId): Promise<ConnectorSchemaDiscovery> =>
        narrowDiscovery(await client.discoverSourceSchema(workflowId, nodeId)),
      // `async` on purpose: `publishType` THROWS rather than rejecting when the
      // transport cannot PUT, and a bridge whose method throws synchronously
      // would escape the panel's error handling and take the screen with it.
      createType: async (draftType: DiscoveredTypeDraft) =>
        client.publishType(draftType.name, {
          // Only what a person confirmed on screen. Everything else about a type
          // — its label, its description, its units — is curation, and inventing
          // any of it here would put words nobody chose into a catalog whose
          // whole claim is that its names were chosen.
          properties: draftType.properties.map((property) => ({
            name: property.name,
            columnName: property.columnName,
            type: property.type,
            nullable: property.nullable,
          })),
        }),
    }),
    [client],
  );

  return (
    /*
     * THE CANVAS IS THE SCREEN.
     *
     * One positioned box filling whatever the host gives it, with exactly two
     * layers in it: the graph, pinned to all four edges, and the chrome floating
     * over the graph. Nothing is in normal flow and nothing scrolls — a
     * full-bleed canvas that can be scrolled away from is a canvas that is not
     * actually the screen.
     *
     * What that buys, and it is the whole point: the drawing surface is now the
     * entire viewport instead of the ~55% left over after a header, a button row
     * and a column of panels had taken their share.
     *
     * What it costs is occlusion — a panel over the canvas covers graph. Three
     * things pay that back. The chrome is compact and translucent, so what is
     * behind it stays perceptible. Everything permanent is either an
     * always-needed control or dismissible. And `fitView` is given the chrome's
     * own insets (see `CHROME`), so the graph is fitted into the region nothing
     * covers rather than into the raw viewport — which is what stops a node
     * being centred underneath the action cluster.
     */
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {/*
       * The chrome, over the graph.
       *
       * DOM order is chrome-then-canvas on purpose, and the canvas is the layer
       * underneath by position rather than by being later in the document. That
       * gives a keyboard user the order they want: the controls that act on the
       * whole graph, then the dock that adds to it, then the rail that lists it,
       * and only then the nodes themselves — instead of tabbing through every
       * box on a large canvas to reach Save.
       *
       * `pointer-events-none` on the container with `pointer-events-auto` on each
       * panel is what keeps the gaps between the panels part of the canvas: the
       * empty space in this overlay is space you can pan and marquee-select
       * through, exactly as if the overlay were not there.
       */}
      <div className="pointer-events-none absolute inset-0 z-20 flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <WorkflowCard
            eyebrow={eyebrow}
            title={title}
            intro={intro}
            stored={stored}
            produces={produces}
            durability={durability}
            selected={selected}
            workflowOptions={workflowOptions}
            workflowsPending={workflows.isPending}
            draftName={draft.name}
            canEdit={canEdit}
            collapsed={cardCollapsed}
            reducedMotion={reducedMotion}
            onExpand={toggleFocus}
            onSelect={(value) => {
              loadedRef.current = null;
              setSelected(value);
            }}
            // Typing is one action, not one per keystroke: consecutive edits
            // sharing the `rename` run fold together while the run is open. See
            // `RUN_WINDOW_MS`.
            onRename={(name) =>
              edit((current) => ({ ...current, name }), {
                label: 'renaming this workflow',
                run: 'rename',
              })
            }
          />

          <div className="flex max-w-full flex-col items-end gap-2">
            <div className={cn('pointer-events-auto flex items-start gap-2 p-1.5', FLOATING)}>
              <CanvasActions
                draft={draft}
                stored={stored}
                canEdit={canEdit}
                blocked={blocked}
                unfinished={unfinished}
                saving={save.isPending}
                running={runIt.isPending}
                durabilityDetail={durability.detail}
                acknowledging={acknowledging}
                reducedMotion={reducedMotion}
                resetting={resetting}
                onAcknowledgingChange={setAcknowledging}
                onResettingChange={setResetting}
                onUndo={undo}
                onReset={reset}
                onSave={saveNow}
                onRun={runNow}
                onLifecycleChange={onLifecycleChange}
                onAskDelete={() => setConfirmingDelete(true)}
              />
              <span className="h-6 w-px shrink-0 bg-zinc-200 dark:bg-zinc-800" aria-hidden />
              <RailToggle open={railOpen} problems={live} onToggle={() => setRailOpen((o) => !o)} />
              {/*
               * Last, and therefore the last tab stop in the cluster.
               *
               * The previous round settled the order deliberately — app nav,
               * card, actions, rail toggle, dock, rail, canvas — so the one
               * control added here goes on the end of the group it belongs to
               * rather than into the middle of it. Nothing that was reachable
               * moves. It is also the outermost thing in the row visually, which
               * is where a control about the whole screen belongs.
               */}
              <FocusToggle on={focused} cardCollapsed={cardCollapsed} onToggle={toggleFocus} />
            </div>

            {/*
             * The refusals, under the buttons that caused them. They were under
             * the header before, which is the same place relative to the
             * controls — and it is still the place somebody who has just pressed
             * Run is looking.
             */}
            {/* `empty:hidden` rather than a guard listing the three things that
                can fill it: React renders each `false` as nothing, so with none
                of them present this is a genuinely childless element and the
                selector matches. One place to change when a fourth is added. */}
            <div className="pointer-events-auto w-[min(26rem,100%)] empty:hidden">
              {save.error && <RefusalNote lead="The server refused it:" error={save.error} />}
              {runIt.error && <RefusalNote lead="The run could not start:" error={runIt.error} />}
              {/*
               * The row-count bound turning a load away, with the one control
               * that answers it. Rendered from both surfaces because a refused
               * sink can arrive either way: as a rejected request when the
               * graph ran inline, or as a failed node on a run that otherwise
               * returned.
               */}
              <ShrinkRefusalNote
                run={run}
                error={runIt.error}
                onAcknowledge={() => setAcknowledging(true)}
              />
            </div>
          </div>
        </div>

        {/*
         * The dock, bottom centre — and placed HERE in the DOM, above the rail,
         * rather than where it is drawn.
         *
         * The one deliberate departure from "DOM order is reading order" on this
         * screen, and it is an operability call. The rail is a list that grows
         * with the graph: every wire, every problem, every sink in the last run
         * is a stop in it. Leaving the dock after all of that means a keyboard
         * user tabs past forty controls to reach "add a source", which is the
         * control they came to use. Tools before the read-out is the order that
         * preserves meaning; a bottom-centre dock and a right-edge panel have no
         * left-to-right relationship for the swap to violate.
         */}
        {canEdit && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center px-3 sm:bottom-4 sm:px-4">
            <AddNodeBar
              refreshing={workflows.isFetching && !workflows.isPending}
              compact={focused}
              onAdd={addNode}
              onTidy={tidy}
            />
          </div>
        )}

        {/*
         * The middle band: nothing but the rail, pushed to the right edge.
         * `pb-14` keeps its foot clear of the dock, which is out of the flow now
         * and would otherwise be overlapped at the widths where a 19rem rail and
         * a centred dock both reach the same pixels.
         */}
        <div className="flex min-h-0 flex-1 justify-end pb-14">
          <AnimatePresence initial={false}>
            {railOpen && (
              <WiringRail
                draft={draft}
                problems={live}
                pending={pending}
                run={run}
                canEdit={canEdit}
                reducedMotion={reducedMotion}
                onInspect={setInspecting}
                onDisconnect={disconnect}
                onClose={() => setRailOpen(false)}
              >
                {/*
                 * The two things that only exist once a graph is STORED, and
                 * that is why they are here rather than in the card: a schedule
                 * on nothing and a run history of nothing are both headings that
                 * would be empty for the whole of the time somebody spends
                 * drawing.
                 *
                 * Keyed by id so switching pipeline resets the cron and the
                 * enabled switch — held locally, and without the key one graph's
                 * schedule would appear inside another's.
                 */}
                {stored && (
                  <>
                    <SchedulePanel
                      key={stored.id}
                      workflow={stored}
                      canEdit={canEdit}
                      onScheduled={onLifecycleChange}
                    />
                    <RunsAsPanel
                      workflowId={stored.id}
                      status={stored.status}
                      transforms={graphTransforms}
                    />
                  </>
                )}
              </WiringRail>
            )}
          </AnimatePresence>
        </div>
      </div>

      <GraphSurface
        focused={focused}
        loading={workflows.isPending}
        failed={workflows.isError}
        error={workflows.error}
        onRetry={() => workflows.refetch()}
        canEdit={canEdit}
        draft={draft}
        flowNodes={flowNodes}
        flowEdges={flowEdges}
        onInspect={setInspecting}
        onEditCode={setEditingCodeFor}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onConnectEnd={announceRefusedDrop}
        onNodeEnter={menu.onNodeEnter}
        onNodeLeave={menu.onNodeLeave}
        // Clicking empty canvas puts away everything that is half-open: the
        // wiring menu, and a wire that was started and never landed. React
        // Flow only fires this for clicks on the pane ITSELF, so finishing a
        // wire on a handle does not also cancel it on the way past.
        onPaneClick={() => {
          menu.close();
          forgetMenu();
          wiring.cancel();
        }}
        onDisconnect={disconnect}
        onOpenMenu={openMenuFor}
        wiring={wiring}
        wiringRefusal={wiringRefusal}
        nodeMenu={
          <NodeActionsToolbar
            node={menu.anchor}
            canEdit={canEdit}
            open={menu.open}
            sections={toolbarSections}
            deleteHint={deleteHint(menu.anchor, draft, stored)}
            onOpenChange={menu.onOpenChange}
            onHoverChange={menu.onHoverChange}
            onDelete={() => {
              dropNodes(idsOf(menu.anchor));
              menu.reset();
            }}
          />
        }
        fitPadding={fitPadding}
      />

      {/*
       * The menu itself, outside `GraphSurface` because Base UI portals it to
       * the document anyway — putting it inside React Flow would only mean it
       * unmounts every time the graph does, taking an open menu with it.
       */}
      <CanvasContextMenu
        opening={contextMenu}
        sections={contextSections}
        label={contextLabel}
        onClose={forgetMenu}
      />

      {workflows.isSuccess && workflows.data.length === 0 && <NothingDrawnYet />}

      {/*
       * Everything the canvas does, said out loud once.
       *
       * `polite` rather than `assertive`: these are confirmations and refusals,
       * not emergencies, and interrupting somebody mid-sentence to tell them a
       * node moved is worse than waiting for a pause.
       */}
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>

      <NodeInspector
        node={inspectingNode}
        draft={draft}
        transforms={transforms}
        connections={connections}
        storage={storage}
        typeOptions={typeOptions}
        canEdit={canEdit}
        modelHref={modelHref}
        problems={problemsOf(problemsFor, inspectingNode)}
        pending={problemsOf(pendingFor, inspectingNode)}
        discovery={discovery}
        discoverable={{ ...discoveryTarget(draft), onSave: saveNow, saving: save.isPending }}
        onDiscovered={rememberShape}
        onClose={() => setInspecting(null)}
        onChange={(next) => {
          // Editing any field is the clearest statement there is that somebody
          // is working on this node rather than looking at one they just made.
          markStarted(next.id);
          // A discovered shape describes the source as it was addressed when it
          // was read. Change where or what this node reads and the columns on
          // file stop being about this node, so they are dropped rather than
          // compared — reporting a missing column against a query somebody has
          // since rewritten would be the validator inventing a fact, which is
          // the one thing `shape.ts` refuses to do. Renaming the node keeps
          // them: a name is not an address.
          //
          // Asked out here, against the rendered draft, rather than inside the
          // updater below: an updater is called again on every re-render React
          // decides to replay, and a `setState` in one is a side effect that
          // would fire with it.
          const before = draft.nodes.find((node) => node.id === next.id);
          if (readsDifferently(before, next)) {
            forgetShape(next.id);
          }
          edit(
            (current) => ({
              ...current,
              nodes: current.nodes.map((node) => (node.id === next.id ? next : node)),
            }),
            nodeEditAction(before, next),
          );
        }}
        onConnect={connect}
        onConnectToNew={connectToNew}
        onDisconnect={disconnect}
        onBranch={setBranch}
        onCreateTransform={(nodeId) => createTransform.mutate(nodeId)}
        creatingTransform={createTransform.isPending}
        createTransformError={createTransform.error}
        // The same path the hover button, the context menu and the selection
        // menu take. It was the only way to remove a node before those existed,
        // and it was the only one that did not say what the removal cost.
        onDelete={(nodeId) => {
          dropNodes([nodeId]);
          setInspecting(null);
        }}
        onEditCode={(nodeId) => setEditingCodeFor(nodeId)}
      />

      {/*
       * The code editor, over the canvas rather than instead of it.
       *
       * `TransformEditor` is a full screen of its own, and rendering it in
       * place of the canvas would unmount React Flow — losing every node
       * position, the half-drawn branch and the viewport somebody panned to,
       * none of which is saved yet. A sheet keeps all of it mounted behind.
       */}
      <Sheet
        open={editingCodeFor !== null}
        onOpenChange={(open) => {
          if (!open) setEditingCodeFor(null);
        }}
        width="wide"
        title={editingTransform ? editingTransform.name : 'Transform'}
        description="The canvas behind this is still exactly as you left it."
      >
        {editingTransform ? (
          <TransformEditor
            transform={editingTransform}
            languages={capabilities?.languages ?? ['javascript']}
            pythonPackages={capabilities?.pythonPackages ?? []}
            onClose={() => setEditingCodeFor(null)}
            onSaved={() => {
              setEditingCodeFor(null);
              queryClient.invalidateQueries({
                queryKey: catalogQueryKeys.transforms,
              });
            }}
          />
        ) : (
          <p className={cn('py-8 text-center text-xs', MUTED)}>
            This node does not name a transform yet. Choose one in the inspector first — there is no
            code to open until it does.
          </p>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete "${draft.name || WORKFLOW_NAME.singular}"?`}
        description={`The connector it runs as goes with it, and the run history keyed on that connector goes too — including the incremental watermark, so anything rebuilt later reads its source from the beginning. The snapshots it already committed stay where they are. The transforms and connections it wired together are not touched: they are shared, and other ${WORKFLOW_NAME.plural} may use them.`}
        confirmLabel="Delete"
        pending={remove.isPending}
        error={remove.error instanceof Error ? remove.error.message : undefined}
        onConfirm={() => draft.id && remove.mutate(draft.id)}
      />
    </div>
  );
}

/**
 * "a" or "an", for a name that is now generated rather than typed out.
 *
 * Worth the three lines: the row used to carry six hand-written labels, and the
 * moment they were derived from the kind the sixth one read "Add a if node".
 * That string is not decoration — it is the whole accessible name of the button,
 * so the only person it is wrong for is the one who cannot see the icon.
 */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function AddButton({
  kind,
  compact,
  onClick,
}: {
  kind: WorkflowNodeKind;
  compact: boolean;
  onClick: () => void;
}) {
  const { icon: Icon, label, hint } = ADD_NODE[kind];
  const noun = label.toLowerCase();
  return (
    <Tooltip content={hint}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        // The visible text is the noun alone, because six buttons reading
        // "Add a source" / "Add a transform" / "Add a sink" in a row is six
        // copies of one word. The accessible name has to say what the control
        // does: heard on its own, "Sink" is a heading, not a button.
        aria-label={`Add ${article(noun)} ${noun} node`}
        className="shrink-0 text-zinc-600 dark:text-zinc-300"
      >
        <Plus size={11} />
        <Icon size={12} />
        {/* Below `md` the dock is icons: six labelled buttons do not fit a phone
            and a dock that scrolls sideways to reach `filter` is a dock that
            hides it again, which is the failure this row was just fixed for.
            Focus mode asks for that same form at any width — and the `aria-label`
            above is what makes that safe, because the button's accessible name
            never depended on this word being rendered. */}
        <span className={compact ? 'hidden' : 'hidden md:inline'}>{label}</span>
      </Button>
    </Tooltip>
  );
}

/**
 * Whether a failed run resumes or restarts, stated on the screen that implies
 * it.
 *
 * Not a tooltip and not a footnote. A canvas of discrete boxes looks like a
 * checkpointed pipeline whether or not one exists, and somebody who builds a
 * ten-node graph on that assumption finds out only when node seven fails at
 * three in the morning. Kept to one line so it costs the canvas as little
 * height as a fact this important can be said in.
 */
function DurabilityBanner({
  durability,
}: {
  durability: ReturnType<typeof describeDurability>;
}) {
  const tone =
    durability.state === 'durable'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
      : durability.state === 'inline'
        ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
        : 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400';

  return (
    <div
      className={cn(
        'mt-2.5 flex flex-wrap items-baseline gap-x-2 rounded-md border px-2.5 py-1.5',
        tone,
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.14em]">{durability.label}</p>
      <p className="text-[11px] leading-relaxed">{durability.detail}</p>
    </div>
  );
}

/**
 * A skeleton, never an empty canvas.
 *
 * An empty canvas is a real state — a workflow with no nodes looks exactly like
 * this — so rendering one while the list is still in flight tells somebody
 * their graph is gone.
 */
function CanvasSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="flex items-center gap-3">
        <div className="h-16 w-48 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        <ArrowRight size={14} className={MUTED} />
        <div className="h-16 w-48 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        <ArrowRight size={14} className={MUTED} />
        <div className="h-16 w-48 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      </div>
    </div>
  );
}

/**
 * Show or hide the details rail, and say what is in it while it is hidden.
 *
 * The count is the load-bearing part. A rail that can be closed is a rail that
 * can hide the problems list, and "there are two errors" is not something
 * somebody should have to open a panel to discover — so the closed state carries
 * the number and the colour, and opening it is what gets the sentences. The
 * accessible name says the same thing in words, because a red 2 on a button is
 * not information if you cannot see it.
 */
function RailToggle({
  open,
  problems,
  onToggle,
}: {
  open: boolean;
  problems: WorkflowProblem[];
  onToggle: () => void;
}) {
  const badge = problemBadge(problems);
  const hint = open
    ? 'Hide the wiring, problems, schedule and run history, and give the canvas the room.'
    : `Show the wiring, problems, schedule and run history.${badge ? ` ${badge.sentence}` : ''}`;
  const name = open
    ? 'Hide the details panel'
    : `Show the details panel${badge ? `, ${badge.summary}` : ''}`;

  return (
    <Tooltip content={hint}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={name}
        className="shrink-0"
      >
        <PanelRight size={12} />
        {/* The count only while the panel is away: repeating it beside an open
            list of the same problems is the same fact twice. */}
        {!open && badge && (
          <span className={cn('rounded px-1 font-mono text-[10px]', badge.tone)}>
            {badge.count}
          </span>
        )}
      </Button>
    </Tooltip>
  );
}

/**
 * The one number a closed rail has to carry, or nothing at all.
 *
 * Errors win over warnings rather than being summed: a graph with one error and
 * six warnings is an error, and "7" beside a neutral chip would be the button
 * averaging two different facts into one that is neither.
 *
 * Split out of {@link RailToggle} because the three shapes it produces — a
 * count, a colour and two grammatical forms — were four nested ternaries inside
 * JSX, which is how a badge ends up saying "1 errors".
 */
function problemBadge(
  problems: WorkflowProblem[],
): { count: number; summary: string; sentence: string; tone: string } | null {
  const errors = problems.filter((problem) => problem.level === 'error').length;
  const warnings = problems.length - errors;

  if (errors > 0) {
    return {
      count: errors,
      summary: `${errors} ${errors === 1 ? 'error' : 'errors'}`,
      sentence: `There ${errors === 1 ? 'is' : 'are'} ${errors} ${errors === 1 ? 'error' : 'errors'}.`,
      tone: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    };
  }
  if (warnings > 0) {
    return {
      count: warnings,
      summary: `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
      sentence: `There ${warnings === 1 ? 'is' : 'are'} ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.`,
      tone: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    };
  }
  return null;
}

/**
 * Give the canvas the screen, or give the chrome back.
 *
 * ## What this control promises, and what it does not
 *
 * It promises room, and it says exactly what it takes to get it — "the card and
 * the dock labels" — rather than "focus mode", because a mode named after a
 * feeling is a mode nobody can predict. What it explicitly does not promise is
 * that the screen goes quiet: the action cluster it sits inside stays whole, so
 * Save, the refusals and the problem count are all still here after it is
 * pressed. Somebody reading the tooltip should come away knowing that nothing
 * which can stop a mistake is about to disappear.
 *
 * ## The refusal
 *
 * The refusal is the case where the mode is ON and the card stayed open anyway,
 * because the graph has no name and the field that fixes that is inside it (see
 * `cardCollapsed`). A control that had been pressed and visibly done nothing
 * would read as broken, so it says which of the two things it is. The word is in
 * the accessible name too, not only in the tooltip — a tooltip is a pointer
 * affordance and this is the one state where the button's behaviour differs
 * from its label.
 *
 * ## The shortcut
 *
 * Rendered as a letter beside the icon rather than mentioned only in prose. A
 * keyboard shortcut nobody can see is a shortcut for whoever read the commit,
 * and this screen's whole argument is that the hands stay on the canvas.
 * `aria-hidden` on the glyph because the accessible name already spells it out
 * as a sentence, and "F" read aloud in the middle of one is noise.
 */
function FocusToggle({
  on,
  cardCollapsed,
  onToggle,
}: {
  on: boolean;
  /** Whether the card actually folded. See {@link focusCollapsesTheCard}. */
  cardCollapsed: boolean;
  onToggle: () => void;
}) {
  const refusing = on && !cardCollapsed;
  const hint = refusing
    ? `Focus is on, but the card is staying until this ${WORKFLOW_NAME.singular} has a name — the field that gives it one is in there, and Save is held back without it. Press ${FOCUS_SHORTCUT.toUpperCase()} or this button to turn focus off.`
    : on
      ? `Bring back the ${WORKFLOW_NAME.singular} card and the dock's labels. Shortcut: ${FOCUS_SHORTCUT.toUpperCase()}.`
      : `Collapse the ${WORKFLOW_NAME.singular} card, drop the dock to icons and put the details panel away, so the graph gets the screen. Save, the refusals and the problem count stay exactly where they are. Shortcut: ${FOCUS_SHORTCUT.toUpperCase()}.`;

  const name = refusing
    ? 'Turn off focus mode (the card is staying: this workflow has no name yet)'
    : on
      ? `Turn off focus mode, shortcut ${FOCUS_SHORTCUT.toUpperCase()}`
      : `Turn on focus mode and give the canvas the room, shortcut ${FOCUS_SHORTCUT.toUpperCase()}`;

  return (
    <Tooltip content={hint}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-pressed={on}
        aria-label={name}
        className={cn(
          'shrink-0',
          // On, the control is the only thing on screen saying so — the chrome
          // it collapsed cannot say it is missing. So it carries the state in
          // its own colour rather than relying on a panel that is gone.
          on && 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
        )}
      >
        {on ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        <span
          aria-hidden
          className="rounded border border-current/30 px-1 font-mono text-[10px] leading-4 opacity-70"
        >
          {FOCUS_SHORTCUT.toUpperCase()}
        </span>
      </Button>
    </Tooltip>
  );
}

/**
 * Which graph this is, and the two fields that name it — top-left, floating.
 *
 * The corner a document's identity lives in, in every tool shaped like this one.
 * What is deliberately NOT here is the description paragraph: it explains the
 * screen to somebody arriving at it and says nothing to somebody mid-draw, so it
 * costs three lines of canvas forever to be read once. It is still reachable
 * from the button beside the title, and still read out in full to a screen
 * reader, which is the one audience a tooltip would have failed.
 *
 * ## Collapsed
 *
 * The tallest panel on the screen, so the one focus mode is really about: ~400
 * by ~270 of the canvas, most of it two fields and a paragraph about durability
 * that nobody reads twice. Collapsed, what is left is the head — and the head
 * gains something rather than only losing things, because the name that was in
 * the field has to go somewhere: it moves up beside the title, truncated, so the
 * card still answers "which graph am I looking at" while it is small.
 *
 * What SURVIVES the collapse is the point. The status badges stay, so a graph
 * that is `adopted`, unpublished or disabled still says so; the commits badge
 * stays, so which type this writes is still on screen. Those are the two facts
 * on this card that can stop a mistake, and neither of them is worth the height
 * that the fields cost.
 *
 * The `h1` is in both states, at the same level, so collapsing does not knock a
 * heading out of the document outline — a screen whose only `h1` comes and goes
 * with a display preference is a screen that reads differently to a screen
 * reader depending on a decision made about pixels.
 */
function WorkflowCard({
  eyebrow,
  title,
  intro,
  stored,
  produces,
  durability,
  selected,
  workflowOptions,
  workflowsPending,
  draftName,
  canEdit,
  collapsed,
  reducedMotion,
  onExpand,
  onSelect,
  onRename,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  stored: CatalogWorkflow | undefined;
  produces: string[];
  durability: ReturnType<typeof describeDurability>;
  selected: string;
  workflowOptions: SelectOption[];
  workflowsPending: boolean;
  draftName: string;
  canEdit: boolean;
  /** Focus mode, and the graph has a name. See `cardCollapsed`. */
  collapsed: boolean;
  reducedMotion: boolean;
  /** Leaves focus mode entirely, rather than opening this card alone. */
  onExpand: () => void;
  onSelect: (value: string) => void;
  onRename: (name: string) => void;
}) {
  /**
   * Whether something inside this card currently has the keyboard.
   *
   * The card will not fold while it does, and that is a correctness fix rather
   * than a nicety. The refusal above holds the card open while the graph has no
   * name — so the very next thing that happens is somebody typing one, and the
   * condition that was holding the card open stops being true on the FIRST
   * character. Without this, the field disappears out from under the caret
   * mid-word and the rest of the name is typed into nothing.
   *
   * Tracked by bubbling rather than by handlers on each field: `focusin` and
   * `focusout` bubble (unlike `focus` and `blur`), which React exposes as
   * `onFocus`/`onBlur` on any ancestor, so this works for the picker, the name
   * field and anything added to the card later without threading a prop.
   *
   * `relatedTarget` is where the focus WENT. Still inside the card — Tab from
   * the picker to the name field — is not a departure. `null` is a departure:
   * it is what a click on something unfocusable produces, and the card folding
   * then is right.
   */
  const [holdsFocus, setHoldsFocus] = useState(false);
  const folded = collapsed && !holdsFocus;

  return (
    /*
     * `layout` rather than a CSS transition, because the box goes from a fixed
     * 24rem to whatever its head needs and there is no width to transition TO —
     * `auto` is not an animatable value. Motion measures both states and
     * interpolates the real numbers, which is the difference between a panel
     * that folds and one that snaps and then re-renders at the new size.
     */
    <motion.div
      layout={!reducedMotion}
      transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
      onFocus={() => setHoldsFocus(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHoldsFocus(false);
      }}
      className={cn(
        'pointer-events-auto p-3',
        // Collapsed it is allowed to be WIDER than the 24rem it is fixed at
        // open, and that is not a slip. Wrapping the head onto a second line
        // costs 23px of height across the full width of the panel; letting it
        // run to 30rem costs a strip of canvas beside a title, at the top-left
        // corner where a graph laid out left-to-right has nothing yet. Height is
        // the expensive axis here, so the trade goes that way.
        folded ? 'w-auto max-w-[min(30rem,100%)] py-2' : 'w-[min(24rem,100%)]',
        FLOATING,
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* The eyebrow is the screen's section, read once on arrival. It is the
            first thing to go and the least missed. */}
        {!folded && (
          <p className={cn('font-mono text-[10px] uppercase tracking-[0.18em]', MUTED)}>
            {eyebrow}
          </p>
        )}
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {/* The name, only while the field that normally holds it is away. Two
            copies of it on screen at once would be the card saying one thing
            twice in a panel whose whole problem is height. */}
        {folded && (
          <p className={cn('max-w-[12rem] truncate text-xs', MUTED)} title={draftName}>
            {draftName}
          </p>
        )}
        {stored && <WorkflowStatusBadge workflow={stored} />}
        <CommitsBadge produces={produces} />
        {folded ? (
          <Tooltip
            content={`Bring the ${WORKFLOW_NAME.singular} picker, the name field and the checkpointing note back, and leave focus mode. Shortcut: ${FOCUS_SHORTCUT.toUpperCase()}.`}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={onExpand}
              aria-expanded={false}
              aria-label="Show the workflow card and leave focus mode"
              className="ml-auto h-5 w-5"
            >
              <ChevronDown size={11} />
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content={intro}>
            <Button
              variant="ghost"
              size="icon"
              aria-label="What this screen is for"
              className="ml-auto h-5 w-5"
            >
              <Info size={11} />
            </Button>
          </Tooltip>
        )}
      </div>
      {/*
       * The paragraph the tooltip carries, kept in the accessible tree.
       * A tooltip is a pointer affordance first and is announced unevenly; the
       * text is short and there is no reason for a screen-reader user to get a
       * worse version of the screen than a hovering one.
       *
       * Rendered in BOTH states, and that is what makes dropping the info button
       * above defensible: collapsing takes away a pointer affordance for text
       * that is already here, not the text.
       */}
      <p className="sr-only">{intro}</p>

      {/*
       * `AnimatePresence` rather than a `hidden` class, and the difference is
       * focus: a collapsed panel left in the DOM is a panel a Tab can still land
       * in, which is exactly the "stranded focus" a hidden control causes.
       * Unmounting is the only version of this that keeps the tab ring on
       * something a person can see.
       */}
      <AnimatePresence initial={false}>
        {!folded && (
          <motion.div
            key="body"
            initial={reducedMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            /*
             * A tween, and NOT the spring the rail and the outer box use.
             *
             * Two reasons, one aesthetic and one that cost an afternoon. A
             * spring overshoots, and a height overshooting past zero is a panel
             * that clips itself against its own border on the way down — the
             * one place on this screen where bounce reads as a glitch rather
             * than as life. And a spring on a height resolved from `auto` has
             * no analytic end: it settles by threshold, on frames. Under jsdom,
             * which reports no layout, it never settled at all and
             * `AnimatePresence` therefore never unmounted the body — so focus
             * mode "worked" in a browser and left the picker and the name field
             * in the document forever in a test. A tween ends on a clock.
             */
            transition={
              reducedMotion ? { duration: 0 } : { duration: 0.22, ease: [0.32, 0.72, 0, 1] }
            }
            // Or the fields spill out of the box on the way down: the height is
            // being animated from zero and their own height is not.
            className="overflow-hidden"
          >
            <div className="mt-2.5 grid gap-2">
              <SelectField
                label={WORKFLOW_NAME.title}
                ariaLabel={`Which ${WORKFLOW_NAME.singular} to edit`}
                value={selected}
                onValueChange={onSelect}
                options={workflowOptions}
                disabled={workflowsPending}
              />
              <TextField
                label="Name"
                value={draftName}
                onChange={onRename}
                placeholder="Fleet readiness"
                disabled={!canEdit}
              />
            </div>

            <DurabilityBanner durability={durability} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * That there are none, said rather than drawn as a blank canvas.
 *
 * The zero case used to be nearly unreachable: a deployment that had connectors
 * got them wrapped into graphs at boot, so `#workflows` opened onto thirteen of
 * them. Nothing wraps anything now — a graph exists because somebody drew one —
 * so a deployment that has never drawn one opens onto an empty canvas, which is
 * pixel-identical to a workflow whose nodes have all been deleted and to a list
 * that failed to load in a way the query did not notice.
 *
 * So it says which of the three it is, and what to do about it. The distinction
 * this file already draws between {@link CanvasSkeleton} and
 * {@link CanvasFailure} is the same one, for the same reason: three states that
 * render identically and mean different things need one of them to speak.
 *
 * It carries no button. The control that creates a workflow is the `New
 * workflow` option already selected in the picker three lines below this note,
 * and a second affordance pointing at the same act is how somebody ends up
 * wondering whether the two do different things.
 */
function NothingDrawnYet() {
  return (
    /*
     * Centred ON the canvas rather than stated above it, now that the canvas is
     * the screen. An empty surface is where somebody is already looking, and it
     * is the thing being explained.
     *
     * `pointer-events-none` throughout: it carries no control — the one that
     * creates a workflow is the picker in the card — and a plate over the middle
     * of the canvas that swallowed a pan would make the empty state feel like a
     * broken canvas, which is precisely the reading it exists to prevent.
     */
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div
        className={cn(
          'max-w-md rounded-xl border border-dashed px-4 py-3 text-center backdrop-blur-sm',
          RULE,
        )}
      >
        <p className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
          No {WORKFLOW_NAME.plural} yet
        </p>
        <p className={cn('mt-1.5 text-[11px] leading-relaxed', MUTED)}>
          Nothing is missing — this deployment has never had one drawn. Add a source, wire it into a
          sink and save, and it becomes the first. If this deployment has connectors already loading
          data, they are not shown here and nothing turns them into {WORKFLOW_NAME.plural}{' '}
          {/* The explicit space is load-bearing: JSX drops the newline between an
              expression and the text after it, so this read "workflowsautomatically"
              on screen. Invisible in the source, obvious the moment it is rendered. */}
          automatically.
        </p>
      </div>
    </div>
  );
}

function CanvasFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-red-50 px-6 dark:bg-red-950/30">
      <div className="max-w-md text-center">
        <CircleAlert size={18} className="mx-auto text-red-600" />
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          {/* Said as a failure, not drawn as an empty canvas. The two look
              identical and mean opposite things. */}
          The {WORKFLOW_NAME.plural} could not be read, so nothing below is drawn. This is not an
          empty {WORKFLOW_NAME.singular}.
        </p>
        <p className="mt-1 font-mono text-[11px] text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : 'No reason was given.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="mt-3 border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
        >
          Try again
        </Button>
      </div>
    </div>
  );
}

/**
 * The graph as a list, beside the graph as a picture.
 *
 * Not a convenience. React Flow makes nodes focusable and movable from the
 * keyboard, but there is no keyboard gesture for drawing an edge — dragging
 * from one handle to another is a pointer interaction and nothing else. Without
 * a linear, operable representation of the wiring, this screen would be
 * buildable only with a mouse, and readable only by somebody who can see it.
 *
 * The problems list sits in the same rail for the same reason: a red ring
 * around a node off the left edge of the viewport communicates nothing.
 */
function WiringRail({
  draft,
  problems,
  pending,
  run,
  canEdit,
  reducedMotion,
  onInspect,
  onDisconnect,
  onClose,
  children,
}: {
  draft: Draft;
  problems: WorkflowProblem[];
  pending: WorkflowProblem[];
  run: WorkflowRun | null;
  canEdit: boolean;
  reducedMotion: boolean;
  onInspect: (nodeId: string) => void;
  onDisconnect: (edge: WorkflowEdge) => void;
  /** Put the rail away. The same state the toggle beside the actions holds. */
  onClose: () => void;
  /**
   * Whatever only makes sense for a graph the server has: its schedule, and the
   * connector it runs as. A slot rather than props, because the rail has no
   * opinion about either and taking them as props would make it the component
   * that knows how a pipeline is published.
   */
  children?: ReactNode;
}) {
  const label = (id: string) => {
    const node = draft.nodes.find((n) => n.id === id);
    return node ? nodeName(node) : id;
  };
  const errors = problems.filter((problem) => problem.level === 'error');
  const warnings = problems.filter((problem) => problem.level === 'warning');
  const sinks = draft.nodes.filter((node) => node.kind === 'sink');

  return (
    /*
     * Floating over the right edge of the canvas rather than beside it in a
     * column, and NOT a modal sheet.
     *
     * The distinction matters for exactly one reason, which `ui/sheet.tsx` spells
     * out from the other direction: a panel that covers the canvas while a
     * keyboard user tabs into what is behind it leaks focus onto controls they
     * cannot see. That argument is about a panel that HIDES things. This one
     * hides nothing — it is always open when it is rendered, everything in it is
     * operable, and Tab flowing between it and the canvas is the correct order
     * rather than a leak. So no focus trap, and deliberately no Escape handler
     * either: Escape on this screen already means "put the half-drawn wire away"
     * (see `workflow/wiring.tsx`), and a second meaning would take that key away
     * from the gesture that needs it most.
     *
     * `dismissible` is the whole reason it may float: an always-on 19rem panel is
     * 19rem of canvas somebody never agreed to spend.
     */
    <motion.aside
      initial={reducedMotion ? false : { opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
      transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
      className={cn(
        'pointer-events-auto flex max-h-full w-[min(19rem,calc(100vw-2rem))] flex-col',
        'overflow-y-auto p-3',
        FLOATING,
      )}
      aria-label={`${WORKFLOW_NAME.title} wiring and problems`}
    >
      <div className="mb-2 flex shrink-0 items-center gap-2">
        {/* A label, not a heading. The `aside` already carries the accessible
            name, and the sections below are the headings — adding one above
            them would put a level in the outline that names nothing new. */}
        <p className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>Details</p>
        <Tooltip content="Put this panel away and give the canvas the room.">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Hide the details panel"
            className="ml-auto h-5 w-5"
          >
            <X size={11} />
          </Button>
        </Tooltip>
      </div>
      <div className="flex flex-col gap-3">
        {/*
         * Ordered by what somebody needs soonest, which is not the order these
         * grew in. The rail scrolls, and on a stored graph the schedule and the
         * connector panel are tall enough to push whatever is under them out of
         * sight — so Problems, the one thing that must never need scrolling to,
         * used to sit fifth and below the fold. Outstanding work and problems
         * now come first, the wiring after them, and the two stored-only panels
         * last, where being scrolled to is what they deserve.
         */}
        <PendingWork pending={pending} label={label} onInspect={onInspect} />

        <section className={cn('rounded-lg border p-3', RULE, SUBPANEL)}>
          <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
            Problems
          </h2>
          {problems.length === 0 ? (
            <p className={cn('mt-2 text-[11px]', MUTED)}>
              {/* Deliberately not "valid". These are the same rules the server
                runs, but it knows things they cannot see — which types exist,
                who may write to them — and its answer is the one that counts. */}
              Nothing to flag here. The server checks it again on save.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {[...errors, ...warnings].map((problem) => (
                <li
                  key={`${problem.code}:${problem.nodeIds.join(',')}`}
                  className="flex gap-1.5 text-[11px] leading-relaxed"
                >
                  {problem.level === 'error' ? (
                    <CircleAlert size={11} className="mt-0.5 shrink-0 text-red-500" />
                  ) : (
                    <TriangleAlert size={11} className="mt-0.5 shrink-0 text-amber-500" />
                  )}
                  <span>
                    {problem.message}
                    {problem.nodeIds.length > 0 && (
                      <span className="ml-1">
                        {problem.nodeIds.map((nodeId) => (
                          <button
                            key={nodeId}
                            type="button"
                            onClick={() => onInspect(nodeId)}
                            className={cn(
                              'mr-1 rounded border px-1 font-mono text-[9px]',
                              RULE,
                              MUTED,
                            )}
                          >
                            {label(nodeId)}
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {run && (
          <section className={cn('rounded-lg border p-3', RULE, SUBPANEL)}>
            <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
              Last run
            </h2>
            <p className="mt-1 text-[11px]">
              {run.status}
              {/* Read from the run, not from capabilities: a deployment can gain
                or lose its durable engine between runs, and this run is what it
                was when it happened. */}
              <span className={cn('ml-1 font-mono text-[10px]', MUTED)}>
                {run.durable ? 'checkpointed per node' : 'ran inline, no checkpoints'}
              </span>
            </p>

            {/*
             * What each sink committed, called out separately from the node list.
             *
             * A graph may commit several types, and each sink commits its own
             * independently — there is no transaction across them. So "the run
             * succeeded" is not a fact about the run: `Mvr` can be live while
             * `Subwo` failed, and a single status line would say the opposite of
             * what happened to one of them. The overall status above is failed if
             * any sink failed; this is where somebody reads which.
             */}
            {sinks.length > 0 && (
              <div className="mt-2">
                <h3 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                  Committed
                </h3>
                <ul className="mt-1 space-y-1">
                  {sinks.map((sink) => {
                    const outcome = run.nodes.find((node) => node.nodeId === sink.id);
                    const type =
                      sink.kind === 'sink' && sink.targetType ? sink.targetType : 'no type';
                    return (
                      <li key={sink.id} className="flex items-center gap-1.5 text-[11px]">
                        <span className="truncate font-mono text-[10px]">{type}</span>
                        <span
                          className={cn(
                            'ml-auto shrink-0 font-mono text-[10px]',
                            outcome?.status === 'failed'
                              ? 'text-red-500'
                              : outcome?.status === 'succeeded'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : MUTED,
                          )}
                        >
                          {outcome
                            ? outcome.status === 'succeeded' && typeof outcome.rows === 'number'
                              ? `${outcome.rows} rows`
                              : outcome.status
                            : 'no outcome recorded'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className={cn('mt-1 text-[10px] leading-relaxed', MUTED)}>
                  Each sink commits on its own. One committing and another failing is a failed run
                  that nevertheless wrote something, not a partial success that will be rolled back.
                </p>
              </div>
            )}

            <ul className="mt-2 space-y-1">
              {run.nodes.map((node) => (
                <li key={node.nodeId} className="flex items-center gap-1.5 font-mono text-[10px]">
                  <span className="truncate">{label(node.nodeId)}</span>
                  <span
                    className={cn(
                      'ml-auto shrink-0',
                      node.status === 'failed' ? 'text-red-500' : MUTED,
                    )}
                  >
                    {node.replayed ? 'replayed' : node.status}
                  </span>
                </li>
              ))}
            </ul>
            {run.error && <p className="mt-2 text-[11px] text-red-600">{run.error}</p>}
          </section>
        )}

        <section className={cn('rounded-lg border p-3', RULE, SUBPANEL)}>
          <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>Wiring</h2>
          {draft.edges.length === 0 ? (
            <p className={cn('mt-2 text-[11px]', MUTED)}>Nothing is wired together yet.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {draft.edges.map((edge) => (
                <li key={edgeId(edge)} className="flex items-center gap-1.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => onInspect(edge.from)}
                    className="truncate hover:underline"
                  >
                    {label(edge.from)}
                  </button>
                  <ArrowRight size={10} className={cn('shrink-0', MUTED)} />
                  <button
                    type="button"
                    onClick={() => onInspect(edge.to)}
                    className="truncate hover:underline"
                  >
                    {label(edge.to)}
                  </button>
                  {canEdit && (
                    <Tooltip content="Remove this connection.">
                      <button
                        type="button"
                        onClick={() => onDisconnect(edge)}
                        aria-label={`Disconnect ${label(edge.from)} from ${label(edge.to)}`}
                        className="ml-auto shrink-0 rounded p-0.5 text-zinc-400 hover:text-red-600"
                      >
                        <Unplug size={11} />
                      </button>
                    </Tooltip>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {children}
      </div>
    </motion.aside>
  );
}

/**
 * What is left to do on the nodes nobody has finished.
 *
 * The same checks as the Problems list below it, and deliberately not the same
 * words. Grouped by node rather than listed one per check, because "Sink" with
 * two things outstanding is one piece of work, not two complaints — and because
 * the group heading is the node's name, which is what somebody needs in order to
 * go and find it.
 *
 * Rendered as nothing at all when there is nothing outstanding, rather than as
 * an empty panel: a heading that is permanently on screen with "nothing here"
 * under it is a heading that stops being read, and this one has to be noticed on
 * the occasions it is not empty.
 */
function PendingWork({
  pending,
  label,
  onInspect,
}: {
  pending: WorkflowProblem[];
  label: (id: string) => string;
  onInspect: (nodeId: string) => void;
}) {
  const byNode = useMemo(() => problemsByNode(pending), [pending]);
  if (byNode.size === 0) return null;

  return (
    <section className={cn('rounded-lg border p-3', RULE, SUBPANEL)}>
      <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
        Still to do
      </h2>
      <ul className="mt-2 space-y-1.5">
        {[...byNode.entries()].map(([nodeId, items]) => (
          <li key={nodeId} className="flex gap-1.5 text-[11px] leading-relaxed">
            <CircleDashed size={11} className={cn('mt-0.5 shrink-0', MUTED)} />
            <span>
              <button
                type="button"
                onClick={() => onInspect(nodeId)}
                className="font-medium hover:underline"
              >
                {label(nodeId)}
              </button>
              <span className={MUTED}>
                {' — '}
                {items.map((problem) => todoFor(problem)).join('; ')}.
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className={cn('mt-2 text-[10px] leading-relaxed', MUTED)}>
        {/* Said once, here, rather than implied by the absence of red. Somebody
            who has seen this canvas shout at a node they added a second ago
            needs to know that the quiet is deliberate and temporary. */}
        These are not problems yet — a node that was just added is unwired and unconfigured by
        construction. They are checked in full the moment you save.
      </p>
    </section>
  );
}

/**
 * One end of a node's wiring — everything feeding it, or everything it feeds.
 *
 * Both directions render the same list off the same edges, so they share one
 * description of it. Only which end of the edge to name, and how removing it is
 * announced, differ; `children` carries whatever belongs under the list.
 */
function WiringList({
  title,
  edges,
  otherEnd,
  describeRemoval,
  canEdit,
  onDisconnect,
  onBranch,
  children,
}: {
  title: string;
  edges: WorkflowEdge[];
  otherEnd: (edge: WorkflowEdge) => string;
  describeRemoval: (name: string) => string;
  canEdit: boolean;
  onDisconnect: (edge: WorkflowEdge) => void;
  /**
   * Move a wire onto the other side of its gate. Supplied only for the outgoing
   * list of an `if` node; absent everywhere else, which is what keeps a branch
   * control off the wires that have no branch to be on.
   */
  onBranch?: (edge: WorkflowEdge, branch: WorkflowBranchLabel) => void;
  children?: ReactNode;
}) {
  return (
    <section>
      <h3 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>{title}</h3>
      {edges.length === 0 ? (
        <p className={cn('mt-1 text-[11px]', MUTED)}>Nothing yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {edges.map((edge) => (
            <li key={edgeId(edge)} className="flex items-center gap-1.5 text-[11px]">
              <span className="truncate">{otherEnd(edge)}</span>
              {onBranch && (
                // Beside the wire it belongs to rather than as two lists headed
                // "Then" and "Else", because the branch is a property of the
                // wire: splitting the list would mean a wire changing sides has
                // to move between two controls, and the order the wires were
                // drawn in — which is what the canvas draws — would be lost.
                <div className="ml-auto w-28 shrink-0">
                  <Select
                    ariaLabel={`Which branch feeds ${otherEnd(edge)}`}
                    value={edge.branch ?? ''}
                    onValueChange={(branch) => {
                      if (!isWorkflowBranchLabel(branch)) return;
                      onBranch(edge, branch);
                    }}
                    options={WORKFLOW_BRANCH_LABELS.map((label) => ({
                      value: label,
                      label,
                    }))}
                    placeholder="branch?"
                    disabled={!canEdit}
                  />
                </div>
              )}
              {canEdit && (
                <Tooltip content="Remove this connection.">
                  <button
                    type="button"
                    onClick={() => onDisconnect(edge)}
                    aria-label={describeRemoval(otherEnd(edge))}
                    className="ml-auto rounded p-0.5 text-zinc-400 hover:text-red-600"
                  >
                    <Unplug size={11} />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

/**
 * Which code runs here, and a way into it.
 *
 * THE TWO THINGS THIS SCREEN KEPT CONFLATING
 * ------------------------------------------
 * A reader's complaint, verbatim: "the transform node needs another transform,
 * it reads a bit strange". They are right, and the model is not wrong — a
 * `CatalogTransform` is named, reusable code, deliberately shared between
 * connectors and graphs, and a node is a *position* in a graph that runs some.
 * Two different things. What made them look like one thing was this form: a
 * field called "Transform", inside a sheet describing a transform node, asking
 * you to choose a Transform.
 *
 * The field is therefore labelled by what it asks for — the code — and says in
 * one line why the two are separate. What is deliberately **not** done is
 * renaming the node: `defaultLabel` and the badge the node draws itself with
 * both live in `workflow/`, so a rename here would produce a step called "Step"
 * wearing a badge that says TRANSFORM, which is the same disease with an extra
 * word in it. One vocabulary or the other, and half of it is not reachable from
 * this file.
 *
 * A FRESH CATALOG
 * ---------------
 * With no transforms stored, the old form offered "Choose a transform…" over an
 * empty list, and a disabled "Open the code" that `opacity-40` did not make look
 * disabled. So the screen presented a promise it could not keep and a control
 * that answered clicks with silence, on a node somebody had added ten seconds
 * earlier. Now: the empty case says it is empty and offers the way out, and the
 * code button is not rendered at all until there is code behind it — a control
 * that cannot act is better absent than present and inert.
 */
function TransformInspector({
  node,
  transforms,
  canEdit,
  creating,
  createError,
  onChange,
  onEditCode,
  onCreate,
}: {
  node: WorkflowTransformNode;
  transforms: CatalogTransform[];
  canEdit: boolean;
  creating: boolean;
  createError: unknown;
  onChange: (node: WorkflowNode) => void;
  onEditCode: (nodeId: string) => void;
  onCreate: (nodeId: string) => void;
}) {
  const empty = transforms.length === 0;

  return (
    <div className="space-y-2">
      {empty ? (
        <div className={cn('rounded-md border p-2', RULE)}>
          <p className="text-[11px] leading-relaxed">
            There are no transforms in this catalog yet, so there is nothing to choose. Make one
            here and its code opens straight away — it is stored on its own, and other steps and
            connectors can run it afterwards.
          </p>
        </div>
      ) : (
        <SelectField
          label="Code it runs"
          ariaLabel="Which transform's code runs at this step"
          value={node.transformId}
          onValueChange={(transformId) => onChange({ ...node, transformId })}
          options={transforms.map((transform) => ({
            value: transform.id,
            label: transform.name,
            hint: `${transform.language} · v${transform.version}`,
          }))}
          placeholder="Choose the code…"
          disabled={!canEdit}
          hint="A transform is named code, stored on its own so a connector and several steps can run the same one. This node is a position in the graph; choosing here says which code runs at it, and does not copy it."
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/*
         * Rendered only when there is something behind it. This was a disabled
         * button at `opacity-40`, which reads as "faint" rather than as "off" —
         * so it got clicked, and answered with nothing at all.
         */}
        {node.transformId.length > 0 && (
          <button
            type="button"
            onClick={() => onEditCode(node.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs',
              RULE,
              'hover:bg-zinc-50 dark:hover:bg-zinc-800',
            )}
          >
            <Code2 size={12} />
            Open the code
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => onCreate(node.id)}
            disabled={creating}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40',
              RULE,
              'hover:bg-zinc-50 dark:hover:bg-zinc-800',
            )}
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {empty ? 'Write the first transform' : 'New transform'}
          </button>
        )}
      </div>
      {createError ? <RefusalNote lead="It could not be created:" error={createError} /> : null}
    </div>
  );
}

/**
 * What this sink commits, and whether it replaces or merges.
 *
 * The type is set here, on the node that commits it, rather than once for the
 * whole graph — several sinks may write several types.
 *
 * ## The way out to the type
 *
 * This inspector is the one place in the whole canvas that names an object type,
 * so it is the only honest place for a link to the model screen. It sits under
 * the picker rather than in the header, and it names the type rather than saying
 * "Open the model": the destination is that type's page, and a link whose label
 * describes a screen rather than a thing gives no clue what pressing it shows.
 *
 * Rendered only when a type is actually chosen. A fresh sink's `targetType` is
 * the empty string, and `#model?type=` names nothing — it would land on the
 * model screen's first type and look, exactly, like a link that worked.
 */
function SinkInspector({
  node,
  typeOptions,
  canEdit,
  modelHref,
  onChange,
}: {
  node: WorkflowSinkNode;
  typeOptions: SelectOption[];
  canEdit: boolean;
  modelHref?: (typeName: string) => string;
  onChange: (node: WorkflowNode) => void;
}) {
  const target = node.targetType.trim();
  const href = target.length > 0 ? modelHref?.(target) : undefined;

  return (
    <div className="space-y-3">
      <SelectField
        label="Commits"
        ariaLabel="Which object type this sink writes"
        value={node.targetType}
        onValueChange={(targetType) => onChange({ ...node, targetType })}
        options={typeOptions}
        placeholder="Choose one type…"
        disabled={!canEdit}
        hint="The type is set here, on the node that commits it, rather than once for the whole graph — several sinks may write several types."
      />
      {href && (
        <a
          href={href}
          // The type's own name in the label, so the accessible name says what
          // is on the other side. `Database` is decorative beside it.
          aria-label={`Open ${target} on the model screen`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs outline-none',
            RULE,
            'hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 dark:hover:bg-zinc-800',
          )}
        >
          <Database size={12} aria-hidden />
          Open {target}
          <ExternalLink size={12} aria-hidden className={MUTED} />
        </a>
      )}
      <SelectField
        label="Commit mode"
        ariaLabel="Whether this sink replaces the dataset or merges into it"
        value={node.mode ?? 'full'}
        onValueChange={(mode) =>
          onChange({
            ...node,
            mode: mode === 'incremental' ? 'incremental' : 'full',
          })
        }
        options={[
          { value: 'full', label: 'Full — replace the dataset' },
          { value: 'incremental', label: 'Incremental — merge into it' },
        ]}
        disabled={!canEdit}
      />
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        This sink commits {node.targetType || 'its type'} on its own. Another sink in the same graph
        committing a different type is a separate commit — one can succeed while this one fails, and
        the run is reported as failed when any of them does.
      </p>
    </div>
  );
}

/**
 * Which workflow this node hands its step to, and what it hands it.
 *
 * ## There is a picker now, and there was not before
 *
 * This used to be two text fields and a docblock explaining why a dropdown
 * could not be built honestly, and that explanation is worth keeping because it
 * is still what the picker has to be careful about. Nothing could enumerate a
 * deployment's registrations: the durable engine answered
 * `workflowBody(name, version)` for the process asking and nothing else, and a
 * missing body meant *either* "not registered" *or* "its body is in another SDK
 * behind `registerRemote`" *or* "it is a group resolved by convention against a
 * live worker". A list inferred from that would have omitted precisely the
 * cross-SDK workflows this node exists to call, and omitted them silently — a
 * picker that quietly hides the thing you are looking for is worse than a text
 * box.
 *
 * `@dudousxd/nestjs-durable-core` **0.65.0** added
 * `WorkflowEngine.announcedWorkflows()`, which is not an inference: live workers
 * publish what they can execute on the descriptor keyspace and every pod folds
 * the same statements. `GET pipeline/callable-workflows` serves it as
 * `CallableWorkflowRef`s, and the two fields below offer them. Three properties
 * of that aggregate are load-bearing here and none of them may be flattened:
 *
 * - **It lists what is runnable now, not what is known about.** The announcer is
 *   always the queue's consumer, so it is neither a superset nor a subset of any
 *   registry. A workflow missing from it may be perfectly real.
 * - **It is a snapshot about one heartbeat wide.** Liveness is a TTL on the
 *   descriptor key, so a worker that dies takes its entries with it within about
 *   half a minute. Hence the ten-second `staleTime` below, the refetch on mount,
 *   and the time printed under the field. It is never cached like
 *   `capabilities`, which is stale-forever and correctly so.
 * - **Disagreements are surfaced, never resolved.** Two workers claiming one
 *   `name@version` from two groups mean nobody can say which queue a run would
 *   land on, so `callableWorkflowBlock` — core's rule, shared with the server —
 *   refuses the entry. It is still SHOWN, greyed, with the reason: an entry
 *   silently dropped from a picker is the failure the old docblock was about.
 *
 * The same rule refuses a bare, unversioned announcement, which is what an
 * un-upgraded worker of any SDK publishes. A name with no version cannot satisfy
 * the pin, and offering it as though it could would be a lie the node then
 * carries.
 *
 * ## Two searchable fields, not one select over `name@version`
 *
 * The first shape of this was a single `SelectField` listing combined
 * `name@version` keys, with the two text fields left underneath it. Three things
 * were wrong with that and all three are fixed here.
 *
 * - **A popup with no search is unusable at fleet size.** A deployment
 *   announcing three hundred workflows renders three hundred rows, and the only
 *   gesture over them is "scroll until you see it". Both fields are `Combobox`
 *   now: type to narrow, on the name, the group and the description.
 * - **Name and version are two questions and read as two.** Choosing the
 *   workflow and choosing which of its versions to pin are separate decisions,
 *   and a list of `billing.reconcile@1`, `billing.reconcile@2`,
 *   `billing.reconcile@3` makes the *name* list three times longer to answer a
 *   question about versions. The name field lists names; the version field
 *   lists the versions announced for the name that was chosen.
 * - **Three controls for two values is one too many.** The select and the text
 *   fields said the same two things twice, and a select that could not express
 *   what somebody typed had to be shown next to a box that could.
 *
 * ## Typing something the fleet never announced still works
 *
 * That is why these are `Combobox`es and not `Select`s, and it is the property
 * the whole node depends on. A deployment whose workers have not been upgraded
 * announces little or nothing, and a picker that became the only path would make
 * this node unusable there. Base UI's `Autocomplete` has no *selected value* at
 * all — the input's text is the value and the list is a suggestion over it — so
 * both fields remain typeable at all times, including when the list is empty,
 * unavailable, or simply does not contain what somebody is pointing at.
 *
 * ## Both halves, or neither
 *
 * Splitting one select into two raised the failure the single select could not
 * have: a name committed on its own, leaving a node that looks configured and
 * runs whatever is newest on the day it runs. See {@link CallInspector}'s
 * `chooseName` — choosing a name writes the version in the SAME update whenever
 * the fleet announces exactly one, which is the common case and stays one
 * action, and blanks it rather than guessing when it does not. Blank is refused
 * by `callIsUnnamed`, and the note under the field says so before the save does.
 *
 * ## Why the version is a required field and not a convenience
 *
 * Without it the load would run whichever version is registered on the day it
 * runs, so the person who owns that workflow could change what this pipeline
 * does by deploying theirs. With it, a mismatch stops the load and says so.
 * What it still cannot do is *prevent* the wrong version starting. `engine.start`
 * takes a pinned `version` as of durable 0.65.0, but the catalog does not pass
 * one, and that is a decision rather than an oversight: a pinned start is
 * refused outright on the two SYNTHESIZED registration paths — a child
 * inheriting a remote ancestor's routing, and convention routing to a live
 * worker group — which are exactly how a cross-SDK workflow is reached. Pinning
 * at the start would therefore break the calls this node exists for. So the
 * check still happens immediately after the start, and cancels. The note under
 * the fields says that in the room where somebody is typing the version, rather
 * than only in a docblock they will never open.
 */
function CallInspector({
  node,
  canEdit,
  onChange,
}: {
  node: WorkflowCallNode;
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  // Held locally, pushed up when it parses — the same rule `SourceInspector`
  // follows for its text fields. Re-deriving the box from the stored config
  // would rewrite what somebody is halfway through typing, and a JSON editor
  // that reformats mid-keystroke is unusable.
  const [text, setText] = useState(() => configText(node.config));
  const [invalid, setInvalid] = useState(false);

  const client = useCatalogClient();
  // Asked here rather than by the canvas and threaded down, because this is the
  // only component that wants it and a call node is a small minority of the
  // nodes anybody draws — a canvas-level query would ask every deployment for
  // its fleet on every page load to serve a field most graphs never open.
  const announced = useQuery({
    queryKey: catalogQueryKeys.callableWorkflows,
    queryFn: () => client.listCallableWorkflows(),
    // Ten seconds, against the descriptor TTL of about thirty-five. Long enough
    // that opening and closing the sheet does not re-ask, short enough that a
    // worker which died while somebody was reading is gone before they choose.
    // Emphatically NOT `Infinity`, which is right for `capabilities` and would
    // here pin the list to whatever the fleet looked like when the tab opened.
    staleTime: 10_000,
    retry: false,
  });

  const pushConfig = (next: string) => {
    setText(next);
    const parsed = parseConfigText(next);
    setInvalid(parsed === undefined);
    if (parsed !== undefined) onChange({ ...node, config: parsed });
  };

  const refs = announced.data?.workflows ?? [];
  const name = node.callName.trim();
  const version = node.callVersion.trim();
  // Every announcement of the name currently in the box — including the blocked
  // ones, which is the point. What the version field offers is derived from
  // this, so an entry that cannot be pinned appears there greyed rather than
  // vanishing between the two fields.
  const forName = refs.filter((ref) => ref.name === name);
  const nameOptions = callableNameOptions(refs);
  const versionOptions = callableVersionOptions(forName);
  // The one announcement this node is pinned to, when it is pinned to one at
  // all. A node pointing at something the fleet is not announcing gets no
  // confirmation line rather than a nearest match — saying "a live worker
  // announces this" about an entry nobody announced is the lie the whole
  // component is arranged against.
  //
  // A blocked entry can never be it, however exactly the two strings line up:
  // an `ambiguous-group` entry is not a pin anybody can act on, and an entry
  // with no version cannot be one at all, however empty the version field
  // happens to be.
  const chosen = forName.find(
    (ref) => ref.version !== undefined && ref.version === version && !callableWorkflowBlock(ref),
  );
  const blocked = refs
    .map((ref) => ({ ref, block: callableWorkflowBlock(ref) }))
    .filter((entry): entry is { ref: CallableWorkflowRef; block: CallableWorkflowBlock } =>
      Boolean(entry.block),
    );
  // Announced, pinnable and not yet chosen: the state where the name is settled
  // and the version is a real question. Worth a sentence of its own because it
  // is the ONLY way this pair of fields can leave a node half-pinned, and the
  // person who just picked a name is the one who can finish it.
  const undecided = name.length > 0 && version.length === 0 && versionOptions.length > 0;
  // Core's reader, not a `?? 'envelope'` of this screen's own: a second copy of
  // the default is how the canvas and `workflowGraphHash` come to disagree, and
  // the symptom is unsaved changes reported on a graph nobody edited.
  const mode: WorkflowCallMode = workflowCallMode(node);
  // Two different silences, and telling somebody the wrong one is worse than
  // telling them nothing. An empty aggregate is a fact about the DEPLOYMENT and
  // the server's own sentence explains it; an empty aggregate is not what a
  // search that matched none of three hundred announcements means, and printing
  // "no durable engine resolved" over that would be a diagnosis of the wrong
  // thing entirely.
  let noNames: string;
  if (announced.isPending) noNames = 'Asking the live workers what they can execute…';
  else if (refs.length > 0)
    noNames =
      'No live worker announces a workflow by that name. Type it anyway if you know it is there — a worker too old to publish its registrations still runs the workflow.';
  else
    noNames =
      announced.data?.detail ??
      'Nothing here could be asked what this deployment can execute, so there is no list to choose from. Type the workflow name and the version to pin.';

  /**
   * Commit a name, and the version with it whenever the fleet leaves no choice.
   *
   * Splitting one `name@version` select into two fields is what makes this
   * function necessary: a name committed on its own leaves a node that looks
   * configured and runs whatever is newest on the day it runs, which is the
   * single failure the pin exists to prevent. So the version moves in the SAME
   * update, by three rules, in order:
   *
   * 1. **The version already held is announced for the new name** — keep it.
   *    Re-picking the same name must not disturb a settled node, and a version
   *    two workflows share is not a coincidence worth punishing.
   * 2. **The version is blank, or was the old name's** — replace it. Blank is
   *    the fresh node; the old name's version is now stale, and leaving it would
   *    produce a pin nobody announced while looking like one somebody chose. It
   *    becomes the one pinnable version when there is exactly one — the common
   *    case, and it stays one action — and blank otherwise, because a guess
   *    between two versions is the thing the pin exists to stop. Blank is
   *    refused by `callIsUnnamed` and said out loud under the field.
   * 3. **Anything else** — leave it. A version somebody typed that the fleet
   *    never offered is theirs, and this field has no standing to erase it.
   *
   * `callableWorkflowBlock` decides what counts as pinnable throughout, here at
   * the moment of commit and not only where rows are greyed. A disabled row is a
   * rendering decision; the rule about what may be written onto the graph is not
   * one, and a Base UI item that stopped honouring `disabled` must not be able
   * to get round it.
   */
  const chooseName = (option: ComboOption) => {
    const offered = pinnableVersions(refs, option.value);
    if (offered.length === 0) return;
    if (offered.includes(version)) {
      onChange({ ...node, callName: option.value });
      return;
    }
    const ours = version.length === 0 || pinnableVersions(refs, name).includes(version);
    const only = offered.length === 1 ? offered[0] : undefined;
    onChange({ ...node, callName: option.value, callVersion: ours ? (only ?? '') : version });
  };

  /**
   * Commit a version, against the name in the box.
   *
   * Looked up as an announcement rather than taken as a string, for the same
   * reason `chooseName` re-checks: the row carries a claim, and the claim is
   * what `callableWorkflowBlock` gets to refuse.
   */
  const chooseVersion = (option: ComboOption) => {
    const ref = forName.find((candidate) => candidate.version === option.value);
    if (!ref || ref.version === undefined || callableWorkflowBlock(ref)) return;
    onChange({ ...node, callName: ref.name, callVersion: ref.version });
  };

  /**
   * Commit a wire format, refusing anything that is not one of the two.
   *
   * A `SelectField` hands back a bare string, and this is the graph being
   * written rather than a row being rendered: the same standing `chooseVersion`
   * takes about a blocked entry. An unrecognised value would be stored, refused
   * at the save boundary by `readCallMode`, and reported as being about a field
   * this screen wrote — so it is never written in the first place.
   */
  const chooseMode = (value: string) => {
    const next = WORKFLOW_CALL_MODES.find((candidate) => candidate === value);
    if (next === undefined) return;
    onChange({ ...node, callMode: next });
  };

  return (
    <div className="space-y-3">
      <ComboboxField
        label="Workflow"
        value={node.callName}
        onValueChange={(callName) => onChange({ ...node, callName })}
        onSelect={chooseName}
        options={nameOptions}
        placeholder="billing.reconcile"
        disabled={!canEdit}
        emptyMessage={noNames}
        hint={
          <>
            The name it is registered under in this deployment, exactly. Type to search what a live
            worker says it can execute right now, read at {readTime(announced.data?.observedAt)} — a
            snapshot, not a registry, so a worker that stops beating drops off it within about half
            a minute and one too old to announce its registrations was never on it. Anything you
            type is accepted whether or not it is on the list; its body may be in another language,
            which is the point of calling it rather than writing it here.
          </>
        }
      />
      <ComboboxField
        label="Version"
        value={node.callVersion}
        onValueChange={(callVersion) => onChange({ ...node, callVersion })}
        onSelect={chooseVersion}
        options={versionOptions}
        placeholder="1"
        disabled={!canEdit}
        emptyMessage={
          name.length === 0
            ? 'Name a workflow first, and the versions announced for it are listed here.'
            : `No live worker announces a version of "${name}". Type the one you mean.`
        }
        hint="Pinned, and part of what this graph is. Registered without a version, a workflow is version 1. Repointing this at another version is an edit to this graph, and shows up as one."
      />
      {undecided && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          {/* The one gap two fields can leave that one combined select could
              not, said in the room rather than only in the save's refusal. */}
          The fleet announces more than one version of “{name}”, so nothing here picked one for you.
          Until you do, this node names half of what it needs and the graph will not save.
        </p>
      )}
      {chosen && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          {/* Worded so it cannot be confused with the refusals below it, which
              also open "A live worker announces …" and mean the opposite. */}
          This exact pin is announced right now: {chosen.name}@{chosen.version}
          {chosen.group ? `, on group ${chosen.group}` : ''}
          {chosen.workers === 1 ? ' — by one worker, so it is a single point of failure.' : '.'}
        </p>
      )}
      {blocked.length > 0 && (
        <div className={cn('space-y-1 text-[11px] leading-relaxed', MUTED)}>
          {/* Listed in full rather than left to the greyed rows, whose hint line
              is one truncated line inside a popup. An entry that cannot be
              chosen owes a reason somebody can read, and the alternative —
              dropping it from the list — is how a picker comes to hide the
              thing you were looking for. Every blocked entry, not only those
              under the name currently in the box: a name whose every
              announcement is refused is a name somebody will otherwise type
              again tomorrow. */}
          {blocked.map(({ ref, block }) => (
            <p key={callableKey(ref)}>{block.message}</p>
          ))}
        </div>
      )}
      <SelectField
        label="What it is sent"
        ariaLabel="Whether the workflow is handed the catalog envelope or the parameters on their own"
        value={mode}
        onValueChange={chooseMode}
        options={WORKFLOW_CALL_MODES.map((value) => ({
          value,
          label: CALL_MODE_COPY[value].label,
        }))}
        disabled={!canEdit}
      />
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        {/* The trade, said where the choice is made rather than only in the
            refusal the save would produce. */}
        {CALL_MODE_COPY[mode].note}
      </p>
      <TextAreaField
        label="Parameters"
        value={text}
        onChange={pushConfig}
        rows={5}
        mono
        placeholder="{}"
        disabled={!canEdit}
        hint={
          invalid
            ? 'That is not valid JSON yet, so it has not been saved onto the node.'
            : CALL_MODE_COPY[mode].parameters
        }
      />
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        This runs as a child of the load, with its own retries, and the load waits for it. If it
        fails, this node fails and nothing after it runs. Cancelling the load cancels it; letting
        the load time out does not, so a workflow you call should carry its own execution timeout.
      </p>
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        Whether two loads calling it can overlap is decided by how <em>it</em> was registered, not
        by this graph — and on the path a workflow in another language is reached by, that
        declaration may not be visible to the engine at all, so assume it can run alongside itself.
      </p>
    </div>
  );
}

/**
 * What each wire format is called on the screen, and what choosing it means.
 *
 * A record over every mode rather than a hand-written options array, for the
 * reason {@link NODE_KIND_IS_REUSABLE} is one in core: a third format added to
 * `WORKFLOW_CALL_MODES` without an entry here is a type error in this file
 * naming the copy it has not been given, rather than a mode the runner can send
 * and this inspector silently never offers. That is the add-node row that
 * shipped the `filter` node with no way to create it, and it is not being
 * repeated one field down.
 *
 * `unreachableCallMode` is not the guard here because a lookup table can be
 * exhaustive at compile time, which is stronger — there is no branch to fall
 * off the end of.
 */
const CALL_MODE_COPY = {
  envelope: {
    label: 'Envelope — written for this catalog',
    note: 'The workflow is handed an envelope: the parameters under `input`, and beside them, under `catalog`, this run’s id and the staged rows of whatever feeds this node — handles, never the rows themselves. It can stage rows back for the next node, and it has to have been written for this catalog to read any of it.',
    parameters:
      'A JSON object, handed to the workflow as `input`. Beside it, under `catalog`, it also gets this run’s id and the staged rows of whatever feeds this node — handles, never the rows themselves. Not a place for a password: name an env var the callee already reads.',
  },
  plain: {
    label: 'Plain — the parameters on their own',
    note: 'The parameters go across on their own, exactly as typed, with nothing of this catalog added — so a workflow that has never heard of this catalog can be called without being changed. It is told no run id and no node id, so it has nowhere to write rows back to: this node always passes on none, whatever the workflow returns, and the graph will not save if you wire anything downstream of it. Run it for its effect, and let a source produce what gets committed.',
    parameters:
      'A JSON object, and the whole of what the workflow receives — its keys are the keys it reads. Not a place for a password: name an env var the callee already reads.',
  },
} as const satisfies Record<WorkflowCallMode, { label: string; note: string; parameters: string }>;

/**
 * What identifies one announced entry among the others.
 *
 * `name@version`, and the bare name when nobody announced a version — the same
 * key the durable aggregate sorts on, and the reason it can identify a row at
 * all: the fleet reports one entry per `name@version`, so two entries can never
 * collide. A key of the name alone would collapse the versions into one, which
 * is the picker undoing the pin.
 */
function callableKey(ref: CallableWorkflowRef): string {
  return ref.version === undefined ? ref.name : `${ref.name}@${ref.version}`;
}

/**
 * The announced names, one row each, for the workflow field.
 *
 * One row per NAME here and one row per version in the field below, which is the
 * split this pair of fields exists to make. A single list of `name@version` keys
 * answers the version question inside the name question: a workflow with eight
 * versions takes eight rows of a list somebody is scanning for a name, and the
 * name they want is eight times harder to find because of versions they have not
 * been asked about yet.
 *
 * A name is refused only when EVERY announcement under it is refused — one
 * unpinnable version among four pinnable ones says nothing about the name. The
 * refusals themselves are per entry and belong to the version field, which shows
 * them; this line only reports that there is nothing pinnable left.
 */
function callableNameOptions(refs: CallableWorkflowRef[]): ComboOption[] {
  const names = [...new Set(refs.map((ref) => ref.name))].sort();
  return names.map((name) =>
    callableNameOption(
      name,
      refs.filter((ref) => ref.name === name),
    ),
  );
}

/** One name, folded across every announcement of it. */
function callableNameOption(name: string, forName: CallableWorkflowRef[]): ComboOption {
  const pinnable = forName.filter((ref) => callableWorkflowBlock(ref) === undefined);
  const groups = [...new Set(forName.flatMap(groupsOf))].sort();
  const description = forName.find((ref) => ref.description !== undefined)?.description;
  const workers = forName.reduce((most, ref) => Math.max(most, ref.workers ?? 0), 0);

  const facts =
    pinnable.length === 0 ? refusalFacts(forName) : [countOf(pinnable.length, 'version')];
  // The group is the single most useful fact here — the only signal
  // distinguishing "this body lives in another process, in another language"
  // from "this one is local", which is precisely what a missing `workflowBody`
  // could never tell apart.
  if (groups.length === 1) facts.push(`group ${groups[0]}`);
  if (groups.length > 1) facts.push(`groups ${groups.join(', ')}`);
  if (description) facts.push(description);
  // One worker is a single point of failure, and a graph built on it should say
  // so before the day it matters.
  if (workers > 0) facts.push(countOf(workers, 'worker'));

  return {
    value: name,
    label: name,
    hint: facts.join(' · '),
    // Searched but not shown. Somebody hunting the Python half of the fleet
    // types the group, and somebody who half-remembers what a workflow does
    // types that — a search over the name alone answers both with "nothing".
    keywords: [...groups, description ?? ''].join(' '),
    disabled: pinnable.length === 0,
  };
}

/**
 * Why nothing under a name can be pinned, in the few words a popup row has.
 *
 * Short deliberately: this line truncates inside the popup, and the full
 * sentences `callableWorkflowBlock` writes are printed under the fields, where
 * nothing truncates them.
 */
function refusalFacts(forName: CallableWorkflowRef[]): string[] {
  const codes = new Set(forName.map((ref) => callableWorkflowBlock(ref)?.code));
  const facts: string[] = [];
  if (codes.has('no-version')) facts.push(noVersionFact(forName));
  if (codes.has('ambiguous-group')) facts.push('claimed by two groups — ambiguous');
  return facts;
}

/**
 * Which flavour of "no version" this is, in the few words a row has.
 *
 * `'observed'` means nothing described the workflow at all — it is on the list
 * because a live queue of that name exists, which is what a call would be routed
 * on and the whole of what is known. That is a weaker thing than a worker which
 * published a description and left the version out, and the row says which,
 * because they call for different reading: the first is "there is a queue here",
 * the second is "there is a worker here that did not say".
 */
function noVersionFact(refs: CallableWorkflowRef[]): string {
  const described = refs.some((ref) => ref.evidence !== 'observed');
  return described
    ? 'no version announced — cannot be pinned'
    : 'live queue only, nothing declared — cannot be pinned';
}

/**
 * The versions announced for one name, one row each.
 *
 * Every announcement of that name, including the ones that cannot be chosen. A
 * bare, unversioned announcement — what an un-upgraded worker of any SDK
 * publishes — is a row here too, greyed and labelled as having no version: it is
 * a real thing the fleet said about this name, and the alternative is a picker
 * that quietly disagrees with the sentence printed underneath it.
 */
function callableVersionOptions(forName: CallableWorkflowRef[]): ComboOption[] {
  return forName
    .map(callableVersionOption)
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
}

function callableVersionOption(ref: CallableWorkflowRef): ComboOption {
  const block = callableWorkflowBlock(ref);
  const facts: string[] = [];
  if (block?.code === 'no-version') facts.push(noVersionFact([ref]));
  if (block?.code === 'ambiguous-group')
    facts.push(`two groups (${groupsOf(ref).join(', ')}) — ambiguous`);
  if (ref.group) facts.push(`group ${ref.group}`);
  if (ref.description) facts.push(ref.description);
  if (ref.workers !== undefined) facts.push(countOf(ref.workers, 'worker'));
  return {
    // The fleet folds one entry per `name@version`, so within one name the
    // versions are distinct and at most one entry is bare — which makes the
    // empty string a safe identity for that one rather than a collision.
    value: ref.version ?? '',
    label: ref.version ?? 'no version announced',
    hint: facts.join(' · '),
    keywords: [ref.group ?? '', ref.description ?? ''].join(' '),
    disabled: block !== undefined,
  };
}

/** "1 worker" / "3 workers". A count whose plural is not left to the reader. */
function countOf(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/**
 * The versions of one name that may actually be pinned.
 *
 * `callableWorkflowBlock` is the authority, not the presence of a version
 * string: an `ambiguous-group` entry has a perfectly good version and still may
 * not be committed.
 */
function pinnableVersions(refs: CallableWorkflowRef[], name: string): string[] {
  const versions: string[] = [];
  for (const ref of refs) {
    if (ref.name !== name || ref.version === undefined) continue;
    if (callableWorkflowBlock(ref) === undefined) versions.push(ref.version);
  }
  return versions;
}

/**
 * Every group named in one announcement.
 *
 * `group` is set when the announcers agree on exactly one, and left unset when
 * they disagree — in which case the values are in `disagreements` and both are
 * worth showing. Silence contributes nothing, because silence is not a claim.
 */
function groupsOf(ref: CallableWorkflowRef): string[] {
  if (ref.group !== undefined) return [ref.group];
  return ref.disagreements?.find((entry) => entry.axis === 'group')?.values ?? [];
}

/**
 * When the fleet was asked, as a clock time.
 *
 * Printed at all because this list is a snapshot roughly one heartbeat wide, and
 * a screen that showed it with no time attached would be presenting a moment as
 * a standing fact. Falls back to the plain string rather than to nothing when
 * the server sends something unparseable — a server that answered is a server
 * that answered, and hiding its timestamp because the format surprised us would
 * remove the one caveat this field is here to carry.
 */
function readTime(observedAt: string | undefined): string {
  if (!observedAt) return 'an unknown time';
  const at = new Date(observedAt);
  return Number.isNaN(at.getTime()) ? observedAt : at.toLocaleTimeString();
}
/**
 * What this gate decides on, and what the decision costs.
 *
 * ## The kind of test comes first, and switching it replaces the test
 *
 * A gate tests one thing — a variable where the load runs, or how many rows
 * reached it — and the model says so with a union rather than with two sets of
 * optional fields. The form is built the same way round: pick the kind, then
 * fill in the fields that kind has. Switching the picker hands back a whole new
 * predicate rather than merging the old one's fields into it, which does discard
 * a variable name somebody typed — deliberately, because the alternative is a
 * node quietly carrying the leftovers of a test it is no longer making, and the
 * next reader cannot tell which of the two it will actually do.
 *
 * ## No picker for the variable, for a different reason than the call node's
 *
 * A call node has no picker because nothing can enumerate the workflows. This
 * one has no picker because the list would be *wrong*: the variables that matter
 * are the ones this deployment has and the other one does not, so a list built
 * from what the console's own process can see would offer exactly the wrong set
 * — the ones present everywhere — and quietly omit the one somebody is looking
 * for. Text, and the graph is refused until it is filled in.
 *
 * ## What is said out loud here and nowhere else
 *
 * That the value never leaves the machine, because somebody typing
 * `CLICKHOUSE_URL` into a form is entitled to know whether they have just put a
 * password on a screen. That the test runs where the *load* runs rather than
 * here, because a variable set in the console's pod and not in the worker's is
 * the way this goes wrong. And that the branch is decided once and recorded, so
 * a resumed run cannot change its mind — which is the sentence that makes the
 * run panel's "took the then branch" trustworthy.
 */
function IfInspector({
  node,
  canEdit,
  onChange,
}: {
  node: WorkflowIfNode;
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  const setPredicate = (predicate: WorkflowIfPredicate) => onChange({ ...node, predicate });

  return (
    <div className="space-y-3">
      <SelectField
        label="Decide on"
        ariaLabel="What this gate branches on"
        value={node.predicate.kind}
        onValueChange={(kind) => {
          // Narrowed rather than trusted, because `onValueChange` hands back a
          // string and the model wants one of two. An unrecognised one is
          // dropped: a gate is never left holding a test nothing can evaluate.
          if (!isWorkflowPredicateKind(kind)) return;
          setPredicate(freshPredicate(kind));
        }}
        options={[
          { value: 'env', label: 'An environment variable', hint: 'where the load runs' },
          {
            value: 'rowCount',
            label: 'How many rows reached it',
            hint: 'off the run’s own record',
          },
        ]}
        disabled={!canEdit}
        hint="A variable tells one deployment apart from another. A row count tells a load that found data apart from one that found none — which is how a sink is kept from committing an empty snapshot over what is live."
      />
      <PredicateFields predicate={node.predicate} canEdit={canEdit} onChange={setPredicate} />
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        The wires out of this node are labelled <strong>then</strong> and <strong>else</strong>,
        under “Feeds” below. To invert the test, swap which one is which — there is no “not”,
        because two ways to say one thing is two places to look when a load goes the way you did not
        expect.
      </p>
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        Everything reachable only through the branch that is not taken is <em>skipped</em>, never
        failed. A sink on that side commits nothing, so whatever it publishes stays exactly as it
        was — that is the point, and the run panel says so rather than leaving a blank.
      </p>
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        The branch is decided once, at the moment this node runs, and recorded on the run. A load
        that is resumed after a crash reads the decision back instead of asking again, so it cannot
        take one branch on the way in and the other on the way back.
      </p>
    </div>
  );
}

/**
 * The test a freshly picked kind starts as.
 *
 * An env test starts blank, so the graph refuses to publish until somebody names
 * a variable — there is nothing to guess. A row-count test starts at 1, which is
 * not a guess but the *only* threshold that means "did anything arrive at all",
 * which is the case the predicate was built for; a bigger number is a claim
 * about a particular pipeline and is typed.
 */
function freshPredicate(kind: WorkflowPredicateKind): WorkflowIfPredicate {
  if (kind === 'env') return { kind: 'env', envVar: '' };
  if (kind === 'rowCount') return { kind: 'rowCount', atLeast: 1 };
  return unreachablePredicateKind(kind, 'freshPredicate');
}

/**
 * The fields one kind of test has, and none of the fields the other has.
 *
 * Split per kind and ending in a refusal, so a predicate kind added to the model
 * without a form here stops the build naming this file — the same rule
 * `KindInspector` follows for node kinds, and for the same reason: the failure
 * it prevents is a node somebody can select, that shows nothing to configure,
 * and that runs anyway.
 */
function PredicateFields({
  predicate,
  canEdit,
  onChange,
}: {
  predicate: WorkflowIfPredicate;
  canEdit: boolean;
  onChange: (predicate: WorkflowIfPredicate) => void;
}) {
  if (predicate.kind === 'env') {
    return <EnvPredicateFields predicate={predicate} canEdit={canEdit} onChange={onChange} />;
  }
  if (predicate.kind === 'rowCount') {
    return <RowCountPredicateFields predicate={predicate} canEdit={canEdit} onChange={onChange} />;
  }
  return unreachablePredicateKind(predicate, 'PredicateFields');
}

function EnvPredicateFields({
  predicate,
  canEdit,
  onChange,
}: {
  predicate: WorkflowEnvPredicate;
  canEdit: boolean;
  onChange: (predicate: WorkflowIfPredicate) => void;
}) {
  // Whether to compare against a value at all is a *mode*, not an empty text
  // box: `equals: ''` is a real test ("set, but blank") and `equals: undefined`
  // is a different one ("set to anything"), and a single field could not express
  // both — clearing the box would silently switch which question is being asked.
  const comparing = predicate.equals !== undefined;

  return (
    <>
      <TextField
        label="Environment variable"
        value={predicate.envVar}
        onChange={(envVar) => onChange({ ...predicate, envVar })}
        placeholder="CLICKHOUSE_URL"
        disabled={!canEdit}
        hint="The name of a variable on the machine that runs the load — not on this one. Only its name is stored, and only “set” or “not set” is ever written to the run log, so naming one that holds a credential is safe."
      />
      <SelectField
        label="Test"
        ariaLabel="What this gate tests the variable for"
        value={comparing ? 'equals' : 'set'}
        onValueChange={(mode) =>
          onChange(
            mode === 'equals' ? { ...predicate, equals: '' } : { ...predicate, equals: undefined },
          )
        }
        options={[
          { value: 'set', label: 'Is set to anything' },
          { value: 'equals', label: 'Equals a particular value' },
        ]}
        disabled={!canEdit}
        hint="“Is set” is the deployment test: a deployment that has a ClickHouse has its URL and one that does not has nothing. Compare against a value when the variable exists everywhere and only its contents differ."
      />
      {comparing && (
        <TextField
          label="Equals"
          value={predicate.equals ?? ''}
          onChange={(equals) => onChange({ ...predicate, equals })}
          placeholder="local"
          disabled={!canEdit}
          hint="Compared exactly, with no trimming. An empty value here means “set, but blank”, which is a different test from “is set to anything”."
        />
      )}
    </>
  );
}

/**
 * One threshold, and the sentence that says what it is for.
 *
 * A text box with a numeric keypad rather than `type="number"`, which is the
 * rule `ObjectExplorer` already writes down: that control drops what it cannot
 * parse and answers a scroll wheel, so a number somebody typed can change while
 * they are reading the form. Non-digits are stripped here instead, and an empty
 * box is stored as 0 — which the validator refuses by name, so a half-filled
 * gate says so on the canvas rather than publishing a test that always passes.
 */
function RowCountPredicateFields({
  predicate,
  canEdit,
  onChange,
}: {
  predicate: WorkflowRowCountPredicate;
  canEdit: boolean;
  onChange: (predicate: WorkflowIfPredicate) => void;
}) {
  const digits = Number.isInteger(predicate.atLeast) && predicate.atLeast > 0;

  return (
    <>
      <TextField
        label="At least this many rows"
        value={digits ? String(predicate.atLeast) : ''}
        onChange={(typed) => {
          const cleaned = typed.replace(/[^0-9]/g, '');
          onChange({
            ...predicate,
            atLeast: cleaned.length === 0 ? 0 : Number.parseInt(cleaned, 10),
          });
        }}
        inputMode="numeric"
        placeholder="1"
        disabled={!canEdit}
        hint="1 is “did anything arrive at all”. A larger number is for a load whose export is never legitimately small — under it, treat the upstream as broken rather than as data."
      />
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        The count is the one on the single wire feeding this node, taken from what that node
        recorded — nothing is re-counted, and nothing is read out of the staged rows.
      </p>
    </>
  );
}

/**
 * Building a filter's predicate, and acknowledging what it shrinks.
 *
 * Two halves, and the second one is the reason this inspector is not just a form
 * over a tree. The predicate editor is the ordinary part: a recursive tree of
 * conditions with "and"/"or" groups, built from the vocabulary core exports so a
 * form that offered an operator the runner cannot evaluate is a build failure
 * rather than a graph somebody saves and a step that throws mid-load.
 *
 * The acknowledgement is the part that matters. If this filter is the only thing
 * feeding a sink that *replaces* what a type publishes, then whatever it drops
 * disappears from that type — silently, because the run succeeds. The graph
 * cannot tell that apart from filtering to derive something new (see
 * `WorkflowFilterNode.narrows`: they are structurally identical graphs), so the
 * screen asks, per type, and the server refuses the graph until it is answered.
 * The switches below are that question, and they are shown *only* when the
 * question is live — offering them on a filter that narrows nothing would train
 * people to flip them.
 */
/**
 * The rename node's form: a list of columns, and one decision about the rest.
 *
 * ## Why the list is local state and the record is not
 *
 * The model is a `Record<string, string>`, which is the right shape to store —
 * a key cannot appear twice, so "two renames of the same source column" is
 * unrepresentable rather than merely refused. It is the wrong shape to *edit*:
 * a half-typed key is a key, and rebuilding the record on every keystroke would
 * collapse two rows the moment they were briefly equal — most obviously the two
 * blank rows you get by pressing "Add column" twice.
 *
 * So the rows are held here, in order, and the record is derived from them. The
 * one thing that can diverge is two rows naming the same source column, and
 * that is said out loud below rather than silently resolved.
 *
 * ## What the panel can tell somebody that a transform's could not
 *
 * Which columns actually reach this node — sometimes. `workflowKnownColumns` is
 * exact downstream of a rename that drops what it does not name, unknown
 * everywhere else, and the difference is stated rather than papered over. This
 * is the whole payoff of the node being data instead of code, so the panel
 * should say it in as many words.
 */
function RenameInspector({
  node,
  graph,
  canEdit,
  onChange,
}: {
  node: WorkflowRenameNode;
  graph: WorkflowGraph;
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  const map: Record<string, string> = node.columns ?? {};
  const [rows, setRows] = useState<Array<{ from: string; to: string }>>(() => {
    const entries = Object.entries(map).map(([from, to]) => ({ from, to }));
    return entries.length > 0 ? entries : [{ from: '', to: '' }];
  });

  const commit = (next: Array<{ from: string; to: string }>) => {
    setRows(next);
    const columns: Record<string, string> = {};
    for (const row of next) columns[row.from] = row.to;
    onChange({ ...node, columns });
  };

  const setUnnamed = (value: string) => {
    if (!isWorkflowRenameUnnamed(value)) return;
    // Stored absent for `keep`, so the default has one spelling and picking up
    // this release cannot renumber a graph nobody edited. The boundary
    // normalises the same way.
    onChange({ ...node, unnamed: value === 'drop' ? 'drop' : undefined });
  };

  const dropping = workflowRenameUnnamed(node) === 'drop';
  const known = workflowKnownColumns(graph, node.id);
  const refusals = renameColumnRefusals(map);
  const duplicated = rows
    .map((row) => row.from)
    .filter((from, at, all) => from.length > 0 && all.indexOf(from) !== at);

  return (
    <div className="space-y-3">
      <FieldGroup
        title="Columns"
        hint={
          <>
            The name the records arrive with, and the name they leave with. The old name is whatever
            the source actually calls it — <code>Mgmt Cd</code> and <code>VEH Type Name</code> are
            fine. The new one has to be a name a column can have: letters, digits and underscore,
            starting with a letter or an underscore.
          </>
        }
      >
        {rows.map((row, index) => (
          <div
            // Positional keys. Rows have no id, the only edits are
            // replace-in-place, append and remove, and there is no draft state
            // below this point to preserve.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            className="flex items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <TextField
                label={index === 0 ? 'In the source' : ''}
                value={row.from}
                placeholder="Mgmt Cd"
                disabled={!canEdit}
                onChange={(from) =>
                  commit(rows.map((each, at) => (at === index ? { ...each, from } : each)))
                }
              />
            </div>
            <div className="min-w-0 flex-1">
              <TextField
                label={index === 0 ? 'Becomes' : ''}
                value={row.to}
                placeholder="mgmtCd"
                disabled={!canEdit}
                onChange={(to) =>
                  commit(rows.map((each, at) => (at === index ? { ...each, to } : each)))
                }
              />
            </div>
            {canEdit && rows.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => commit(rows.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => commit([...rows, { from: '', to: '' }])}
            disabled={rows.length >= WORKFLOW_RENAME_MAX_COLUMNS}
          >
            Add column
          </Button>
        )}
      </FieldGroup>

      <SelectField
        label="Columns you did not name"
        ariaLabel="What happens to the columns this node does not rename"
        value={workflowRenameUnnamed(node)}
        onValueChange={setUnnamed}
        disabled={!canEdit}
        options={[
          { value: 'keep', label: 'Pass through unchanged', hint: 'no data moves' },
          { value: 'drop', label: 'Drop them', hint: 'rebuilds every row' },
        ]}
      />

      {/* The cost, said before the run says it. A pure rename rewrites the
          staged column list and leaves the values exactly where they are;
          dropping a column removes a position from every row, so the data has
          to move. Both are fine and they are not the same node, which is the
          only reason this sentence is here rather than in a docblock. */}
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        {dropping ? (
          <>
            This node <strong>also removes</strong> every column it does not name, so what reaches
            the sink is exactly the {Object.keys(map).length} new name
            {Object.keys(map).length === 1 ? '' : 's'} above. That is a projection as well as a
            rename, and it costs a pass over the rows — a staged batch keeps its values in
            positional arrays, and taking a column out moves every one of them.
          </>
        ) : (
          <>
            Nothing else changes. A staged batch names its columns once and keeps the values in
            positional arrays, so renaming one rewrites a handful of strings and{' '}
            <strong>moves no data at all</strong> — which is why this is a node rather than four
            lines of JavaScript in a transform.
          </>
        )}
      </p>

      {refusals.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          {refusals.join(' ')}
        </p>
      )}

      {duplicated.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          {duplicated.map((from) => `“${from}”`).join(', ')} appears more than once on the left. A
          column can only be renamed to one thing, so only the last row naming it is stored.
        </p>
      )}

      {known ? (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          A rename above this node drops the columns it does not name, so the graph knows exactly
          what arrives here:{' '}
          <span className="font-mono">{[...known].join(', ') || 'nothing at all'}</span>. A row on
          the left naming anything else is refused when this graph is saved, rather than found out
          when the column comes back empty.
        </p>
      ) : (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          The graph cannot say which columns reach this node — a source discovers its shape against
          the live system, and a transform is code. So the old names are taken on trust, and the run
          says out loud if one of them was in no row.
        </p>
      )}
    </div>
  );
}

/**
 * The aggregate node's form: what defines a group, and what to compute per group.
 *
 * ## Why the two lists are local state and the node is not
 *
 * The same argument {@link RenameInspector} makes, arrived at from the other
 * direction. A rename's model is a `Record` and has to be edited as a list; an
 * aggregate's model is already a list, and the reason it is one is here in the
 * form: two aggregates reading the same column — `min(closedDate)` and
 * `max(closedDate)` — are the normal case rather than the mistake, so the
 * output name is the key and a half-typed one is still a row somebody is in the
 * middle of writing.
 *
 * Rows are held here, in order, and the node is derived from them. What can
 * diverge is two rows sharing an output name, and that is said out loud below
 * rather than silently resolved, because resolving it means deciding which of
 * somebody's numbers survives.
 *
 * ## What this panel can say that no other inspector can
 *
 * **Exactly** which columns leave the node. Every other kind's answer is an
 * upper bound at best and `undefined` at worst; an aggregate's output set is
 * closed by its own config — the group keys plus the named aggregates, on every
 * record, always. So the panel prints the list rather than hedging it, and the
 * hedge is reserved for the columns coming *in*, where `workflowKnownColumns`
 * genuinely may not know.
 *
 * ## And the one number it puts in front of somebody before they run it
 *
 * The group ceiling. A hash aggregate is cheap only while the groups are far
 * fewer than the rows, and the moment somebody groups on a near-unique column
 * the node holds the whole load. That is a decision made in this form, so the
 * bound belongs in this form and not only in the run that refuses.
 */
function AggregateInspector({
  node,
  graph,
  canEdit,
  onChange,
}: {
  node: WorkflowAggregateNode;
  graph: WorkflowGraph;
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  const [groupBy, setGroupBy] = useState<string[]>(() =>
    node.groupBy.length > 0 ? [...node.groupBy] : [''],
  );
  const [rows, setRows] = useState<WorkflowAggregate[]>(() =>
    node.aggregates.length > 0 ? [...node.aggregates] : [{ as: '', fn: 'count' }],
  );

  const commitGroupBy = (next: string[]) => {
    setGroupBy(next);
    onChange({ ...node, groupBy: next });
  };

  const commitRows = (next: WorkflowAggregate[]) => {
    setRows(next);
    onChange({ ...node, aggregates: next });
  };

  const setFunction = (index: number, value: string) => {
    if (!isWorkflowAggregateFunction(value)) return;
    commitRows(rows.map((each, at) => (at === index ? refunction(each, value) : each)));
  };

  const known = workflowKnownColumns(graph, node.id);
  const refusals = aggregateRefusals(node);
  const produces = workflowAggregateOutputColumns(node);
  const duplicated = rows
    .map((row) => row.as)
    .filter((as, at, all) => as.length > 0 && all.indexOf(as) !== at);

  return (
    <div className="space-y-3">
      <FieldGroup
        title="Group by"
        hint={
          <>
            What makes two records the same group. These come out under the names they went in
            under, so each has to be a name a column can have — letters, digits and underscore,
            starting with a letter or an underscore. If the source spells its headers{' '}
            <code>Work Order Id</code>, put a Rename node above this one.
          </>
        }
      >
        {groupBy.map((column, index) => (
          <div
            // Positional keys. Rows have no id, the only edits are
            // replace-in-place, append and remove, and there is no draft state
            // below this point to preserve.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            className="flex items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <TextField
                label={index === 0 ? 'Column' : ''}
                value={column}
                placeholder="workOrderId"
                disabled={!canEdit}
                onChange={(next) =>
                  commitGroupBy(groupBy.map((each, at) => (at === index ? next : each)))
                }
              />
            </div>
            {canEdit && groupBy.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => commitGroupBy(groupBy.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => commitGroupBy([...groupBy, ''])}
            disabled={groupBy.length >= WORKFLOW_AGGREGATE_MAX_GROUP_BY}
          >
            Add column
          </Button>
        )}
      </FieldGroup>

      <FieldGroup
        title="Compute"
        hint={
          <>
            One column out per row. <code>count</code> with no column counts the records in the
            group; with a column it counts the ones that are not null. Anything more than these is a
            Transform — there is no conditional here on purpose.
          </>
        }
      >
        {rows.map((row, index) => (
          <div
            // Positional keys, for the reason the group-by list above gives.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            className="space-y-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
          >
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <SelectField
                  label={index === 0 ? 'Function' : ''}
                  ariaLabel="Aggregate function"
                  value={row.fn}
                  onValueChange={(value) => setFunction(index, value)}
                  disabled={!canEdit}
                  options={WORKFLOW_AGGREGATE_FUNCTIONS.map((fn) => ({
                    value: fn,
                    label: fn,
                    hint: AGGREGATE_HINTS[fn],
                  }))}
                />
              </div>
              <div className="min-w-0 flex-1">
                <TextField
                  label={index === 0 ? 'Of column' : ''}
                  value={row.column ?? ''}
                  placeholder={
                    workflowAggregateNeedsColumn(row.fn) ? 'actualLaborCost' : 'every record'
                  }
                  disabled={!canEdit}
                  onChange={(column) =>
                    commitRows(
                      rows.map((each, at) =>
                        at === index
                          ? column.length === 0
                            ? { ...each, column: undefined }
                            : { ...each, column }
                          : each,
                      ),
                    )
                  }
                />
              </div>
              <div className="min-w-0 flex-1">
                <TextField
                  label={index === 0 ? 'Called' : ''}
                  value={row.as}
                  placeholder="totalLaborCost"
                  disabled={!canEdit}
                  onChange={(as) =>
                    commitRows(rows.map((each, at) => (at === index ? { ...each, as } : each)))
                  }
                />
              </div>
              {canEdit && rows.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => commitRows(rows.filter((_, at) => at !== index))}
                >
                  Remove
                </Button>
              )}
            </div>
            {row.fn === 'join' && (
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <TextField
                    label="Separator"
                    value={row.separator ?? ''}
                    placeholder=", "
                    disabled={!canEdit}
                    onChange={(separator) =>
                      commitRows(
                        rows.map((each, at) =>
                          at === index
                            ? separator.length === 0
                              ? { ...each, separator: undefined }
                              : { ...each, separator }
                            : each,
                        ),
                      )
                    }
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <TextField
                    label="Refuse past"
                    value={row.maxLength === undefined ? '' : String(row.maxLength)}
                    placeholder="65535 characters"
                    inputMode="numeric"
                    disabled={!canEdit}
                    hint="Refused, not truncated."
                    onChange={(text) => {
                      const parsed = Number(text.trim());
                      const maxLength =
                        text.trim().length === 0 || !Number.isInteger(parsed) ? undefined : parsed;
                      commitRows(
                        rows.map((each, at) => (at === index ? { ...each, maxLength } : each)),
                      );
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        ))}
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => commitRows([...rows, { as: '', fn: 'count' }])}
            disabled={rows.length >= WORKFLOW_AGGREGATE_MAX_AGGREGATES}
          >
            Add aggregate
          </Button>
        )}
      </FieldGroup>

      {/* The bound, said before the run says it. This is the one node whose cost
          is chosen in the form rather than discovered afterwards: a grouping
          holds one accumulator row per group, so the whole question is whether
          the group-by columns above are coarse enough. */}
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        This node holds <strong>one row per group</strong> and reads the records one staged batch at
        a time, so its memory is the number of groups and not the number of records. If the grouping
        turns out to be nearly one-to-one it holds the whole load, so the run{' '}
        <strong>refuses</strong> past {workflowAggregateMaxGroups(node).toLocaleString()} groups
        rather than quietly filling the machine.
      </p>

      {refusals.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          {refusals.join(' ')}
        </p>
      )}

      {duplicated.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          {duplicated.map((as) => `“${as}”`).join(', ')} is used by more than one row. Two columns
          cannot share one name, and picking a winner would be a rule about which of your numbers
          survives.
        </p>
      )}

      {produces.length > 0 && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          What leaves this node is exactly <span className="font-mono">{produces.join(', ')}</span>,
          on every record — including where the answer is null. Every other column of every record
          stops here. That set is <strong>exact</strong> rather than a best guess, which is what
          lets a filter or a sink below this node be checked when the graph is saved.
        </p>
      )}

      {known ? (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          The graph knows exactly what arrives here:{' '}
          <span className="font-mono">{[...known].join(', ') || 'nothing at all'}</span>. A column
          named above that is not in that list is refused when this graph is saved, rather than
          found out when sixteen thousand rows come back as one.
        </p>
      ) : (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          The graph cannot say which columns reach this node — a source discovers its shape against
          the live system, and a transform is code. So the column names above are taken on trust,
          and the run says out loud if one of them was in no record at all.
        </p>
      )}
    </div>
  );
}

/**
 * The lookup node's form: which input is the reference, the two key columns, and
 * the fields to bring across.
 *
 * ## Why the reference is a picker over inbound edges and not a text box
 *
 * Because the field is a node id, and a node id typed by hand is a graph that
 * saves and then either refuses at validation or — worse — names a node that
 * happens to exist and holds the wrong side of the join in memory. The picker is
 * built from this node's own inbound edges, so the only offerable answers are the
 * ones `validateWorkflow` accepts. With nothing wired in there is nothing to
 * offer, and the panel says that instead of showing an empty select somebody
 * would read as a bug.
 *
 * ## What the panel can say that no other inspector can
 *
 * Which columns are on **which side**. Every other node with several inputs sees
 * them pooled — the rows arrive concatenated — so "the columns reaching this
 * node" is one set. A lookup is the exception: the reference's columns never flow
 * on, so pooling them would offer a key column that only exists over there, and a
 * join on a column the driving rows do not have matches nothing on every row and
 * commits. `workflowLookupColumns` is core's answer to that, not this screen's.
 *
 * Both sides answer "unknown" often and that is stated rather than papered over,
 * the stance `RenameInspector` takes about the same question.
 *
 * ## The rows are local state, the record is derived
 *
 * The same argument `RenameInspector` makes at length: a half-typed key is a key,
 * and rebuilding a `Record` on every keystroke collapses two rows the moment they
 * are briefly equal.
 */
function LookupInspector({
  node,
  graph,
  canEdit,
  onChange,
}: {
  node: WorkflowLookupNode;
  graph: WorkflowGraph;
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  const map: Record<string, string> = node.fields ?? {};
  const [rows, setRows] = useState<Array<{ from: string; to: string }>>(() => {
    const entries = Object.entries(map).map(([from, to]) => ({ from, to }));
    return entries.length > 0 ? entries : [{ from: '', to: '' }];
  });

  const commit = (next: Array<{ from: string; to: string }>) => {
    setRows(next);
    const fields: Record<string, string> = {};
    for (const row of next) fields[row.from] = row.to;
    onChange({ ...node, fields });
  };

  const setUnmatched = (value: string) => {
    if (!isWorkflowLookupUnmatched(value)) return;
    // Stored absent for `null`, so the default has one spelling and picking up
    // this release cannot renumber a graph nobody edited. The boundary
    // normalises the same way.
    onChange({ ...node, unmatched: value === 'null' ? undefined : value });
  };

  const feeds = (graph.edges ?? []).filter((edge) => edge.to === node.id).map((edge) => edge.from);
  const nameOf = (id: string) => (graph.nodes ?? []).find((each) => each.id === id)?.name ?? id;
  const { driving, reference } = workflowLookupColumns(graph, node);
  const refusals = lookupConfigRefusals(node);
  const duplicated = rows
    .map((row) => row.from)
    .filter((from, at, all) => from.length > 0 && all.indexOf(from) !== at);
  const unmatched = workflowLookupUnmatched(node);

  return (
    <div className="space-y-3">
      {feeds.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          Nothing is wired into this node yet. A lookup needs two inputs — the rows you want
          enriched, and the reference to match them against — and it has to be told which of them is
          the reference, because that is the side it holds in memory.
        </p>
      ) : (
        <SelectField
          label="Reference rows come from"
          ariaLabel="Which input holds the reference rows"
          value={feeds.includes(node.reference) ? node.reference : ''}
          onValueChange={(reference) => onChange({ ...node, reference })}
          disabled={!canEdit}
          options={feeds.map((id) => ({
            value: id,
            label: nameOf(id),
            hint: id === node.reference ? 'held in memory' : 'would be held in memory',
          }))}
        />
      )}

      {/* Said here rather than left to the run, because it is the one thing about
          this node that is a property of the operation rather than of the data:
          one side streams and the other does not, and which is which is the
          decision being made two lines above. */}
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        The reference is read once and held as a map, up to{' '}
        {WORKFLOW_LOOKUP_MAX_REFERENCE_ROWS.toLocaleString()} rows; everything else wired in streams
        past it a batch at a time and never accumulates. Point this at the <em>smaller</em> side — a
        run that would hold more than that refuses rather than filling the pod.
      </p>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label="Match on (the rows being enriched)"
            value={typeof node.key === 'string' ? node.key : ''}
            placeholder="planId"
            disabled={!canEdit}
            onChange={(key) => onChange({ ...node, key })}
          />
        </div>
        <div className="min-w-0 flex-1">
          <TextField
            label="Against (the reference rows)"
            value={typeof node.referenceKey === 'string' ? node.referenceKey : ''}
            placeholder="Plan ID"
            disabled={!canEdit}
            onChange={(referenceKey) => onChange({ ...node, referenceKey })}
          />
        </div>
      </div>

      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        Keys are compared <strong>as text, exactly as written</strong> — no trimming, no case
        folding. That is deliberate: deciding that <code>21 CES</code> and <code>21CES</code> are
        the same unit is a rule about your data, and it belongs in a transform on both sides where
        you can see it. A row with nothing in its key column is counted separately and never
        matches.
      </p>

      <FieldGroup
        title="Bring across"
        hint={
          <>
            The column on the reference rows, and the name it lands under. The reference name is
            whatever that side actually calls it — <code>Plan Name</code> is fine. The new one has
            to be a name a column can have: letters, digits and underscore, starting with a letter
            or an underscore. Landing on a column the rows already have is expected and works: a
            published type declares its columns, so the ones you are filling arrive empty. A row
            that already holds a <em>value</em> there stops the run rather than losing it.
          </>
        }
      >
        {rows.map((row, index) => (
          <div
            // Positional keys, for the reason `RenameInspector` gives.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            className="flex items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <TextField
                label={index === 0 ? 'On the reference' : ''}
                value={row.from}
                placeholder="Plan Name"
                disabled={!canEdit}
                onChange={(from) =>
                  commit(rows.map((each, at) => (at === index ? { ...each, from } : each)))
                }
              />
            </div>
            <div className="min-w-0 flex-1">
              <TextField
                label={index === 0 ? 'Lands as' : ''}
                value={row.to}
                placeholder="planName"
                disabled={!canEdit}
                onChange={(to) =>
                  commit(rows.map((each, at) => (at === index ? { ...each, to } : each)))
                }
              />
            </div>
            {canEdit && rows.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => commit(rows.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => commit([...rows, { from: '', to: '' }])}
            disabled={rows.length >= WORKFLOW_LOOKUP_MAX_FIELDS}
          >
            Add field
          </Button>
        )}
      </FieldGroup>

      <SelectField
        label="Rows whose key matches nothing"
        ariaLabel="What happens to a row whose key matches no reference row"
        value={unmatched}
        onValueChange={setUnmatched}
        disabled={!canEdit}
        options={[
          { value: 'null', label: 'Pass on, fields set to null', hint: 'a LEFT JOIN' },
          { value: 'drop', label: 'Drop the row', hint: 'an INNER JOIN — removes rows' },
          { value: 'fail', label: 'Fail this node', hint: 'the reference is a prerequisite' },
        ]}
      />

      {/* The counts are the feature, so they are promised on the screen where the
          node is configured rather than discovered in a run log afterwards. */}
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        {unmatched === 'drop' ? (
          <>
            Unmatched rows <strong>will not reach the next node</strong>, so this node also removes
            rows — a full sink below it publishes only what matched.
          </>
        ) : unmatched === 'fail' ? (
          <>
            The first unmatched row <strong>stops the run</strong>, naming the key it could not
            find. Choose this when the reference is meant to cover everything and a load that cannot
            be enriched is one that should not commit.
          </>
        ) : (
          <>
            Unmatched rows are passed on with these columns set to null — the same result as
            enriching by hand, with one difference that is the whole point of the node.
          </>
        )}{' '}
        Either way the run says how many rows matched, how many had a key that matched nothing, and
        how many had no key at all. A join that matched nothing looks exactly like one that worked
        unless somebody counts.
      </p>

      {refusals.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          {refusals.join(' ')}
        </p>
      )}

      {duplicated.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          {duplicated.map((from) => `“${from}”`).join(', ')} appears more than once on the left. A
          reference column can only land under one name, so only the last row naming it is stored.
        </p>
      )}

      <LookupSidesNote driving={driving} reference={reference} />
    </div>
  );
}

/**
 * One aggregate, with its function changed and the fields that no longer apply
 * dropped.
 *
 * Dropped rather than left behind, because a stored separator on a `sum` is a
 * node the server refuses — and a form that can reach a refused state by
 * changing a dropdown is a form that fails after Save with nothing visibly
 * wrong on the screen.
 */
function refunction(
  aggregate: WorkflowAggregate,
  fn: WorkflowAggregateFunction,
): WorkflowAggregate {
  const kept: WorkflowAggregate = { as: aggregate.as, fn };
  if (workflowAggregateNeedsColumn(fn) && aggregate.column !== undefined) {
    kept.column = aggregate.column;
  }
  if (fn !== 'join') return kept;
  if (aggregate.separator !== undefined) kept.separator = aggregate.separator;
  if (aggregate.maxLength !== undefined) kept.maxLength = aggregate.maxLength;
  return kept;
}

/** One line per function, for the picker. What it does, and what it costs. */
const AGGREGATE_HINTS: Record<WorkflowAggregateFunction, string> = {
  count: 'records in the group, or non-null values of a column',
  sum: 'the total, with the low-order bits kept',
  avg: 'the mean of the non-null values',
  min: 'the least value — text compares by code point, not by database collation',
  max: 'the greatest value — same comparison',
  join: 'the values run together, refusing past a length rather than truncating',
};

/**
 * Which columns the graph can prove are on each of a lookup's two sides.
 *
 * Its own component because it is the sentence that is *only* true of this node
 * kind: every other multi-input inspector could say "the columns reaching this
 * node" as one list, and saying that here would offer a key column that exists
 * only on the reference — a join that matches nothing on every row.
 *
 * Either side answering "unknown" is the ordinary case and is said out loud
 * rather than papered over, the stance `RenameInspector` takes about the same
 * question. `undefined` is not "no columns": treating it as empty would refuse
 * every lookup below a transform.
 */
function LookupSidesNote({
  driving,
  reference,
}: {
  driving: ReadonlySet<string> | undefined;
  reference: ReadonlySet<string> | undefined;
}) {
  return (
    <p className={cn('text-[11px] leading-relaxed', MUTED)}>
      {driving ? (
        <>
          The graph knows exactly what reaches the rows being enriched:{' '}
          <span className="font-mono">{[...driving].join(', ') || 'nothing at all'}</span>.
        </>
      ) : (
        <>
          The graph cannot say which columns reach the rows being enriched — a source discovers its
          shape against the live system, and a transform is code — so the key is taken on trust and
          the run reports the counts.
        </>
      )}{' '}
      {reference ? (
        <>
          On the reference side it is{' '}
          <span className="font-mono">{[...reference].join(', ') || 'nothing at all'}</span>.
        </>
      ) : (
        <>The reference side is unknown for the same reason.</>
      )}
    </p>
  );
}

function FilterInspector({
  node,
  graph,
  canEdit,
  onChange,
}: {
  node: WorkflowFilterNode;
  graph: WorkflowGraph;
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  // Core's answer, not this file's. A canvas that worked out its own set would
  // offer acknowledgements the server then refuses, which is a person ticking a
  // box to be told no.
  const narrowable = workflowNarrowedTypes(graph, node.id);
  const acknowledged = node.narrows ?? [];

  const setPredicate = (predicate: WorkflowFilterPredicate) => onChange({ ...node, predicate });
  const setNarrows = (type: string, on: boolean) => {
    const next = on ? [...acknowledged, type] : acknowledged.filter((named) => named !== type);
    // Stored as absent rather than as `[]`, so "acknowledged nothing" has one
    // spelling. The boundary normalises the same way.
    onChange({ ...node, narrows: next.length === 0 ? undefined : next });
  };

  return (
    <div className="space-y-3">
      <FilterPredicateEditor
        predicate={node.predicate}
        depth={0}
        canEdit={canEdit}
        onChange={setPredicate}
        onRemove={undefined}
      />

      {/* The whole predicate as one sentence, from the same function that
          writes the node's own subtitle — so a tree deep enough that the face
          gives up and says "5 conditions" can still be read back in full here,
          and the two can never describe one filter differently. */}
      <p className={cn('font-mono text-[10px] leading-relaxed', MUTED)}>
        keeps {describeFilterPredicate(node.predicate)}
      </p>

      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        Rows that match are passed on; the rest are dropped here. The run records{' '}
        <strong>how many went in and how many came out</strong>, so the panel can say what this node
        removed — a filter whose effect is invisible is how data goes missing quietly.
      </p>
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        A column with no value never matches, not even a “does not equal” test — that is what a
        database would answer, and it is what keeps this test meaning the same thing if it is ever
        pushed into the source query. Use <em>is empty</em> to find those rows. A value the test
        cannot compare against — text where the test names a number — does not match either, and the
        run says how many of those there were.
      </p>

      {narrowable.length > 0 && (
        <FieldGroup
          title="What this shrinks"
          hint={
            <>
              This filter is the only thing feeding{' '}
              {narrowable.length === 1 ? 'a sink that replaces' : 'sinks that replace'} what{' '}
              {narrowable.length === 1 ? 'a type publishes' : 'these types publish'}. So everything
              it drops disappears from {narrowable.length === 1 ? 'that type' : 'those types'} the
              next time this graph runs, and the run reports success while doing it. Say so here if
              that is what you mean. If you meant to build something new out of a subset, point the
              sink at a different object type; if you meant to add rows rather than replace them,
              set the sink to incremental.
            </>
          }
        >
          {narrowable.map((type) => (
            <Switch
              key={type}
              checked={acknowledged.includes(type)}
              onCheckedChange={(on) => setNarrows(type, on)}
              disabled={!canEdit}
              label={`Replace what ${type} publishes with the rows that pass`}
              hint={`The published snapshot of ${type} will hold only what this filter keeps. The type's row-count bound still applies and can still refuse the commit.`}
            />
          ))}
        </FieldGroup>
      )}

      {/* Shown whenever something is acknowledged that the graph no longer
          backs up — which is what happens when somebody rewires around a filter
          and leaves the switch on. The validator refuses it; this says why
          before they hit save. */}
      {acknowledged.some((type) => !narrowable.includes(type)) && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          This filter says it narrows{' '}
          {acknowledged
            .filter((type) => !narrowable.includes(type))
            .map((type) => `“${type}”`)
            .join(', ')}
          , and it no longer does — rows now reach that sink another way, or it merges rather than
          replaces. Turn it off: an acknowledgement nothing reads is worse than none, because the
          next reader believes it.
        </p>
      )}
    </div>
  );
}

/**
 * One node of the predicate tree: a group, or a single condition.
 *
 * Recursive rather than flattened, because the model is a tree and a flat list
 * of conditions with a single and/or toggle cannot express "A and (B or C)" —
 * which is the second thing anybody wants after "A and B".
 *
 * `onRemove` is absent exactly at the root, which is what makes the root
 * unremovable without a separate flag: a predicate is required, so there is
 * always at least one condition and the button that would delete the last one
 * does not exist.
 */
function FilterPredicateEditor({
  predicate,
  depth,
  canEdit,
  onChange,
  onRemove,
}: {
  predicate: WorkflowFilterPredicate;
  depth: number;
  canEdit: boolean;
  onChange: (predicate: WorkflowFilterPredicate) => void;
  onRemove: (() => void) | undefined;
}) {
  if (predicate.kind === 'all' || predicate.kind === 'any') {
    return (
      <FilterGroupEditor
        predicate={predicate}
        depth={depth}
        canEdit={canEdit}
        onChange={onChange}
        onRemove={onRemove}
      />
    );
  }
  return (
    <FilterConditionEditor
      predicate={predicate}
      depth={depth}
      canEdit={canEdit}
      onChange={onChange}
      onRemove={onRemove}
    />
  );
}

/** The word between a group's conditions, and the two ways to add another one. */
function FilterGroupEditor({
  predicate,
  depth,
  canEdit,
  onChange,
  onRemove,
}: {
  predicate: { kind: 'all' | 'any'; children: WorkflowFilterPredicate[] };
  depth: number;
  canEdit: boolean;
  onChange: (predicate: WorkflowFilterPredicate) => void;
  onRemove: (() => void) | undefined;
}) {
  const replaceChild = (index: number, child: WorkflowFilterPredicate) =>
    onChange({
      ...predicate,
      children: predicate.children.map((existing, at) => (at === index ? child : existing)),
    });
  // Removing the last child would leave an empty group, which keeps every row
  // (`all`) or drops every row (`any`) and is refused by the validator. Rather
  // than let somebody build one and then be told, removing the second-to-last
  // child collapses the group into the one that is left.
  const removeChild = (index: number) => {
    const left = predicate.children.filter((_, at) => at !== index);
    onChange(left.length === 1 ? left[0] : { ...predicate, children: left });
  };

  return (
    <div className={cn('space-y-2 rounded-md border px-2 py-2', RULE)}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SelectField
            label="Match"
            ariaLabel="Whether every condition in this group has to match, or any one of them"
            value={predicate.kind}
            onValueChange={(kind) => {
              if (kind !== 'all' && kind !== 'any') return;
              onChange({ ...predicate, kind });
            }}
            options={[
              { value: 'all', label: 'Every condition', hint: 'and' },
              { value: 'any', label: 'Any one condition', hint: 'or' },
            ]}
            disabled={!canEdit}
          />
        </div>
        {onRemove && canEdit && (
          <Button variant="ghost" size="sm" onClick={onRemove} className="mt-4 shrink-0">
            Remove group
          </Button>
        )}
      </div>

      {predicate.children.map((child, index) => (
        <FilterPredicateEditor
          // Positional keys, because a condition has no id and nothing in this
          // tree is reordered — the only edits are replace-in-place, append and
          // remove, and a removal re-renders the whole subtree from the model
          // anyway. There is no draft state below this point to be preserved.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          predicate={child}
          depth={depth + 1}
          canEdit={canEdit}
          onChange={(next) => replaceChild(index, next)}
          onRemove={() => removeChild(index)}
        />
      ))}

      {canEdit && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({ ...predicate, children: [...predicate.children, freshFilterCondition()] })
            }
          >
            Add condition
          </Button>
          {/* Offered only while there is room, rather than offered and then
              refused: the depth bound is core's, and a button that builds a
              tree the server will not store is worse than one that is not
              there. */}
          {depth + 1 < WORKFLOW_FILTER_MAX_DEPTH && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onChange({
                  ...predicate,
                  children: [
                    ...predicate.children,
                    { kind: 'any', children: [freshFilterCondition()] },
                  ],
                })
              }
            >
              Add group
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** One condition: a column, a test, and whatever that test compares against. */
function FilterConditionEditor({
  predicate,
  depth,
  canEdit,
  onChange,
  onRemove,
}: {
  predicate: Exclude<WorkflowFilterPredicate, { kind: 'all' } | { kind: 'any' }>;
  depth: number;
  canEdit: boolean;
  onChange: (predicate: WorkflowFilterPredicate) => void;
  onRemove: (() => void) | undefined;
}) {
  return (
    <div className={cn('space-y-2 rounded-md border px-2 py-2', RULE)}>
      <TextField
        label="Column"
        value={predicate.column}
        onChange={(column) => onChange({ ...predicate, column })}
        placeholder="status"
        disabled={!canEdit}
        hint="The bare name as the rows carry it — letters, digits and underscore, starting with a letter or underscore. No table prefix and no expression: the name has to be usable as an identifier so this test can one day be handed to the source as a WHERE. Rename anything else in a transform first."
      />
      <SelectField
        label="Test"
        ariaLabel="What kind of test this condition makes"
        value={predicate.kind}
        onValueChange={(kind) => {
          if (!isWorkflowFilterPredicateKind(kind)) return;
          onChange(retargetFilterCondition(predicate, kind));
        }}
        options={[
          { value: 'compare', label: 'Compare against a value' },
          { value: 'oneOf', label: 'Is one of a list' },
          { value: 'present', label: 'Is empty, or has a value' },
        ]}
        disabled={!canEdit}
      />
      <FilterConditionFields predicate={predicate} canEdit={canEdit} onChange={onChange} />

      {onRemove && canEdit && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove condition
          </Button>
        </div>
      )}
      {depth === 0 && canEdit && (
        // The root starts as a single condition, so the only way to reach a
        // group is from here. Wrapping rather than offering a group at the top
        // level keeps a one-condition filter looking like a one-condition
        // filter, which is what nearly all of them are.
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange({ kind: 'all', children: [predicate, freshFilterCondition()] })}
          >
            Add another condition
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The fields one kind of condition has, and none of the fields the others have.
 *
 * Split per kind and ending in a refusal, for the reason `PredicateFields`
 * gives about gates: a kind added to the model without a form here would be a
 * condition somebody can select, that shows nothing to fill in, and that decides
 * which rows a published type contains.
 */
function FilterConditionFields({
  predicate,
  canEdit,
  onChange,
}: {
  predicate: Exclude<WorkflowFilterPredicate, { kind: 'all' } | { kind: 'any' }>;
  canEdit: boolean;
  onChange: (predicate: WorkflowFilterPredicate) => void;
}) {
  if (predicate.kind === 'present') {
    return (
      <SelectField
        label="Has a value?"
        ariaLabel="Whether the column has to be empty or has to hold something"
        value={predicate.operator}
        onValueChange={(operator) => {
          if (operator !== 'isNull' && operator !== 'isNotNull') return;
          onChange({ ...predicate, operator });
        }}
        options={[
          { value: 'isNotNull', label: 'Has a value' },
          { value: 'isNull', label: 'Is empty' },
        ]}
        disabled={!canEdit}
        hint="The only test that can see an empty column. Every other test here treats an empty value as “cannot say”, which never matches."
      />
    );
  }
  if (predicate.kind === 'oneOf') {
    return (
      <>
        <SelectField
          label="In the list?"
          ariaLabel="Whether the column has to be in the list or out of it"
          value={predicate.operator}
          onValueChange={(operator) => {
            if (operator !== 'in' && operator !== 'notIn') return;
            onChange({ ...predicate, operator });
          }}
          options={[
            { value: 'in', label: 'Is one of these' },
            { value: 'notIn', label: 'Is none of these' },
          ]}
          disabled={!canEdit}
        />
        <FilterValueTypeField
          value={predicate.values[0]}
          canEdit={canEdit}
          onChange={(sample) =>
            onChange({
              ...predicate,
              values: predicate.values.map((existing) => castFilterValue(existing, sample)),
            })
          }
        />
        <TextAreaField
          label="Values"
          value={predicate.values.map((value) => String(value)).join('\n')}
          onChange={(text) =>
            onChange({ ...predicate, values: parseFilterValues(text, predicate.values[0]) })
          }
          rows={4}
          mono
          disabled={!canEdit}
          hint={`One per line. At most ${WORKFLOW_FILTER_MAX_VALUES} — past that this is a join against another dataset rather than a filter, and the thing to do is read that dataset in as a second source.`}
        />
      </>
    );
  }
  if (predicate.kind === 'compare') {
    return (
      <>
        <SelectField
          label="Comparison"
          ariaLabel="How the column is compared against the value"
          value={predicate.operator}
          onValueChange={(operator) => {
            if (!isWorkflowFilterOperator(operator)) return;
            onChange({ ...predicate, operator });
          }}
          options={WORKFLOW_FILTER_OPERATORS.map((operator) => ({
            value: operator,
            label: FILTER_OPERATOR_LABELS[operator],
          }))}
          disabled={!canEdit}
        />
        <FilterValueTypeField
          value={predicate.value}
          canEdit={canEdit}
          onChange={(sample) =>
            onChange({ ...predicate, value: castFilterValue(predicate.value, sample) })
          }
        />
        <FilterValueField
          value={predicate.value}
          canEdit={canEdit}
          onChange={(value) => onChange({ ...predicate, value })}
        />
      </>
    );
  }
  return unreachableFilterPredicateKind(predicate, 'FilterConditionFields');
}

/**
 * Each operator, spelled out in a sentence rather than in symbols.
 *
 * The node's face uses `>` and `≥` because it has 224 pixels; a dropdown has
 * room, and "is after / greater than" is what somebody scanning a list of ten
 * options is actually reading for. A `Record` keyed by the union, so an operator
 * added to core without a label here stops the build rather than rendering an
 * empty row in a select.
 */
const FILTER_OPERATOR_LABELS: Record<WorkflowFilterOperator, string> = {
  equals: 'equals',
  notEquals: 'does not equal',
  greaterThan: 'is greater than',
  greaterThanOrEqual: 'is greater than or equal to',
  lessThan: 'is less than',
  lessThanOrEqual: 'is less than or equal to',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  notStartsWith: 'does not start with',
};

/**
 * Whether the value is text, a number, or true/false.
 *
 * A visible choice rather than something inferred from what was typed, and this
 * is the field most likely to be mistaken for clutter. It is not: `"10"` and
 * `10` are different values here and neither matches the other, exactly as a
 * strongly-typed column would answer, and a form that guessed from the
 * characters would silently flip a text column's test to numeric the moment
 * somebody filtered on an order number. The run log reports those rows as
 * incomparable; this field is how they are avoided in the first place.
 */
function FilterValueTypeField({
  value,
  canEdit,
  onChange,
}: {
  value: WorkflowFilterValue | undefined;
  canEdit: boolean;
  onChange: (sample: WorkflowFilterValue) => void;
}) {
  return (
    <SelectField
      label="Value type"
      ariaLabel="Whether the value is text, a number, or true/false"
      value={typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text'}
      onValueChange={(type) => {
        if (type === 'number') return onChange(0);
        if (type === 'boolean') return onChange(true);
        onChange('');
      }}
      options={[
        { value: 'text', label: 'Text' },
        { value: 'number', label: 'A number' },
        { value: 'boolean', label: 'True or false' },
      ]}
      disabled={!canEdit}
      hint="Text and numbers are never equal to each other here, and neither is greater or less than the other — a row whose column holds the wrong one of the two is reported on the run rather than quietly matching. Dates are text: ISO-8601 sorts correctly."
    />
  );
}

/** The value itself, in whichever control the chosen type deserves. */
function FilterValueField({
  value,
  canEdit,
  onChange,
}: {
  value: WorkflowFilterValue;
  canEdit: boolean;
  onChange: (value: WorkflowFilterValue) => void;
}) {
  if (typeof value === 'boolean') {
    return (
      <SelectField
        label="Value"
        ariaLabel="The true or false value this column is compared against"
        value={value ? 'true' : 'false'}
        onValueChange={(chosen) => onChange(chosen === 'true')}
        options={[
          { value: 'true', label: 'True' },
          { value: 'false', label: 'False' },
        ]}
        disabled={!canEdit}
      />
    );
  }
  if (typeof value === 'number') {
    return (
      <TextField
        label="Value"
        // A text box with a numeric keypad rather than `type="number"`, which is
        // the rule the row-count threshold above already writes down: that
        // control drops what it cannot parse and answers a scroll wheel.
        value={Number.isFinite(value) ? String(value) : ''}
        onChange={(typed) => {
          const cleaned = typed.replace(/[^0-9.-]/g, '');
          const parsed = Number.parseFloat(cleaned);
          // An unparseable box stores 0 rather than `NaN`: every comparison
          // against `NaN` is false, so a filter holding one drops every row
          // while looking perfectly well configured — and the model refuses to
          // store it, so the graph could not be saved to find that out.
          onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
        inputMode="numeric"
        placeholder="0"
        disabled={!canEdit}
      />
    );
  }
  return (
    <TextField
      label="Value"
      value={value}
      onChange={onChange}
      placeholder="OPEN"
      disabled={!canEdit}
      hint="Compared exactly, with no trimming and no case folding. Collation is a property of the column in every database this runs against, so a case-insensitive test evaluated here and the same one evaluated in the source would legitimately disagree — normalise in a transform instead."
    />
  );
}

/** A condition somebody has not filled in yet. Refused by the validator until they do. */
function freshFilterCondition(): WorkflowFilterPredicate {
  return { kind: 'compare', column: '', operator: 'equals', value: '' };
}

/**
 * The same condition, asked to be a different kind of test.
 *
 * The **column is carried across** and nothing else is, which is the split worth
 * arguing: the column is what somebody typed and is the expensive half to
 * retype, while an operator and a value belong to the test that is being left
 * behind — `greaterThan` has no meaning for a presence check and a value has
 * none either.
 */
function retargetFilterCondition(
  predicate: Exclude<WorkflowFilterPredicate, { kind: 'all' } | { kind: 'any' }>,
  kind: WorkflowFilterPredicateKind,
): WorkflowFilterPredicate {
  if (kind === 'compare') {
    return { kind: 'compare', column: predicate.column, operator: 'equals', value: '' };
  }
  if (kind === 'oneOf') {
    return { kind: 'oneOf', column: predicate.column, operator: 'in', values: [''] };
  }
  if (kind === 'present') {
    return { kind: 'present', column: predicate.column, operator: 'isNotNull' };
  }
  // The two group kinds are reachable from the select's type but never from its
  // options, because a group is added by its own button and is not a *test* a
  // condition can be switched to. Refusing rather than building one keeps the
  // exhaustiveness honest without pretending this is a conversion.
  if (kind === 'all' || kind === 'any') return predicate;
  return unreachableFilterPredicateKind(kind, 'retargetFilterCondition');
}

/** One value, moved to the type of a sample, keeping whatever survives the move. */
function castFilterValue(
  value: WorkflowFilterValue,
  sample: WorkflowFilterValue,
): WorkflowFilterValue {
  if (typeof sample === 'number') {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof sample === 'boolean') return value === true || value === 'true';
  return String(value);
}

/**
 * A textarea of values, one per line, in the type the list is already in.
 *
 * Blank lines are dropped rather than kept as empty strings, because a trailing
 * newline is what a textarea has after every entry and a list ending in `""`
 * would filter for a value nobody typed. An entirely empty box keeps one blank
 * entry: the model refuses an empty list, and clearing the box should leave a
 * condition to finish rather than a graph that cannot be saved with no visible
 * cause.
 */
function parseFilterValues(
  text: string,
  sample: WorkflowFilterValue | undefined,
): WorkflowFilterValue[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [''];
  const cast = sample ?? '';
  return lines.slice(0, WORKFLOW_FILTER_MAX_VALUES).map((line) => castFilterValue(line, cast));
}

/**
 * The parameter box's two directions, kept together because they are inverses.
 *
 * An empty object shows as an empty box rather than as `{}`: the node starts
 * with no parameters, and opening a fresh call node onto punctuation somebody
 * has to delete is a worse start than a placeholder.
 */
function configText(config: Record<string, unknown>): string {
  return Object.keys(config).length === 0 ? '' : JSON.stringify(config, null, 2);
}

/**
 * A JSON object, or `undefined` for anything else — including an array and
 * including `null`, both of which `JSON.parse` accepts and neither of which is
 * a parameter bag. Blank means no parameters, which is not an error.
 */
function parseConfigText(text: string): Record<string, unknown> | undefined {
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const config: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) config[key] = Reflect.get(parsed, key);
    return config;
  } catch {
    return undefined;
  }
}

/**
 * The fields that belong to one kind of node and to no other.
 *
 * Split out of `NodeInspector` rather than written inline, because that
 * function is otherwise about the things every node has — its name, its wiring,
 * its problems, deleting it — and the per-kind chain is the one part of it that
 * grows every time the vocabulary does. Narrowing is what the union is for, so
 * a kind added without a branch here shows up as a node with a name and nothing
 * to configure, which is visible on the screen rather than silent.
 */
function KindInspector({
  node,
  graph,
  transforms,
  connections,
  storage,
  typeOptions,
  canEdit,
  modelHref,
  discovery,
  discoverable,
  onDiscovered,
  onChange,
  onEditCode,
  onCreateTransform,
  creatingTransform,
  createTransformError,
}: {
  node: WorkflowNode;
  /**
   * The graph the node sits in.
   *
   * Only one branch reads it, and it is the one that has to: whether a filter
   * narrows a published type is a fact about what is downstream of it, not about
   * the node. Passed as the graph rather than as a precomputed list so the
   * inspector calls core's `workflowNarrowedTypes` — the same function the
   * validator does — instead of being handed an answer this file worked out.
   */
  graph: WorkflowGraph;
  transforms: CatalogTransform[];
  connections: CatalogConnection[];
  /** What this deployment says about naming a media disk. Absent is a third answer. */
  storage?: StorageAvailability;
  typeOptions: SelectOption[];
  canEdit: boolean;
  /** The way out to the type, for the one kind of node that names one. */
  modelHref?: (typeName: string) => string;
  /**
   * Asking a source what its columns are. Passed straight through to the one
   * branch that has a source in it — a `call` node has no schema to discover,
   * because what it reads is decided by a workflow this graph does not own.
   */
  discovery: SchemaDiscoveryBridge;
  discoverable: DiscoveryOffer;
  /** And what it answered, passed back out for the same reason. */
  onDiscovered: (nodeId: string, shape: SourceShape) => void;
  onChange: (node: WorkflowNode) => void;
  onEditCode: (nodeId: string) => void;
  onCreateTransform: (nodeId: string) => void;
  creatingTransform: boolean;
  createTransformError: unknown;
}) {
  if (node.kind === 'transform') {
    return (
      <TransformInspector
        node={node}
        transforms={transforms}
        canEdit={canEdit}
        creating={creatingTransform}
        createError={createTransformError}
        onChange={onChange}
        onEditCode={onEditCode}
        onCreate={onCreateTransform}
      />
    );
  }
  if (node.kind === 'source') {
    return (
      <SourceInspector
        // Keyed so the text fields reset when a different source is opened.
        // Without it the draft state would survive the swap and one node's URL
        // would appear inside another.
        key={node.id}
        node={node}
        connections={connections}
        storage={storage}
        canEdit={canEdit}
        discovery={discovery}
        discoverable={discoverable}
        onDiscovered={onDiscovered}
        onChange={onChange}
      />
    );
  }
  if (node.kind === 'call') {
    // Keyed for the same reason the source inspector is: the parameter box
    // holds text somebody is midway through typing, and it must not survive
    // being pointed at a different node.
    return <CallInspector key={node.id} node={node} canEdit={canEdit} onChange={onChange} />;
  }
  if (node.kind === 'if') {
    return <IfInspector key={node.id} node={node} canEdit={canEdit} onChange={onChange} />;
  }
  if (node.kind === 'filter') {
    // Given the whole graph, not only the node, because the one question this
    // inspector cannot answer from the node alone is the important one: which
    // published types this filter stands in front of. See
    // `WorkflowFilterNode.narrows`.
    return (
      <FilterInspector
        key={node.id}
        node={node}
        graph={graph}
        canEdit={canEdit}
        onChange={onChange}
      />
    );
  }
  if (node.kind === 'rename') {
    // Given the whole graph for the same reason the filter inspector is, and
    // with a different question in mind: the one thing a declarative rename
    // buys is that the graph can sometimes say exactly which columns reach this
    // node. See `workflowKnownColumns`.
    return (
      <RenameInspector
        key={node.id}
        node={node}
        graph={graph}
        canEdit={canEdit}
        onChange={onChange}
      />
    );
  }
  if (node.kind === 'aggregate') {
    return <AggregateInspector node={node} graph={graph} canEdit={canEdit} onChange={onChange} />;
  }
  if (node.kind === 'lookup') {
    // Given the whole graph, and it needs it more than any other inspector does:
    // a lookup's `reference` is a node id, so the form cannot even list the
    // choices without the edges — and `workflowLookupColumns` is what lets it say
    // which columns are on which side rather than pooling them.
    return (
      <LookupInspector
        key={node.id}
        node={node}
        graph={graph}
        canEdit={canEdit}
        onChange={onChange}
      />
    );
  }
  if (node.kind === 'sink') {
    return (
      <SinkInspector
        node={node}
        typeOptions={typeOptions}
        canEdit={canEdit}
        modelHref={modelHref}
        onChange={onChange}
      />
    );
  }
  // The chain ends in a refusal rather than a fallthrough, so a kind added to
  // core without a form here is a type error naming this file — which is the
  // whole reason the docblock above says a missing branch shows up as "a node
  // with a name and nothing to configure". It no longer can.
  return unreachableNodeKind(node, 'KindInspector');
}

function NodeInspector({
  node,
  draft,
  transforms,
  connections,
  storage,
  typeOptions,
  canEdit,
  modelHref,
  problems,
  pending,
  discovery,
  discoverable,
  onDiscovered,
  onClose,
  onChange,
  onConnect,
  onConnectToNew,
  onDisconnect,
  onBranch,
  onDelete,
  onEditCode,
  onCreateTransform,
  creatingTransform,
  createTransformError,
}: {
  node: WorkflowNode | null;
  draft: Draft;
  transforms: CatalogTransform[];
  connections: CatalogConnection[];
  /** What this deployment says about naming a media disk. Absent is a third answer. */
  storage?: StorageAvailability;
  typeOptions: SelectOption[];
  canEdit: boolean;
  /** Passed through to the sink inspector, the one node that names a type. */
  modelHref?: (typeName: string) => string;
  discovery: SchemaDiscoveryBridge;
  discoverable: DiscoveryOffer;
  /** What a discovery said, passed up so it outlives this sheet. */
  onDiscovered: (nodeId: string, shape: SourceShape) => void;
  problems: WorkflowProblem[];
  pending: WorkflowProblem[];
  onClose: () => void;
  onChange: (node: WorkflowNode) => void;
  onConnect: (from: string, to: string) => void;
  onConnectToNew: (from: string, kind: WorkflowNodeKind) => void;
  onDisconnect: (edge: WorkflowEdge) => void;
  onBranch: (edge: WorkflowEdge, branch: WorkflowBranchLabel) => void;
  onDelete: (nodeId: string) => void;
  onEditCode: (nodeId: string) => void;
  onCreateTransform: (nodeId: string) => void;
  creatingTransform: boolean;
  createTransformError: unknown;
}) {
  const [pendingTarget, setPendingTarget] = useState('');

  const label = (id: string) => {
    const found = draft.nodes.find((n) => n.id === id);
    return found ? nodeName(found) : id;
  };

  const outgoing = node ? draft.edges.filter((edge) => edge.from === node.id) : [];
  const incoming = node ? draft.edges.filter((edge) => edge.to === node.id) : [];

  /**
   * The keyboard path to wiring.
   *
   * React Flow has no keyboard gesture for drawing an edge — a connection is a
   * drag from one handle to another and nothing else — so without this control
   * the screen would be operable with a mouse only. The eligible list is
   * filtered by the same `canConnect` the drag uses, so a target that would
   * close a loop is simply not offered rather than offered and then refused.
   */
  const eligible = useMemo<SelectOption[]>(() => {
    if (!node) return [];
    return draft.nodes
      .filter((candidate) => canConnect(draft.nodes, draft.edges, node.id, candidate.id).ok)
      .map((candidate) => ({
        value: candidate.id,
        label: nodeName(candidate),
        hint: candidate.kind,
      }));
  }, [node, draft.nodes, draft.edges]);

  /**
   * The keyboard half of "make the next node and wire it".
   *
   * The canvas menu is a pointer affordance and cannot be anything else, so the
   * action it introduced has to exist here too or it is an action half the
   * people using this screen cannot reach. Same function, same rules — the kinds
   * come from `newKindsFrom`, which asks `canConnect` rather than restating what
   * may follow what.
   */
  const newKinds = useMemo(
    () => (node ? newKindsFrom(node, draft.nodes, draft.edges) : []),
    [node, draft.nodes, draft.edges],
  );

  return (
    <Sheet
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={node ? nodeName(node) : ''}
      description={node ? `${node.kind} node` : undefined}
    >
      {node && (
        <div className="space-y-4">
          {problems.length > 0 && (
            <ul className="space-y-1.5 rounded-md border border-red-200 bg-red-50 p-2 dark:border-red-900 dark:bg-red-950/40">
              {problems.map((problem) => (
                <li
                  key={problem.code}
                  className="text-[11px] leading-relaxed text-red-700 dark:text-red-300"
                >
                  {problem.message}
                </li>
              ))}
            </ul>
          )}

          {/*
           * The same checks, in the state they are actually in for a node this
           * sheet opened onto the instant it was created. Neutral, and phrased
           * as work — see `partitionProblems`. Never rendered alongside the red
           * box above: a check is in one list or the other, never both.
           */}
          {pending.length > 0 && (
            <div className={cn('rounded-md border p-2', RULE)}>
              <p className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                Still to do
              </p>
              <ul className="mt-1 space-y-0.5">
                {pending.map((problem) => (
                  <li key={problem.code} className="text-[11px] leading-relaxed">
                    {todoFor(problem)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TextField
            label="Name"
            value={node.name}
            onChange={(name) => onChange({ ...node, name })}
            placeholder={node.kind}
            disabled={!canEdit}
            hint="What it is called on the canvas and in the wiring list. Renaming it does not change what the graph does, so it does not bump the version."
          />

          <KindInspector
            node={node}
            graph={draft}
            transforms={transforms}
            connections={connections}
            storage={storage}
            typeOptions={typeOptions}
            canEdit={canEdit}
            modelHref={modelHref}
            discovery={discovery}
            discoverable={discoverable}
            onDiscovered={onDiscovered}
            onChange={onChange}
            onEditCode={onEditCode}
            onCreateTransform={onCreateTransform}
            creatingTransform={creatingTransform}
            createTransformError={createTransformError}
          />

          <WiringList
            title="Fed by"
            edges={incoming}
            otherEnd={(edge) => label(edge.from)}
            describeRemoval={(name) => `Stop ${name} feeding this node`}
            canEdit={canEdit}
            onDisconnect={onDisconnect}
          >
            {incoming.length > 1 && (
              <p className={cn('mt-1 text-[11px] leading-relaxed', MUTED)}>
                Inputs arrive in this order, and the order is part of what the graph produces — a
                transform joining two feeds sees them exactly like this.
              </p>
            )}
          </WiringList>

          <WiringList
            title="Feeds"
            edges={outgoing}
            otherEnd={(edge) => label(edge.to)}
            describeRemoval={(name) => `Stop this node feeding ${name}`}
            canEdit={canEdit}
            onDisconnect={onDisconnect}
            // Only a gate's wires have a side to be on. `validateWorkflow`
            // refuses a label on any other wire, so offering the control there
            // would be offering a change the server will not take.
            onBranch={node.kind === 'if' ? onBranch : undefined}
          >
            {canEdit && (
              <div className="mt-2 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    ariaLabel="Send this node's output to"
                    value={pendingTarget}
                    onValueChange={setPendingTarget}
                    options={eligible}
                    placeholder={
                      eligible.length === 0
                        ? 'Nothing can be wired from here'
                        : 'Send its output to…'
                    }
                    disabled={eligible.length === 0}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!pendingTarget) return;
                    onConnect(node.id, pendingTarget);
                    setPendingTarget('');
                  }}
                  disabled={!pendingTarget}
                  className={cn(
                    'shrink-0 rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40',
                    RULE,
                    'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  )}
                >
                  Connect
                </button>
              </div>
            )}
            {canEdit && newKinds.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {newKinds.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => onConnectToNew(node.id, kind)}
                    className={cn(
                      'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]',
                      RULE,
                      'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                    )}
                  >
                    <Plus size={10} />
                    New {kind}
                  </button>
                ))}
              </div>
            )}
            <p className={cn('mt-1 text-[11px] leading-relaxed', MUTED)}>
              Only nodes that can legally take this one's output are listed — anything that would
              close a loop, or feed a source, is left out. "New" makes one and wires it in the same
              action, one column to the right of this node.
            </p>
          </WiringList>

          {canEdit && (
            <button
              type="button"
              onClick={() => onDelete(node.id)}
              className="flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
            >
              <Trash2 size={12} />
              Remove this node
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

/**
 * Where a source reads from.
 *
 * The same fields the connector form uses, from the same module, because a
 * source node and a connector are the same half of the same idea and the
 * executable model gives them the same vocabulary: a kind, an optional named
 * connection, a config, the name of an env var holding the credential, and
 * whether it reads everything or only what changed.
 *
 * There is deliberately no "which connector feeds this" picker. A connector
 * references a *workflow*, so a source referencing a connector would be
 * circular — and it would leave one load with two authorities on where its data
 * comes from.
 *
 * The text fields are held locally and pushed up as a config on every change,
 * rather than read back out of the node. Re-deriving them from the stored config
 * would make a half-typed number disappear the moment it stopped parsing.
 */
function SourceInspector({
  node,
  connections,
  storage,
  canEdit,
  discovery,
  discoverable,
  onDiscovered,
  onChange,
}: {
  node: WorkflowSourceNode;
  connections: CatalogConnection[];
  /** What this deployment says about naming a media disk. Absent is a third answer. */
  storage?: StorageAvailability;
  canEdit: boolean;
  discovery: SchemaDiscoveryBridge;
  /**
   * Whether this node can be asked about its source, and why not when it
   * cannot.
   *
   * A pair rather than a boolean, because the two reasons a discovery is
   * unavailable are completely different and only one of them is worth waiting
   * for. `undefined` means press it.
   */
  discoverable: DiscoveryOffer;
  /**
   * What discovery said about this node, handed up rather than kept here.
   *
   * This sheet closes; the Problems rail beside the canvas does not. So the one
   * screen that can compare these columns against the type a sink writes is the
   * one that outlives the panel that read them — see the canvas's
   * `shapesByNode`.
   */
  onDiscovered: (nodeId: string, shape: SourceShape) => void;
  onChange: (node: WorkflowNode) => void;
}) {
  const [source, setSource] = useState<SourceDraft>(() => sourceDraftFrom(node.config));
  const kind: ConnectorKind = toConnectorKind(node.sourceKind ?? 'http');

  /**
   * The history of the type a `catalog` source names, so the snapshot can be
   * chosen instead of looked up.
   *
   * The whole answer to the objection that naming a snapshot by id is friction —
   * see `SnapshotField`. Keyed on the type the field currently holds and asked
   * only for that kind, so no other source node makes a request; the same query
   * key the object explorer's picker uses, so opening both costs one fetch.
   *
   * A failure is not surfaced: the field falls back to accepting a typed id,
   * which is exactly what it does on a store with no history. A console that
   * cannot list snapshots must not be a console that cannot edit a graph.
   */
  const client = useCatalogClient();
  const namedType = kind === 'catalog' ? source.objectType.trim() : '';
  const { data: snapshots } = useQuery({
    queryKey: catalogQueryKeys.objectSnapshots(namedType),
    queryFn: () => client.snapshots(namedType),
    enabled: namedType.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const options = connectionOptionsFor(kind, connections);
  // A connection chosen for one kind is meaningless for another, so switching
  // the kind drops it rather than keeping an id the server would reject.
  const chosen = options.some((option) => option.value === node.connectionId)
    ? (node.connectionId ?? INLINE_CONNECTION)
    : INLINE_CONNECTION;
  const viaConnection = chosen !== INLINE_CONNECTION;
  const mode = node.mode === 'incremental' ? 'incremental' : 'full';
  const incremental = readsIncrementally(kind) && mode === 'incremental';

  /** One place that turns the text fields back into a stored config. */
  const push = (next: SourceDraft, over: Partial<WorkflowSourceNode> = {}) => {
    const merged: WorkflowSourceNode = { ...node, ...over };
    const mergedKind = toConnectorKind(merged.sourceKind ?? 'http');
    const mergedVia = Boolean(merged.connectionId);
    onChange({
      ...merged,
      config: sourceConfigFrom(mergedKind, next, {
        viaConnection: mergedVia,
        incremental: readsIncrementally(mergedKind) && merged.mode === 'incremental',
      }),
    });
  };

  const update = (next: SourceDraft) => {
    setSource(next);
    push(next);
  };

  return (
    <div className="space-y-3">
      <SelectField
        label="Source kind"
        ariaLabel="What kind of system this reads from"
        value={kind}
        onValueChange={(value) => {
          const sourceKind = toConnectorKind(value);
          // The connection goes with the kind it belonged to. Keeping it would
          // point an S3 source at a SQL address.
          push(source, { sourceKind, connectionId: undefined });
        }}
        options={KIND_OPTIONS}
        disabled={!canEdit}
      />

      {/*
       * The connection picker, above the address fields it replaces.
       *
       * Offered rather than required: a one-off source does not deserve a second
       * object to manage, and forcing one would make the quickest thing this
       * screen can do — paste a URL, load it once — the slowest.
       */}
      {usesConnection(kind) && (
        <>
          <SelectField
            label="Read through"
            ariaLabel="Connection"
            value={chosen}
            onValueChange={(value) =>
              push(source, {
                // Omitted, never sent empty: an empty string is a connection id
                // the server would look up and fail to find, where absent means
                // "this source carries its own address".
                connectionId: value === INLINE_CONNECTION ? undefined : value,
              })
            }
            options={[
              {
                value: INLINE_CONNECTION,
                label: 'Configure the address here',
                hint: 'This source alone',
              },
              ...options,
            ]}
            disabled={!canEdit}
            hint={
              options.length === 0
                ? 'No connections of this kind yet. One is worth making when a second source needs the same address.'
                : viaConnection
                  ? 'The connection supplies the address and the credential. What stays below is only what is specific to this load.'
                  : undefined
            }
          />

          {/*
           * …and making one, rather than only choosing one.
           *
           * The other half of what the sink node has had all along: its
           * schema-discovery panel creates the type it commits, here, on a
           * draft. A source could only pick from addresses that already
           * existed, so a graph whose connection did not exist yet meant
           * leaving the canvas, making it on another screen, and coming back to
           * find the node again.
           *
           * Selecting it is what `push` does everywhere else on this panel, so
           * it marks the draft dirty exactly as typing a URL into the field
           * below would. `SourceConnectionCreator` says so where it happens —
           * see its docblock for why that is the honest option rather than a
           * silent selection.
           */}
          <SourceConnectionCreator
            kind={kind}
            canEdit={canEdit}
            hasOptions={options.length > 0}
            onCreated={(connection) => push(source, { connectionId: connection.id })}
          />
        </>
      )}

      <SourceFields
        kind={kind}
        draft={source}
        onChange={update}
        viaConnection={viaConnection}
        disabled={!canEdit}
        storage={storage}
        snapshots={snapshots}
      />

      <ReadModeFields
        kind={kind}
        mode={mode}
        onModeChange={(next) => push(source, { mode: next })}
        draft={source}
        onChange={update}
        disabled={!canEdit}
      />

      {incremental && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          A watermark is kept per node, so two sources in the same graph reading incrementally do
          not overwrite each other's position.
        </p>
      )}

      {/*
       * Under the address it reads from, which is where it belongs in the
       * story: somebody has just said where this reads, and this is what
       * answers "what is in there".
       *
       * It reaches the SERVER'S copy of this node, not the one on screen, which
       * is why it says so when the two differ. It does not need the graph to be
       * published, and that is the point of the route: a sink cannot commit into
       * a type that does not exist, so the type has to be creatable while the
       * graph is still a draft.
       */}
      <SchemaDiscoveryPanel
        workflowId={discoverable.workflowId ?? ''}
        nodeId={node.id}
        bridge={discovery}
        onDiscovered={onDiscovered}
        onSave={discoverable.onSave}
        saving={discoverable.saving}
        {...(discoverable.workflowId === undefined ? { disabledReason: discoverable.because } : {})}
      />
    </div>
  );
}
