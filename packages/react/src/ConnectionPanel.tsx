import type {
  CatalogConnection,
  CatalogConnector,
  ConnectionCheck,
  ConnectorKind,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleX,
  KeyRound,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Trash2,
  Waypoints,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { cn } from './cn';
import { type ConnectionInput, catalogQueryKeys, useCatalogClient } from './context';
import { ConfirmDialog } from './ui/dialog';
import { FieldGroup, TextField } from './ui/field';
import { SelectField } from './ui/select';
import { Switch } from './ui/switch';
import { Tooltip } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * The kinds worth naming once and reusing.
 *
 * Deliberately three of the five a connector can be, and the two that are
 * missing are missing for the same reason the checker refuses to probe them: a
 * file's path and a set of pasted records belong to the load, not to a shared
 * address. A connection there would be a name with no address behind it, and a
 * "Test connection" that always passes is worse than no button — it teaches
 * people that a green tick means nothing.
 */
const CONNECTABLE_KINDS = ['http', 'sql', 's3'] as const;

type ConnectableKind = (typeof CONNECTABLE_KINDS)[number];

/** A select hands back a string. Narrow it rather than promise it is a kind. */
function toConnectableKind(value: string): ConnectableKind {
  return CONNECTABLE_KINDS.find((kind) => kind === value) ?? 'http';
}

const KIND_OPTIONS = [
  { value: 'http', label: 'HTTP — a JSON endpoint' },
  { value: 'sql', label: 'SQL — a database' },
  { value: 's3', label: 'S3 — a bucket, or anything S3-compatible' },
];

/** Read a string out of a stored config without believing it is one. */
function text(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

/**
 * One line saying what a connection actually points at.
 *
 * Per kind rather than reading `config.url` for everything, because an S3
 * connection has no url and would render a blank subtitle — a card saying a
 * connection exists and nothing about where it goes, which is the one thing the
 * list is for.
 */
export function describeConnection(connection: CatalogConnection): string {
  const config = connection.config ?? {};
  if (connection.kind === 's3') {
    const bucket = text(config, 'bucket') || '(no bucket)';
    const endpoint = text(config, 'endpoint');
    const region = text(config, 'region');
    return `s3://${bucket}${endpoint ? ` · ${endpoint}` : ''}${region ? ` · ${region}` : ''}`;
  }
  if (connection.kind === 'sql') {
    const url = text(config, 'url');
    // The credential path is the normal one for a database, and it has no URL
    // to show — saying which variable holds it is the honest substitute.
    if (url) return url;
    return connection.secretEnvVar ? `URL from $${connection.secretEnvVar}` : 'no URL configured';
  }
  return text(config, 'url') || 'no URL configured';
}

export interface ConnectionPanelProps {
  /**
   * Hidden when the caller knows the viewer cannot write. The endpoints refuse
   * anyway; this only stops a console offering a button that always 403s.
   */
  canEdit?: boolean;
}

/**
 * Named, reusable sources — and a button that finds out whether they answer.
 *
 * The reason this screen is worth having at all is the test. Before it, the
 * only way to learn that a host was wrong, a credential missing or a bucket
 * spelled differently was to run a load and read the failure — which happens on
 * a schedule, hours after somebody typed it, and is attributed to a connector
 * rather than to the address it borrowed.
 */
export function ConnectionPanel({ canEdit = true }: ConnectionPanelProps) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CatalogConnection | 'new' | null>(null);

  const {
    data: connections = [],
    isPending,
    isError,
  } = useQuery({
    queryKey: catalogQueryKeys.connections,
    queryFn: () => client.listConnections(),
  });

  // One request for every card's "used by", rather than one per card. The
  // connectors list is loaded by the sibling tab anyway, so this is usually a
  // cache hit, and a per-card fetch would put N requests behind a screen whose
  // whole job is to be quick to glance at.
  const { data: connectors = [] } = useQuery({
    queryKey: catalogQueryKeys.connectors,
    queryFn: () => client.listConnectors(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connections });
    queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connectors });
  };

  if (editing) {
    return (
      <ConnectionForm
        connection={editing === 'new' ? undefined : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidate();
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
          New connection
        </button>
      )}

      {isPending && (
        <p
          className={cn(
            'rounded-lg border border-dashed px-4 py-12 text-center text-sm',
            RULE,
            MUTED,
          )}
        >
          Reading connections…
        </p>
      )}

      {/* Said out loud rather than rendered as an empty list. A failed read that
          looks like "you have no connections" is the worst thing this screen
          could do: the next thing somebody does is create a second copy of one
          that already exists. */}
      {isError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-8 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          Could not read the connections. This is not the same as having none — nothing here is safe
          to act on until it loads.
        </p>
      )}

      {!isPending && !isError && connections.length === 0 && (
        <p
          className={cn(
            'rounded-lg border border-dashed px-4 py-12 text-center text-sm',
            RULE,
            MUTED,
          )}
        >
          No connections yet. A connector can still carry its own address — a connection is worth
          making when more than one of them shares it.
        </p>
      )}

      {connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          users={connectors.filter((c) => c.connectionId === connection.id)}
          canEdit={canEdit}
          onEdit={() => setEditing(connection)}
          onChanged={invalidate}
        />
      ))}
    </div>
  );
}

/**
 * Who this connection is: name, kind, who reads through it, what it addresses.
 *
 * The credential line names the variable and never its value — that is the
 * property worth showing, so it is shown rather than described in a doc.
 */
function ConnectionIdentity({
  connection,
  users,
}: {
  connection: CatalogConnection;
  users: CatalogConnector[];
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Plug size={13} className={MUTED} />
        <span className="text-sm font-medium">{connection.name}</span>
        <span className="rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase dark:bg-zinc-800">
          {connection.kind}
        </span>
        {users.length > 0 && (
          <Tooltip
            content={`Read through by ${users.map((c) => c.name).join(', ')}. Moving this address moves all of them at once, which is the point.`}
          >
            <span
              className={cn('flex cursor-help items-center gap-1 font-mono text-[10px]', MUTED)}
            >
              <Waypoints size={10} />
              {users.length}
            </span>
          </Tooltip>
        )}
      </div>
      <div className={cn('mt-1 font-mono text-[11px]', MUTED)}>
        {describeConnection(connection)}
      </div>
      {connection.description && (
        <p className={cn('mt-1 text-[11px]', MUTED)}>{connection.description}</p>
      )}
      {connection.secretEnvVar && (
        <Tooltip content="The catalog stores the NAME of this variable, never its value. A leaked catalog database gives away the shape of the integration, not the keys to it.">
          <div
            className={cn(
              'mt-1 flex w-fit cursor-help items-center gap-1 font-mono text-[10px]',
              MUTED,
            )}
          >
            <KeyRound size={10} />
            {connection.secretEnvVar}
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * What the last check found, from the stored fields.
 *
 * Recorded rather than probed on every page load, because a list that reaches
 * every system it names on render turns opening a tab into a burst of outbound
 * connections.
 */
function StoredCheckSummary({ connection }: { connection: CatalogConnection }) {
  if (!connection.lastCheckedAt) return null;
  return (
    <div className={cn('mt-3 flex items-center gap-2 border-t pt-3 text-[11px]', RULE)}>
      {connection.lastCheckOk ? (
        <CircleCheck size={12} aria-hidden className="text-emerald-600" />
      ) : (
        <CircleX size={12} aria-hidden className="text-red-600" />
      )}
      <span className="sr-only">{connection.lastCheckOk ? 'Reachable: ' : 'Unreachable: '}</span>
      <span className={MUTED}>
        {connection.lastCheckOk ? 'Reached' : (connection.lastCheckError ?? 'Could not reach it')}
      </span>
      <span className={cn('ml-auto font-mono text-[10px]', MUTED)}>
        {new Date(connection.lastCheckedAt).toLocaleString()}
      </span>
    </div>
  );
}

/**
 * What a check that just ran found, in the checker's own words.
 *
 * A server version, a bucket and whether anything is under the prefix, an HTTP
 * status. That sentence is the whole product of the button; "OK" would prove
 * only that something is listening on a port.
 */
function LiveCheckResult({ result }: { result: ConnectionCheck }) {
  return (
    <div
      className={cn(
        'mt-3 rounded-md border px-3 py-2 text-[11px]',
        result.ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
      )}
    >
      <div className="flex items-start gap-2">
        {result.ok ? (
          <CircleCheck size={13} aria-hidden className="mt-px shrink-0" />
        ) : (
          <CircleX size={13} aria-hidden className="mt-px shrink-0" />
        )}
        <div className="min-w-0">
          <div className="font-medium">{result.ok ? 'Reached it.' : 'Could not reach it.'}</div>
          <div className="mt-0.5 font-mono leading-relaxed">{result.detail}</div>
          {/*
           * The error beside the detail, not instead of it. "Reachable but
           * refused" and "unreachable" send an operator to completely
           * different places, and only the raw message distinguishes them.
           */}
          {result.error && (
            <div className="mt-1 font-mono leading-relaxed opacity-80">{result.error}</div>
          )}
          <div className="mt-1 font-mono text-[10px] opacity-70">{result.elapsedMs} ms</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Why a delete would be refused, said before it is attempted.
 *
 * `blockedBy` is the server's own answer to "who still reads through this",
 * asked after it refused; it outranks `remove.error`, which is only the generic
 * failure that came with it.
 */
function deleteRefusalMessage(blockedBy: CatalogConnector[] | null, error: unknown): ReactNode {
  if (blockedBy && blockedBy.length > 0) {
    return (
      <>
        Refused: still read through by {blockedBy.map((c) => c.name).join(', ')}. Point{' '}
        {blockedBy.length === 1 ? 'it' : 'them'} elsewhere first.
      </>
    );
  }
  if (error && !blockedBy) {
    return error instanceof Error ? error.message : 'Could not delete it.';
  }
  return undefined;
}

/**
 * The buttons on a card: test it, and — with write access — edit or delete it.
 *
 * The delete tooltip says up front that a connection with readers will be
 * refused, so the refusal is not the first time somebody hears about it.
 */
function ConnectionCardActions({
  connection,
  users,
  canEdit,
  testing,
  onTest,
  onEdit,
  onAskDelete,
}: {
  connection: CatalogConnection;
  users: CatalogConnector[];
  canEdit: boolean;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onAskDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={onTest}
        disabled={testing}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40',
          RULE,
          'hover:bg-zinc-50 dark:hover:bg-zinc-800',
        )}
      >
        {testing ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
        {testing ? 'Reaching…' : 'Test connection'}
      </button>
      {canEdit && (
        <>
          <Tooltip content={`Edit ${connection.name}`}>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${connection.name}`}
              className={cn('rounded-sm p-1.5 hover:text-sky-600', MUTED)}
            >
              <Pencil size={12} />
            </button>
          </Tooltip>
          <Tooltip
            content={
              users.length > 0
                ? `${users.length} connector${users.length === 1 ? '' : 's'} read through this. Deleting it is refused while that is true.`
                : `Delete ${connection.name}`
            }
          >
            <button
              type="button"
              onClick={onAskDelete}
              aria-label={`Delete ${connection.name}`}
              className={cn('rounded-sm p-1.5 hover:text-red-600', MUTED)}
            >
              <Trash2 size={12} />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}

/** What deleting would actually cost, named readers and all, before it is tried. */
function deleteConsequence(users: CatalogConnector[]): ReactNode {
  if (users.length === 0) {
    return 'Nothing reads through it. The connectors that used to are unaffected; only this address and the name of its credential variable go.';
  }
  return (
    <>
      {users.length} connector{users.length === 1 ? '' : 's'} read through this connection —{' '}
      {users.map((c) => c.name).join(', ')}. Deleting it would leave{' '}
      {users.length === 1 ? 'it' : 'them'} without an address, and that is discovered on the next
      scheduled run rather than now. The server refuses while this is true.
    </>
  );
}

function ConnectionCard({
  connection,
  users,
  canEdit,
  onEdit,
  onChanged,
}: {
  connection: CatalogConnection;
  users: CatalogConnector[];
  canEdit: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const client = useCatalogClient();
  const [confirming, setConfirming] = useState(false);
  /** Filled only when the server refuses a delete, with its own answer. */
  const [blockedBy, setBlockedBy] = useState<CatalogConnector[] | null>(null);

  const check = useMutation({
    mutationFn: () => client.checkConnection(connection.id),
    // The server records the outcome as well as returning it, so the stored
    // lastChecked fields on the card are stale the moment this resolves.
    onSuccess: onChanged,
  });

  const remove = useMutation({
    mutationFn: async () => {
      const result = await client.deleteConnection(connection.id);
      if (!result.deleted) {
        // The store refuses while connectors still read through it. Asking who
        // they are is the difference between "it would not delete" and a
        // sentence somebody can act on — and it is the server's answer, not the
        // list this page happened to load a minute ago.
        setBlockedBy(await client.connectionConnectors(connection.id));
        throw new Error('Still in use.');
      }
      return result;
    },
    onSuccess: () => {
      setConfirming(false);
      onChanged();
    },
  });

  const result = check.data;

  return (
    <div className={cn('rounded-lg border p-4', RULE, PANEL)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ConnectionIdentity connection={connection} users={users} />

        <ConnectionCardActions
          connection={connection}
          users={users}
          canEdit={canEdit}
          testing={check.isPending}
          onTest={() => check.mutate()}
          onEdit={onEdit}
          onAskDelete={() => {
            setBlockedBy(null);
            remove.reset();
            setConfirming(true);
          }}
        />
      </div>

      {/* The stored outcome only while this session has not run its own check. */}
      {!result && <StoredCheckSummary connection={connection} />}

      {result && <LiveCheckResult result={result} />}

      {check.error && !result && (
        <p className="mt-3 text-[11px] text-red-600">
          {check.error instanceof Error ? check.error.message : 'The check itself failed.'}
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setBlockedBy(null);
        }}
        title={`Delete ${connection.name}?`}
        description={deleteConsequence(users)}
        confirmLabel={remove.isPending ? 'Deleting…' : 'Delete'}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        error={deleteRefusalMessage(blockedBy, remove.error)}
      />
    </div>
  );
}

/** Everything the form edits, before it is split into a name and a config. */
interface ConnectionDraft {
  name: string;
  description: string;
  url: string;
  bucket: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  secretEnvVar: string;
}

/** A patch onto the draft, so each field can name only what it changes. */
type UpdateDraft = (patch: Partial<ConnectionDraft>) => void;

/**
 * Only the config fields the chosen kind actually reads.
 *
 * Carrying the rest would leave a stale bucket on an HTTP connection, which
 * reads as configuration somebody meant rather than as a leftover from a
 * dropdown they changed.
 */
function connectionConfigFor(
  kind: ConnectableKind,
  draft: ConnectionDraft,
): Record<string, unknown> {
  if (kind === 's3') {
    return {
      bucket: draft.bucket,
      ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
      ...(draft.region ? { region: draft.region } : {}),
      ...(draft.forcePathStyle ? { forcePathStyle: true } : {}),
    };
  }
  return draft.url ? { url: draft.url } : {};
}

/**
 * Whether there is not yet enough here to save.
 *
 * A SQL connection needs one of its two addresses and neither is more correct:
 * the variable is the right answer in a deployment, the inline URL is the one
 * that gets somebody running locally in a minute.
 */
function connectionIsIncomplete(kind: ConnectableKind, draft: ConnectionDraft): boolean {
  if (draft.name.trim().length === 0) return true;
  if (kind === 's3') return draft.bucket.trim().length === 0;
  if (kind === 'http') return draft.url.trim().length === 0;
  return draft.url.trim().length === 0 && draft.secretEnvVar.trim().length === 0;
}

/** A base URL, and the token sent against it. */
function HttpFields({ draft, update }: { draft: ConnectionDraft; update: UpdateDraft }) {
  return (
    <>
      <TextField
        label="URL"
        value={draft.url}
        onChange={(url) => update({ url })}
        placeholder="https://api.example.mil/v1"
        hint="The base the connectors reading through this will hang their paths off."
      />
      <TextField
        label="Credential env var"
        value={draft.secretEnvVar}
        onChange={(secretEnvVar) => update({ secretEnvVar })}
        placeholder="Optional — sent as a bearer token"
      />
    </>
  );
}

/** Either an inline URL or the variable holding one. */
function SqlFields({ draft, update }: { draft: ConnectionDraft; update: UpdateDraft }) {
  return (
    <FieldGroup
      title="Address"
      hint="Name the variable holding the connection URL — that is the whole credential for most databases, so the catalog stores its name and never its value. The inline URL is here for local work."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="URL (optional)"
          value={draft.url}
          onChange={(url) => update({ url })}
          placeholder="mysql://user:pass@host/db"
        />
        <TextField
          label="Env var holding the URL"
          value={draft.secretEnvVar}
          onChange={(secretEnvVar) => update({ secretEnvVar })}
          placeholder="FLEET_DATABASE_URL"
        />
      </div>
    </FieldGroup>
  );
}

/** A bucket, plus everything needed to address a non-AWS one. */
function S3Fields({ draft, update }: { draft: ConnectionDraft; update: UpdateDraft }) {
  return (
    <FieldGroup title="Bucket">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Bucket"
          value={draft.bucket}
          onChange={(bucket) => update({ bucket })}
          placeholder="fleet-drops"
        />
        <TextField
          label="Region"
          value={draft.region}
          onChange={(region) => update({ region })}
          placeholder="Blank uses the environment's"
        />
        <TextField
          label="Endpoint"
          value={draft.endpoint}
          onChange={(endpoint) => update({ endpoint })}
          placeholder="MinIO, e.g. http://localhost:9000"
        />
        <TextField
          label="Env var holding accessKeyId:secretAccessKey"
          value={draft.secretEnvVar}
          onChange={(secretEnvVar) => update({ secretEnvVar })}
          placeholder="Optional"
          hint="Leave blank anywhere the pod has its own role — those credentials rotate, and a static pair named here would not."
        />
      </div>
      <Switch
        checked={draft.forcePathStyle}
        onCheckedChange={(forcePathStyle) => update({ forcePathStyle })}
        label="Path-style addressing"
        hint="MinIO needs it; AWS does not."
      />
    </FieldGroup>
  );
}

/** The address fields for whichever kind is selected, and only those. */
function ConnectionKindFields({
  kind,
  draft,
  update,
}: {
  kind: ConnectableKind;
  draft: ConnectionDraft;
  update: UpdateDraft;
}) {
  if (kind === 'http') return <HttpFields draft={draft} update={update} />;
  if (kind === 'sql') return <SqlFields draft={draft} update={update} />;
  return <S3Fields draft={draft} update={update} />;
}

/**
 * Create or edit one.
 *
 * The form carries the address and the credential variable and nothing about
 * any particular load — no query, no prefix, no path. That split is the whole
 * point of the concept: five connectors reading one database used to hold five
 * copies of its URL, and moving the database meant editing five rows nobody
 * could find.
 */
function ConnectionForm({
  connection,
  onClose,
  onSaved,
}: {
  connection?: CatalogConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useCatalogClient();
  const config = connection?.config ?? {};

  const [kind, setKind] = useState<ConnectableKind>(toConnectableKind(connection?.kind ?? 'http'));
  const [draft, setDraft] = useState<ConnectionDraft>({
    name: connection?.name ?? '',
    description: connection?.description ?? '',
    url: text(config, 'url'),
    bucket: text(config, 'bucket'),
    endpoint: text(config, 'endpoint'),
    region: text(config, 'region'),
    forcePathStyle: config.forcePathStyle === true,
    secretEnvVar: connection?.secretEnvVar ?? '',
  });
  const update: UpdateDraft = (patch) => setDraft({ ...draft, ...patch });

  const save = useMutation({
    mutationFn: () => {
      const input: ConnectionInput = {
        id: connection?.id,
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        kind,
        config: connectionConfigFor(kind, draft),
        secretEnvVar: draft.secretEnvVar.trim() || undefined,
      };
      return client.saveConnection(input);
    },
    onSuccess: onSaved,
  });

  const incomplete = connectionIsIncomplete(kind, draft);

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
          onChange={(name) => update({ name })}
          placeholder="Fleet warehouse"
        />
        <TextField
          label="Description"
          value={draft.description}
          onChange={(description) => update({ description })}
          placeholder="What lives behind it (optional)"
        />
        <SelectField
          label="Kind"
          ariaLabel="Connection kind"
          value={kind}
          onValueChange={(value) => setKind(toConnectableKind(value))}
          options={KIND_OPTIONS}
        />
      </div>

      <ConnectionKindFields kind={kind} draft={draft} update={update} />

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={save.isPending || incomplete}
          className="rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
        >
          {save.isPending ? 'Saving…' : connection ? 'Save changes' : 'Save connection'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={cn('rounded-md px-3 py-1.5 text-xs', MUTED)}
        >
          Cancel
        </button>
        {/* Said here rather than promised by the save: nothing about writing a
            row proves the address behind it answers, and the button that finds
            out is on the card this returns to. */}
        <span className={cn('text-[11px]', MUTED)}>
          Saving does not reach it. Test the connection from its card.
        </span>
      </div>

      {save.error && (
        <p className="text-[11px] text-red-600">
          {save.error instanceof Error ? save.error.message : 'Could not save.'}
        </p>
      )}
    </form>
  );
}

/**
 * The options a connector form offers for "read through".
 *
 * Exported because the connector form lives in another file and this list has
 * one rule that must not be duplicated: only connections of the same kind. A
 * connector reading S3 through a database connection is not a configuration
 * anybody meant, and it would fail at run time with an error about a missing
 * bucket rather than about the mistake.
 */
export function connectionOptionsFor(kind: ConnectorKind, connections: CatalogConnection[]) {
  return connections
    .filter((connection) => connection.kind === kind)
    .map((connection) => ({
      value: connection.id,
      label: connection.name,
      hint: describeConnection(connection),
    }));
}
