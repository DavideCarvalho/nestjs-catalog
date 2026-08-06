import {
  CATALOG_PIPELINE_STORE,
  type CatalogConnector,
  type CatalogPipelineStore,
  type ConnectorRun,
  SubprocessTransformRunner,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { closeAbandonedAttempts } from './abandoned-runs';
import { EXPECT_SHRINK_LABEL } from './load-expectations';
import { PublishService } from './publish.service';
import { capLines, redactLines, redactSecrets } from './run-logs';
import {
  type RecordStream,
  SOURCES,
  applyConnection,
  resolveSecret,
  toRecordStream,
} from './sources';

const BATCH_SIZE = 500;

/**
 * How often a long read says something on the process log.
 *
 * Twenty batches is ten thousand rows. The number is a compromise between two
 * bad outcomes and neither is subtle: a line per batch makes a million-row load
 * two thousand lines of noise, and no line at all is what a running load used to
 * look like from outside — the run row is written at `startRun` and not again
 * until `finishRun`, so `fetched` reads 0 for the whole of it and nothing
 * anywhere distinguished "reading" from "wedged". This is the cheapest thing
 * that tells them apart, and it goes to the process log rather than the run row
 * because `finishRun` stamps `finishedAt`: there is no way to update a run row
 * mid-run without closing it.
 */
const PROGRESS_EVERY_BATCHES = 20;

/**
 * How many lines of a transform's own logging survive into the run record.
 *
 * The number is unchanged — it was `.slice(0, 50)` inline — but it was only ever
 * half a bound. A line cap with no character cap lets one line naming every
 * record a transform received write megabytes into a run row, and it grows with
 * the data, which is exactly the property a persisted record must not have.
 * `capLines` bounds both, the way the workflow runner has since it was measured
 * there; this path was simply missed.
 */
const TRANSFORM_LOG_LINES = 50;

/**
 * What a caller may say about ONE run, beyond which connector it is.
 *
 * Everything here is a property of the load, never of the connector. Nothing in
 * it is read from the store, written to the store, or carried between runs, and
 * that is the whole design rather than an implementation note — see
 * {@link ConnectorRunOptions.expectShrink}.
 */
export interface ConnectorRunOptions {
  /**
   * Why this load is expected to come back smaller — a deliberate truncation, a
   * source cut back to one base for a migration, a first load after the tables
   * were emptied.
   *
   * Sets {@link EXPECT_SHRINK_LABEL} on the snapshot this run writes, which
   * stands the row-count bound down **for that snapshot and nothing else**. The
   * alternative an operator had before this existed was to raise
   * `rowCount.maxShrink` for the type, run the connector, and lower it again —
   * three steps, of which the third is the one that gets forgotten, and between
   * the first and the third the type has no bound at all.
   *
   * **A reason, not a boolean, and an empty one is refused.** It is the same
   * requirement `DeleteReconciliation.because` makes and it is made for the same
   * reason: the sentence ends up in the snapshot's labels, so the answer to "why
   * was this collapse allowed?" is readable off the snapshot forever, by
   * somebody who was not there. A flag would answer only "somebody clicked".
   *
   * **It cannot become permanent, because there is nowhere to keep it.** It is
   * an argument to one call. It is not a column on the connector, not a key in
   * `connector.state` — which is the runner's watermark and is documented as
   * never written by a person — and not a field on `ConnectorRunStepInput`, so
   * the scheduled path cannot supply one at all. That last exclusion is
   * deliberate and is the point: a cron-fired run is unattended, and an
   * acknowledgement that fires every night at 03:00 with nobody watching is not
   * an acknowledgement, it is the bound switched off with extra steps. The
   * operator's route when a scheduled load is refused is to look at what the
   * source did and then re-run it by hand, saying why — which is the shape the
   * refusal was asking for.
   */
  expectShrink?: string;
}

/**
 * Fetch, transform, publish.
 *
 * The whole pipeline in one place, and it deliberately ends where the publish
 * protocol already is: a connector run *is* a snapshot load, with the same
 * append-and-commit boundary, the same attribution, and the same idempotent
 * batches. Giving connectors a second write path would mean two ways for rows
 * to arrive and two things to keep honest.
 *
 * Nothing here schedules. The durable engine does that, or a human presses the
 * button. Two systems believing they decide when a load runs is the failure
 * mode this design exists to avoid.
 *
 * **A connector without a transform reads a batch at a time. One with a
 * transform reads the lot.** That split is not a performance decision that
 * happened to land there; it is the transform contract, and it is written down
 * in two places already. `CatalogTransform.code` says the code is "the body of a
 * function over one batch ... a transform that needs to look up, deduplicate or
 * aggregate cannot do it one row at a time", and `WorkflowRunnerService`
 * repeats it where it holds a node's whole input for the same reason. So the
 * *whole fetch* is what a transform is promised, and chunking the calls would
 * silently redefine that promise as "five hundred rows": a transform that counts
 * would return one number per chunk, one that deduplicates would stop catching
 * duplicates that fell either side of a boundary, and one that sorts would
 * return the data in pieces. None of that fails. It commits, and the numbers are
 * wrong.
 *
 * A per-connector opt-in was the alternative and is rejected. The flag would
 * live on the connector and the assumption it encodes would live in the
 * transform — two rows, versioned independently, edited by different people. The
 * day somebody adds a `dedupe` to a transform that six connectors read through,
 * a checkbox one of them ticked months earlier makes their load quietly wrong,
 * and nothing in the diff they wrote says so. If a transform is genuinely
 * row-wise, that is a fact about the transform and belongs beside it — a change
 * to the transform contract, made once, not a promise a connector makes on its
 * behalf.
 *
 * What a transformed connector gets instead is a run log that says why it is
 * holding everything, which is the part that was missing: the previous
 * behaviour was the same, and unexplained.
 */
@Injectable()
export class ConnectorRunnerService {
  private readonly logger = new Logger(ConnectorRunnerService.name);

  constructor(
    @Inject(CATALOG_PIPELINE_STORE)
    private readonly pipeline: CatalogPipelineStore,
    private readonly transforms: SubprocessTransformRunner,
    private readonly publish: PublishService,
  ) {}

  /**
   * Run one connector.
   *
   * `snapshotId` comes from the caller — the durable run id when durable
   * scheduled it — so a retried run appends to the same snapshot and replaces
   * its own batches instead of opening a second one.
   *
   * `options` is what this particular run is allowed to say for itself, and it
   * is empty for every caller that does not have somebody watching. See
   * {@link ConnectorRunOptions}.
   */
  async run(
    connectorId: string,
    principalId: string,
    snapshotId: string,
    options: ConnectorRunOptions = {},
  ): Promise<ConnectorRun> {
    const connector = await this.pipeline.getConnector(connectorId);
    if (!connector) {
      throw new NotFoundException(`No connector ${connectorId}`);
    }
    if (!connector.enabled) {
      throw new BadRequestException(`"${connector.name}" is disabled. Enable it before running.`);
    }

    // Before `startRun`, so a run row is never opened for a call that was never
    // going to be honoured. A blank reason is refused rather than dropped: a
    // caller that sent one believes the shrink is acknowledged, and silently
    // ignoring it would surface as a refusal at the commit — after the source
    // has been read — naming the row count and never the empty string.
    const labels = labelsFor(connector.name, options);

    // Before `startRun`, so this run's own row is not among the ones scanned and
    // no ordering has to be reasoned about. See {@link closeAbandonedAttempts},
    // which `WorkflowRunnerService` calls too — it is one rule and one message
    // rather than the same subtle keying written down twice.
    const abandoned = await closeAbandonedAttempts(
      this.pipeline,
      { name: connector.name, connectorId: connector.id, snapshotId },
      this.logger,
    );

    const run = await this.pipeline.startRun({
      connectorId,
      snapshotId,
      principalId,
    });

    emitCatalog('connector.run.started', {
      connectorId,
      connectorName: connector.name,
      typeName: connector.targetType,
      snapshotId,
      principalId,
    });

    // The run starts with whatever it was allowed to say for itself, so the
    // acknowledgement is on the run row and not only in the snapshot's labels.
    // The runs list is where somebody scanning last night's loads sees that one
    // of them was permitted to collapse, and a run that carried an
    // acknowledgement silently would be the one entry there that reads exactly
    // like the others.
    const logs: string[] = [...openingLogs(labels, snapshotId, connector.name), ...abandoned];
    let fetched = 0;
    let written = 0;
    let transformVersion: number | undefined;

    try {
      const source = await this.fetch(connector);
      const load = await this.readIntoSnapshot(connector, principalId, snapshotId, source, {
        labels,
        logs,
        noteTransformVersion: (version) => {
          transformVersion = version;
        },
      });
      fetched = load.fetched;
      written += load.written;

      // Asked here — after the last row and before the merge and the commit —
      // rather than where it is used forty lines down. A streamed watermark is a
      // running maximum, so it is not final until the read is, and it can still
      // refuse: a bounded query whose rows never carried the watermark column
      // has nothing to advance to. That refusal used to arrive before any write
      // because the whole result set was in hand; now some batches have already
      // been appended when it fires, and they are left in an uncommitted
      // snapshot exactly as every other mid-run failure's are.
      const advanced = source.state();

      // An incremental run has only fetched what changed, so what sits in the
      // snapshot right now is not the dataset — it is a diff. This turns it
      // back into the dataset by copying the previously committed snapshot's
      // surviving rows in beside it, so that the thing being committed a few
      // lines below is the complete state, the way every other snapshot in this
      // catalog is.
      //
      // After the batches and before the commit, and it has to be exactly
      // there: the merge is decided against the rows present when it runs, so a
      // batch written afterwards would leave both versions of every row it
      // touched in the snapshot. The store refuses such a commit rather than
      // serving it, which is what makes the ordering enforced rather than
      // merely documented.
      if (connector.mode === 'incremental') {
        // The same labels the batches carried, and it has to be the same object
        // of facts rather than a second literal: the store creates the snapshot
        // row from whichever of the two writes reaches it first, so an
        // acknowledgement attached to only one of them would land or not
        // depending on whether this run happened to fetch any rows.
        const merged = await this.publish.carryForwardAsSystem(
          principalId,
          connector.targetType,
          snapshotId,
          labels,
        );
        logs.push(
          merged.from
            ? `Carried ${merged.carried} unchanged rows forward from snapshot ${merged.from}; ${merged.total} rows in this snapshot.`
            : `Nothing committed for ${connector.targetType} yet, so this run stands as the whole dataset (${merged.total} rows).`,
        );
      }

      const ref = await this.publish.commitAsSystem(principalId, connector.targetType, snapshotId);
      // The snapshot's own count, not this run's. For an incremental run the
      // two differ by everything that did not change, and a log line that
      // reported the run's number as the dataset's would make a healthy load
      // look like it had lost most of the data.
      logs.push(
        `Committed snapshot ${snapshotId}: ${ref.rowCount} rows, ${written} of them from this run.`,
      );

      // Only now. A watermark advanced before the commit is a promise never to
      // read those records again, made by a run that had not yet succeeded —
      // and the next run would start after data nobody stored.
      //
      // `options` is deliberately not part of what gets written here. This is
      // the one place a connector run persists anything about itself, so it is
      // the one place a per-run acknowledgement could turn into a standing one
      // — and a `_expectShrink` that survived into `connector.state` would be
      // read back by every run after it and would have switched the bound off
      // for good, silently, from a call that meant it once.
      if (advanced) {
        await this.pipeline.saveConnectorState(connector.id, {
          ...connector.state,
          ...advanced,
        });
        logs.push(`Advanced state: ${Object.keys(advanced).join(', ')}.`);
      }

      emitCatalog('connector.run.finished', {
        connectorId,
        connectorName: connector.name,
        typeName: connector.targetType,
        snapshotId,
        principalId,
        status: 'succeeded',
        fetched,
        written,
        transformVersion,
      });

      // Redacted on the way *out*, not on the way in, and on the success path
      // as well as the failure one. A run that succeeded can still have logged a
      // URL — a transform printing the endpoint it read, a carry-forward line
      // quoting a source — and `GET pipeline/runs` serves these to anybody
      // holding `catalog:read`, which is the softest scope in the system. The
      // lines are left intact in `logs` until here so that everything above
      // reads exactly as it did; the boundary is the store.
      const finished = await this.pipeline.finishRun(run.id, {
        status: 'succeeded',
        fetched,
        written,
        logs: redactLines(logs),
        transformVersion,
      });
      this.logger.log(`${connector.name}: ${fetched} fetched, ${written} written as ${snapshotId}`);
      return finished ?? run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The one the two readable sinks get. `fetchHttp` throws `GET ${url} →
      // ${status}` and the file source does the same, so a credential-bearing
      // URL that fails once used to be readable by every holder of
      // `catalog:read` — from `logs` and `error` on `GET pipeline/runs`, and
      // from the event payload on `GET catalog/events`. Redacted here, at the
      // sink, rather than at each thrower: a URL can reach this line from any
      // fetcher, any driver and any transform, and guarding the throwers means
      // guarding the next one somebody writes too.
      const readable = redactSecrets(message);
      logs.push(`Failed: ${readable}`);

      emitCatalog('connector.run.finished', {
        connectorId,
        connectorName: connector.name,
        typeName: connector.targetType,
        snapshotId,
        principalId,
        status: 'failed',
        fetched,
        written,
        error: readable,
        transformVersion,
      });

      // The snapshot is left written and uncommitted on purpose: nobody reads
      // it, and it is still there to look at when working out what went wrong.
      const finished = await this.pipeline.finishRun(run.id, {
        status: 'failed',
        fetched,
        written,
        logs: redactLines(logs),
        error: readable,
        transformVersion,
      });
      // The unredacted one, deliberately, and only here. A process log is read
      // by whoever operates the deployment; `logs` and `error` are read by
      // anybody with the softest scope in the system. That split is the same one
      // `resolveSecretEnv` makes, and it is what keeps this a redaction rather
      // than a deletion — the URL that failed is still recoverable by the person
      // who is supposed to be debugging it.
      this.logger.warn(`${connector.name} failed: ${message}`);
      return finished ?? run;
    }
  }

  /**
   * The read and the writes, and the one decision that separates them.
   *
   * **A connector with no transform streams; one with a transform does not**, and
   * which happens is decided here by the transform contract rather than by what
   * the source was capable of. The reasoning is on {@link ConnectorRunnerService}
   * and it is not a performance argument — a transform is promised the whole
   * batch, and chunking the calls would change what an aggregating one computes
   * without failing.
   *
   * `logs` is appended to rather than returned, because the caller has already
   * started the run's log with what this run was allowed to say for itself and
   * the ordering of those lines is what somebody reads a failed run in.
   *
   * `noteTransformVersion` is reported the moment the transform is in hand
   * rather than carried out on the return value, and that is not tidiness: a
   * transform that *throws* never reaches a return, and the version is exactly
   * what somebody investigating the failure wants on the run row. Returning it
   * would have recorded it only for the runs that did not need it.
   */
  private async readIntoSnapshot(
    connector: CatalogConnector,
    principalId: string,
    snapshotId: string,
    source: RecordStream,
    into: {
      labels: Record<string, string>;
      logs: string[];
      noteTransformVersion: (version: number) => void;
    },
  ): Promise<{ fetched: number; written: number }> {
    const { labels, logs } = into;

    if (!connector.transformId) {
      const counts = await this.appendBatches(
        connector,
        principalId,
        snapshotId,
        source.records,
        labels,
      );
      // After the writes, because with a streamed source the count is not known
      // until the last row has gone past. The line reads the same and sits in
      // the same place in the log as it always did.
      logs.push(`Fetched ${counts.seen} records from ${connector.kind}.`);
      return { fetched: counts.seen, written: counts.written };
    }

    const transform = await this.pipeline.getTransform(connector.transformId);
    if (!transform) {
      throw new Error(
        `Transform ${connector.transformId} is gone. A connector pointing at code that no longer exists must fail rather than load raw records under a shape nobody chose.`,
      );
    }
    into.noteTransformVersion(transform.version);

    const records = await collect(source.records);
    logs.push(`Fetched ${records.length} records from ${connector.kind}.`);
    // Only when the source could have streamed and was not allowed to. An
    // operator looking at a connector that exhausted its heap should be able to
    // read why off the run, rather than working it out from the fact that the
    // connector happens to have a transform on it.
    if (source.streamed) {
      logs.push(
        `Held all ${records.length} records in memory: "${transform.name}" is a function over the whole batch, so this read could not be streamed. Drop the transform to have it read a batch at a time.`,
      );
    }

    const result = await this.transforms.run(transform, records);
    logs.push(
      `Transform "${transform.name}" v${transform.version} produced ${result.rows.length} rows in ${result.elapsedMs}ms.`,
      ...capLines(result.logs, TRANSFORM_LOG_LINES),
    );

    const counts = await this.appendBatches(
      connector,
      principalId,
      snapshotId,
      toRecordStream(result.rows).records,
      labels,
    );
    return { fetched: records.length, written: counts.written };
  }

  /**
   * Every batch this load writes, and — for a full load that read nothing — the
   * one empty batch that would otherwise not exist.
   *
   * **It pulls, and that is what bounds the memory.** The records arrive as an
   * async iterable, and the next one is not asked for until the batch before it
   * has been written, so what this holds is at most `BATCH_SIZE` rows however
   * many the source has. When the source is a real stream — see
   * {@link fetchSql} — that back-pressure reaches the driver's socket and the
   * whole read is bounded end to end. When it is an array the fetcher already
   * had, this walks it and nothing is copied.
   *
   * One implementation for both paths on purpose. The transform path hands its
   * *output* through here as an array; the streamed path hands the source's rows
   * through directly. Two loops would be two answers to where a batch boundary
   * falls, and the empty-batch rule below is exactly the kind of thing that would
   * end up on one of them.
   *
   * `seen` counts everything the iterable yielded, before the filter — which is
   * what `fetched` on the run row has always meant. Records that are not plain
   * objects cannot be written as rows and are dropped, as they always were.
   *
   * A batch is the only thing that creates the snapshot row. A FULL load of
   * zero rows therefore used to leave no snapshot at all, and the commit
   * refused with "no snapshot has been written" — an error naming the wrong
   * event entirely, for a source that answered perfectly and had nothing to
   * say. It also carries the labels, which is where an operator's
   * acknowledgement that this collapse was deliberate travels, so the one case
   * that acknowledgement exists for was the one case it could not arrive.
   *
   * INCREMENTAL is excluded, and the asymmetry is deliberate: a carry-forward
   * follows, it writes the snapshot, and it carries the same labels. A batch
   * here would be a second write on a path that already has one.
   *
   * An empty batch is a statement — the load ran and produced nothing. Writing
   * no batch at all is silence, and the store cannot tell silence from a crash.
   */
  private async appendBatches(
    connector: CatalogConnector,
    principalId: string,
    snapshotId: string,
    records: AsyncIterable<unknown>,
    labels: Record<string, string>,
  ): Promise<{ seen: number; written: number }> {
    // Numbered so a retry replaces rather than appends.
    let batch = 1;
    let seen = 0;
    let written = 0;
    let pending: Array<Record<string, unknown>> = [];

    const flush = async (): Promise<void> => {
      const result = await this.publish.appendRowsAsSystem(
        principalId,
        connector.targetType,
        snapshotId,
        pending,
        labels,
        batch,
      );
      written += result.written;
      batch += 1;
      pending = [];
      if (batch % PROGRESS_EVERY_BATCHES === 1 && batch > 1) {
        this.logger.log(
          `${connector.name}: ${seen} records read, ${written} written into ${snapshotId} so far.`,
        );
      }
    };

    for await (const record of records) {
      seen += 1;
      if (isRowRecord(record)) pending.push(record);
      if (pending.length >= BATCH_SIZE) await flush();
    }

    // `batch === 1` is "nothing was ever written", which is the condition the
    // array version spelled as `rows.length === 0`. It is not the same as "the
    // source read nothing": a full load of a thousand records that were all
    // strings writes an empty batch too, and did before.
    if (pending.length > 0 || (batch === 1 && connector.mode !== 'incremental')) await flush();

    return { seen, written };
  }

  /** Pull the raw records. Shaping is the transform's job, not this one's. */
  private async fetch(rawConnector: CatalogConnector): Promise<RecordStream> {
    // Resolved here rather than at save time: a connection edited after a
    // connector was saved must take effect on the next run, which is the whole
    // point of naming it once.
    const connection = rawConnector.connectionId
      ? await this.pipeline.getConnection(rawConnector.connectionId)
      : undefined;
    if (rawConnector.connectionId && !connection) {
      throw new Error(
        `"${rawConnector.name}" reads through a connection that no longer exists (${rawConnector.connectionId}). Point it at one that does rather than letting it load from a half-configured source.`,
      );
    }
    const connector = applyConnection(rawConnector, connection);

    const source = SOURCES[connector.kind];
    if (!source) {
      throw new Error(
        `Connector kind "${connector.kind}" has no fetcher. This should be unreachable — the kind list and this map are meant to move together.`,
      );
    }
    return toRecordStream(
      await source({
        connector,
        secret: resolveSecret(connector),
        state: connector.state ?? {},
        mode: connector.mode === 'incremental' ? 'incremental' : 'full',
      }),
    );
  }
}

/**
 * Everything an iterable yields, as an array.
 *
 * Named for what it costs. The one caller is the transform path, and the reason
 * it is a separate function with this docblock rather than three lines inline is
 * so that the next person to reach for it has to read why the transform path is
 * allowed to do this and nothing else is.
 */
/**
 * Whether a record can be written as a row at all.
 *
 * A string, a number or an array cannot be, and dropping one silently is how a
 * load comes out short with nothing to explain it — which is why `fetched`
 * counts what arrived and `written` counts what survived this, and the two being
 * different is visible on the run. `WorkflowRunnerService` applies the identical
 * filter to a source node's output, and says so.
 */
function isRowRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function collect(records: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const record of records) collected.push(record);
  return collected;
}

/**
 * The labels this run's snapshot carries — provenance, plus whatever this one
 * run was allowed to say for itself.
 *
 * Built once per run and used by every write in it, which is what makes the
 * acknowledgement a property of the snapshot rather than of a code path. A
 * function rather than two literals inline because the previous shape — the
 * same object spelled out at the batch write and again at the merge — is
 * exactly how a label ends up on one of the two.
 *
 * Refusing a blank reason here rather than at some validating edge is
 * deliberate: this service is called by the bundled controller, by a host's own
 * controller, and by the durable step, and a rule that lived in one of them
 * would be a rule the other two do not have. `BadRequestException` because that
 * is what an operator sending `{"expectShrink": ""}` should get back — the same
 * 400 the publish surface answers a malformed load with — rather than a 500 or
 * a run that opens and then refuses itself.
 */
function labelsFor(connectorName: string, options: ConnectorRunOptions): Record<string, string> {
  const labels: Record<string, string> = { source: 'connector', connector: connectorName };
  if (options.expectShrink === undefined) return labels;

  const because = options.expectShrink.trim();
  if (because.length === 0) {
    throw new BadRequestException(
      `This run of "${connectorName}" was told to expect a shrink and given no reason for it. The reason is what makes the acknowledgement worth anything: it is stored in the snapshot's labels and is the only answer anybody will have in six months to "why was this load allowed to lose most of the data?". Say what happened at the source — a truncation, a migration, a base being cut — or drop the acknowledgement and let the bound decide.`,
    );
  }
  labels[EXPECT_SHRINK_LABEL] = because;
  return labels;
}

/**
 * What the run's log says before it has done anything.
 *
 * Read back off the labels rather than off the options, so that the line and the
 * snapshot cannot disagree: the label is what the bound will actually read, and
 * a log built from the caller's argument would keep saying "acknowledged" if
 * anything ever stopped that argument from reaching the write.
 *
 * Empty for an ordinary run, which is why this returns the array rather than
 * appending to one — nothing about a load that acknowledges nothing needs
 * saying, and a "no acknowledgement" line on every run of every connector is
 * how the ones that matter become invisible.
 */
function openingLogs(
  labels: Record<string, string>,
  snapshotId: string,
  connectorName: string,
): string[] {
  const because = labels[EXPECT_SHRINK_LABEL];
  if (because === undefined) return [];
  return [
    `This run acknowledges a shrink: ${because} The row-count bound stands down for snapshot ${snapshotId} only; the next run of "${connectorName}" is measured against the full bound again.`,
  ];
}
