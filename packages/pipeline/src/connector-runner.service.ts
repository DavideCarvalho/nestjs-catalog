import {
  CATALOG_PIPELINE_STORE,
  type CatalogConnector,
  type CatalogPipelineStore,
  type ConnectorRun,
  SubprocessTransformRunner,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EXPECT_SHRINK_LABEL } from './load-expectations';
import { PublishService } from './publish.service';
import {
  type FetchResult,
  SOURCES,
  applyConnection,
  resolveSecret,
  toFetchResult,
} from './sources';

const BATCH_SIZE = 500;

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
    const logs: string[] = openingLogs(labels, snapshotId, connector.name);
    let fetched = 0;
    let written = 0;
    let transformVersion: number | undefined;

    try {
      const fetchResult = await this.fetch(connector);
      const records = fetchResult.records;
      fetched = records.length;
      logs.push(`Fetched ${fetched} records from ${connector.kind}.`);

      let rows: Array<Record<string, unknown>> = records.filter(
        (record): record is Record<string, unknown> =>
          typeof record === 'object' && record !== null && !Array.isArray(record),
      );

      if (connector.transformId) {
        const transform = await this.pipeline.getTransform(connector.transformId);
        if (!transform) {
          throw new Error(
            `Transform ${connector.transformId} is gone. A connector pointing at code that no longer exists must fail rather than load raw records under a shape nobody chose.`,
          );
        }
        transformVersion = transform.version;
        const result = await this.transforms.run(transform, records);
        rows = result.rows;
        logs.push(
          `Transform "${transform.name}" v${transform.version} produced ${rows.length} rows in ${result.elapsedMs}ms.`,
          ...result.logs.slice(0, 50),
        );
      }

      // Batches of the same size the publish protocol expects, numbered so a
      // retry replaces rather than appends.
      //
      // A FULL source that returned nothing still writes one — an empty batch,
      // where the loop below writes none. A batch is the only thing that
      // creates the snapshot, so without this a full load of zero rows left no
      // snapshot at all and the commit a few lines down refused with "no
      // snapshot has been written": an error naming the wrong event entirely,
      // for a source that answered perfectly and had nothing to say.
      //
      // It also carries the labels, which is where an operator's
      // acknowledgement that this collapse was deliberate travels — so the one
      // case `expectShrink` exists for, a source that really was emptied, was
      // the one case where it could not arrive.
      //
      // FULL only, and the asymmetry is not an oversight. An incremental run
      // that fetched nothing is already covered: the carry-forward below writes
      // the snapshot and carries the same labels, deliberately, and adding a
      // batch here would put a second write on a path that already has one.
      //
      // An empty batch is a statement — the load ran and produced nothing.
      // Writing no batch at all is silence, and the store cannot tell silence
      // from a crash.
      written += await this.appendBatches(connector, principalId, snapshotId, rows, labels);

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
      if (fetchResult.state) {
        await this.pipeline.saveConnectorState(connector.id, {
          ...connector.state,
          ...fetchResult.state,
        });
        logs.push(`Advanced state: ${Object.keys(fetchResult.state).join(', ')}.`);
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

      const finished = await this.pipeline.finishRun(run.id, {
        status: 'succeeded',
        fetched,
        written,
        logs,
        transformVersion,
      });
      this.logger.log(`${connector.name}: ${fetched} fetched, ${written} written as ${snapshotId}`);
      return finished ?? run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push(`Failed: ${message}`);

      emitCatalog('connector.run.finished', {
        connectorId,
        connectorName: connector.name,
        typeName: connector.targetType,
        snapshotId,
        principalId,
        status: 'failed',
        fetched,
        written,
        error: message,
        transformVersion,
      });

      // The snapshot is left written and uncommitted on purpose: nobody reads
      // it, and it is still there to look at when working out what went wrong.
      const finished = await this.pipeline.finishRun(run.id, {
        status: 'failed',
        fetched,
        written,
        logs,
        error: message,
        transformVersion,
      });
      this.logger.warn(`${connector.name} failed: ${message}`);
      return finished ?? run;
    }
  }

  /** Pull the raw records. Shaping is the transform's job, not this one's. */
  /**
   * Every batch this load writes, and — for a full load that read nothing — the
   * one empty batch that would otherwise not exist.
   *
   * Extracted from `run` because `run` had grown past the point where a reader
   * could hold it, not to hide anything: the two calls below are the same call
   * with different rows, and the interesting part is which of them happens.
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
    rows: Array<Record<string, unknown>>,
    labels: Record<string, string>,
  ): Promise<number> {
    // Numbered so a retry replaces rather than appends.
    let batch = 1;
    let written = 0;

    if (rows.length === 0 && connector.mode !== 'incremental') {
      await this.publish.appendRowsAsSystem(
        principalId,
        connector.targetType,
        snapshotId,
        [],
        labels,
        batch,
      );
      return 0;
    }

    for (let index = 0; index < rows.length; index += BATCH_SIZE) {
      const result = await this.publish.appendRowsAsSystem(
        principalId,
        connector.targetType,
        snapshotId,
        rows.slice(index, index + BATCH_SIZE),
        labels,
        batch,
      );
      written += result.written;
      batch += 1;
    }
    return written;
  }

  private async fetch(rawConnector: CatalogConnector): Promise<FetchResult> {
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
    return toFetchResult(
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
