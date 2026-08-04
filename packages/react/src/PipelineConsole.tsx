import type {
  CatalogConnection,
  CatalogConnector,
  CatalogTransform,
  ConnectorKind,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Cable,
  CircleCheck,
  CircleX,
  Code2,
  KeyRound,
  Loader2,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { ConnectionPanel, connectionOptionsFor } from './ConnectionPanel';
import { TransformEditor } from './TransformEditor';
import { cn } from './cn';
import { type ConnectorInput, catalogQueryKeys, useCatalogClient } from './context';
// One description of what a source needs, shared with the workflow canvas's
// source inspector. See the header of that module for why it is not two.
import {
  CredentialField,
  INLINE_CONNECTION,
  KIND_OPTIONS,
  ReadModeFields,
  type SourceDraft,
  SourceFields,
  parseRecords,
  readsIncrementally,
  sourceConfigFrom,
  sourceDraftFrom,
  sourceIsIncomplete,
  toConnectorKind,
  usesConnection,
} from './source-fields';
import { ConfirmDialog } from './ui/dialog';
import { TextField } from './ui/field';
import { SelectField, type SelectOption } from './ui/select';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from './ui/tabs';
import { Tooltip, TooltipProvider } from './ui/tooltip';

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
 * Where data comes from, and the code that shapes it.
 *
 * Three tabs on one screen because they are only ever understood together: a
 * connection without its connectors is an address nobody uses, a connector
 * without its transform is a URL, and a transform without the connector it
 * feeds is code nobody can place.
 */
export function PipelineConsole({
  title = 'Connectors',
  eyebrow = 'Ingestion',
  intro = 'A source, code that reshapes it, and a snapshot at the end. Running one goes through exactly the same append-and-commit a publisher uses, so there is one way rows arrive rather than two.',
  canEdit = true,
}: PipelineConsoleProps) {
  const client = useCatalogClient();
  const [tab, setTab] = useState('connectors');

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
              <TabsTab value="connectors">
                <Cable size={13} />
                Connectors
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
            <TabsPanel value="connectors">
              <ConnectorList canEdit={canEdit} />
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

function ConnectorList({ canEdit }: { canEdit: boolean }) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CatalogConnector | 'new' | null>(null);

  const connectors = useQuery({
    queryKey: catalogQueryKeys.connectors,
    queryFn: () => client.listConnectors(),
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

  /**
   * A run rewrites three things at once, so all three are invalidated together.
   *
   * The connector's own last-run fields, its run list, and the catalog snapshot
   * the load wrote into. Invalidating them one at a time is how a list ends up
   * showing a run that finished beside a connector that still says it never has.
   */
  const invalidateRun = () => {
    queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connectors });
    queryClient.invalidateQueries({ queryKey: catalogQueryKeys.runs() });
    queryClient.invalidateQueries({ queryKey: catalogQueryKeys.snapshot });
  };

  const run = useMutation({
    mutationFn: (id: string) => client.runConnector(id),
    onSuccess: invalidateRun,
  });

  if (editing) {
    return (
      <ConnectorForm
        connector={editing === 'new' ? undefined : editing}
        transforms={transforms}
        connections={connections}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connectors });
        }}
      />
    );
  }

  return (
    <div className="mt-6 space-y-3">
      {canEdit && (
        <button
          type="button"
          onClick={() => setEditing('new')}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs',
            RULE,
            'hover:bg-zinc-50 dark:hover:bg-zinc-800',
          )}
        >
          <Plus size={12} />
          New connector
        </button>
      )}

      {/* `isPending`, not `isFetching`: a background refetch must not replace a
          list somebody is reading with a placeholder. */}
      {connectors.isPending && (
        <p
          className={cn(
            'rounded-lg border border-dashed px-4 py-12 text-center text-sm',
            RULE,
            MUTED,
          )}
        >
          Reading connectors…
        </p>
      )}

      {connectors.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-center dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-300">
            {connectors.error instanceof Error
              ? connectors.error.message
              : 'Could not read the connectors.'}
          </p>
          <button
            type="button"
            onClick={() => connectors.refetch()}
            className="mt-2 rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300"
          >
            Try again
          </button>
        </div>
      )}

      {connectors.data?.length === 0 && (
        <p
          className={cn(
            'rounded-lg border border-dashed px-4 py-12 text-center text-sm',
            RULE,
            MUTED,
          )}
        >
          No connectors yet.
        </p>
      )}

      {connectors.data?.map((connector) => (
        <ConnectorCard
          key={connector.id}
          connector={connector}
          canEdit={canEdit}
          transform={transforms.find((t) => t.id === connector.transformId)}
          connection={connections.find((c) => c.id === connector.connectionId)}
          running={run.isPending && run.variables === connector.id}
          onRun={() => run.mutate(connector.id)}
          onEdit={() => setEditing(connector)}
          onDeleted={invalidateRun}
        />
      ))}
    </div>
  );
}

/**
 * One line saying where a connector actually reads from.
 *
 * Per kind, because reading `config.url` for everything left an s3 connector
 * with a blank subtitle — the card said a connector existed and nothing about
 * where it pointed, which is the one thing the list is for.
 */
/** Read a string out of a stored config without believing it is one. */
function configText(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

/** A prefix under a shared bucket, or a bucket of this connector's own. */
function describeS3Source(config: Record<string, unknown>, via: string): string {
  if (via) return `${via}${configText(config, 'prefix') || '(whole bucket)'}`;
  const bucket = configText(config, 'bucket');
  if (!bucket) return 'no bucket configured';
  return `s3://${bucket}/${configText(config, 'prefix')}`;
}

/** The query, shortened to fit a line, plus the watermark when it reads incrementally. */
function describeSqlSource(config: Record<string, unknown>, via: string): string {
  const watermark = configText(config, 'watermarkColumn');
  const query = configText(config, 'query').replace(/\s+/g, ' ').trim();
  const shown = query.length > 70 ? `${query.slice(0, 70)}…` : query;
  return `${via}${watermark ? `${shown} · since ${watermark}` : shown}`;
}

/** A path under a shared base URL, or a full URL of this connector's own. */
function describeHttpSource(config: Record<string, unknown>, via: string): string {
  const path = configText(config, 'path');
  if (via) return `${via}${path || '/'}`;
  return `${configText(config, 'url')}${path ? ` · ${path}` : ''}`;
}

function describeSource(connector: CatalogConnector, connection?: CatalogConnection): string {
  const config = connector.config ?? {};

  // The connection's name first, because when one is in use it is the answer to
  // "where does this read from" and the connector's own config is only the part
  // specific to this load.
  const via = connection ? `${connection.name} · ` : '';

  if (connector.kind === 's3') return describeS3Source(config, via);
  if (connector.kind === 'sql') return describeSqlSource(config, via);
  if (connector.kind === 'file') {
    return configText(config, 'path') || configText(config, 'url') || 'no path configured';
  }
  if (connector.kind === 'inline') {
    const records = config.records;
    return `${Array.isArray(records) ? records.length : 0} pasted records`;
  }
  return describeHttpSource(config, via);
}

function ConnectorCard({
  connector,
  transform,
  connection,
  canEdit,
  running,
  onRun,
  onEdit,
  onDeleted,
}: {
  connector: CatalogConnector;
  transform?: CatalogTransform;
  connection?: CatalogConnection;
  canEdit: boolean;
  running: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const client = useCatalogClient();
  const [confirming, setConfirming] = useState(false);

  const { data: runs = [] } = useQuery({
    queryKey: catalogQueryKeys.runs(connector.id),
    queryFn: () => client.listRuns(connector.id),
  });

  const remove = useMutation({
    mutationFn: () => client.deleteConnector(connector.id),
    onSuccess: () => {
      setConfirming(false);
      onDeleted();
    },
  });

  return (
    <div className={cn('rounded-lg border p-4', RULE, PANEL)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{connector.name}</span>
            <span className="rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase dark:bg-zinc-800">
              {connector.kind}
            </span>
            <span className={cn('font-mono text-[10px]', MUTED)}>→ {connector.targetType}</span>
            {connection && (
              <Tooltip
                content={`Reads through the ${connection.name} connection, which supplies the address and the credential. Moving that connection moves this connector with it.`}
              >
                <span
                  className={cn('flex cursor-help items-center gap-1 font-mono text-[10px]', MUTED)}
                >
                  <Plug size={10} />
                  {connection.name}
                </span>
              </Tooltip>
            )}
            {connector.mode === 'incremental' && (
              <Tooltip content="Reads only what changed since the last run, and carries the rest forward.">
                <span
                  className={cn('flex cursor-help items-center gap-1 font-mono text-[10px]', MUTED)}
                >
                  <RefreshCw size={10} />
                  incremental
                </span>
              </Tooltip>
            )}
            {!connector.enabled && (
              <span className="rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-800">
                disabled
              </span>
            )}
          </div>
          <div className={cn('mt-1 font-mono text-[11px]', MUTED)}>
            {describeSource(connector, connection)}
          </div>
          {connector.secretEnvVar && (
            <Tooltip content="The catalog stores the NAME of this variable, never its value. A leaked catalog database gives away the shape of the integration, not the keys to it.">
              <div
                className={cn(
                  'mt-1 flex w-fit cursor-help items-center gap-1 font-mono text-[10px]',
                  MUTED,
                )}
              >
                <KeyRound size={10} />
                {connector.secretEnvVar}
              </div>
            </Tooltip>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRun}
            disabled={running || !connector.enabled}
            className="flex items-center gap-1.5 rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            {running ? 'Running…' : 'Run now'}
          </button>
          {canEdit && (
            <Tooltip content={`Delete ${connector.name}`}>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                aria-label={`Delete ${connector.name}`}
                className={cn('rounded-sm p-1.5 hover:text-red-600', MUTED)}
              >
                <Trash2 size={12} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {transform && (
        <button
          type="button"
          onClick={onEdit}
          className={cn('mt-3 flex items-center gap-1.5 text-[11px]', MUTED, 'hover:text-sky-600')}
        >
          <Code2 size={11} />
          {transform.name}
          <span className="font-mono">
            {transform.language} · v{transform.version}
          </span>
        </button>
      )}

      {runs.length > 0 && (
        <div className={cn('mt-3 border-t pt-3', RULE)}>
          <div className={cn('mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
            Recent runs
          </div>
          <div className="space-y-1">
            {runs.slice(0, 4).map((entry) => (
              <Tooltip
                key={entry.id}
                content={
                  entry.error ? (
                    <span className="font-mono text-[11px]">{entry.error}</span>
                  ) : (
                    <span className="font-mono text-[11px]">
                      {entry.logs.slice(-3).join('\n') || 'No logs.'}
                    </span>
                  )
                }
              >
                <div className="flex cursor-help items-center gap-2 text-[11px]">
                  {/* The icon carries the outcome, so the outcome needs a name
                      too — otherwise a failed run and a run that found nothing
                      read identically as "0 fetched · 0 written". */}
                  <span className="sr-only">{entry.status}: </span>
                  {entry.status === 'succeeded' ? (
                    <CircleCheck size={11} aria-hidden className="text-emerald-600" />
                  ) : entry.status === 'failed' ? (
                    <CircleX size={11} aria-hidden className="text-red-600" />
                  ) : (
                    <Loader2 size={11} aria-hidden className="animate-spin text-sky-600" />
                  )}
                  <span className="font-mono">{entry.snapshotId}</span>
                  <span className={MUTED}>
                    {entry.fetched} fetched · {entry.written} written
                    {entry.transformVersion ? ` · code v${entry.transformVersion}` : ''}
                  </span>
                  <span className={cn('ml-auto font-mono text-[10px]', MUTED)}>
                    {new Date(entry.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${connector.name}?`}
        description="The snapshots it already wrote stay where they are — this removes the connector, its schedule and its incremental watermark. Recreating it later starts reading from the beginning again."
        confirmLabel={remove.isPending ? 'Deleting…' : 'Delete'}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
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

/**
 * The connection picker, above the address fields it replaces.
 *
 * Offered rather than required: a one-off source does not deserve a second
 * object to manage, and forcing one would make the quickest thing this screen
 * can do — paste a URL, load it once — the slowest.
 */
function ConnectionPicker({
  value,
  options,
  viaConnection,
  onChange,
}: {
  value: string;
  options: SelectOption[];
  viaConnection: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SelectField
      label="Read through"
      ariaLabel="Connection"
      value={value}
      onValueChange={onChange}
      options={[
        {
          value: INLINE_CONNECTION,
          label: 'Configure the address here',
          hint: 'This connector alone',
        },
        ...options,
      ]}
      hint={connectionPickerHint(options.length, viaConnection)}
    />
  );
}

/** Why the picker looks the way it does — nothing to choose, or something chosen. */
function connectionPickerHint(optionCount: number, viaConnection: boolean): string | undefined {
  if (optionCount === 0) {
    return 'No connections of this kind yet. One is worth making when a second connector needs the same address.';
  }
  if (viaConnection) {
    return 'The connection supplies the address and the credential. What stays below is only what is specific to this load.';
  }
  return undefined;
}

/** Save and cancel, plus whatever the server said when saving failed. */
function ConnectorFormActions({
  editing,
  pending,
  incomplete,
  error,
  onClose,
}: {
  editing: boolean;
  pending: boolean;
  incomplete: boolean;
  error: unknown;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || incomplete}
          className="rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
        >
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Save connector'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={cn('rounded-md px-3 py-1.5 text-xs', MUTED)}
        >
          Cancel
        </button>
      </div>

      {error ? (
        <p className="text-[11px] text-red-600">
          {error instanceof Error ? error.message : 'Could not save.'}
        </p>
      ) : null}
    </>
  );
}

function ConnectorForm({
  connector,
  transforms,
  connections,
  onClose,
  onSaved,
}: {
  connector?: CatalogConnector;
  transforms: CatalogTransform[];
  connections: CatalogConnection[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useCatalogClient();

  const [kind, setKind] = useState<ConnectorKind>(toConnectorKind(connector?.kind ?? 'http'));
  const [connectionId, setConnectionId] = useState(connector?.connectionId ?? INLINE_CONNECTION);
  const [mode, setMode] = useState<'full' | 'incremental'>(
    connector?.mode === 'incremental' ? 'incremental' : 'full',
  );
  const [enabled, setEnabled] = useState(connector?.enabled ?? true);
  // The address fields live in their own state because they are shared with the
  // workflow source inspector — see `source-fields.tsx`. What is left in `draft`
  // is what only a connector has.
  const [source, setSource] = useState<SourceDraft>(() => sourceDraftFrom(connector?.config));
  const [draft, setDraft] = useState({
    name: connector?.name ?? '',
    targetType: connector?.targetType ?? '',
    secretEnvVar: connector?.secretEnvVar ?? '',
    transformId: connector?.transformId ?? '',
  });

  const incremental = readsIncrementally(kind) && mode === 'incremental';
  const connectionOptions = connectionOptionsFor(kind, connections);
  // A connection chosen for one kind is meaningless for another, so switching
  // the kind drops it rather than sending an id the server would reject.
  const chosenConnection = connectionOptions.some((option) => option.value === connectionId)
    ? connectionId
    : INLINE_CONNECTION;
  const viaConnection = chosenConnection !== INLINE_CONNECTION;
  const records = parseRecords(source.records);

  const save = useMutation({
    mutationFn: () => {
      if (kind === 'inline' && !records.ok) {
        // Refused here rather than sent, so the message names the JSON rather
        // than arriving as a server error about an empty load.
        return Promise.reject(new Error(records.message));
      }
      const next = sourceConfigFrom(kind, source, { viaConnection, incremental });

      const input: ConnectorInput = {
        id: connector?.id,
        name: draft.name.trim(),
        kind,
        targetType: draft.targetType.trim(),
        config: next,
        // Omitted, never sent empty: an empty string is a connection id the
        // server would look up and fail to find, where absent means "this
        // connector carries its own address".
        ...(viaConnection ? { connectionId: chosenConnection } : {}),
        // A kind that cannot be asked what changed is saved as `full`, so the
        // stored mode never claims something the fetcher does not do.
        mode: incremental ? 'incremental' : 'full',
        // The connection owns the credential when one is in use. Sending the
        // connector's own as well would mean two answers to "which variable
        // holds the password", and the runner can only use one.
        ...(viaConnection || !draft.secretEnvVar.trim()
          ? {}
          : { secretEnvVar: draft.secretEnvVar.trim() }),
        ...(draft.transformId ? { transformId: draft.transformId } : {}),
        enabled,
      };
      return client.saveConnector(input);
    },
    onSuccess: onSaved,
  });

  const incomplete =
    draft.name.trim().length === 0 ||
    draft.targetType.trim().length === 0 ||
    sourceIsIncomplete(kind, source, viaConnection);

  return (
    <form
      className={cn('mt-6 space-y-4 rounded-lg border p-4', RULE, PANEL)}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Name"
          value={draft.name}
          onChange={(name) => setDraft({ ...draft, name })}
          placeholder="Nightly fleet load"
        />
        <TextField
          label="Target object type"
          value={draft.targetType}
          onChange={(targetType) => setDraft({ ...draft, targetType })}
          placeholder="e.g. Mvr"
        />
        <SelectField
          label="Source kind"
          ariaLabel="Source kind"
          value={kind}
          onValueChange={(value) => setKind(toConnectorKind(value))}
          options={KIND_OPTIONS}
        />
      </div>

      {usesConnection(kind) && (
        <ConnectionPicker
          value={chosenConnection}
          options={connectionOptions}
          viaConnection={viaConnection}
          onChange={setConnectionId}
        />
      )}

      <SourceFields kind={kind} draft={source} onChange={setSource} viaConnection={viaConnection} />

      <ReadModeFields
        kind={kind}
        mode={mode}
        onModeChange={setMode}
        draft={source}
        onChange={setSource}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {!viaConnection && (
          <CredentialField
            kind={kind}
            value={draft.secretEnvVar}
            onChange={(secretEnvVar) => setDraft({ ...draft, secretEnvVar })}
          />
        )}
        <SelectField
          label="Transform"
          ariaLabel="Transform"
          value={draft.transformId}
          onValueChange={(transformId) => setDraft({ ...draft, transformId })}
          options={[
            {
              value: '',
              label: 'No transform',
              hint: 'Store records as they arrive',
            },
            ...transforms.map((transform) => ({
              value: transform.id,
              label: transform.name,
              hint: `${transform.language} · v${transform.version}`,
            })),
          ]}
        />
      </div>

      <Switch
        checked={enabled}
        onCheckedChange={setEnabled}
        label="Enabled"
        hint="A disabled connector keeps its configuration and its watermark, and refuses to run."
      />

      <ConnectorFormActions
        editing={connector !== undefined}
        pending={save.isPending}
        incomplete={incomplete}
        error={save.error}
        onClose={onClose}
      />
    </form>
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
        <button
          type="button"
          onClick={() => setEditing('new')}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs',
            RULE,
            'hover:bg-zinc-50 dark:hover:bg-zinc-800',
          )}
        >
          <Plus size={12} />
          New transform
        </button>
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
          <button
            type="button"
            onClick={() => transforms.refetch()}
            className="mt-2 rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300"
          >
            Try again
          </button>
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
          No transforms yet. Without one, a connector stores records exactly as they arrive.
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
              <button
                type="button"
                onClick={() => setConfirming(transform)}
                aria-label={`Delete ${transform.name}`}
                className={cn('rounded-sm p-1 hover:text-red-600', MUTED)}
              >
                <Trash2 size={12} />
              </button>
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
        description="Any connector pointing at it will store records exactly as they arrive from now on, which is rarely what its target type expects. Every past version goes with it, so a surprising load can no longer be traced to the code that ran."
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
