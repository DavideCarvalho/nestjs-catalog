/**
 * Asking a source what its columns are, and turning the answer into a type.
 *
 * ITS OWN MODULE, AND WHY
 * -----------------------
 * All of this used to live inside `PipelineConsole`, reached from a connector
 * editor, because a connector was the thing that held an address and a query.
 * It is not any more: a source node on a graph is, and the route moved with it —
 * `POST connectors/:id/discover` became
 * `POST workflows/:id/nodes/:nodeId/discover`. The panel therefore has to be
 * mountable from the canvas, and the canvas lives behind its own entry point
 * because it imports `@xyflow/react`. Left where it was, either the canvas would
 * import a screen it has nothing else to do with, or there would be two copies
 * of the rules that decide whether a schema somebody ticked is publishable.
 *
 * Nothing here imports React Flow, so both entry points can reach it.
 *
 * WHAT THIS SCREEN IS FOR
 * -----------------------
 * One thing: never letting a guess become a type. Discovery reports columns it
 * could not type, and the job here is to keep those visibly out of the proposal
 * until a person says what they are. A wrong type becomes a wrong column in a
 * lake nobody re-checks, and everything downstream reads it as fact rather than
 * as the guess it was.
 */

import type { ScalarType } from '@dudousxd/nestjs-catalog/client';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck, Loader2, Save, ScanSearch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { cn } from './cn';
import { Button } from './ui/button';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';

/**
 * How this console reaches discovery and publication.
 *
 * A bridge rather than two more calls made inline, because a host embedding
 * these screens may route either through its own gateway — and because
 * `createType` is genuinely optional: the publish route needs `catalog:write`
 * and per-type ownership, and a host that has deliberately not given its console
 * that has to be able to say so without the screen pretending the button is
 * merely broken.
 *
 * `discover` takes a workflow and a node, not a connector. See
 * {@link CatalogClient.discoverSourceSchema} for why the pair replaced the
 * single id, and why it answers on a draft.
 */
export interface SchemaDiscoveryBridge {
  discover(workflowId: string, nodeId: string): Promise<ConnectorSchemaDiscovery>;
  /**
   * Create the type from what a person confirmed. Absent is a supported state —
   * the panel does everything up to the confirmation and then prints the exact
   * request it would have sent.
   */
  createType?(draft: DiscoveredTypeDraft): Promise<unknown>;
}

/**
 * What `POST pipeline/workflows/:id/nodes/:nodeId/discover` answers, mirrored
 * for the browser.
 *
 * Mirrored rather than imported, exactly as `PipelineCapabilities` is in
 * `context.tsx`: the authority is `schema-discovery.ts` in
 * `@dudousxd/nestjs-catalog-pipeline`, which is a NestJS package with a
 * `node:fs` import in its dependency graph and has no business in a browser
 * bundle. The two are kept honest by being the documented response of one route,
 * and by this screen treating every field it renders as something the server may
 * not have sent.
 *
 * Named after the connector still, matching the server's own name for it, and
 * the FIELDS are what changed: `connectorId`/`connectorName` became
 * `workflowId`/`nodeId`/`nodeName`/`kind`. A connector's own kind and config
 * stopped being read the moment it gained a `workflowId`, and every connector
 * has one now — so a connector id here would have named a row whose
 * configuration has nothing to do with the columns underneath it. A graph can
 * also have several sources, which the old pair could not express at all.
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
  /** The graph this node belongs to, so a report can be traced back to it. */
  workflowId: string;
  nodeId: string;
  nodeName: string;
  /** What kind of system the node reads from, as the server resolved it. */
  kind: string;
  /**
   * The type the graph's sink commits — the graph's, not the node's, because a
   * source node has none. Empty on a draft with no sink drawn yet, which reads
   * back as `typeExists: false` and is the honest answer: there is nothing for
   * the columns to have drifted from.
   */
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
export function narrowDiscovery(answer: unknown): ConnectorSchemaDiscovery {
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
 * Only for a source node on a SAVED graph, and deliberately not only on a
 * published one. Discovery reads the stored node, so there is nothing to read
 * from a canvas nobody has saved — but requiring a published graph would be
 * circular: a sink cannot commit into a type that does not exist, so the type
 * has to be creatable before the graph is declared finished. `disabledReason`
 * is how the caller states which of those two it is; a panel that simply hid
 * itself would leave somebody hunting for a button that used to be there.
 *
 * The screen's job is to make the difference between what was *reported* and
 * what was *inferred* impossible to miss, because that difference is the whole
 * value of the report. A driver describing a `NUMERIC` column is the database
 * speaking; forty records that all happened to hold a string is a sample, and
 * the forty-first is where somebody finds out.
 */
export function SchemaDiscoveryPanel({
  workflowId,
  nodeId,
  bridge,
  disabledReason,
  onSave,
  saving = false,
  onDiscovered,
}: {
  workflowId: string;
  nodeId: string;
  bridge: SchemaDiscoveryBridge;
  /** Why the button cannot be pressed, said out loud. Absent means it can. */
  disabledReason?: string;
  /**
   * Do the thing `disabledReason` asks for, from here.
   *
   * Both reasons this panel can be disabled for are "save it first", and until
   * this existed the panel said so while the save control lived in a header the
   * panel is not even in — the inspector is a side sheet over the canvas. A
   * reader was being told to do something with no way to do it where they were
   * standing, and the report that produced was "it's disabled and I can't see
   * anything" rather than "ah, I should save".
   *
   * Optional because a host may mount this panel somewhere with no draft behind
   * it; the sentence alone is still correct, just less useful.
   */
  onSave?: () => void;
  /** Whether that save is in flight, so the button says so rather than lying. */
  saving?: boolean;
  /**
   * Told to whoever mounted this, because the answer outlives the panel.
   *
   * This component holds the report in state, and the canvas unmounts it the
   * moment the inspector closes — so the columns a person just read would be
   * gone by the time they looked at the problems rail, which is the one place
   * the same answer has anything else to say. The canvas keeps them per node
   * and hands them to `validateWorkflow`; see `workflow/shape.ts`.
   *
   * A callback rather than a query the canvas fires itself, because discovery
   * is a **read of a live source** behind a `POST`: opening a graph with four
   * source nodes must not open four database connections nobody asked for. The
   * shape check is therefore answered exactly where somebody asked the
   * question, and stays silent everywhere else — which is what that module is
   * written around.
   */
  onDiscovered?: (nodeId: string, discovery: ConnectorSchemaDiscovery) => void;
}) {
  // Counted rather than timestamped so a second discovery always remounts the
  // table below, dropping the choices somebody made against a column list that
  // no longer exists.
  const [discovered, setDiscovered] = useState<{ run: number; value: ConnectorSchemaDiscovery }>();

  const discover = useMutation({
    mutationFn: () => bridge.discover(workflowId, nodeId),
    onSuccess: (value) => {
      setDiscovered((previous) => ({ run: (previous?.run ?? 0) + 1, value }));
      onDiscovered?.(nodeId, value);
    },
  });

  return (
    <div className={cn('rounded-md border border-dashed p-3', RULE)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => discover.mutate()}
          disabled={discover.isPending || disabledReason !== undefined}
        >
          {discover.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <ScanSearch size={12} />
          )}
          {discover.isPending ? 'Reading the source…' : 'Discover schema'}
        </Button>
        <span className={cn('text-[11px]', MUTED)}>
          {disabledReason ??
            'Reads the source and reports its columns. Creates nothing on its own, and works on a draft — the type has to exist before a sink can commit into it.'}
        </span>

        {/*
         * The remedy, beside the sentence that asks for it.
         *
         * Only when there is something to remedy — an enabled panel showing a
         * save button would be offering an action with no bearing on the one
         * thing this panel does.
         *
         * The label says "Save" and the hint says it does not publish, carrying
         * the same care the `!draft.id` reason already takes: a reader told to
         * save is entitled to worry they are being asked to publish, and on this
         * screen publishing is a different, louder thing.
         */}
        {disabledReason !== undefined && onSave && (
          <Button variant="secondary" size="sm" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Saving…' : 'Save now'}
          </Button>
        )}
      </div>

      {disabledReason !== undefined && onSave && (
        <p className={cn('mt-1.5 text-[11px]', MUTED)}>
          Saving stores the graph as a draft. It does not publish it, and nothing runs because of
          it.
        </p>
      )}

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

      {discovery.targetType ? (
        <DriftReport drift={discovery.drift} targetType={discovery.targetType} />
      ) : (
        <p className={cn('text-[11px]', MUTED)}>
          {/* The draft case, and the one that made this route answer before
              publication: nothing downstream of this source commits yet, so
              there is no type to compare against and nothing to create until a
              sink says which one. */}
          This graph has no sink naming an object type yet, so there is nothing to compare these
          columns against. Draw one and choose a type, and this becomes the way to create it.
        </p>
      )}

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

      {discovery.targetType ? (
        <Confirmation
          discovery={discovery}
          draft={draft}
          problems={problems}
          createType={createType}
        />
      ) : null}
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
        workflow will load into it.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        onClick={() => create.mutate()}
        disabled={problems.length > 0 || create.isPending}
        size="sm"
      >
        {create.isPending
          ? 'Creating…'
          : discovery.typeExists
            ? `Update ${discovery.targetType}`
            : `Create ${discovery.targetType}`}
      </Button>
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
              already know. Same argument for the checkbox above: `Switch` is a
              statement about a setting, not a row selector in a dense table. */}
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
              // The popup is the browser's, so its background is not this
              // component's to style — but the options inherit the control's
              // colour, and without an explicit dark background a dark theme
              // renders light-on-light in some engines.
              'text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100',
              choice.type === '' && 'text-amber-600 dark:text-amber-500',
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
 * happens for as long as the pipeline exists, and every one of these is silent
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
