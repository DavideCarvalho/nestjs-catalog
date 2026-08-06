import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CalendarClock, PauseCircle } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
import { type CatalogWorkflow, producedTypes } from './workflow/model';
import { WORKFLOW_NAME } from './workflow/name';

/**
 * What loads this type — the answer the model screen could not give.
 *
 * A sink node knows exactly which type it commits, and until this section
 * existed that knowledge only ever pointed one way: you could stand on a graph
 * and read off the type, and standing on the type there was nothing at all. The
 * question a deployment actually asks is the second one — *there is an `af_fleet`
 * workflow, how is it tied to this type* — and it was answerable only by opening
 * every graph in turn.
 *
 * ## Why the list may be empty, plural, and still incomplete
 *
 * These three are not edge cases to be tidied away; they are what the answer is,
 * and the section says all three out loud rather than implying a single owner.
 *
 * - **Plural.** Several graphs may commit one type, and one graph may commit
 *   several — a sink is what commits, and a graph may hold more than one. So the
 *   membership test is `producedTypes(nodes)` over the sinks rather than
 *   {@link CatalogWorkflow.targetType}, which is one stored string and can only
 *   ever name one of them.
 * - **Empty.** A type with no graph behind it is an ordinary state, not a
 *   fault: it may be loaded by an application, or not loaded at all yet.
 * - **Incomplete, always.** An application holding a `catalog:write` key can
 *   `POST` straight to the publish API, and no workflow will ever explain that
 *   load. So the note below is rendered in *both* states — the empty one and the
 *   populated one — because a list of two that quietly omits a third writer is
 *   more misleading than a list of none.
 *
 * ## What each row does and does not claim
 *
 * Naming a type at a sink is not the same as loading it. A draft is not
 * scheduled, a disabled graph does not run, and a published graph with no cron
 * runs only when somebody presses Run. Each row therefore says which of those it
 * is, because "loaded by af_fleet" beside a graph nobody has published is the
 * kind of half-truth that gets read off a screen and believed.
 *
 * ## Where the link goes, and why the host decides
 *
 * `workflowHref` is the host's, in the shape `explorerHref` already established
 * on this screen: this package does not know where — or whether — a host mounts
 * a canvas. Omit it and the rows render as plain rows rather than as dead links,
 * which is the rule `search-console.tsx` argues for a row that has nowhere to go.
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const SECONDARY = 'text-zinc-500 dark:text-zinc-400';
const PANEL = 'bg-white dark:bg-zinc-900';
const RULE = 'border-zinc-200 dark:border-zinc-800';

export interface LoadedBySectionProps {
  typeName: string;
  /** What a person calls the type. The sentences here are about the type. */
  displayName: string;
  /**
   * Where a graph lives, if the host mounts a screen for one. Receives the
   * workflow's id. Omit and the rows stay rows.
   */
  workflowHref?: (workflowId: string) => string;
}

/**
 * One graph that commits this type, with what it would take for it to run.
 *
 * Derived rather than stored, and computed here rather than asked of the server:
 * the workflow list is already a query this console makes, and a per-type route
 * would be a second answer to a question the sinks already answer.
 */
interface Loader {
  id: string;
  name: string;
  /** What stops it running, or nothing at all when the answer is "it runs". */
  standing: string;
  /** Whether `standing` is the reason it does NOT currently load anything. */
  idle: boolean;
  /** The other types this same graph commits. Empty when it commits only this one. */
  alsoCommits: string[];
}

/**
 * Whether this graph would run on its own, and what says so.
 *
 * Four states rather than a status badge, because `status` alone answers the
 * wrong question here. A reader on the model screen is asking "does this type
 * get refreshed", and a graph can be `ready` and still never run — `enabled` is
 * false, or nothing ever set a cron on it. Reporting `ready` for all three would
 * be the screen agreeing with a schedule that does not exist, which is the
 * incident `CatalogWorkflow.schedule` carries its own warning about.
 */
function standingOf(workflow: CatalogWorkflow): { standing: string; idle: boolean } {
  if (workflow.status !== 'ready') {
    return {
      standing: 'draft — nobody has published it, so nothing schedules it',
      idle: true,
    };
  }
  if (!workflow.enabled) {
    return { standing: 'published, but turned off', idle: true };
  }
  const schedule = workflow.schedule?.trim();
  if (!schedule) {
    return { standing: 'published, and runs only when somebody starts it', idle: false };
  }
  return { standing: `runs on ${schedule}`, idle: false };
}

/**
 * Every graph whose sinks commit this type.
 *
 * A whitespace-only `targetType` on a sink is not a match, which
 * `producedTypes` already handles by dropping it — a half-configured sink names
 * nothing, and treating a blank as a match would attach every unfinished graph
 * in the deployment to whichever type happened to sort first.
 */
export function loadersOf(workflows: CatalogWorkflow[], typeName: string): Loader[] {
  const loaders: Loader[] = [];
  for (const workflow of workflows) {
    const produces = producedTypes(workflow.nodes);
    if (!produces.includes(typeName)) continue;
    loaders.push({
      id: workflow.id,
      name: workflow.name,
      ...standingOf(workflow),
      alsoCommits: produces.filter((produced) => produced !== typeName),
    });
  }
  return loaders;
}

export function LoadedBySection({ typeName, displayName, workflowHref }: LoadedBySectionProps) {
  const client = useCatalogClient();
  const {
    data: workflows,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: catalogQueryKeys.workflows,
    queryFn: () => client.listWorkflows(),
    // Not retried, for the reason `LoadExpectationSection` gives beside the same
    // decision: the likely failure is a host that mounts no pipeline endpoints,
    // and four attempts at a 404 is half a minute of a section saying nothing
    // before it says that.
    retry: false,
  });

  const loaders = useMemo(
    () => (workflows ? loadersOf(workflows, typeName) : []),
    [workflows, typeName],
  );

  return (
    <section className="mt-10">
      <div className="mb-3">
        <h2 className={cn('font-mono text-[11px] uppercase tracking-[0.16em]', MUTED)}>
          Loaded by
        </h2>
        <p className={cn('mt-1 text-xs', MUTED)}>
          Which authored {WORKFLOW_NAME.plural} commit into {displayName}, read from their sink
          nodes. Not the whole answer — see below.
        </p>
      </div>

      {isPending && (
        <p className={cn('font-mono text-xs', MUTED)}>Reading the {WORKFLOW_NAME.plural}…</p>
      )}

      {isError && (
        <div className={cn('rounded-lg border px-4 py-3', RULE, PANEL)}>
          <p className="text-sm">Could not read the {WORKFLOW_NAME.plural}.</p>
          <p className={cn('mt-1 text-xs', SECONDARY)}>
            They are served by the pipeline endpoints, which are the host's rather than this
            library's — this deployment may not mount them, or this account may not read them.
            Nothing here says what loads {displayName}; in particular this is <em>not</em> the same
            answer as "nothing does".
          </p>
          {error instanceof Error && (
            <p className={cn('mt-1 font-mono text-[11px]', MUTED)}>{error.message}</p>
          )}
        </div>
      )}

      {workflows &&
        (loaders.length === 0 ? (
          <p
            className={cn(
              'rounded-lg border border-dashed px-4 py-6 text-center text-sm',
              RULE,
              MUTED,
            )}
          >
            No {WORKFLOW_NAME.singular} in this catalog commits {displayName}.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {loaders.map((loader) => (
              <LoaderRow
                key={loader.id}
                loader={loader}
                href={workflowHref?.(loader.id)}
                displayName={displayName}
              />
            ))}
          </ul>
        ))}

      {/*
        Rendered whichever way the list came out, and that is the point of it
        rather than an afterthought. The list is built from graphs, and a graph
        is not the only thing that can write a type — so "none" means "no graph",
        never "nothing", and "two" means "two graphs", never "two writers".
      */}
      {workflows && (
        <p className={cn('mt-2 text-[11px] leading-relaxed', MUTED)}>
          An application holding a key of its own can publish straight into {displayName} through
          the publish API, and such a load is authored nowhere in this catalog — so it cannot appear
          above, whether the list is empty or not. What did land, and when, is on the type's
          freshness note and in Activity.
        </p>
      )}
    </section>
  );
}

/**
 * One graph, as a row.
 *
 * The link wraps the NAME only, and the standing sits outside it. Wrapping both
 * would fold "draft — nobody has published it" into the link's accessible name,
 * so a screen reader would announce the whole sentence as the destination — and
 * two rows whose names differ only after forty characters are two links nobody
 * can tell apart by ear.
 */
function LoaderRow({
  loader,
  href,
  displayName,
}: {
  loader: Loader;
  href: string | undefined;
  displayName: string;
}) {
  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2',
        RULE,
        PANEL,
        // Dimmed, not dropped: a draft that commits this type is the answer to
        // "somebody is building one", which is a different and more useful
        // answer than an empty list.
        loader.idle && 'opacity-70',
      )}
    >
      {href ? (
        <a
          href={href}
          // Named for the destination rather than left as the bare graph name.
          // "af_fleet" alone is a fine label on screen, where the heading above
          // supplies the context; read out of a links list it is a word with no
          // verb, and this is the one control on the row that goes anywhere.
          aria-label={`${loader.name} — open the ${WORKFLOW_NAME.singular} that commits ${displayName}`}
          className={cn(
            'flex items-center gap-1.5 rounded-sm text-sm outline-none',
            'hover:text-sky-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 dark:hover:text-sky-400',
          )}
        >
          {loader.name}
          <ArrowUpRight size={13} aria-hidden className={MUTED} />
        </a>
      ) : (
        // A plain row, never an anchor to nowhere: the host mounts no screen for
        // a graph, and a link that looks live and goes nowhere is worse than
        // text.
        <span className="text-sm">{loader.name}</span>
      )}

      <span className={cn('flex items-center gap-1 font-mono text-[10px]', MUTED)}>
        {loader.idle ? (
          <PauseCircle size={11} aria-hidden />
        ) : (
          <CalendarClock size={11} aria-hidden />
        )}
        {loader.standing}
      </span>

      {loader.alsoCommits.length > 0 && (
        // Said because it changes what a run of this graph means: it is one read
        // feeding several outputs, so a failure here may leave the other types
        // committed. `WorkflowRun.status` is failed if any sink failed.
        <span className={cn('font-mono text-[10px]', SECONDARY)}>
          also commits {loader.alsoCommits.join(', ')}
        </span>
      )}
    </li>
  );
}
