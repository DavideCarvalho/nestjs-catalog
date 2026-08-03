import {
  CATALOG_PIPELINE_STORE,
  type CatalogConnector,
  type CatalogPipelineStore,
  type ConnectorRun,
  SubprocessTransformRunner,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
   */
  async run(connectorId: string, principalId: string, snapshotId: string): Promise<ConnectorRun> {
    const connector = await this.pipeline.getConnector(connectorId);
    if (!connector) {
      throw new NotFoundException(`No connector ${connectorId}`);
    }
    if (!connector.enabled) {
      throw new BadRequestException(`"${connector.name}" is disabled. Enable it before running.`);
    }

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

    const logs: string[] = [];
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
      let batch = 1;
      for (let index = 0; index < rows.length; index += BATCH_SIZE) {
        const slice = rows.slice(index, index + BATCH_SIZE);
        const result = await this.publish.appendRowsAsSystem(
          principalId,
          connector.targetType,
          snapshotId,
          slice,
          { source: 'connector', connector: connector.name },
          batch,
        );
        written += result.written;
        batch += 1;
      }

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
        const merged = await this.publish.carryForwardAsSystem(
          principalId,
          connector.targetType,
          snapshotId,
          { source: 'connector', connector: connector.name },
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
