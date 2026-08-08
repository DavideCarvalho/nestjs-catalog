import type {
  CatalogConnection,
  ConnectionCheck,
  ConnectorKind,
} from '@dudousxd/nestjs-catalog/client';
import { CONNECTOR_KINDS, REDACTED_SECRET } from '@dudousxd/nestjs-catalog/client';
import { CircleCheck, CircleX } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { FieldGroup, TextField } from './ui/field';
import { Switch } from './ui/switch';

/**
 * Describing where a *shared address* lives, in one place.
 *
 * The sibling of `source-fields.tsx`, and for the same reason. That module
 * exists because two screens ask "where does this read from" and must ask it the
 * same way; this one exists because two screens now ask "what is this connection"
 * — the Connections console, and the source node's inspector on the canvas,
 * which can create one without leaving the graph. Two forms would mean two
 * answers to "what does an S3 connection need", and the one updated second would
 * quietly be the one that is right.
 *
 * The split between the two modules is the split the model draws. A connection
 * carries the address and the credential and nothing about any particular load;
 * a source carries the query, the prefix, the path — the part that is specific to
 * one read. Five pipelines reading one database used to hold five copies of its
 * URL, and moving the database meant editing five rows nobody could find.
 */

/**
 * Every kind, and what a connection to one is — including the kinds where the
 * answer is "nothing".
 *
 * A total record over {@link CONNECTOR_KINDS} rather than a hand-kept list of
 * the three kinds that happen to be connectable today, and `satisfies` rather
 * than an annotation so the keys stay literal: a sixth kind added to the
 * exported constant fails this build with a missing property, instead of quietly
 * arriving in a dropdown with no fields under it. That is the failure this shape
 * is for — a form that renders nothing looks like a form somebody has not
 * finished typing into.
 *
 * `file`, `inline` and `catalog` are refusals, and deliberately: a file's path
 * and a set of pasted records belong to the load, not to a shared address, and a
 * catalog source has no address at all. A connection there would be a name with
 * nothing behind it, and — since a connection's whole worth is the button that
 * finds out whether it answers — a "Test connection" that always passes is worse
 * than no button, because it teaches people that a green tick means nothing.
 * `ConnectionChecker.probe` says the same thing from the server's side.
 */
const KINDS = {
  http: {
    connectable: true,
    label: 'HTTP — a JSON endpoint',
    Fields: HttpFields,
    configFrom: (draft) => (draft.url ? { url: draft.url } : {}),
    isIncomplete: (draft) => draft.url.trim().length === 0,
  },
  sql: {
    connectable: true,
    label: 'SQL — a database',
    Fields: SqlFields,
    configFrom: (draft) => (draft.url ? { url: draft.url } : {}),
    // Either address will do and neither is more correct: the variable is the
    // right answer in a deployment, the inline URL is the one that gets somebody
    // running locally in a minute.
    isIncomplete: (draft) =>
      draft.url.trim().length === 0 && draft.secretEnvVar.trim().length === 0,
  },
  file: {
    connectable: false,
    because:
      'A file source carries its own path, and a path belongs to the load rather than to an address several loads share.',
  },
  s3: {
    connectable: true,
    label: 'S3 — a bucket, or anything S3-compatible',
    Fields: S3Fields,
    configFrom: (draft) => ({
      bucket: draft.bucket,
      ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
      ...(draft.region ? { region: draft.region } : {}),
      ...(draft.forcePathStyle ? { forcePathStyle: true } : {}),
    }),
    isIncomplete: (draft) => draft.bucket.trim().length === 0,
  },
  inline: {
    connectable: false,
    because: 'Inline records are pasted into the source itself. There is no address to share.',
  },
  catalog: {
    connectable: false,
    because:
      'A catalog source reads this catalog, through the store the application already holds. There is no address and no credential — which is the point of the kind: pointing the catalog at its own database through a connection meant an operator minting a URL and a secret that did not need to exist.',
  },
} satisfies Record<ConnectorKind, ConnectionKindSpec>;

/** A kind a connection can actually address, narrowed from the record above. */
export type ConnectableKind = {
  [Kind in ConnectorKind]: (typeof KINDS)[Kind] extends { connectable: true } ? Kind : never;
}[ConnectorKind];

/** What a connection to one kind is, or why it is not a thing. */
export type ConnectionKindSpec = ConnectableKindSpec | UnconnectableKindSpec;

export interface ConnectableKindSpec {
  connectable: true;
  /** How the kind reads in a picker. */
  label: string;
  /** The address fields this kind asks for, and no others. */
  Fields: (props: { draft: ConnectionDraft; update: UpdateDraft }) => ReactNode;
  /**
   * Only the config fields this kind actually reads.
   *
   * Carrying the rest would leave a stale bucket on an HTTP connection, which
   * reads as configuration somebody meant rather than as a leftover from a
   * dropdown they changed.
   */
  configFrom(draft: ConnectionDraft): Record<string, unknown>;
  /** Whether there is not yet enough here to save. */
  isIncomplete(draft: ConnectionDraft): boolean;
}

export interface UnconnectableKindSpec {
  connectable: false;
  /** Said where the offer would otherwise be, rather than leaving a gap. */
  because: string;
}

export const CONNECTION_KINDS: Record<ConnectorKind, ConnectionKindSpec> = KINDS;

/**
 * The kinds a connection can be, in the order the vocabulary declares them.
 *
 * Derived from the record and never written out, so it cannot fall behind it.
 * A predicate rather than a cast: the value being narrowed is the same string
 * the guard tests, which is the one shape of narrowing that is not a promise.
 */
export const CONNECTABLE_KINDS: readonly ConnectableKind[] = CONNECTOR_KINDS.filter(
  (kind): kind is ConnectableKind => CONNECTION_KINDS[kind].connectable,
);

/** A select hands back a string. Narrow it rather than promise it is a kind. */
export function toConnectableKind(value: string): ConnectableKind {
  return CONNECTABLE_KINDS.find((kind) => kind === value) ?? 'http';
}

/** The kind dropdown, derived so a new connectable kind appears in it by existing. */
export const CONNECTION_KIND_OPTIONS = CONNECTABLE_KINDS.map((kind) => ({
  value: kind,
  label: connectableSpec(kind).label,
}));

/**
 * The spec for a kind that is definitely connectable.
 *
 * The narrowing every caller below would otherwise write inline. It throws
 * rather than returning a fallback, because every call site has already asked
 * {@link CONNECTION_KINDS} whether this kind is connectable — reaching here with
 * one that is not means those two questions disagree, and a silent fallback to
 * HTTP would save an S3 connection as an HTTP one.
 */
export function connectableSpec(kind: ConnectableKind): ConnectableKindSpec {
  const spec = CONNECTION_KINDS[kind];
  if (!spec.connectable) {
    throw new Error(`"${kind}" is in CONNECTABLE_KINDS but its spec says it is not connectable.`);
  }
  return spec;
}

/** Read a string out of a stored config without believing it is one. */
export function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

/** Everything the form edits, before it is split into a name and a config. */
export interface ConnectionDraft {
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
export type UpdateDraft = (patch: Partial<ConnectionDraft>) => void;

/** A blank draft, or one filled from the connection being edited. */
export function connectionDraftFrom(connection?: CatalogConnection): ConnectionDraft {
  const config = connection?.config ?? {};
  return {
    name: connection?.name ?? '',
    description: connection?.description ?? '',
    url: configString(config, 'url'),
    bucket: configString(config, 'bucket'),
    endpoint: configString(config, 'endpoint'),
    region: configString(config, 'region'),
    forcePathStyle: config.forcePathStyle === true,
    secretEnvVar: connection?.secretEnvVar ?? '',
  };
}

/** The stored config for one kind, and nothing else. */
export function connectionConfigFor(
  kind: ConnectableKind,
  draft: ConnectionDraft,
): Record<string, unknown> {
  return connectableSpec(kind).configFrom(draft);
}

/** Whether there is not yet enough here to save. A name, plus whatever the kind needs. */
export function connectionIsIncomplete(kind: ConnectableKind, draft: ConnectionDraft): boolean {
  if (draft.name.trim().length === 0) return true;
  return connectableSpec(kind).isIncomplete(draft);
}

/**
 * The config key holding a URL whose password is the redaction placeholder, if
 * there is one.
 *
 * The one thing a form that offers a paste box owes the redaction. `GET
 * pipeline/connections` answers with the password replaced by
 * {@link REDACTED_SECRET}, and the server puts the real one back when a caller
 * posts the placeholder against a connection it can look up. **A create has no
 * such row**, so the same string arrives with nothing to restore it from and is
 * stored verbatim: a connection whose password is the word "REDACTED", which
 * saves cleanly and fails at the first scheduled load as an authentication
 * error against a password nobody typed.
 *
 * Parsed with WHATWG `URL` rather than matched as a substring, exactly as the
 * server's redaction is, so `postgres:` and `mysql:` yield a real `password`
 * instead of being swept into an opaque path — and so a host genuinely called
 * `redacted.internal` is not accused of anything.
 */
export function redactedCredentialIn(config: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.password === REDACTED_SECRET) return key;
  }
  return undefined;
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
        hint="The base every source reading through this will hang its path off."
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

/**
 * The connection string, and nothing beside it.
 *
 * This was two fields — an inline URL and the name of an environment variable
 * holding one — presented side by side with a paragraph explaining when each
 * applied. Two doors for one decision, and only one of them worked for a
 * database with a password, which is every database anybody connects to. The
 * question it produced was "what is this second field", which is the form
 * asking the reader to understand its implementation.
 *
 * One field now. Whether the URL may REST in the catalog's own table is the
 * store's decision (`allowInlineCredentials`) and not something to ask on a
 * form — and it is a decision about the deployment, not about this connection.
 * The server refuses and says why if the answer is no, which is a better place
 * to learn it than a hint nobody reads until afterwards.
 *
 * `secretEnvVar` still exists on the model and is still what a hardened
 * deployment should use; it is not on this screen. A host that wants it back
 * has the field on the record.
 */
function SqlFields({ draft, update }: { draft: ConnectionDraft; update: UpdateDraft }) {
  return (
    <FieldGroup
      title="Address"
      hint="The connection string, as your database gives it to you. It is served back redacted, so the password never travels in a response — but it does rest in this catalog's own table, and a deployment can refuse that."
    >
      <TextField
        label="Connection URL"
        value={draft.url}
        onChange={(url) => update({ url })}
        placeholder="mysql://user:pass@host:3306/database"
      />
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

/**
 * What a check that just ran found, in the checker's own words.
 *
 * A server version, a bucket and whether anything is under the prefix, an HTTP
 * status. That sentence is the whole product of the button; "OK" would prove
 * only that something is listening on a port.
 *
 * Shared by the console's card and by the inline form on the canvas, and the
 * `error` line is why that matters: the checker redacts the password, the query
 * string and the fragment out of a failure and keeps the host and the user,
 * because which host refused and as whom is the entire value of a failed check.
 * A second renderer would eventually print `detail` alone, and the difference
 * between "reachable but refused" and "unreachable" — which send an operator to
 * completely different places — would be the thing it dropped.
 */
export function ConnectionCheckResult({ result }: { result: ConnectionCheck }) {
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

/** The address fields for whichever kind is selected, and only those. */
export function ConnectionKindFields({
  kind,
  draft,
  update,
}: {
  kind: ConnectableKind;
  draft: ConnectionDraft;
  update: UpdateDraft;
}) {
  const { Fields } = connectableSpec(kind);
  return <Fields draft={draft} update={update} />;
}
