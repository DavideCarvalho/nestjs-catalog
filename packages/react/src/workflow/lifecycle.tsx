/**
 * What happens to a graph after it is drawn: publish it, schedule it, run it.
 *
 * WHY THESE ARE ONE MODULE AND NOT PART OF THE CANVAS
 * ---------------------------------------------------
 * They arrived together, from a screen that no longer exists. Publishing,
 * scheduling and running-with-an-acknowledgement all used to be connector
 * concerns reached from `#connectors`; the connector stopped being something
 * anybody authors, so all three landed on the graph. Putting them in the canvas
 * file would have added four dialogs and three mutations to a component that is
 * already the largest thing in this package, and none of them touch React Flow —
 * which is also what lets this module be imported without a canvas at all.
 *
 * THE ONE THING TO BE CAREFUL WITH
 * --------------------------------
 * `expectShrink`. It is the only way an operator can re-drive a load the
 * row-count bound refused, and it exists on exactly one route now. The
 * alternative, when it is not reachable, is not "the load stays refused" — it is
 * somebody raising `rowCount.maxShrink` in the type's policy, which stands the
 * guard down for every future load of that type instead of for the one snapshot
 * in front of them. So it is a visible control, it says what it does where it is
 * used, and it will not send a blank reason.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  Clock,
  Loader2,
  Play,
  Sparkles,
  TriangleAlert,
  Undo2,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../cn';
import {
  type ScheduledWorkflow,
  type WorkflowRunOptions,
  catalogQueryKeys,
  useCatalogClient,
} from '../context';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { TextAreaField, TextField } from '../ui/field';
import { Switch } from '../ui/switch';
import { Tooltip } from '../ui/tooltip';
import type { CatalogWorkflow, WorkflowRun } from './model';
import { WORKFLOW_NAME } from './name';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * Who a graph is attributed to when nobody drew it.
 *
 * `ConnectorAdoption` wraps a pre-workflow connector into the graph it always
 * was, at boot, and publishes it — so an operator on an upgraded deployment
 * opens this screen and finds pipelines marked `ready` that they never drew and
 * never declared finished. That is worth saying out loud rather than leaving
 * them to infer it from a description.
 *
 * Matched on `createdBy` rather than on the generated description, because a
 * connector that carried a description of its own keeps it — so the description
 * is silent on exactly the graphs that had the most history behind them. The
 * string is the server's `ADOPTION_ACTOR`, and it is a copy: a rename there
 * makes this badge disappear rather than lie, which is the failure mode to
 * prefer between the two.
 */
export const WORKFLOW_ADOPTION_ACTOR = 'connector-adoption';

export function wasAdopted(workflow: Pick<CatalogWorkflow, 'createdBy'>): boolean {
  return workflow.createdBy === WORKFLOW_ADOPTION_ACTOR;
}

/**
 * Whether a failure is the row-count bound refusing a load, rather than
 * anything else that can go wrong in a run.
 *
 * Matched on the label the refusal names, which is the one token in that
 * sentence that is not prose: the message ends by telling the reader to set
 * `_expectShrink` in the load's labels or raise `rowCount.maxShrink`, and this
 * screen is the place that can do the first of those in one click.
 *
 * A miss costs nothing — the acknowledgement control is on screen regardless,
 * and this only decides whether the refusal itself grows a way straight into it.
 * That is deliberately the weaker of the two paths: a console that could offer
 * the escape hatch *only* after a refusal would be a console where an operator
 * who already knows a truncation is coming has to trigger a failed load first.
 */
export function refusedForShrink(message: string | undefined): boolean {
  return typeof message === 'string' && message.includes('_expectShrink');
}

/**
 * Draft or ready, and — where it applies — who decided.
 *
 * Rendered even for `draft`, which is the status a screen is tempted to leave
 * unsaid because it is the default. It is not decoration: a draft cannot be
 * scheduled and does not run on its own, so "why did my pipeline not fire last
 * night" has its answer here.
 */
export function WorkflowStatusBadge({ workflow }: { workflow: CatalogWorkflow }) {
  const ready = workflow.status === 'ready';
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Tooltip
        content={
          ready
            ? `Declared finished, and validated when it was. It runs as a connector of its own, and only a ready ${WORKFLOW_NAME.singular} can be scheduled.`
            : 'Being drawn. It saves without being validated — that is what a draft is for — and it neither runs on a schedule nor mints anything. Publishing is where the checks are answered for real.'
        }
      >
        <span
          className={cn(
            'cursor-help rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
            ready
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
          )}
        >
          {workflow.status}
        </span>
      </Tooltip>
      {!workflow.enabled && (
        <Tooltip content="Turned off. It keeps its configuration, its schedule and its incremental watermark, and refuses to fire.">
          <span
            className={cn(
              'cursor-help rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
              'text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
            )}
          >
            disabled
          </span>
        </Tooltip>
      )}
      {wasAdopted(workflow) && (
        <Tooltip
          content={`Nobody drew this. It was a connector from before a ${WORKFLOW_NAME.singular} was the only thing anybody authors, and it was wrapped into this graph at boot — one source, optionally one transform, one sink — and published as ready without a person declaring it finished. It keeps the connector's id, so its run history and its incremental watermark carry over. Worth reading before you trust the shape.`}
        >
          <span className="flex cursor-help items-center gap-1 rounded-sm bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-sky-800 dark:bg-sky-950 dark:text-sky-300">
            <Sparkles size={9} aria-hidden />
            adopted
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * The paragraph the badge cannot hold.
 *
 * On screen rather than in a tooltip, and only for an adopted graph, because a
 * tooltip is something you find when you already suspect there is something to
 * find. Somebody opening a pipeline they have never seen and being told it is
 * `ready` has no reason to hover anything.
 */
export function AdoptionNote({ workflow }: { workflow: CatalogWorkflow }) {
  if (!wasAdopted(workflow)) return null;
  return (
    <div
      className={cn(
        'mt-2.5 flex flex-wrap items-baseline gap-x-2 rounded-md border px-2.5 py-1.5',
        'border-sky-200 bg-sky-50 text-sky-900',
        'dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.14em]">adopted at boot</p>
      <p className="text-[11px] leading-relaxed">
        This graph was not drawn by anybody. A connector that predates {WORKFLOW_NAME.plural} was
        wrapped into it and published as <em>ready</em> automatically, so "ready" here means "it
        validated", not "somebody looked at it and said it was finished". Its run history and
        incremental watermark carried over with the connector's id.
      </p>
    </div>
  );
}

/**
 * Publish, or take it back to draft.
 *
 * Publishing is not offered while the canvas has unsaved edits, and that is the
 * one place on this screen where blocking is right: publishing validates the
 * STORED graph, so pressing it with edits on screen would report on a shape
 * nobody is looking at — and, worse, would succeed on it.
 *
 * The local checks do not gate it. They cannot see which types exist or who may
 * write to them, and a rule that is subtly wrong here would become a graph
 * nobody can publish with no error to read. The server refuses, in its own
 * words, and those words are what gets rendered.
 */
export function PublishControls({
  workflow,
  dirty,
  canEdit,
  onPublished,
}: {
  workflow: CatalogWorkflow;
  dirty: boolean;
  canEdit: boolean;
  onPublished: (workflow: CatalogWorkflow) => void;
}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
    // The connector is minted, disabled or removed by these two, and it is
    // where the run history is keyed — a stale read shows a pipeline that is
    // ready beside "nothing runs this yet".
    queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connectors });
  };

  const publish = useMutation({
    mutationFn: () => client.publishWorkflow(workflow.id),
    onSuccess: (saved) => {
      onPublished(saved);
      invalidate();
    },
  });

  const unpublish = useMutation({
    mutationFn: () => client.unpublishWorkflow(workflow.id),
    onSuccess: (saved) => {
      setConfirmingUnpublish(false);
      onPublished(saved);
      invalidate();
    },
  });

  return (
    <>
      {workflow.status === 'ready' ? (
        <Tooltip content="Back to draft. The connector it runs as is disabled and keeps its id, its run history and its watermark, so publishing again resumes this workflow rather than starting a second one beside it.">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmingUnpublish(true)}
            disabled={!canEdit || unpublish.isPending}
          >
            {unpublish.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Undo2 size={12} />
            )}
            Unpublish
          </Button>
        </Tooltip>
      ) : (
        <Tooltip
          content={
            dirty
              ? 'Save first — publishing validates the stored graph, not what is on screen.'
              : `Declare it finished. The server validates it and, if it passes, mints the connector this ${WORKFLOW_NAME.singular} runs as — which is what makes it schedulable and what a run history is keyed on.`
          }
        >
          <Button
            size="sm"
            onClick={() => publish.mutate()}
            disabled={!canEdit || dirty || publish.isPending}
          >
            {publish.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Upload size={12} />
            )}
            Publish
          </Button>
        </Tooltip>
      )}

      {/* The server's own words. It knows which types exist and who may write
          to them; a generic "could not publish" would throw away the only
          sentence that says which node to go and fix. The unpublish refusal is
          suppressed while its dialog is open, because the dialog prints the same
          message and two copies of one refusal reads as two refusals. */}
      <Refusal lead="Publishing was refused:" error={publish.error} />
      {!confirmingUnpublish && <Refusal lead="Could not unpublish it:" error={unpublish.error} />}

      <ConfirmDialog
        open={confirmingUnpublish}
        onOpenChange={setConfirmingUnpublish}
        destructive={false}
        title={`Take "${workflow.name}" back to draft?`}
        description="It stops running: the connector behind it is disabled, and a schedule on it will not fire. Nothing is lost — the id, the run history and the incremental watermark stay, so publishing again picks the same workflow back up rather than starting a second one from the beginning."
        confirmLabel={unpublish.isPending ? 'Unpublishing…' : 'Unpublish'}
        pending={unpublish.isPending}
        onConfirm={() => unpublish.mutate()}
        error={reasonFrom(unpublish.error)}
      />
    </>
  );
}

/** What went wrong, in the server's words, or nothing at all. */
function Refusal({ lead, error }: { lead: string; error: unknown }) {
  const reason = reasonFrom(error);
  if (!reason) return null;
  return (
    <p className="basis-full text-[11px] text-red-600">
      {lead} {reason}
    </p>
  );
}

/**
 * The sentence out of a rejection, or `undefined` when nothing was rejected.
 *
 * One place, because the alternative is the nested ternary this file had three
 * copies of — and the branch that is easy to get wrong is the middle one: a
 * rejection that is not an `Error` still has to say something, or a refusal
 * renders as blank space where a reason belongs.
 */
function reasonFrom(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error.message : 'no reason given.';
}

/**
 * Run it now, and the one thing a run may be told about itself.
 *
 * Two controls rather than one, and deliberately not a checkbox tucked beside
 * the button: an acknowledgement that a load is expected to lose most of its
 * rows is not a preference, it is a statement somebody signs. The second control
 * opens a dialog that says exactly what it is about to do and refuses to submit
 * without a reason — the reason is written into the snapshot's labels and is the
 * only answer anybody will have in six months to "why was this load allowed to
 * collapse?".
 *
 * It is on screen always, not only after a refusal. An operator who already
 * knows a base is being cut should not have to trigger a failed load first in
 * order to be offered the way through it.
 */
export function RunControls({
  workflowId,
  dirty,
  canEdit,
  running,
  durabilityDetail,
  acknowledging,
  onAcknowledgingChange,
  onRun,
}: {
  workflowId: string | undefined;
  dirty: boolean;
  canEdit: boolean;
  running: boolean;
  durabilityDetail: string;
  /**
   * Whether the acknowledgement dialog is open, held by the CALLER.
   *
   * Controlled rather than internal because there are two ways in and they are
   * in different parts of the screen: the icon button here, and the refusal
   * note that appears after a load the bound turned away — which is the moment
   * somebody most needs it and is nowhere near this row of buttons.
   */
  acknowledging: boolean;
  onAcknowledgingChange: (open: boolean) => void;
  onRun: (options?: WorkflowRunOptions) => void;
}) {
  const [reason, setReason] = useState('');

  const blocked = !canEdit || !workflowId || dirty || running;

  return (
    <>
      <Tooltip
        content={
          dirty
            ? 'Save first — a run executes the stored graph, not what is on screen.'
            : durabilityDetail
        }
      >
        <Button variant="outline" size="sm" onClick={() => onRun()} disabled={blocked}>
          {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Run
        </Button>
      </Tooltip>

      <Tooltip content="Run, saying up front that this load is expected to lose rows. Use it when a source really was truncated or cut back — it stands the row-count bound down for this one snapshot instead of for every future load of the type.">
        <Button
          variant="outline"
          size="icon"
          aria-label="Run, acknowledging that this load is expected to lose rows"
          onClick={() => {
            setReason('');
            onAcknowledgingChange(true);
          }}
          disabled={blocked}
        >
          <TriangleAlert size={12} />
        </Button>
      </Tooltip>

      <ConfirmDialog
        open={acknowledging}
        onOpenChange={onAcknowledgingChange}
        destructive={false}
        title="Run, expecting this load to shrink?"
        description={
          <span className="block space-y-2.5">
            <span className="block">
              A load that loses more rows than the type allows is refused and the previous snapshot
              keeps serving — because a broken <code>WHERE</code>, a source-side filter change and a
              partial outage all look exactly like this, and the data would be fresh and wrong.
            </span>
            <span className="block">
              This acknowledgement stands that bound down <strong>for this run only</strong>. The
              alternative — raising the type's <code>rowCount.maxShrink</code> — turns the guard off
              for every load of it from now on, including the ones nobody is watching.
            </span>
            <TextAreaField
              label="Why is this load expected to lose rows?"
              value={reason}
              onChange={setReason}
              rows={3}
              placeholder="e.g. Hurlburt was cut from the feed on the 3rd; this is the first load without it."
              hint="Stored in the snapshot's labels, so the load itself carries the answer. A blank reason is refused — an acknowledgement nobody can explain later is worth nothing."
            />
          </span>
        }
        confirmLabel={running ? 'Running…' : 'Run with this reason'}
        pending={running}
        confirmDisabled={reason.trim().length === 0}
        onConfirm={() => {
          onAcknowledgingChange(false);
          onRun({ expectShrink: reason.trim() });
        }}
      />
    </>
  );
}

/**
 * When this graph runs on its own.
 *
 * Its own write, `PUT workflows/:id/schedule`, rather than fields folded into
 * the save the canvas performs on every drag — a cron that rides along with an
 * autosave is one a stale tab can silently revert.
 *
 * The `warning` is the reason this panel does not just show a text box. There
 * are several ways to store a cron that will never fire — the graph is a draft,
 * the graph is disabled, the expression does not parse — and the incident behind
 * this route is a scheduler that logged it was watching schedules every 30
 * seconds while parsing nothing. The server names which one, and this prints it.
 */
export function SchedulePanel({
  workflow,
  canEdit,
  onScheduled,
}: {
  workflow: CatalogWorkflow;
  canEdit: boolean;
  onScheduled: (workflow: CatalogWorkflow) => void;
}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [schedule, setSchedule] = useState(workflow.schedule ?? '');
  const [enabled, setEnabled] = useState(workflow.enabled);

  const save = useMutation({
    mutationFn: (): Promise<ScheduledWorkflow> =>
      client.scheduleWorkflow(workflow.id, { schedule, enabled }),
    onSuccess: (saved) => {
      onScheduled(saved);
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connectors });
    },
  });

  const changed = schedule !== (workflow.schedule ?? '') || enabled !== workflow.enabled;

  return (
    <section className={cn('rounded-lg border p-3', RULE, PANEL)}>
      <h2
        className={cn(
          'flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em]',
          MUTED,
        )}
      >
        <Clock size={10} aria-hidden />
        Schedule
      </h2>

      <div className="mt-2 space-y-2">
        <TextField
          label="Cron"
          value={schedule}
          onChange={setSchedule}
          placeholder="0 3 * * *"
          disabled={!canEdit}
          hint="Empty means this only runs when somebody presses Run."
        />
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          label="Enabled"
          hint="Off keeps the cron, the configuration and the watermark, and refuses to fire."
          disabled={!canEdit}
        />
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => save.mutate()}
            disabled={!changed || save.isPending}
          >
            {save.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
            {changed ? 'Save schedule' : 'Schedule saved'}
          </Button>
        )}
      </div>

      {/* Said before the write rather than only after it. A cron on a draft is
          the commonest way to end up with a workflow that looks scheduled and
          has never fired, and the person typing one has no reason to know that
          publishing is what turns it on. */}
      {workflow.status !== 'ready' && (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          This is a draft, so nothing here will fire whatever the cron says. Publish it first —
          scheduling a graph nobody has declared finished is a load nobody approved.
        </p>
      )}

      {save.data?.warning ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" aria-hidden />
          {save.data.warning}
        </p>
      ) : null}
      {save.isSuccess && !save.data?.warning && !changed && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-600">
          <CircleCheck size={11} aria-hidden />
          Stored. The scheduler reads this graph, not the connector behind it.
        </p>
      )}
      {save.error && (
        <p className="mt-2 text-[11px] text-red-600">
          {save.error instanceof Error ? save.error.message : 'Could not store the schedule.'}
        </p>
      )}
    </section>
  );
}

/**
 * A run that was refused by the row-count bound, with the way through it.
 *
 * The refusal itself is the server's sentence and is printed whole. What this
 * adds is the one action that answers it, at the moment somebody is reading the
 * reason — because the alternative they will otherwise reach for is the type's
 * policy, which is the wrong lever and the hard one to put back.
 */
export function ShrinkRefusalNote({
  run,
  error,
  onAcknowledge,
}: {
  run: WorkflowRun | null;
  error: unknown;
  onAcknowledge: () => void;
}) {
  const message =
    error instanceof Error ? error.message : (run?.error ?? runNodeError(run) ?? undefined);
  if (!refusedForShrink(message)) return null;

  return (
    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">{message}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
        If the load is right, re-drive it with a reason. That acknowledges this snapshot and nothing
        else — raising the type's bound would stand the guard down for every load of it from now on.
      </p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onAcknowledge}>
        <TriangleAlert size={12} />
        Re-run, acknowledging the shrink
      </Button>
    </div>
  );
}

/**
 * The first node error in a run, when the run itself carries none.
 *
 * A sink that refuses is one failed node in an otherwise ordinary run, and
 * depending on whether the graph ran durably the refusal can land on the node
 * rather than on the run. Reading both is cheaper than caring which.
 */
function runNodeError(run: WorkflowRun | null): string | undefined {
  return run?.nodes.find((node) => typeof node.error === 'string' && node.error.length > 0)?.error;
}
