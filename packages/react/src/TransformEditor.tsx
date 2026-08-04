import type { CatalogTransform, TransformLanguage } from '@dudousxd/nestjs-catalog/client';
import { isTransformLanguage } from '@dudousxd/nestjs-catalog/client';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Play } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useRef, useState } from 'react';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { CodeEditor } from './ui/code-editor';
import { TextField } from './ui/field';
import { SelectField } from './ui/select';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * Starter code per language.
 *
 * Keyed by the language union rather than by `string`, so adding a language to
 * the library without a starter here is a type error rather than an editor that
 * silently opens empty.
 */
const STARTERS: Record<TransformLanguage, string> = {
  typescript: `// \`records\` is the batch the connector fetched.
// Types are stripped, never checked — the try pane is what catches a mistake.
type Source = { tag: string; risk: string; kind: string };

return (records as Source[]).map((r) => ({
  assetId: r.tag,
  riskScore: Number(r.risk),
  vehicleTypeName: r.kind.toUpperCase(),
  critical: Number(r.risk) >= 80,
}));`,
  javascript: `// \`records\` is the batch the connector fetched.
// Return the rows to store — the keys must be property names of the target type.
return records.map((r) => ({
  assetId: r.tag,
  riskScore: Number(r.risk),
  vehicleTypeName: String(r.kind).toUpperCase(),
  critical: Number(r.risk) >= 80,
}));`,
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
  const [code, setCode] = useState(
    transform?.code ?? STARTERS[transform?.language ?? 'javascript'],
  );
  const [sample, setSample] = useState(SAMPLE);
  const editorRef = useRef<HTMLTextAreaElement>(null);

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
      return client.tryTransform({ language, code, records });
    },
  });

  const save = useMutation({
    mutationFn: () =>
      client.saveTransform({
        id: transform?.id,
        name: name.trim(),
        language,
        code,
        description: description.trim() || undefined,
      }),
    onSuccess: onSaved,
  });

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
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
            if (Object.values(STARTERS).includes(code)) {
              setCode(STARTERS[value]);
            }
          }}
          options={languages.map((option) => ({
            value: option,
            label: option,
          }))}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
          <div className={cn('flex items-center justify-between border-b px-3 py-1.5', RULE)}>
            <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
              Code
            </span>
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
            language={language === 'python' ? 'python' : 'tsx'}
            label="Transform code"
            textareaRef={editorRef}
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
            {/* Highlighted like the code above it. This was the one pane
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
            <div className="max-h-64 overflow-auto p-3">
              {tryIt.error && (
                <p className="font-mono text-[11px] leading-relaxed text-red-600">
                  {tryIt.error instanceof Error ? tryIt.error.message : 'It failed.'}
                </p>
              )}
              {tryIt.data && (
                <>
                  {tryIt.data.logs.length > 0 && (
                    <pre className={cn('mb-2 whitespace-pre-wrap font-mono text-[10px]', MUTED)}>
                      {tryIt.data.logs.join('\n')}
                    </pre>
                  )}
                  {/* An empty result said out loud. `[]` rendered as two
                      characters in a scroll pane reads as "nothing happened
                      yet", and the run that produced no rows is exactly the one
                      somebody needs to notice. */}
                  {tryIt.data.rows.length === 0 ? (
                    <p className="text-[11px] text-amber-600">
                      It ran and returned no rows. A connector using this would commit an empty
                      snapshot.
                    </p>
                  ) : (
                    <pre className="whitespace-pre-wrap font-mono text-[11px]">
                      {JSON.stringify(tryIt.data.rows, null, 2)}
                    </pre>
                  )}
                  <p className={cn('mt-2 font-mono text-[10px]', MUTED)}>
                    {tryIt.data.rows.length} rows · {tryIt.data.elapsedMs}ms
                  </p>
                </>
              )}
              {!tryIt.data && !tryIt.error && (
                <p className={cn('py-4 text-center text-[11px]', MUTED)}>
                  Run it to see what it produces.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || name.trim().length === 0}
          className={cn(
            'rounded-md border px-3 py-1.5 text-xs disabled:opacity-40',
            RULE,
            'hover:bg-zinc-50 dark:hover:bg-zinc-800',
          )}
        >
          {save.isPending ? 'Saving…' : transform ? 'Save changes' : 'Save transform'}
        </button>
        {transform && (
          <span className={cn('font-mono text-[10px]', MUTED)}>
            saving new code makes this v{transform.version + 1}
          </span>
        )}
        {save.error && (
          <span className="text-[11px] text-red-600">
            {save.error instanceof Error ? save.error.message : 'Could not save.'}
          </span>
        )}
      </div>
    </div>
  );
}
