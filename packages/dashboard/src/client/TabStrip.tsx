import { Button, TabsList, TabsTab } from '@dudousxd/nestjs-catalog-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The console's tab strip, when there are more tabs than room.
 *
 * Nine tabs plus the brand and two controls need ~1150px, and below that the
 * strip used to push the whole DOCUMENT sideways. Scrolling the strip fixes
 * that but creates a second problem: tabs that exist and cannot be seen, with
 * nothing saying so. The arrows are the "nothing saying so" part.
 *
 * Each arrow appears only when there is something in ITS direction. A pair of
 * chevrons that are always present, one of them always dead, teaches people to
 * ignore both — and on a wide screen where everything fits, two permanently
 * greyed arrows are pure noise beside a strip that is not scrollable at all.
 */
export function TabStrip({
  tabs,
  value,
}: {
  tabs: Array<{ id: string; label: string; icon: React.ComponentType<{ size?: number }> }>;
  value: string;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const node = strip.current;
    if (!node) return;
    // A pixel of slack at each end. Sub-pixel layout means `scrollLeft` rarely
    // lands exactly on 0 or on the maximum, and without this the arrow flickers
    // on at the very end of a scroll that has in fact finished.
    const max = node.scrollWidth - node.clientWidth;
    setOverflow({ left: node.scrollLeft > 1, right: node.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    // Resizing is the case a scroll listener alone misses entirely: widen the
    // window until everything fits and the arrows would stay up forever,
    // pointing at nothing, because nobody scrolled.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => {
      node.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure]);

  const nudge = (direction: -1 | 1) => {
    const node = strip.current;
    if (!node) return;
    // Most of a screenful rather than all of it, so the tab at the edge stays
    // visible after the jump and there is something to anchor on.
    node.scrollBy({ left: direction * node.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <div className="flex min-w-0 flex-1 items-center">
      <Arrow show={overflow.left} direction="left" onClick={() => nudge(-1)} />
      {/* `min-w-0` is what makes the overflow work at all: a flex item defaults
          to `min-width: auto`, so without it this box refuses to shrink below
          its content and pushes the parent wide instead of scrolling.

          The scrollbar is hidden, not the scrolling. A native horizontal bar
          here is as tall as the tabs and sits between them and their underline,
          which reads as a broken layout. The arrows and the half-cut tab are
          the affordance instead. */}
      <TabsList
        ref={strip}
        className="min-w-0 flex-1 border-b-0 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <TabsTab key={id} value={id} className="py-3">
            <ScrollIntoViewWhenActive active={id === value} />
            <Icon size={14} />
            {label}
          </TabsTab>
        ))}
      </TabsList>
      <Arrow show={overflow.right} direction="right" onClick={() => nudge(1)} />
    </div>
  );
}

/**
 * Kept mounted with `invisible` rather than unmounted, so the strip does not
 * change width as the arrows come and go — a tab sliding sideways because you
 * scrolled to the end is exactly the kind of movement that makes a click miss.
 */
function Arrow({
  show,
  direction,
  onClick,
}: {
  show: boolean;
  direction: 'left' | 'right';
  onClick: () => void;
}) {
  const Icon = direction === 'left' ? ChevronLeft : ChevronRight;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={`Scroll tabs ${direction}`}
      // Out of the tab order and out of the accessibility tree when it does
      // nothing: keyboard users move between tabs with the arrow KEYS, which
      // Base UI already wires and which scroll the strip on their own. These
      // buttons are for pointers.
      tabIndex={-1}
      aria-hidden={!show}
      disabled={!show}
      className={show ? '' : 'invisible'}
    >
      <Icon size={16} />
    </Button>
  );
}

/**
 * Brings the active tab into view when it is the one selected.
 *
 * A zero-size child rather than a ref on the tab itself, because `TabsTab`
 * renders a Base UI component that does not forward one. Selecting a tab that
 * is scrolled out of sight would otherwise change the screen and leave the strip
 * looking untouched — and arriving on `#access` directly opens the last screen
 * with the strip parked at the first.
 */
function ScrollIntoViewWhenActive({ active }: { active: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    // `nearest` so a tab already on screen is left alone; recentering on every
    // click makes the whole strip jump under the cursor.
    if (active) ref.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [active]);
  return <span ref={ref} aria-hidden className="sr-only" />;
}
