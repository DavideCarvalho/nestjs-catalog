import type {
  CatalogTransform,
  TransformLanguage,
  TransformMode,
  TransformResult,
} from '@dudousxd/nestjs-catalog/client';
import {
  isTransformLanguage,
  isTransformMode,
  recordModeRefusal,
  transformMode,
  transformShape,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Play } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { RevisionHistoryButton, RevisionHistorySheet } from './diff/RevisionDiff';
import { CodeEditor } from './ui/code-editor';
import { TRANSFORM_HIGHLIGHTED_AS } from './ui/code-languages';
import { TextField } from './ui/field';
import { SelectField } from './ui/select';
import { Tooltip } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * Starter code per language.
 *
 * Keyed by the language union rather than by `string`, so adding a language to
 * the library without a starter here is a type error rather than an editor that
 * silently opens empty.
 *
 * The JavaScript and TypeScript starters open in the **module shape** — a real
 * function taking one object — because a starter is how a shape is actually
 * adopted. Nobody reads a changelog to find out that a signature moved; they
 * copy what the editor put in front of them, and every transform written from
 * here on gains fields on that object for free.
 *
 * Nothing is migrated by this. An existing transform opens with its own saved
 * code and keeps running exactly as it always has, in whichever shape it was
 * written in; the starter is only what an empty editor is pre-filled with.
 */
const STARTERS: Record<TransformLanguage, string> = {
  // The type import is `import type`, and that is load-bearing rather than
  // stylistic: the stripper erases the whole statement, so nothing tries to
  // resolve the package inside a child process that has no `node_modules`. The
  // same specifier as a value import would fail at run time.
  typescript: `import type { CatalogTransformFunction } from '@dudousxd/nestjs-catalog/client';

// Types here are erased before this runs, and never checked — a wrong one is a
// squiggle in your editor, not a failed run. The try pane is what catches it.
type Source = { tag: string; risk: string; kind: string };

const transform: CatalogTransformFunction<Source> = ({ records, context }) =>
  records.map((r) => ({
    assetId: r.tag,
    riskScore: Number(r.risk),
    vehicleTypeName: r.kind.toUpperCase(),
    critical: Number(r.risk) >= 80,
  }));

export default transform;`,
  javascript: `// One object in, the rows to store out. \`records\` is the batch the connector
// fetched; \`context\` carries the run, the counts and the admitted env vars.
// The keys you return must be property names of the target type.
export default function transform({ records, context }) {
  return records.map((r) => ({
    assetId: r.tag,
    riskScore: Number(r.risk),
    vehicleTypeName: String(r.kind).toUpperCase(),
    critical: Number(r.risk) >= 80,
  }));
}`,
  python: `# \`records\` is the batch the connector fetched.
# Return the rows to store — the keys must be property names of the target type.
log("mapping", len(records), "records")
return [{
    "assetId": r["tag"],
    "riskScore": int(r["risk"]),
    "vehicleTypeName": r["kind"].upper(),
    "critical": int(r["risk"]) >= 80,
} for r in records]`,
};

/**
 * Starter code for the per-record mode.
 *
 * A second table rather than a branch inside the first, so that adding a
 * language without a per-record starter is a type error in the same way adding
 * one without a batch starter already is.
 *
 * Python is absent from this table and cannot be here: its harness writes
 * `def transform(records, context):` and there is no second `def` yet, which is
 * why `recordModeRefusal` refuses the combination outright. The type says so —
 * the key set is the two languages the mode can actually run in — rather than
 * carrying a starter for a mode the server will reject.
 */
const RECORD_STARTERS: Record<'javascript' | 'typescript', string> = {
  typescript: `import type { CatalogRecordTransformFunction } from '@dudousxd/nestjs-catalog/client';

// One record in, one row out. This runs once per record over a stream, so
// nothing anywhere holds the whole read — see the mode selector above.
type Source = { tag: string; risk: string; kind: string };

const transform: CatalogRecordTransformFunction<Source> = ({ record, context }) => ({
  assetId: record.tag,
  riskScore: Number(record.risk),
  vehicleTypeName: record.kind.toUpperCase(),
  critical: Number(record.risk) >= 80,
});

export default transform;`,
  javascript: `// One record in, one row out — this runs once per record over a stream.
// Return an array to turn one record into several, or null to drop it.
export default function transform({ record, context }) {
  return {
    assetId: record.tag,
    riskScore: Number(record.risk),
    vehicleTypeName: String(record.kind).toUpperCase(),
    critical: Number(record.risk) >= 80,
  };
}`,
};

/**
 * What an empty editor opens with, for this language in this mode.
 *
 * One function so the two tables are consulted in one place. A per-record
 * Python transform has no starter because it has no harness; it falls back to
 * the batch one, and `recordModeRefusal` is what tells the author why the
 * combination cannot be saved — a starter that pretended otherwise would be the
 * editor teaching a shape the server refuses.
 */
function starterFor(language: TransformLanguage, mode: TransformMode): string {
  if (mode === 'record' && language !== 'python') return RECORD_STARTERS[language];
  return STARTERS[language];
}

/** Every starter, so "has this been edited" can be asked without listing them. */
function isUntouchedStarter(code: string): boolean {
  return Object.values(STARTERS).includes(code) || Object.values(RECORD_STARTERS).includes(code);
}

const SAMPLE = `[
  { "tag": "AF93E00073", "risk": "88", "kind": "truck" },
  { "tag": "AF00D00169", "risk": "12", "kind": "sedan" }
]`;

export interface TransformEditorProps {
  transform?: CatalogTransform;
  /**
   * The languages this deployment can actually run, from
   * `pipelineCapabilities()`. Offering one the image cannot execute turns a
   * deployment difference into a traceback the author cannot act on.
   */
  languages: TransformLanguage[];
  pythonPackages?: string[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Write the code, and run it against a couple of records before it ever touches
 * a load.
 *
 * The try pane is the point of this screen. A transform is the one place where
 * somebody's typo silently reshapes stored data, and the difference between a
 * transform you can iterate on and one you can only test in production is
 * whether you can see its output beside its input.
 */
/**
 * What the last run produced: its logs, its rows, or why it failed.
 *
 * An empty result is said out loud rather than shown as `[]`. Two characters in
 * a scroll pane read as "nothing happened yet", and the run that produced no
 * rows is exactly the one somebody needs to notice — a connector using this
 * transform would commit an empty snapshot.
 */
function TryOutput({ result, error }: { result: TransformResult | undefined; error: unknown }) {
  return (
    <div className="max-h-64 overflow-auto p-3">
      {error ? (
        <p className="font-mono text-[11px] leading-relaxed text-red-600">
          {error instanceof Error ? error.message : 'It failed.'}
        </p>
      ) : null}
      {result && (
        <>
          {result.logs.length > 0 && (
            <pre className={cn('mb-2 whitespace-pre-wrap font-mono text-[10px]', MUTED)}>
              {result.logs.join('\n')}
            </pre>
          )}
          {result.rows.length === 0 ? (
            <p className="text-[11px] text-amber-600">
              It ran and returned no rows. A connector using this would commit an empty snapshot.
            </p>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[11px]">
              {JSON.stringify(result.rows, null, 2)}
            </pre>
          )}
          <p className={cn('mt-2 font-mono text-[10px]', MUTED)}>
            {result.rows.length} rows · {result.elapsedMs}ms
          </p>
        </>
      )}
      {!result && !error && (
        <p className={cn('py-4 text-center text-[11px]', MUTED)}>Run it to see what it produces.</p>
      )}
    </div>
  );
}

/**
 * Which shape the runner will read this code as, decided by the runner's own
 * rule.
 *
 * `transformShape` is imported from the library rather than re-derived here, and
 * that is the entire point of the control. A badge that reasoned about the code
 * independently would be a second opinion, and the day the two disagreed the
 * badge would be reassuring somebody about a run that did the other thing.
 *
 * Shown at all because the two shapes are otherwise invisible: the editor is a
 * text box, and "this ran as a bare body" is something an author currently only
 * learns from a syntax error. Neither shape is marked as wrong — the bare body
 * is supported, not deprecated — so this states a fact and stays out of the way.
 *
 * Not shown for Python, which has one shape and no rule: its harness writes the
 * `def` itself, so there is nothing here for an author to have got wrong.
 */
function ShapeBadge({
  language,
  code,
  mode,
}: { language: TransformLanguage; code: string; mode: TransformMode }) {
  if (language === 'python') return null;
  const shape = transformShape(code);
  const isModule = shape === 'module';
  // The argument named in the tooltip follows the selected mode, because that is
  // what the harness will actually pass. A badge that said `{ records, context }`
  // beside a per-record selector would be reassuring somebody about a call that
  // is not going to happen.
  const argument = mode === 'record' ? '{ record, context }' : '{ records, context }';
  return (
    <Tooltip
      content={
        isModule
          ? `A top-level \`export\`, so this is imported as a module and its default export (or an export named \`transform\`) is called with one object: ${argument}. Fields can be added to that object later without changing this signature.`
          : 'No top-level `export`, so this runs as the body of a function that already has `records` and `context` in scope. Supported and unchanged — `export default function transform({ records, context })` is the shape that can gain fields later.'
      }
    >
      <span
        className={cn(
          'cursor-default rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]',
          RULE,
          MUTED,
        )}
      >
        {isModule ? 'function' : 'bare body'}
      </span>
    </Tooltip>
  );
}

/**
 * Save, and what saving will do.
 *
 * The version note is beside the button rather than in a confirmation, because
 * saving new code always cuts a version — that is how a running connector keeps
 * the code it was pinned to — and it should be visible before the click, not
 * explained after it.
 */
function SaveBar({
  transform,
  nameIsEmpty,
  refused,
  pending,
  error,
  onSave,
}: {
  transform: CatalogTransform | undefined;
  nameIsEmpty: boolean;
  /**
   * Whether the language and mode chosen cannot run together.
   *
   * Disabled rather than left clickable-and-rejected, because the sentence
   * explaining it is already on screen above this button: letting the click
   * through would replace a note the author can act on with a toast saying the
   * same thing after the fact.
   */
  refused: boolean;
  pending: boolean;
  error: unknown;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onSave}
        disabled={pending || nameIsEmpty || refused}
        className={cn(
          'rounded-md border px-3 py-1.5 text-xs disabled:opacity-40',
          RULE,
          'hover:bg-zinc-50 dark:hover:bg-zinc-800',
        )}
      >
        {pending ? 'Saving…' : transform ? 'Save changes' : 'Save transform'}
      </button>
      {transform && (
        <span className={cn('font-mono text-[10px]', MUTED)}>
          saving new code makes this v{transform.version + 1}
        </span>
      )}
      {error ? (
        <span className="text-[11px] text-red-600">
          {error instanceof Error ? error.message : 'Could not save.'}
        </span>
      ) : null}
    </div>
  );
}

export function TransformEditor({
  transform,
  languages,
  pythonPackages = [],
  onClose,
  onSaved,
}: TransformEditorProps) {
  const client = useCatalogClient();
  const [name, setName] = useState(transform?.name ?? '');
  const [description, setDescription] = useState(transform?.description ?? '');
  const [language, setLanguage] = useState<TransformLanguage>(
    transform?.language ?? languages[0] ?? 'javascript',
  );
  const [mode, setMode] = useState<TransformMode>(transform ? transformMode(transform) : 'batch');
  const [code, setCode] = useState(
    transform?.code ?? starterFor(transform?.language ?? 'javascript', 'batch'),
  );
  const [sample, setSample] = useState(SAMPLE);
  const [historyOpen, setHistoryOpen] = useState(false);

  const tryIt = useMutation({
    mutationFn: () => {
      let records: unknown[];
      try {
        const parsed: unknown = JSON.parse(sample);
        records = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // Thrown rather than sent, because the server would answer with a
        // parser error about a body it never should have received, and the
        // person reading it would go looking at their transform.
        throw new Error('The sample is not valid JSON.');
      }
      // The mode goes with it, so the pane runs the code under the contract the
      // author has selected rather than under whichever one the server would
      // default to. A per-record transform tried as a batch is handed the whole
      // array as its `record` and shows empty rows for correct code.
      return client.tryTransform({ language, code, records, mode });
    },
  });

  const save = useMutation({
    mutationFn: () =>
      client.saveTransform({
        id: transform?.id,
        name: name.trim(),
        language,
        code,
        mode,
        description: description.trim() || undefined,
      }),
    onSuccess: onSaved,
  });

  // The same question the controller asks, from the same function, so the
  // editor and the server cannot disagree about which combinations are legal.
  const refusal = recordModeRefusal({ language, code, mode });

  // `preventDefault` is what claims the key. The editor's default keymap binds
  // ⌘↵ to "insert a blank line", and `CodeEditor` only withholds a keystroke
  // from it when the host has said it wants it — so without this, trying the
  // transform would also leave a blank line in the code being tried.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      tryIt.mutate();
    }
  }

  return (
    <div className="mt-6 space-y-3">
      <button
        type="button"
        onClick={onClose}
        className={cn(
          'flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em]',
          MUTED,
          'hover:text-zinc-950 dark:hover:text-zinc-50',
        )}
      >
        <ArrowLeft size={12} />
        Transforms
      </button>

      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Name" value={name} onChange={setName} placeholder="Fleet rows" />
        <TextField
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="What it does (optional)"
        />
        <SelectField
          label="Language"
          ariaLabel="Language"
          value={language}
          onValueChange={(value) => {
            // Narrowed against the library's own list rather than trusted from
            // the select, which hands back a bare string.
            if (!isTransformLanguage(value)) return;
            setLanguage(value);
            // Only replace untouched starter code — silently discarding
            // somebody's work because they changed a dropdown would be rude.
            if (isUntouchedStarter(code)) setCode(starterFor(value, mode));
          }}
          options={languages.map((option) => ({
            value: option,
            label: option,
          }))}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          label="Called"
          ariaLabel="Called"
          value={mode}
          onValueChange={(value) => {
            if (!isTransformMode(value)) return;
            setMode(value);
            if (isUntouchedStarter(code)) setCode(starterFor(language, value));
          }}
          options={[
            { value: 'batch', label: 'once with the whole batch' },
            { value: 'record', label: 'once per record (streams)' },
          ]}
        />
        <p className={cn('sm:col-span-2 self-center text-xs leading-relaxed', MUTED)}>
          {mode === 'record'
            ? 'Each record is mapped on its own and the rows are written as they are produced, so nothing holds the whole read. Return one object, an array of them, or null to drop the record. Aggregating, deduplicating and sorting need the whole batch and cannot be written this way.'
            : 'The code is called once with every record, which is what aggregating, deduplicating, sorting and joining need. The whole read is held in memory while it runs.'}
        </p>
      </div>

      {/* Refused by the server as well, and with this same sentence. Shown here
          because a refusal an author reads after pressing save is a refusal
          they read once they have stopped thinking about the choice that
          caused it. */}
      {refusal ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          {refusal}
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
          <div className={cn('flex items-center justify-between border-b px-3 py-1.5', RULE)}>
            <div className="flex items-center gap-2">
              <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                Code
              </span>
              <ShapeBadge language={language} code={code} mode={mode} />
            </div>
            <span className={cn('font-mono text-[10px]', MUTED)}>
              {language === 'python' && pythonPackages.length > 0
                ? `imports: ${pythonPackages.join(', ')}`
                : '⌘↵ to try'}
            </span>
          </div>
          <CodeEditor
            value={code}
            onChange={setCode}
            onKeyDown={onKeyDown}
            // A table rather than the `language === 'python' ? 'python' : 'tsx'`
            // that used to be here. The ternary answered a fourth transform
            // language with `tsx` — silently, and wrongly — where the table
            // cannot be indexed by one at all until somebody adds the row.
            language={TRANSFORM_HIGHLIGHTED_AS[language]}
            label="Transform code"
            className="h-72"
          />
        </div>

        <div className="space-y-3">
          <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
            <div className={cn('border-b px-3 py-1.5', RULE)}>
              <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                Sample records
              </span>
            </div>
            {/* The same editor as the code above it. This was the one pane
                that stayed a bare textarea, so the sample you are debugging
                against rendered as flat grey while the transform beside it was
                coloured — and a missing brace in a sample is exactly the thing
                highlighting finds for you. */}
            <CodeEditor
              value={sample}
              onChange={setSample}
              language="json"
              label="Sample records"
              className="h-32"
            />
          </div>

          <button
            type="button"
            onClick={() => tryIt.mutate()}
            disabled={tryIt.isPending}
            className="flex items-center gap-1.5 rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
          >
            <Play size={12} />
            {tryIt.isPending ? 'Running…' : 'Try it'}
          </button>

          <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
            <div className={cn('border-b px-3 py-1.5', RULE)}>
              <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                Output
              </span>
            </div>
            <TryOutput result={tryIt.data} error={tryIt.error} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SaveBar
          refused={refusal !== undefined}
          transform={transform}
          nameIsEmpty={name.trim().length === 0}
          pending={save.isPending}
          error={save.error}
          onSave={() => save.mutate()}
        />
        {/* Only for a transform that exists. A draft has no history and a
            control that can only ever open an empty panel is a control that
            teaches people to stop pressing it. */}
        {transform && (
          <RevisionHistoryButton className="ml-auto" onClick={() => setHistoryOpen(true)} />
        )}
      </div>

      {transform && (
        <RevisionHistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          subject={{ kind: 'transform', id: transform.id, name: transform.name }}
          // The SAVED code, not what is in the editor above. A history is what
          // this catalog has recorded; comparing against an unsaved buffer would
          // put a version number on text that exists only in one browser tab,
          // and no run will ever have used it.
          current={{ version: transform.version, body: transform.code }}
        />
      )}
    </div>
  );
}
