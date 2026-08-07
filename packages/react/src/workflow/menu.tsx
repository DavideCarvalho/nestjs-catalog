import { Menu as BaseMenu } from '@base-ui/react/menu';
import { NodeToolbar, Position } from '@xyflow/react';
import {
  ArrowRight,
  Code2,
  GitBranch,
  LayoutGrid,
  Maximize2,
  MoreHorizontal,
  PanelRight,
  Plus,
  Trash2,
  Unplug,
  Waypoints,
} from 'lucide-react';
import { cn } from '../cn';
import { Tooltip } from '../ui/tooltip';
import type { CanvasMenuIcon, CanvasMenuItem, CanvasMenuSection } from './canvas-menu';
import { type WorkflowNode, nodeName } from './model';

/**
 * The two surfaces that render {@link CanvasMenuSection}, and the way back from
 * the destructive items they carry.
 *
 * ## One list, two ways in
 *
 * The right-click menu and the pill on a node's hover toolbar draw **the same
 * sections from the same builder**. That is the point rather than an economy:
 * the hover pill used to have a bespoke dropdown of its own, and the moment a
 * second menu existed the two would have started answering "what can this node
 * do" differently — which is precisely the failure the pill was already an
 * example of, since it was called "Wire" while the handle beside it was also
 * called wiring.
 *
 * The pill is therefore **renamed**. It says "Actions", it is `aria-label`ed as
 * the actions for the node it belongs to, and its tooltip says the same list is
 * on right-click — because the discovery problem this whole change exists for
 * was never that the menu was missing, it was that nobody could tell the two
 * "wire" things apart. It survives rather than being deleted for one reason
 * worth stating: right-click is not discoverable either. A control that appears
 * under the pointer is how somebody finds out the menu exists at all, and the
 * menu is how they find out what it contains.
 *
 * ## Where the browser's own menu is left alone
 *
 * These take over `contextmenu` on nodes, wires and the canvas pane, and nowhere
 * else. The chrome floating over the canvas — the header card, the action row,
 * the details rail, the inspector sheet, every text field in all of them — is a
 * sibling DOM subtree and is untouched, so right-clicking a name field still
 * gets cut/copy/paste/spell-check, which is the only menu that is any use there.
 *
 * ## Keyboard
 *
 * Nothing extra is bound, and that is deliberate: pressing the context-menu key
 * or Shift+F10 makes the browser dispatch a real `contextmenu` event at whatever
 * has focus, so a focused node or wire opens this menu through the same path a
 * right-click does. What the canvas has to add is the anchor — a keyboard-fired
 * event has no pointer, so it is anchored to the focused element instead of to
 * (0, 0), which is a corner of the screen nowhere near the node. Base UI's menu
 * supplies the rest of the contract: arrow keys move the highlight, Escape
 * closes, focus goes back where it came from.
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

const ICONS: Record<CanvasMenuIcon, typeof Plus> = {
  open: PanelRight,
  code: Code2,
  arrow: ArrowRight,
  plus: Plus,
  // A wire with a stop on it — the one item on these menus that changes the
  // shape of an existing connection rather than making or breaking one.
  insert: Waypoints,
  branch: GitBranch,
  unplug: Unplug,
  trash: Trash2,
  tidy: LayoutGrid,
  fit: Maximize2,
};

/**
 * How a popup looks. Shared, so the two entry points cannot drift visually
 * either — a right-click menu that looked different from the pill's would read
 * as a different feature.
 *
 * The transitions are `motion-safe:` throughout. Base UI drives its enter and
 * exit from `data-starting-style` / `data-ending-style`, which is CSS, so
 * `prefers-reduced-motion` is honoured by the variant rather than by a hook —
 * and the popup still appears, instantly, which is the test for whether an
 * animation was carrying information.
 */
const POPUP = cn(
  'z-50 max-h-[min(28rem,var(--available-height))] w-64 overflow-y-auto rounded-md border p-1 shadow-lg outline-none',
  RULE,
  PANEL,
  'origin-[var(--transform-origin)]',
  'motion-safe:transition-[opacity,transform] motion-safe:duration-100 motion-safe:ease-out',
  'motion-safe:data-[starting-style]:scale-95 motion-safe:data-[starting-style]:opacity-0',
  'motion-safe:data-[ending-style]:scale-95 motion-safe:data-[ending-style]:opacity-0',
);

const ITEM = cn(
  'flex w-full cursor-default select-none items-start gap-1.5 rounded px-1.5 py-1 text-left text-[11px] outline-none',
  // `data-highlighted` is Base UI's, and it is set by the keyboard as well as by
  // the pointer — so arrowing down a menu looks like moving a mouse down it,
  // which is the whole reason not to style `:hover` here.
  'data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800',
);

/**
 * The destructive tone.
 *
 * Red before the pointer arrives rather than on hover, for the reason the
 * `destructive` button variant gives: an action you cannot undo by looking at it
 * should be identifiable from across the menu, not on contact.
 */
const DESTRUCTIVE = cn(
  'text-rose-600 dark:text-rose-400',
  'data-[highlighted]:bg-rose-50 dark:data-[highlighted]:bg-rose-950/40',
);

function MenuItemRow({ item }: { item: CanvasMenuItem }) {
  const Icon = ICONS[item.icon];
  return (
    <BaseMenu.Item className={cn(ITEM, item.destructive && DESTRUCTIVE)} onClick={() => item.run()}>
      <Icon size={11} className={cn('mt-[3px] shrink-0', item.destructive ? '' : MUTED)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.hint && (
            <span className={cn('shrink-0 font-mono text-[9px]', MUTED)}>{item.hint}</span>
          )}
        </span>
        {/*
         * The cost, under the label, and only where there is one. This is what a
         * confirmation dialog would have said — the wires that go with a node,
         * what removing one from a published graph runs into — said before the
         * click instead of after it, which is the trade this menu makes: a
         * dialog on every removal is friction people learn to click through
         * without reading, and the undo bar below is what covers the mistake.
         */}
        {item.detail && (
          <span className={cn('mt-0.5 block text-[10px] leading-snug', MUTED)}>{item.detail}</span>
        )}
      </span>
    </BaseMenu.Item>
  );
}

function MenuSectionBlock({ section }: { section: CanvasMenuSection }) {
  return (
    <>
      {section.separated && <BaseMenu.Separator className={cn('my-1 h-px border-t', RULE)} />}
      <BaseMenu.Group className="py-0.5">
        {section.title && (
          <BaseMenu.GroupLabel
            className={cn('px-1.5 pb-0.5 font-mono text-[9px] uppercase tracking-[0.14em]', MUTED)}
          >
            {section.title}
          </BaseMenu.GroupLabel>
        )}
        {section.note && (
          <p className={cn('px-1.5 py-0.5 text-[11px] leading-relaxed', MUTED)}>{section.note}</p>
        )}
        {section.items.map((item) => (
          <MenuItemRow key={item.key} item={item} />
        ))}
      </BaseMenu.Group>
    </>
  );
}

function MenuBody({ sections }: { sections: CanvasMenuSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <MenuSectionBlock key={section.key} section={section} />
      ))}
    </>
  );
}

/** Where a context menu is anchored, in viewport coordinates. */
export interface MenuAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The menu itself, anchored to a point rather than to a control.
 *
 * Base UI ships a `ContextMenu` whose `Trigger` owns the `contextmenu` event on
 * a wrapping element, and it is not what this canvas needs: the trigger takes
 * over right-click for its whole subtree unconditionally, and this canvas has to
 * decide *per event* whether it has something better to offer than the browser's
 * menu — and, when it does, which of four different things was clicked. React
 * Flow already answers that question (`onNodeContextMenu`, `onEdgeContextMenu`,
 * `onPaneContextMenu`, `onSelectionContextMenu`), so the event stays the
 * canvas's and only the anchor comes here.
 *
 * `positionMethod="fixed"` because the rect is in viewport coordinates. The
 * collision behaviour is Base UI's default and is the reason it is not
 * configured here: near the right edge the popup flips to the other side of the
 * point, near the bottom it shifts up, and it never renders off-screen — which
 * is the one thing about a context menu that cannot be checked in jsdom and had
 * to be checked in a browser.
 */
export function CanvasContextMenu({
  opening,
  sections,
  label,
  onClose,
}: {
  /** Null before anything has been right-clicked, which is most of the time. */
  opening: { anchor: MenuAnchorRect } | null;
  sections: CanvasMenuSection[];
  /** What this menu is about, for a screen reader that gets no pointer context. */
  label: string;
  onClose: () => void;
}) {
  if (!opening) return null;
  const anchor = opening.anchor;

  return (
    <BaseMenu.Root
      open
      // Opening is the canvas's decision and is made by a `contextmenu` event, so
      // the only thing this menu's own controls can ask for is to be closed —
      // Escape, an outside press, or an item that has just run.
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      // Not modal: a modal menu locks the host page's scroll and disables
      // pointer interaction everywhere outside it, which on a canvas embedded in
      // somebody else's app shell is a heavier promise than a context menu has
      // any business making. Dismiss-on-outside-press and Escape are unaffected.
      modal={false}
    >
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          positionMethod="fixed"
          side="right"
          align="start"
          sideOffset={2}
          collisionPadding={8}
          anchor={{
            getBoundingClientRect: () =>
              DOMRect.fromRect({
                x: anchor.x,
                y: anchor.y,
                width: anchor.width,
                height: anchor.height,
              }),
          }}
          className="z-50"
        >
          <BaseMenu.Popup className={POPUP} aria-label={label}>
            <MenuBody sections={sections} />
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/**
 * The controls that appear on the node under the pointer.
 *
 * Two of them, and the second is the one that was asked for: *"tem que ter uma
 * forma mais rápida de deletar o nó… talvez no hover tipo o wire"*. Removing a
 * node meant opening its inspector and scrolling to the bottom of it, which is
 * four gestures for the most ordinary edit there is.
 *
 * It is a separate button rather than a menu item **and** a menu item, because
 * they answer different needs: the button is for somebody who already knows what
 * they want, and the item is for somebody reading the menu to find out what is
 * possible. What keeps that safe is that neither of them asks first and both of
 * them are undoable — see `removal.ts` for why that trade was made in that
 * direction.
 *
 * `NodeToolbar` with an explicit `nodeId` is React Flow's documented way of
 * rendering a toolbar for a node from outside that node's own component, so the
 * placement comes from the same measurements the canvas draws with and this file
 * does no arithmetic on a viewport transform. `offset={0}` is load-bearing: the
 * pointer has to travel from the node to the toolbar, and any gap is canvas —
 * `onNodeMouseLeave` would fire with nothing to catch it and the control would
 * vanish on the way to itself.
 *
 * ## Why `nopan` is what makes the pill openable at all
 *
 * `NodeToolbar` renders as a **direct child of `.react-flow__renderer`** — the
 * element React Flow attaches d3-zoom to — rather than inside the node it points
 * at. So a `mousedown` anywhere on this toolbar bubbles straight into the pan
 * gesture, and d3-zoom's `mousedowned` opens with `nopropagation(event)`, which
 * is `stopImmediatePropagation`. React 17+ delegates its listeners to the ROOT
 * container, which is an ancestor of the renderer, so an event stopped there
 * never reaches React at all: `onMouseDown` simply does not fire.
 *
 * That is fatal here and nowhere else on this toolbar, because Base UI's
 * `Menu.Trigger` opens on **mousedown**, not click (`useClick({ event:
 * 'mousedown' })`). The trash button beside it opens on `click`, which d3-zoom
 * leaves alone — so the toolbar looked half-working: delete fine, "Actions"
 * inert, with no error and nothing rendered to inspect.
 *
 * `nopan` is React Flow's own escape hatch and the only thing needed: its zoom
 * filter refuses the gesture outright when the event's target is inside an
 * element carrying that class, so `mousedowned` returns before it stops
 * anything. `nodrag` would be cargo — that one is read by the per-node drag
 * handler, and this toolbar is a sibling of every node rather than inside one.
 * The edge's × wrapper in `edges.tsx` has carried the same guard since it
 * shipped; this toolbar was the one control inside the flow that went without.
 */
export function NodeActionsToolbar({
  node,
  canEdit,
  open,
  sections,
  deleteHint,
  onOpenChange,
  onHoverChange,
  onDelete,
}: {
  /** Null whenever nothing is hovered or selected, which is most of the time. */
  node: WorkflowNode | null;
  canEdit: boolean;
  open: boolean;
  sections: CanvasMenuSection[];
  /** What deleting this node costs, spelled out on the button's tooltip. */
  deleteHint: string;
  onOpenChange: (open: boolean) => void;
  onHoverChange: (hovering: boolean) => void;
  onDelete: () => void;
}) {
  if (!node || !canEdit) return null;
  const name = nodeName(node);

  return (
    <NodeToolbar
      nodeId={node.id}
      isVisible
      position={Position.Top}
      align="end"
      offset={0}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      // `nopan` first, because it is the reason anything on this toolbar can be
      // pressed — see the note above. Without it d3-zoom eats the mousedown and
      // Base UI's trigger never hears the press that opens it.
      className="nopan flex items-center gap-1"
    >
      <BaseMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
        <BaseMenu.Trigger
          aria-label={`Actions for ${name}`}
          className={cn(
            'flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] shadow-sm outline-none',
            RULE,
            PANEL,
            'hover:bg-zinc-50 dark:hover:bg-zinc-800',
            'focus-visible:ring-2 focus-visible:ring-sky-500/40',
          )}
        >
          <MoreHorizontal size={11} />
          Actions
        </BaseMenu.Trigger>
        <BaseMenu.Portal>
          <BaseMenu.Positioner
            side="bottom"
            align="end"
            sideOffset={4}
            collisionPadding={8}
            className="z-50"
          >
            <BaseMenu.Popup className={POPUP} aria-label={`Actions for ${name}`}>
              <MenuBody sections={sections} />
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>

      {/*
       * Deliberately NOT inside the menu's own row, and deliberately last: the
       * gap is what stops a pointer aimed at "Actions" landing on a delete, and
       * putting it at the end means the destructive control is never where the
       * ordinary one was a moment ago.
       */}
      <Tooltip content={deleteHint}>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${name}`}
          className={cn(
            'flex items-center rounded-md border px-1.5 py-1 shadow-sm outline-none',
            RULE,
            PANEL,
            'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40',
            'focus-visible:ring-2 focus-visible:ring-rose-500/40',
          )}
        >
          <Trash2 size={11} />
        </button>
      </Tooltip>
    </NodeToolbar>
  );
}
