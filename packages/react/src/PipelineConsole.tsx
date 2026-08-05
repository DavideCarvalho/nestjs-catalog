import type {
  CatalogConnection,
  CatalogConnector,
  CatalogTransform,
  ConnectorKind,
  ScalarType,
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
  ScanSearch,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
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
  /**
   * Asking a connector what its source looks like, and creating the type from
   * the answer.
   *
   * A prop rather than two more methods on `CatalogClient`, and that is not a
   * design preference — it is the honest report of a boundary. `CatalogClient`
   * carries no `discoverConnectorSchema` and no publish call of any kind, and
   * both live in `context.tsx`, so a console that reached for them would be
   * naming methods that do not exist. Wiring is one function each:
   *
   *     discover:   POST <pipelineBasePath>/connectors/:id/discover
   *     createType: PUT  <publishBasePath>/publish/:name/schema
   *
   * Omit it and the connector editor simply does not offer discovery, which is
   * the correct state for a host that has not mounted those routes. Supply
   * `discover` without `createType` and the panel does everything up to the
   * confirmation and then shows the exact request it would have sent — the
   * publish route requires `catalog:write` and per-type ownership, and a host
   * that has deliberately not given its console that has to be able to say so
   * without the screen pretending the button is merely broken.
   */
  schemaDiscovery?: SchemaDiscoveryBridge;
}

export interface SchemaDiscoveryBridge {
  discover(connectorId: string): Promise<ConnectorSchemaDiscovery>;
  /**
   * Create the type from what a person confirmed. Absent is a supported state —
   * see {@link PipelineConsoleProps.schemaDiscovery}.
   */
  createType?(draft: DiscoveredTypeDraft): Promise<unknown>;
}

/**
 * What `POST pipeline/connectors/:id/discover` answers, mirrored for the browser.
 *
 * Mirrored rather than imported, exactly as `PipelineCapabilities` is in
 * `context.tsx`: the authority is `schema-discovery.ts` in
 * `@dudousxd/nestjs-catalog-pipeline`, which is a NestJS package with a
 * `node:fs` import in its dependency graph and has no business in a browser
 * bundle. The two are kept honest by being the documented response of one route,
 * and by this screen treating every field it renders as something the server may
 * not have sent.
 */
export interface DiscoveredColumn {
  /**
   * The column as the source spells it, which is also the property name. The
   * server explains at length why it is not tidied: the store matches records to
   * properties by property NAME, so a renamed property is a column that loads
   * null on every run and reports success.
   */
  name: string;
  /** `null` means discovery reached no conclusion — which is not a type. */
  type: ScalarType | null;
  confidence: 'reported' | 'inferred' | 'unknown';
  sourceType: string;
  /** `null` where the source did not say. Postgres never does. */
  nullable: boolean | null;
  note?: string;
}

export interface SchemaDrift {
  added: string[];
  removed: string[];
  retyped: Array<{ property: string; was: ScalarType; now: ScalarType }>;
}

export interface ConnectorSchemaDiscovery {
  connectorId: string;
  connectorName: string;
  targetType: string;
  typeExists: boolean;
  basis: 'driver' | 'sample';
  sampled: number;
  caveat: string;
  columns: DiscoveredColumn[];
  drift: SchemaDrift | null;
}

/**
 * The discovery response, checked rather than assumed.
 *
 * The client returns `unknown` because this package must not import
 * `@dudousxd/nestjs-catalog-pipeline` — it would drag database drivers behind
 * optional imports into a browser bundle — so the shape above is a mirror of a
 * contract held somewhere else. A mirror can fall behind: a console talking to
 * an older server gets a body with no `columns`, and rendering it would throw
 * somewhere deep in the table with a message about `undefined.map`.
 *
 * Checked at the seam, once, so the failure names itself. Only the fields this
 * screen would crash without — validating every column here would be
 * re-implementing the server's own shape in a place that cannot be kept honest.
 */
function narrowDiscovery(answer: unknown): ConnectorSchemaDiscovery {
  if (!answer || typeof answer !== 'object' || !Array.isArray(Reflect.get(answer, 'columns'))) {
    throw new Error(
      'The server answered the discovery request with something this console does not recognise. ' +
        'It is most likely running a version of @dudousxd/nestjs-catalog-pipeline older than this ' +
        'console expects.',
    );
  }
  return Object.assign(Object.create(null), answer);
}

/** The subset of a published type this screen is able to state. */
export interface DiscoveredTypeDraft {
  name: string;
  properties: Array<{
    name: string;
    columnName: string;
    type: ScalarType;
    nullable: boolean;
  }>;
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
  schemaDiscovery,
}: PipelineConsoleProps) {
  const client = useCatalogClient();
  const [tab, setTab] = useState('connectors');

  /**
   * The bridge, from the client, unless the host supplied its own.
   *
   * Until this existed the panel took `schemaDiscovery` as a prop and nothing
   * supplied one, so the feature was reachable only by a host that had read the
   * source and written the two calls itself. The prop stays — a host embedding
   * this screen may route discovery through its own gateway — but it is an
   * override now rather than the only way in.
   */
  const bridge = useMemo<SchemaDiscoveryBridge>(
    () => ({
      discover: async (connectorId) =>
        narrowDiscovery(await client.discoverConnectorSchema(connectorId)),
      // `async` on purpose: `publishType` THROWS rather than rejecting when the
      // transport cannot PUT, and a bridge whose method throws synchronously
      // would escape the panel's error handling and take the screen with it.
      createType: async (draft) =>
        client.publishType(draft.name, {
          // Only what a person confirmed on screen. Everything else about a type
          // — its label, its description, its units — is curation, and inventing
          // any of it here would put words nobody chose into a catalog whose
          // whole claim is that its names were chosen.
          properties: draft.properties.map((property) => ({
            name: property.name,
            columnName: property.columnName,
            type: property.type,
            nullable: property.nullable,
          })),
        }),
    }),
    [client],
  );
  const discovery = schemaDiscovery ?? bridge;

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
              <ConnectorList canEdit={canEdit} schemaDiscovery={discovery} />
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

function ConnectorList({
  canEdit,
  schemaDiscovery,
}: { canEdit: boolean; schemaDiscovery?: SchemaDiscoveryBridge }) {
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
        schemaDiscovery={schemaDiscovery}
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

/**
 * Every type the catalog can hold, in the order a person scans for one.
 *
 * `unknown` is last and named plainly, because choosing it is a decision: the
 * store gives it a TEXT column and stringifies whatever arrives. It is the right
 * answer for a column nobody can classify and the wrong answer for one nobody
 * looked at, which is exactly why discovery never picks it on anyone's behalf.
 */
const SCALAR_TYPES: ScalarType[] = [
  'string',
  'number',
  'boolean',
  'date',
  'uuid',
  'json',
  'unknown',
];

/** What a person decided about one discovered column. */
export interface ColumnChoice {
  include: boolean;
  /** Empty means nothing has been chosen yet — see {@link initialChoices}. */
  type: ScalarType | '';
}

/**
 * Where the checkboxes start, and why the untyped ones start off.
 *
 * A column discovery could type is proposed; a column it could not is present,
 * visible, and **excluded** until somebody says what it is. Pre-selecting it
 * with a plausible default is the failure that matters — a wrong type becomes a
 * wrong column in a lake nobody re-checks, and everything downstream reads it
 * as fact rather than as the guess it was.
 *
 * Keyed by position rather than by name on purpose: `SELECT a.id, b.id` gives
 * two columns called `id`, and a map would silently merge their choices.
 */
export function initialChoices(columns: DiscoveredColumn[]): ColumnChoice[] {
  return columns.map((column) => ({ include: column.type !== null, type: column.type ?? '' }));
}

/**
 * The type this would create, and everything standing in the way of creating it.
 *
 * Pure, and separate from the panel, because these are the rules that decide
 * whether a schema somebody approved is one the publish route will accept — and
 * rules that live inside a component are rules only a rendered DOM can check.
 *
 * `columnName` is sent as well as `name`, and they are the same string. The
 * publish service maps `columnName` to `sourceColumn` and `name` to the property
 * itself, and the store reads records by property name; sending them equal is
 * what makes a load match. See the server's `DiscoveredColumn.name`.
 */
export function proposalFrom(
  discovery: ConnectorSchemaDiscovery,
  choices: ColumnChoice[],
): { draft: DiscoveredTypeDraft; problems: string[] } {
  const chosen = discovery.columns
    .map((column, index) => ({ column, choice: choices[index] ?? { include: false, type: '' } }))
    .filter((entry) => entry.choice.include);

  const problems: string[] = [];

  const untyped = chosen.filter((entry) => entry.choice.type === '');
  if (untyped.length > 0) {
    problems.push(
      `Choose a type for ${untyped.map((entry) => `"${entry.column.name}"`).join(', ')}, or leave ${untyped.length === 1 ? 'it' : 'them'} out.`,
    );
  }

  const counts = new Map<string, number>();
  for (const entry of chosen) {
    counts.set(entry.column.name, (counts.get(entry.column.name) ?? 0) + 1);
  }
  const duplicated = [...counts].filter(([, count]) => count > 1).map(([name]) => `"${name}"`);
  if (duplicated.length > 0) {
    problems.push(
      `${duplicated.join(', ')} appears more than once. A record is an object, so only one of them can survive — leave the others out.`,
    );
  }

  const properties: DiscoveredTypeDraft['properties'] = [];
  for (const entry of chosen) {
    if (entry.choice.type === '') continue;
    properties.push({
      name: entry.column.name,
      columnName: entry.column.name,
      type: entry.choice.type,
      // Not stated is published nullable. A column marked NOT NULL that the
      // source sometimes leaves empty is a load that fails at 3am; a nullable
      // column that never holds a null costs nothing at all.
      nullable: entry.column.nullable ?? true,
    });
  }

  if (properties.length === 0) {
    problems.push('Nothing is selected, and a type with no properties is refused.');
  }

  return { draft: { name: discovery.targetType, properties }, problems };
}

/**
 * What the source looks like, offered to the person who has to name it.
 *
 * Only for a SAVED connector: discovery runs the connector's own configured
 * read, and there is nothing to read from a form that has not been stored yet.
 *
 * The screen's job is to make the difference between what was *reported* and
 * what was *inferred* impossible to miss, because that difference is the whole
 * value of the report. A driver describing a `NUMERIC` column is the database
 * speaking; forty records that all happened to hold a string is a sample, and
 * the forty-first is where somebody finds out.
 */
function SchemaDiscoveryPanel({
  connectorId,
  bridge,
}: {
  connectorId: string;
  bridge: SchemaDiscoveryBridge;
}) {
  // Counted rather than timestamped so a second discovery always remounts the
  // table below, dropping the choices somebody made against a column list that
  // no longer exists.
  const [discovered, setDiscovered] = useState<{ run: number; value: ConnectorSchemaDiscovery }>();

  const discover = useMutation({
    mutationFn: () => bridge.discover(connectorId),
    onSuccess: (value) => setDiscovered((previous) => ({ run: (previous?.run ?? 0) + 1, value })),
  });

  return (
    <div className={cn('rounded-md border border-dashed p-3', RULE)}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => discover.mutate()}
          disabled={discover.isPending}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40',
            RULE,
            'hover:bg-zinc-50 dark:hover:bg-zinc-800',
          )}
        >
          {discover.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <ScanSearch size={12} />
          )}
          {discover.isPending ? 'Reading the source…' : 'Discover schema'}
        </button>
        <span className={cn('text-[11px]', MUTED)}>
          Reads the source and reports its columns. Creates nothing on its own.
        </span>
      </div>

      {discover.error ? (
        <p className="mt-2 text-[11px] text-red-600">
          {discover.error instanceof Error ? discover.error.message : 'Could not read the source.'}
        </p>
      ) : null}

      {discovered && (
        <DiscoveredSchema
          key={discovered.run}
          discovery={discovered.value}
          createType={bridge.createType}
        />
      )}
    </div>
  );
}

function DiscoveredSchema({
  discovery,
  createType,
}: {
  discovery: ConnectorSchemaDiscovery;
  createType?: (draft: DiscoveredTypeDraft) => Promise<unknown>;
}) {
  const [choices, setChoices] = useState<ColumnChoice[]>(() => initialChoices(discovery.columns));
  const { draft, problems } = proposalFrom(discovery, choices);

  const setChoice = (index: number, next: Partial<ColumnChoice>) =>
    setChoices((current) =>
      current.map((choice, position) => (position === index ? { ...choice, ...next } : choice)),
    );

  return (
    <div className="mt-3 space-y-3">
      <p className={cn('text-[11px]', MUTED)}>
        {/* The caveat comes from the server rather than being written here, so a
            console and a script piping the same payload into a file say the same
            thing about what it proves. */}
        {discovery.caveat}
      </p>

      <DriftReport drift={discovery.drift} targetType={discovery.targetType} />

      {discovery.columns.length === 0 ? (
        <p className={cn('text-[11px]', MUTED)}>No columns came back.</p>
      ) : (
        <table className="w-full text-left text-[11px]">
          <thead className={cn('font-mono uppercase tracking-[0.14em]', MUTED)}>
            <tr>
              <th className="w-6 pb-1 font-normal">
                <span className="sr-only">Include</span>
              </th>
              <th className="pb-1 font-normal">Column</th>
              <th className="pb-1 font-normal">Type</th>
              <th className="pb-1 font-normal">Null</th>
              <th className="pb-1 font-normal">Source</th>
            </tr>
          </thead>
          <tbody>
            {discovery.columns.map((column, index) => (
              <ColumnRow
                // The source may legally return two columns of one name, so the
                // position has to be part of the key: on its own the name would
                // collide, and React would reuse one row's choice for the other.
                key={`${column.name}-${index}`}
                column={column}
                choice={choices[index] ?? { include: false, type: '' }}
                onChange={(next) => setChoice(index, next)}
              />
            ))}
          </tbody>
        </table>
      )}

      {problems.map((problem) => (
        <p key={problem} className="flex items-start gap-1.5 text-[11px] text-amber-600">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" aria-hidden />
          {problem}
        </p>
      ))}

      <Confirmation
        discovery={discovery}
        draft={draft}
        problems={problems}
        createType={createType}
      />
    </div>
  );
}

/**
 * The act that creates the type — the only thing on this screen that writes.
 *
 * Its own component because it has three states and they are not variations on
 * a button: nothing has been created yet, something has, or this console has no
 * way to create anything and has to hand over the request instead.
 */
function Confirmation({
  discovery,
  draft,
  problems,
  createType,
}: {
  discovery: ConnectorSchemaDiscovery;
  draft: DiscoveredTypeDraft;
  problems: string[];
  createType?: (draft: DiscoveredTypeDraft) => Promise<unknown>;
}) {
  const [created, setCreated] = useState(false);
  const create = useMutation({
    mutationFn: () => {
      if (!createType) return Promise.reject(new Error('This console cannot create types.'));
      return createType(draft);
    },
    onSuccess: () => setCreated(true),
  });

  if (!createType) return <UnwiredConfirmation draft={draft} />;

  if (created) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-600">
        <CircleCheck size={11} aria-hidden />
        {discovery.targetType} now exists with {draft.properties.length} properties. Running this
        connector will load into it.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => create.mutate()}
        disabled={problems.length > 0 || create.isPending}
        className="rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
      >
        {create.isPending
          ? 'Creating…'
          : discovery.typeExists
            ? `Update ${discovery.targetType}`
            : `Create ${discovery.targetType}`}
      </button>
      <p className={cn('text-[11px]', MUTED)}>
        {discovery.typeExists
          ? 'Adds and retypes properties. Display names, descriptions and classifications somebody wrote are kept.'
          : 'This is the act that creates the type. Nothing has been created up to here.'}
      </p>
      {create.error ? (
        <p className="text-[11px] text-red-600">
          {create.error instanceof Error ? create.error.message : 'Could not create it.'}
        </p>
      ) : null}
    </div>
  );
}

/** One column, with the two decisions a person can make about it. */
function ColumnRow({
  column,
  choice,
  onChange,
}: {
  column: DiscoveredColumn;
  choice: ColumnChoice;
  onChange: (next: Partial<ColumnChoice>) => void;
}) {
  return (
    <>
      <tr className={cn('border-t', RULE)}>
        <td className="py-1 align-top">
          <input
            type="checkbox"
            checked={choice.include}
            aria-label={`Include ${column.name}`}
            onChange={(event) => onChange({ include: event.target.checked })}
          />
        </td>
        <td className="py-1 align-top font-mono">{column.name}</td>
        <td className="py-1 align-top">
          {/* A native select rather than this package's `SelectField`, and the
              reason is the shape of this control rather than a preference:
              `SelectField` exists to give an option a second line of hint text,
              which one-word scalar names have no use for, and it renders a
              portalled popup per instance — thirty of those stacked inside a
              scrolling form is not what that component is for. A native select
              is also the one control here that a keyboard and a screen reader
              already know. */}
          <select
            value={choice.type}
            aria-label={`Type for ${column.name}`}
            onChange={(event) => {
              const next = SCALAR_TYPES.find((scalar) => scalar === event.target.value);
              onChange({ type: next ?? '' });
            }}
            className={cn(
              'rounded-sm border bg-transparent px-1 py-0.5 font-mono text-[11px]',
              RULE,
              choice.type === '' && 'text-amber-600',
            )}
          >
            <option value="">not typed</option>
            {SCALAR_TYPES.map((scalar) => (
              <option key={scalar} value={scalar}>
                {scalar}
              </option>
            ))}
          </select>
          {column.confidence === 'inferred' && (
            <span className={cn('ml-1.5 font-mono text-[10px]', MUTED)}>inferred</span>
          )}
        </td>
        <td className={cn('py-1 align-top font-mono', MUTED)}>
          {/* Three states, not two. "not stated" is what Postgres reports about
              every column, and rendering it as "nullable" would be this screen
              inventing an answer the database never gave. */}
          {column.nullable === null ? 'not stated' : column.nullable ? 'nullable' : 'not null'}
        </td>
        <td className={cn('py-1 align-top font-mono', MUTED)}>{column.sourceType}</td>
      </tr>
      {column.note && (
        <tr>
          <td />
          <td colSpan={4} className="pb-1.5 text-[11px] text-amber-600">
            {column.note}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * What the source says now against what the type says now.
 *
 * The part worth having. A first discovery happens once per source; drift
 * happens for as long as the connector exists, and every one of these is silent
 * today — an added column is dropped by the store, a removed one loads as null,
 * and a retyped one is coerced into whatever the catalog still believes.
 */
function DriftReport({ drift, targetType }: { drift: SchemaDrift | null; targetType: string }) {
  if (!drift) {
    return (
      <p className={cn('text-[11px]', MUTED)}>
        {targetType} does not exist yet, so there is nothing to compare against.
      </p>
    );
  }

  const quiet =
    drift.added.length === 0 && drift.removed.length === 0 && drift.retyped.length === 0;
  if (quiet) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-600">
        <CircleCheck size={11} aria-hidden />
        The source still matches {targetType}.
      </p>
    );
  }

  return (
    <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-400">
        Drift since {targetType} was written down
      </p>
      {drift.added.length > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          New in the source, and dropped by every load until the type has them:{' '}
          <span className="font-mono">{drift.added.join(', ')}</span>
        </p>
      )}
      {drift.removed.length > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          On the type, absent from the source, so they load as null:{' '}
          <span className="font-mono">{drift.removed.join(', ')}</span>
        </p>
      )}
      {drift.retyped.map((change) => (
        <p key={change.property} className="text-[11px] text-amber-700 dark:text-amber-300">
          <span className="font-mono">{change.property}</span> is {change.now} in the source and{' '}
          {change.was} here — every load coerces it, and a value that will not convert becomes null.
        </p>
      ))}
    </div>
  );
}

/**
 * The confirmation, for a console whose host did not wire one.
 *
 * The request is printed rather than the button being greyed out with a
 * shrug. Creating a type is a `PUT` a person can make with a terminal, and a
 * host that deliberately kept type creation out of its console — because the
 * publish route is owned by an application principal, or because schema changes
 * go through review — has a reader here who still needs the body somebody
 * approved on this screen.
 */
function UnwiredConfirmation({ draft }: { draft: DiscoveredTypeDraft }) {
  return (
    <div className="space-y-1">
      <p className={cn('text-[11px]', MUTED)}>
        This console cannot create types — nothing is wired to the publish route. What was confirmed
        above is this request:
      </p>
      <pre
        className={cn(
          'overflow-x-auto rounded-md border p-2 font-mono text-[10px]',
          RULE,
          'bg-zinc-50 dark:bg-zinc-950',
        )}
      >
        {`PUT /publish/${draft.name}/schema\n${JSON.stringify(draft, null, 2)}`}
      </pre>
    </div>
  );
}

function ConnectorForm({
  connector,
  transforms,
  connections,
  schemaDiscovery,
  onClose,
  onSaved,
}: {
  connector?: CatalogConnector;
  transforms: CatalogTransform[];
  connections: CatalogConnection[];
  schemaDiscovery?: SchemaDiscoveryBridge;
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

      {/* Under the target type and above the source, which is where it belongs
          in the story: the person typed a name for a type that may not exist,
          and this is what answers "what would be in it". Only for a connector
          that has been saved — discovery runs the connector's own read, and a
          form nobody has stored has nothing to read from. */}
      {schemaDiscovery && connector?.id && (
        <SchemaDiscoveryPanel connectorId={connector.id} bridge={schemaDiscovery} />
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
