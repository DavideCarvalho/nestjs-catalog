import type { ConnectorKind, SourceFormat } from '@dudousxd/nestjs-catalog/client';
import { CONNECTOR_KINDS, SOURCE_FORMATS } from '@dudousxd/nestjs-catalog/client';
import { cn } from './cn';
import { CONNECTION_KINDS, type ConnectableKind } from './connection-form';
import { FieldGroup, TextAreaField, TextField } from './ui/field';
import { SelectField } from './ui/select';
import { Switch } from './ui/switch';

/**
 * Describing where records are read from, in one place.
 *
 * There are two screens that ask this question and they must ask it the same
 * way. A connector reads from a system; a workflow's **source node** reads from
 * a system. They are the same half of the same idea — the executable model says
 * so, giving a source node the same vocabulary a connector has: a kind, an
 * optional named connection, a config, and the *name* of an environment
 * variable holding the credential. Two forms would mean two answers to "what
 * does an S3 source need", and the one that was updated second would quietly be
 * the one that is right.
 *
 * A source node deliberately does **not** point at a connector. A connector
 * references a workflow, so a source referencing a connector would be circular —
 * and it would give one load two authorities on where its data comes from.
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';

/** A select hands back a string. Narrow it rather than promise it is a kind. */
export function toConnectorKind(value: string): ConnectorKind {
  return CONNECTOR_KINDS.find((kind) => kind === value) ?? 'http';
}

/** The sources that can be asked what changed. The rest always read it all. */
export function readsIncrementally(kind: ConnectorKind): boolean {
  return kind === 'sql' || kind === 's3';
}

/**
 * Which kinds can borrow an address from a named connection.
 *
 * Asked of `connection-form.tsx` rather than answered here with a list of
 * three, because that module now has to answer the same question to decide
 * whether it can offer to CREATE one — and two lists is how a picker comes to be
 * offered for a kind whose form has no fields, or withheld for one that does.
 *
 * A type predicate, and that is what it is for: the source inspector renders the
 * picker behind this call, and the creator beside it takes a {@link
 * ConnectableKind}. Narrowing here is what makes those two the same decision
 * rather than two that happen to agree today.
 */
export function usesConnection(kind: ConnectorKind): kind is ConnectableKind {
  return CONNECTION_KINDS[kind].connectable;
}

export const KIND_OPTIONS = [
  { value: 'http', label: 'HTTP — a JSON endpoint' },
  { value: 'sql', label: 'SQL — a database query' },
  { value: 'file', label: 'File — CSV, NDJSON, JSON or Excel' },
  { value: 's3', label: 'S3 — a bucket prefix' },
  { value: 'inline', label: 'Inline — records pasted below' },
];

/**
 * How each format is labelled, and the reason this is a map rather than a list.
 *
 * `satisfies Record<SourceFormat, string>` is the whole point: a format added to
 * the library's list leaves this object missing a property and the build stops
 * here, rather than the console quietly offering three of four formats. It is
 * the same argument {@link toConnectorKind} makes about kinds — the parser and
 * the picker are meant to move together.
 */
const FORMAT_LABELS = {
  csv: 'CSV',
  ndjson: 'NDJSON',
  json: 'JSON',
  xlsx: 'Excel workbook (.xlsx)',
} satisfies Record<SourceFormat, string>;

/**
 * The formats, with the leading "work it out" option.
 *
 * Derived from `SOURCE_FORMATS` rather than written out beside it, so the order
 * and the membership are the library's and not a copy of them.
 */
export const FORMAT_OPTIONS = [
  { value: '', label: 'Format from the extension' },
  ...SOURCE_FORMATS.map((format) => ({ value: format, label: FORMAT_LABELS[format] })),
];

/**
 * The same options for a bucket, whose blank option reads differently because
 * an S3 connector guesses per key rather than once.
 *
 * A function over the named formats rather than `FORMAT_OPTIONS.slice(1)`, which
 * is what this replaced: the slice encoded "the first entry is the blank one" as
 * a number, and a format inserted at the front of the list would have dropped
 * itself from this picker and nothing else.
 */
export const KEY_FORMAT_OPTIONS = [
  { value: '', label: 'Format from each key' },
  ...SOURCE_FORMATS.map((format) => ({ value: format, label: FORMAT_LABELS[format] })),
];

/** The value the connection picker uses for "do not use one". */
export const INLINE_CONNECTION = '';

/**
 * The config, as text fields.
 *
 * Every value is a string even where the stored config holds a number or a
 * boolean, because a half-typed number is not a number and a form that coerces
 * while somebody is still typing eats the keystroke. Conversion happens once,
 * in {@link sourceConfigFrom}.
 */
export interface SourceDraft {
  url: string;
  path: string;
  query: string;
  format: string;
  records: string;
  bucket: string;
  prefix: string;
  suffix: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  maxObjectsPerRun: string;
  watermarkColumn: string;
}

export function sourceDraftFrom(config: Record<string, unknown> | undefined): SourceDraft {
  const source = config ?? {};
  const text = (key: string): string => {
    const value = source[key];
    return typeof value === 'string' ? value : '';
  };
  const records = source.records;
  return {
    url: text('url'),
    path: text('path'),
    query: text('query'),
    format: text('format'),
    records: Array.isArray(records) && records.length > 0 ? JSON.stringify(records, null, 2) : '',
    bucket: text('bucket'),
    prefix: text('prefix'),
    suffix: text('suffix'),
    endpoint: text('endpoint'),
    region: text('region'),
    forcePathStyle: source.forcePathStyle === true,
    maxObjectsPerRun:
      typeof source.maxObjectsPerRun === 'number' ? String(source.maxObjectsPerRun) : '',
    watermarkColumn: text('watermarkColumn'),
  };
}

/**
 * Pasted records, parsed without throwing.
 *
 * A result rather than an exception because one caller parses on save and the
 * other parses on every keystroke, and a half-typed array is the normal state of
 * this field rather than an error worth unwinding for.
 */
export type RecordsParse = { ok: true; records: unknown[] } | { ok: false; message: string };

export function parseRecords(text: string): RecordsParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, records: [] };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        message:
          'Inline records have to be a JSON array. A single object is one record, so wrap it in [ ].',
      };
    }
    return { ok: true, records: parsed };
  } catch (error) {
    return {
      ok: false,
      message: `That is not valid JSON: ${error instanceof Error ? error.message : 'it could not be parsed'}.`,
    };
  }
}

export interface SourceConfigOptions {
  /** True when a named connection supplies the address and the credential. */
  viaConnection: boolean;
  /** True only when the kind can read incrementally *and* is set to. */
  incremental: boolean;
}

/** The url unless a connection supplies it, plus the sub-path off it if there is one. */
function httpConfig(draft: SourceDraft, viaConnection: boolean): Record<string, unknown> {
  return {
    ...(viaConnection ? {} : { url: draft.url }),
    ...(draft.path ? { path: draft.path } : {}),
  };
}

/** The query, the url unless a connection supplies it, and the watermark if it is in play. */
function sqlConfig(
  draft: SourceDraft,
  viaConnection: boolean,
  incremental: boolean,
): Record<string, unknown> {
  return {
    query: draft.query,
    ...(viaConnection || !draft.url ? {} : { url: draft.url }),
    // Only when it will be used. A watermark column left on a source somebody
    // switched back to full reads as a bound that is being applied, and it is
    // not.
    ...(incremental && draft.watermarkColumn ? { watermarkColumn: draft.watermarkColumn } : {}),
  };
}

/** A path on disk — `url` doubles as the path here — and the format if it was picked. */
function fileConfig(draft: SourceDraft): Record<string, unknown> {
  return {
    path: draft.path || draft.url,
    ...(draft.format ? { format: draft.format } : {}),
  };
}

/** Bucket and addressing, which a connection can supply, then the per-load narrowing. */
function s3Config(draft: SourceDraft, viaConnection: boolean): Record<string, unknown> {
  return {
    ...(viaConnection
      ? {}
      : {
          bucket: draft.bucket,
          ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
          ...(draft.region ? { region: draft.region } : {}),
          ...(draft.forcePathStyle ? { forcePathStyle: true } : {}),
        }),
    ...(draft.prefix ? { prefix: draft.prefix } : {}),
    ...(draft.suffix ? { suffix: draft.suffix } : {}),
    ...(draft.format ? { format: draft.format } : {}),
    ...(draft.maxObjectsPerRun ? { maxObjectsPerRun: Number(draft.maxObjectsPerRun) } : {}),
  };
}

/**
 * The pasted records, or none when the text will not parse.
 *
 * Unparseable text keeps the previous records rather than wiping them: the
 * caller shows the message from `parseRecords` and refuses to save.
 */
function inlineConfig(draft: SourceDraft): Record<string, unknown> {
  const parsed = parseRecords(draft.records);
  return { records: parsed.ok ? parsed.records : [] };
}

/**
 * The stored config for one kind, and nothing else.
 *
 * Only the fields this kind actually reads, and — when a connection supplies the
 * address — only the ones specific to this load. Sending the rest would leave a
 * stale url on a SQL source, which reads as configuration somebody meant.
 */
export function sourceConfigFrom(
  kind: ConnectorKind,
  draft: SourceDraft,
  { viaConnection, incremental }: SourceConfigOptions,
): Record<string, unknown> {
  if (kind === 'http') return httpConfig(draft, viaConnection);
  if (kind === 'sql') return sqlConfig(draft, viaConnection, incremental);
  if (kind === 'file') return fileConfig(draft);
  if (kind === 's3') return s3Config(draft, viaConnection);
  return inlineConfig(draft);
}

/*
 * `sourceIsIncomplete` and `connectionOptions` used to be here, and both went
 * with the connector form that was their only caller.
 *
 * `sourceIsIncomplete` decided whether that form's Save button was pressable.
 * A source node has no such gate and should not grow one: an unconfigured node
 * is the normal state of a node somebody just added, `workflow/validate.ts`
 * separates INCOMPLETE from WRONG for exactly that reason, and a second opinion
 * held in this module would fire while the first is deliberately quiet.
 *
 * `connectionOptions` was the same filter as `connectionOptionsFor` in
 * `ConnectionPanel.tsx` without the address hint. Two spellings of "connections
 * of this kind" is how a rule ends up enforced on one screen; the one that is
 * left is the one that can say which address it is offering.
 */

/**
 * The address fields for one kind.
 *
 * Rendered by both the connector form and the workflow source inspector, which
 * is the entire point of this module: the two screens configure the same thing
 * and there is exactly one description of what that thing needs.
 */
export function SourceFields({
  kind,
  draft,
  onChange,
  viaConnection,
  disabled,
}: {
  kind: ConnectorKind;
  draft: SourceDraft;
  onChange: (draft: SourceDraft) => void;
  viaConnection: boolean;
  disabled?: boolean;
}) {
  const set = (patch: Partial<SourceDraft>) => onChange({ ...draft, ...patch });

  if (kind === 'http') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {!viaConnection && (
          <TextField
            label="URL"
            value={draft.url}
            onChange={(url) => set({ url })}
            placeholder="https://…"
            disabled={disabled}
          />
        )}
        <TextField
          label="Path to the array"
          value={draft.path}
          onChange={(path) => set({ path })}
          placeholder="e.g. data"
          disabled={disabled}
        />
      </div>
    );
  }

  if (kind === 'sql') {
    return (
      <div className="space-y-3">
        <TextAreaField
          label="Query"
          value={draft.query}
          onChange={(query) => set({ query })}
          placeholder="SELECT … FROM …"
          mono
          disabled={disabled}
          hint="Runs inside a read-only transaction, so the database refuses a write whatever the statement parses as."
        />
        {!viaConnection && (
          <TextField
            label="URL (optional)"
            value={draft.url}
            onChange={(url) => set({ url })}
            placeholder="Prefer naming the environment variable below"
            disabled={disabled}
          />
        )}
      </div>
    );
  }

  if (kind === 'file') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="File path or URL"
          value={draft.path}
          onChange={(path) => set({ path })}
          placeholder="/data/drop.csv or https://…"
          disabled={disabled}
        />
        <SelectField
          label="Format"
          ariaLabel="Format"
          value={draft.format}
          onValueChange={(format) => set({ format })}
          options={FORMAT_OPTIONS}
          disabled={disabled}
        />
      </div>
    );
  }

  if (kind === 's3') {
    return (
      <div className="space-y-3">
        {!viaConnection && (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Bucket"
              value={draft.bucket}
              onChange={(bucket) => set({ bucket })}
              placeholder="fleet-drops"
              disabled={disabled}
            />
            <TextField
              label="Region"
              value={draft.region}
              onChange={(region) => set({ region })}
              placeholder="Blank uses the environment's"
              disabled={disabled}
            />
            <TextField
              label="Endpoint"
              value={draft.endpoint}
              onChange={(endpoint) => set({ endpoint })}
              placeholder="MinIO, e.g. http://localhost:9000"
              disabled={disabled}
            />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Prefix"
            value={draft.prefix}
            onChange={(prefix) => set({ prefix })}
            placeholder="drops/mvr/"
            disabled={disabled}
          />
          <TextField
            label="Only keys ending in"
            value={draft.suffix}
            onChange={(suffix) => set({ suffix })}
            placeholder=".csv"
            disabled={disabled}
          />
          <TextField
            label="Max objects per run"
            value={draft.maxObjectsPerRun}
            onChange={(maxObjectsPerRun) => set({ maxObjectsPerRun })}
            inputMode="numeric"
            disabled={disabled}
          />
        </div>
        <SelectField
          label="Format"
          ariaLabel="Format"
          value={draft.format}
          onValueChange={(format) => set({ format })}
          options={KEY_FORMAT_OPTIONS}
          disabled={disabled}
        />
        {!viaConnection && (
          <Switch
            checked={draft.forcePathStyle}
            onCheckedChange={(forcePathStyle) => set({ forcePathStyle })}
            label="Path-style addressing"
            hint="MinIO needs it; AWS does not."
          />
        )}
      </div>
    );
  }

  const parsed = parseRecords(draft.records);
  return (
    <TextAreaField
      label="Records"
      value={draft.records}
      onChange={(records) => set({ records })}
      placeholder='[{ "tag": "AF93E00073" }]'
      mono
      rows={5}
      disabled={disabled}
      hint={
        parsed.ok ? undefined : (
          <span className="text-red-600 dark:text-red-400">{parsed.message}</span>
        )
      }
    />
  );
}

/** Full or incremental, with the per-kind explanation of what that means. */
export function ReadModeFields({
  kind,
  mode,
  onModeChange,
  draft,
  onChange,
  disabled,
}: {
  kind: ConnectorKind;
  mode: 'full' | 'incremental';
  onModeChange: (mode: 'full' | 'incremental') => void;
  draft: SourceDraft;
  onChange: (draft: SourceDraft) => void;
  disabled?: boolean;
}) {
  if (!readsIncrementally(kind)) return null;
  return (
    <FieldGroup title="Read mode">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Mode"
          ariaLabel="Read mode"
          value={mode}
          onValueChange={(value) => onModeChange(value === 'incremental' ? 'incremental' : 'full')}
          options={[
            { value: 'full', label: 'Full — read everything, every run' },
            { value: 'incremental', label: 'Incremental — only what changed' },
          ]}
          disabled={disabled}
        />
        {kind === 'sql' && mode === 'incremental' && (
          <TextField
            label="Watermark column"
            value={draft.watermarkColumn}
            onChange={(watermarkColumn) => onChange({ ...draft, watermarkColumn })}
            placeholder="updated_at"
            disabled={disabled}
          />
        )}
      </div>
      {kind === 'sql' && mode === 'incremental' && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          The query is wrapped as{' '}
          <span className="font-mono">SELECT * FROM (your query) WHERE column &gt; ?</span> with the
          value bound, never pasted in. Two things follow from wrapping: the column has to be in
          what your query selects, and a query with its own LIMIT or GROUP BY is filtered after that
          step. Leave the column blank and this reads everything.
        </p>
      )}
      {kind === 's3' && mode === 'incremental' && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          Each run remembers the newest LastModified it read and the keys sitting at exactly that
          timestamp, so objects written in the same second are neither skipped nor read twice.
          Objects rewritten in place under a key already read are not picked up again.
        </p>
      )}
    </FieldGroup>
  );
}

/** The env var holding the credential — the name of one, never the value. */
export function CredentialField({
  kind,
  value,
  onChange,
  disabled,
}: {
  kind: ConnectorKind;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <TextField
      label="Credential env var"
      value={value}
      onChange={onChange}
      placeholder={
        kind === 'sql'
          ? 'Env var holding the connection URL'
          : kind === 's3'
            ? 'accessKeyId:secretAccessKey (optional)'
            : 'Optional'
      }
      disabled={disabled}
      hint="The credential is read from the environment by name at run time. Only the variable name is stored."
    />
  );
}
