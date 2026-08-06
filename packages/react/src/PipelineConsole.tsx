import type { CatalogTransform } from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, Plug, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConnectionPanel } from './ConnectionPanel';
import { TransformEditor } from './TransformEditor';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/dialog';
import { Tabs, TabsList, TabsPanel, TabsTab } from './ui/tabs';
import { Tooltip, TooltipProvider } from './ui/tooltip';
import { WORKFLOW_NAME } from './workflow/name';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

export interface PipelineConsoleProps {
  /** Heading copy, so the host can call this whatever its users call it. */
  title?: string;
  eyebrow?: string;
  intro?: string;
  /**
   * Set false where the viewer is known to be read-only. The endpoints refuse
   * regardless; this only stops the console offering buttons that always 403.
   */
  canEdit?: boolean;
}

/**
 * The two things a pipeline borrows, and neither of them is a pipeline.
 *
 * WHAT THIS SCREEN STOPPED BEING
 * ------------------------------
 * It was `#connectors`, and its middle tab was where somebody authored a load:
 * a name, a source kind, an address, a credential, a transform, a target type, a
 * schedule. Every one of those is a field on a node of a graph now, and the
 * routes behind that tab are gone — a connector is not authored any more, it is
 * what a published {@link WORKFLOW_NAME.singular} runs as. Keeping the tab would
 * have meant a form whose Save button 404s, which is worse than no form.
 *
 * WHAT IS LEFT, AND WHY IT IS NOT ON THE CANVAS
 * ---------------------------------------------
 * A connection is the credential and address boundary: a real object somebody
 * manages, shared by several pipelines, with a "can this host actually be
 * reached" question of its own that has nothing to do with any graph. Moving it
 * onto a canvas would make managing an address something you can only do while
 * drawing something.
 *
 * A transform is the other shared object — code, referenced by node id from any
 * number of graphs. The canvas creates one and edits its code inline, because
 * that is where you want it while wiring; this is where the whole set is listed,
 * and where deleting one is a decision made deliberately rather than mid-drag.
 *
 * Authoring a pipeline is one screen and it is not this one. See
 * `WorkflowCanvas`.
 */
export function PipelineConsole({
  title = 'Connections & transforms',
  eyebrow = 'Ingestion',
  intro = `The two things a ${WORKFLOW_NAME.singular} borrows: the addresses it reads through and the code it runs. Both are shared, so both outlive any one of them — which is why they are managed here rather than on the canvas where they are used.`,
  canEdit = true,
}: PipelineConsoleProps) {
  const client = useCatalogClient();
  const [tab, setTab] = useState('connections');

  const { data: capabilities } = useQuery({
    queryKey: catalogQueryKeys.capabilities,
    queryFn: () => client.pipelineCapabilities(),
    // Which languages an image can execute cannot change without a redeploy,
    // and a redeploy reloads the page. Refetching it per tab switch would be a
    // request that can only ever return the same answer.
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <p className={cn('font-mono text-[11px] uppercase tracking-[0.18em]', MUTED)}>
            {eyebrow}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{intro}</p>

          <Tabs value={tab} onValueChange={setTab} className="mt-6">
            <TabsList>
              <TabsTab value="connections">
                <Plug size={13} />
                Connections
              </TabsTab>
              <TabsTab value="transforms">
                <Code2 size={13} />
                Transforms
              </TabsTab>
              <Tooltip
                content={
                  capabilities?.pythonPackages?.length
                    ? `Python transforms may import ${capabilities.pythonPackages.join(', ')} — provisioned by the image, not by this service.`
                    : 'Which languages this deployment can actually execute.'
                }
              >
                <span
                  className={cn('ml-auto cursor-help self-center font-mono text-[10px]', MUTED)}
                >
                  {capabilities ? `runs ${capabilities.languages.join(' · ')}` : 'checking…'}
                </span>
              </Tooltip>
            </TabsList>

            <TabsPanel value="connections">
              <ConnectionPanel canEdit={canEdit} />
            </TabsPanel>
            <TabsPanel value="transforms">
              <TransformList
                canEdit={canEdit}
                languages={capabilities?.languages ?? ['javascript']}
                pythonPackages={capabilities?.pythonPackages ?? []}
              />
            </TabsPanel>
          </Tabs>
        </div>
      </div>
    </TooltipProvider>
  );
}

function TransformList({
  canEdit,
  languages,
  pythonPackages,
}: {
  canEdit: boolean;
  languages: Array<'javascript' | 'typescript' | 'python'>;
  pythonPackages: string[];
}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CatalogTransform | 'new' | null>(null);
  const [confirming, setConfirming] = useState<CatalogTransform | null>(null);

  const transforms = useQuery({
    queryKey: catalogQueryKeys.transforms,
    queryFn: () => client.listTransforms(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteTransform(id),
    onSuccess: () => {
      setConfirming(null);
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.transforms });
    },
  });

  if (editing) {
    return (
      <TransformEditor
        transform={editing === 'new' ? undefined : editing}
        languages={languages}
        pythonPackages={pythonPackages}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: catalogQueryKeys.transforms });
        }}
      />
    );
  }

  return (
    <div className="mt-6 space-y-3">
      {canEdit && (
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus size={12} />
          New transform
        </Button>
      )}

      {transforms.isPending && (
        <p
          className={cn(
            'rounded-lg border border-dashed px-4 py-12 text-center text-sm',
            RULE,
            MUTED,
          )}
        >
          Reading transforms…
        </p>
      )}

      {transforms.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-center dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-300">
            {transforms.error instanceof Error
              ? transforms.error.message
              : 'Could not read the transforms.'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
            onClick={() => transforms.refetch()}
          >
            Try again
          </Button>
        </div>
      )}

      {transforms.data?.length === 0 && (
        <p
          className={cn(
            'rounded-lg border border-dashed px-4 py-12 text-center text-sm',
            RULE,
            MUTED,
          )}
        >
          No transforms yet. Without one, a {WORKFLOW_NAME.singular} stores records exactly as they
          arrive — and a transform node on the canvas can write its first one for you.
        </p>
      )}

      {transforms.data?.map((transform) => (
        <div
          key={transform.id}
          className={cn('flex items-start gap-3 rounded-lg border p-4', RULE, PANEL)}
        >
          <Code2 size={14} className={cn('mt-0.5 shrink-0', MUTED)} />
          <button
            type="button"
            onClick={() => setEditing(transform)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{transform.name}</span>
              <span className="rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800">
                {transform.language}
              </span>
              <Tooltip content="Bumped only when the code changed, so it stays useful for tracing a surprising load back to what ran.">
                <span className={cn('cursor-help font-mono text-[10px]', MUTED)}>
                  v{transform.version}
                </span>
              </Tooltip>
            </div>
            {transform.description && (
              <p className={cn('mt-0.5 text-[11px]', MUTED)}>{transform.description}</p>
            )}
          </button>
          {canEdit && (
            <Tooltip content={`Delete ${transform.name}`}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setConfirming(transform)}
                aria-label={`Delete ${transform.name}`}
                className="hover:text-red-600"
              >
                <Trash2 size={12} />
              </Button>
            </Tooltip>
          )}
        </div>
      ))}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={confirming ? `Delete ${confirming.name}?` : ''}
        description={`Any ${WORKFLOW_NAME.singular} with a transform node pointing at it stops validating — the node names code that no longer exists, and the graph cannot be published until somebody chooses another. Every past version goes with it, so a surprising load can no longer be traced to the code that ran.`}
        confirmLabel={remove.isPending ? 'Deleting…' : 'Delete'}
        pending={remove.isPending}
        onConfirm={() => {
          if (confirming) remove.mutate(confirming.id);
        }}
        error={
          remove.error
            ? remove.error instanceof Error
              ? remove.error.message
              : 'Could not delete it.'
            : undefined
        }
      />
    </div>
  );
}
