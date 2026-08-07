import { kindsBetween, newKindsFrom } from './create';
import {
  type WorkflowBranchLabel,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  nodeName,
} from './model';
import { WORKFLOW_NAME } from './name';
import { canConnect, edgeId } from './validate';

/**
 * What right-clicking something on this canvas offers, worked out from the graph.
 *
 * ## The problem this is really solving
 *
 * "Create the next node and wire it in one action" already existed. It lives in
 * a pill on a node's hover toolbar, roughly 46×20 pixels on a 1600-pixel canvas,
 * and the person who asked for this feature never found it. When told it was
 * there they answered: *"Apertei na borda e só deu wire ué"* — they pressed the
 * handle, got the click-to-connect gesture, and reasonably concluded that was
 * the feature. **Two different affordances were both called "wire", and the one
 * carrying the menu was the less visible of the two.**
 *
 * So a context menu here is not a convenience on top of a discovered feature. It
 * is the discoverable home for a capability that already shipped and was being
 * missed, and everything else follows from that: the same list is what the hover
 * pill opens (renamed, because the collision of names was half the bug), so
 * there is one set of node actions in this package and no way for two menus to
 * drift apart.
 *
 * ## The two rules everything here obeys
 *
 * **Never offer something the graph would refuse.** Every option that makes an
 * edge is filtered through `canConnect` — the same function the drag, the click
 * gesture and the inspector's picker are all refused by — by building a
 * throwaway node and asking. Nothing here restates a rule about what may follow
 * what. And where a list comes out empty, the menu *says why* instead of showing
 * a blank space: "nothing here" and "nothing is possible" look identical and
 * mean completely different things, and for a sink the answer is permanent.
 *
 * **Destructive items are separated.** `separated` puts a rule and a gap above a
 * section, and delete is always the last section on the menu, on its own, in the
 * destructive tone. It is still true that a variable-length "Already wired"
 * group above it moves it between openings; what is avoided is the worse case —
 * an ordinary item and a destructive one trading places at the same coordinates.
 *
 * ## Why this is a model and not JSX
 *
 * Two surfaces render it, and a third could. Keeping it as data means the
 * question a reviewer actually cares about — *does a sink get offered anything
 * downstream, ever?* — is a plain assertion over an array rather than a DOM
 * query against a portalled popup that jsdom cannot lay out.
 */

/** What was right-clicked. The four things this canvas can distinguish. */
export type CanvasMenuTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'edge'; edge: WorkflowEdge }
  /** Empty canvas, with the point in GRAPH coordinates — where a node would land. */
  | { kind: 'pane'; at: { x: number; y: number } }
  /** Several nodes at once. Only ever reached with two or more. */
  | { kind: 'selection'; nodeIds: string[] };

/**
 * The mark beside an item.
 *
 * A name rather than an element, so this module stays data and the icon set
 * stays an implementation detail of whichever surface draws it.
 */
export type CanvasMenuIcon =
  | 'open'
  | 'code'
  | 'arrow'
  | 'plus'
  | 'insert'
  | 'branch'
  | 'unplug'
  | 'trash'
  | 'tidy'
  | 'fit';

export interface CanvasMenuItem {
  key: string;
  label: string;
  /** The right-hand column: what this does, in two or three words. */
  hint?: string;
  icon: CanvasMenuIcon;
  /** Set on anything that removes something. Colours it, and nothing else. */
  destructive?: boolean;
  /**
   * A sentence under the label, for the one case where the cost is not obvious
   * from it. Used for exactly two things today — the wires a node takes with it,
   * and what removing a node from a PUBLISHED graph does — because a warning on
   * every item is a warning nobody reads.
   */
  detail?: string;
  run(): void;
}

export interface CanvasMenuSection {
  key: string;
  title?: string;
  /**
   * Rendered instead of an empty list.
   *
   * The whole reason a section can be empty and still present: a sink offered no
   * downstream targets has to say "a sink commits its rows, nothing runs after
   * one" rather than show a gap that reads like a loading state.
   */
  note?: string;
  /** A rule and a gap above it. Every destructive section sets this. */
  separated?: boolean;
  items: CanvasMenuItem[];
}

/**
 * Everything the menu can ask the canvas to do.
 *
 * Handed in rather than dispatched through a union the canvas then switches on,
 * because every one of these already exists on the canvas as a named callback
 * with its own announcement and its own `markStarted` bookkeeping. A second
 * dispatch layer would be a place for one of them to be forgotten.
 */
export interface CanvasMenuActions {
  inspect(nodeId: string): void;
  editCode(nodeId: string): void;
  connect(from: string, to: string): void;
  connectToNew(from: string, kind: WorkflowNodeKind): void;
  insertBetween(edge: WorkflowEdge, kind: WorkflowNodeKind): void;
  setBranch(edge: WorkflowEdge, branch: WorkflowBranchLabel): void;
  disconnect(edge: WorkflowEdge): void;
  removeNodes(ids: string[]): void;
  addAt(kind: WorkflowNodeKind, at: { x: number; y: number }): void;
  tidy(): void;
  fitAll(): void;
  fitNodes(ids: string[]): void;
}

export interface CanvasMenuContext {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Every kind that can exist, in the order the palette offers them. */
  kinds: readonly WorkflowNodeKind[];
  canEdit: boolean;
  /**
   * Whether the STORED graph is published.
   *
   * Changes one sentence and no behaviour. A published graph has to stay
   * runnable — the server refuses a save that would leave one unable to run, in
   * those words — so removing a node from one is an edit that will be turned
   * away at the moment it is saved rather than at the moment it is made. Saying
   * so on the item is the difference between finding that out now and finding it
   * out after twenty minutes of further editing.
   */
  published: boolean;
  actions: CanvasMenuActions;
}

/** A node's display name, falling back to its id when it is not in the graph. */
function labelIn(nodes: WorkflowNode[], id: string): string {
  const found = nodes.find((candidate) => candidate.id === id);
  return found ? nodeName(found) : id;
}

/** "1 connection" / "3 connections", with the plural not left to the reader. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function buildCanvasMenu(
  target: CanvasMenuTarget,
  context: CanvasMenuContext,
): CanvasMenuSection[] {
  if (target.kind === 'node') return nodeMenu(target.nodeId, context);
  if (target.kind === 'edge') return edgeMenu(target.edge, context);
  if (target.kind === 'pane') return paneMenu(target.at, context);
  return selectionMenu(target.nodeIds, context);
}

/**
 * What a node offers.
 *
 * The order is the order somebody reaches for these: look at it, extend it,
 * unwire it, remove it. Opening comes first because it is the only
 * non-destructive thing that is true of every node in every state, and a menu
 * whose first item changes identity with the graph is a menu you have to read
 * every time.
 */
function nodeMenu(nodeId: string, context: CanvasMenuContext): CanvasMenuSection[] {
  const { nodes, edges, canEdit, actions } = context;
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const name = nodeName(node);

  const open: CanvasMenuItem[] = [
    {
      key: 'inspect',
      label: `Open ${name}`,
      hint: 'settings',
      icon: 'open',
      run: () => actions.inspect(node.id),
    },
  ];
  // Only when it names one. The code sheet on a transform with no transform
  // chosen renders a paragraph explaining that there is nothing to open, which
  // is the right thing for a sheet somebody navigated to and the wrong thing to
  // put in a menu — a menu item exists to promise an outcome.
  if (node.kind === 'transform' && typeof node.transformId === 'string' && node.transformId) {
    open.push({
      key: 'code',
      label: 'Edit its code',
      hint: 'transform',
      icon: 'code',
      run: () => actions.editCode(node.id),
    });
  }

  const sections: CanvasMenuSection[] = [{ key: 'open', items: open }];
  if (!canEdit) return sections;

  const targets = nodes.filter((candidate) => canConnect(nodes, edges, node.id, candidate.id).ok);
  sections.push({
    key: 'targets',
    title: 'Send its output to',
    // Said rather than shown as an empty list, and the two sentences are
    // different on purpose: one of them is a fact about this graph right now and
    // the other is a fact about sinks forever.
    note:
      targets.length > 0
        ? undefined
        : node.kind === 'sink'
          ? 'A sink commits its rows. Nothing runs after one.'
          : 'Nothing on the canvas can take its output yet. Make one below.',
    items: targets.map((candidate) => ({
      key: `to:${candidate.id}`,
      label: nodeName(candidate),
      hint: candidate.kind,
      icon: 'arrow' as const,
      run: () => actions.connect(node.id, candidate.id),
    })),
  });

  const kinds = newKindsFrom(node, nodes, edges);
  if (kinds.length > 0) {
    sections.push({
      key: 'new',
      title: 'Or make one',
      items: kinds.map((kind) => ({
        key: `new:${kind}`,
        label: `New ${kind}`,
        hint: 'added and wired',
        icon: 'plus' as const,
        run: () => actions.connectToNew(node.id, kind),
      })),
    });
  }

  const wires = edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  if (wires.length > 0) {
    sections.push({
      key: 'wires',
      title: 'Already wired',
      separated: true,
      items: wires.map((edge) => ({
        key: `cut:${edgeId(edge)}`,
        label: `Disconnect ${labelIn(nodes, edge.from === node.id ? edge.to : edge.from)}`,
        hint: edge.from === node.id ? 'feeds' : 'fed by',
        icon: 'unplug' as const,
        destructive: true,
        run: () => actions.disconnect(edge),
      })),
    });
  }

  sections.push({
    key: 'delete',
    separated: true,
    items: [
      {
        key: 'delete',
        label: `Delete ${name}`,
        hint: 'Ctrl+Z undoes',
        icon: 'trash',
        destructive: true,
        detail: deleteCost(wires.length, context.published),
        run: () => actions.removeNodes([node.id]),
      },
    ],
  });

  return sections;
}

/**
 * What removing this node costs, in one sentence, or nothing at all.
 *
 * Two facts, and only when they apply. The wires, because a node removal that
 * quietly unwires two OTHER nodes and says nothing is how somebody finds out
 * half an hour later that their graph no longer reaches its sink. And the
 * published case, because the server enforces a rule this canvas cannot: a
 * published graph has to stay runnable, so the edit is accepted here and refused
 * at the save — the one place a warning in advance is worth more than a
 * confirmation dialog.
 */
export function deleteCost(wires: number, published: boolean): string | undefined {
  const parts: string[] = [];
  if (wires > 0)
    parts.push(`The ${count(wires, 'connection')} on it ${wires === 1 ? 'goes' : 'go'} too.`);
  if (published) {
    parts.push(
      `This ${WORKFLOW_NAME.singular} is published, so it has to stay runnable — what is published keeps running until you save, and a save that would leave it unable to run is refused.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * What a wire offers.
 *
 * A wire is a thing on the canvas that people can hit and could previously do
 * almost nothing with: selecting it offered a × to remove it, and the two other
 * things anybody wants from a wire — which branch it is on, and putting a step
 * in the middle of it — were both buried in the inspector of one of its ends.
 *
 * "Insert between them" is the one item here that is a genuinely new capability
 * rather than a shortcut to an old one, and it is the reason an edge menu earns
 * its place: `A → B` becoming `A → filter → B` is a normal thing to want and
 * used to be four gestures, one of which was undoing the wire you already had.
 */
function edgeMenu(edge: WorkflowEdge, context: CanvasMenuContext): CanvasMenuSection[] {
  const { nodes, edges, canEdit, actions } = context;
  const from = labelIn(nodes, edge.from);
  const to = labelIn(nodes, edge.to);

  const sections: CanvasMenuSection[] = [
    {
      key: 'ends',
      title: 'Its ends',
      items: [
        {
          key: 'open:from',
          label: `Open ${from}`,
          hint: 'feeds',
          icon: 'open',
          run: () => actions.inspect(edge.from),
        },
        {
          key: 'open:to',
          label: `Open ${to}`,
          hint: 'fed by',
          icon: 'open',
          run: () => actions.inspect(edge.to),
        },
      ],
    },
  ];
  if (!canEdit) return sections;

  const between = kindsBetween(edge, nodes, edges);
  sections.push({
    key: 'insert',
    title: 'Put a node in the middle',
    note:
      between.length > 0
        ? undefined
        : `Nothing can stand between "${from}" and "${to}" — whatever went there would have to take one's output and feed the other, and no kind of node can do both here.`,
    items: between.map((kind) => ({
      key: `between:${kind}`,
      label: `New ${kind}`,
      hint: 'spliced in',
      icon: 'insert' as const,
      run: () => actions.insertBetween(edge, kind),
    })),
  });

  // Only a gate's wires have a side to be on — `validateWorkflow` refuses a
  // label on any other wire — so this is offered exactly where it is legal, and
  // it is the largest single change anybody can make from this menu: it inverts
  // which half of the pipeline runs.
  const branch = edge.branch;
  if (branch !== undefined) {
    const other: WorkflowBranchLabel = branch === 'then' ? 'else' : 'then';
    sections.push({
      key: 'branch',
      title: `On the "${branch}" branch`,
      items: [
        {
          key: `branch:${other}`,
          label: `Move it to "${other}"`,
          hint: 'inverts it',
          icon: 'branch',
          detail: `"${to}" would then run when the gate goes the other way, and not when it goes this one.`,
          run: () => actions.setBranch(edge, other),
        },
      ],
    });
  }

  sections.push({
    key: 'disconnect',
    separated: true,
    items: [
      {
        key: 'disconnect',
        label: 'Disconnect them',
        hint: 'Ctrl+Z undoes',
        icon: 'unplug',
        destructive: true,
        detail: `Both nodes stay. "${from}" stops feeding "${to}".`,
        run: () => actions.disconnect(edge),
      },
    ],
  });

  return sections;
}

/**
 * What empty canvas offers.
 *
 * "Add a node here" is the item that justifies the whole target: the dock's add
 * buttons put a node past the right-hand edge of everything that exists — which
 * is correct for a button that has no idea where you are looking, and is exactly
 * wrong when you have just pointed at a spot. This one lands where the pointer
 * was.
 *
 * The kinds come from {@link CanvasMenuContext.kinds}, which is core's
 * `WORKFLOW_NODE_KINDS`, and never from a list written out here. That is a bug
 * fix wearing a rule: `filter` shipped complete and could not be added from this
 * screen at all, because the palette was six hand-typed JSX elements and only
 * five of them had been typed.
 */
function paneMenu(at: { x: number; y: number }, context: CanvasMenuContext): CanvasMenuSection[] {
  const { nodes, canEdit, kinds, actions } = context;
  const sections: CanvasMenuSection[] = [];

  if (canEdit) {
    sections.push({
      key: 'add',
      title: 'Add a node here',
      items: kinds.map((kind) => ({
        key: `add:${kind}`,
        label: `New ${kind}`,
        hint: 'at the pointer',
        icon: 'plus' as const,
        run: () => actions.addAt(kind, at),
      })),
    });
  }

  sections.push({
    key: 'view',
    title: 'The whole graph',
    // An empty canvas has nothing to arrange and nothing to fit, and two
    // controls that do nothing are worse than a sentence saying why.
    note:
      nodes.length === 0
        ? `Nothing is drawn yet, so there is nothing to arrange${canEdit ? ' — start with a source above' : ''}.`
        : undefined,
    separated: canEdit,
    items:
      nodes.length === 0
        ? []
        : [
            ...(canEdit
              ? [
                  {
                    key: 'tidy',
                    label: 'Tidy the layout',
                    hint: 'by dependency',
                    icon: 'tidy' as const,
                    run: () => actions.tidy(),
                  },
                ]
              : []),
            {
              key: 'fit',
              label: 'Fit it on screen',
              hint: 'zoom to fit',
              icon: 'fit' as const,
              run: () => actions.fitAll(),
            },
          ],
  });

  return sections;
}

/**
 * What several selected nodes offer.
 *
 * Deliberately short. Almost everything on the node menu is about *this* node —
 * what it can feed, what feeds it, what it is called — and offering "send its
 * output to" against five nodes at once would be offering an action whose "its"
 * has no referent. What is genuinely plural is looking at them and removing
 * them, so that is what is here.
 */
function selectionMenu(nodeIds: string[], context: CanvasMenuContext): CanvasMenuSection[] {
  const { nodes, edges, canEdit, actions } = context;
  const chosen = nodes.filter((node) => nodeIds.includes(node.id));
  if (chosen.length === 0) return [];

  const sections: CanvasMenuSection[] = [
    {
      key: 'view',
      title: `${count(chosen.length, 'node')} selected`,
      items: [
        {
          key: 'fit',
          label: 'Bring these into view',
          hint: 'zoom to them',
          icon: 'fit',
          run: () => actions.fitNodes(chosen.map((node) => node.id)),
        },
      ],
    },
  ];
  if (!canEdit) return sections;

  const ids = new Set(chosen.map((node) => node.id));
  const wires = edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to));
  sections.push({
    key: 'delete',
    separated: true,
    items: [
      {
        key: 'delete',
        label: `Delete these ${count(chosen.length, 'node')}`,
        hint: 'Ctrl+Z undoes',
        icon: 'trash',
        destructive: true,
        detail: deleteCost(wires.length, context.published),
        run: () => actions.removeNodes(chosen.map((node) => node.id)),
      },
    ],
  });

  return sections;
}
