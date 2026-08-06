import {
  ConnectorRow,
  ConnectorRunRow,
  MySqlPipelineStore,
  WorkflowRow,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';
import { WorkflowEngine } from '@dudousxd/nestjs-durable';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CatalogDatabase,
  openCatalogDatabase,
  startMySql,
} from '../../store-mikro-orm/test/mysql-harness';
import { ConnectorScheduler } from './connector-scheduler.service';
import { AbandonedRunReconciler } from './run-reconciler.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * What a mounted, **idle** catalog costs the application it is embedded in.
 *
 * ## The question this exists to answer
 *
 * This library mounts inside somebody else's NestJS process. Two of its services
 * run on a timer whether or not anybody has ever opened the console —
 * `ConnectorScheduler` every 30s and `AbandonedRunReconciler` every 5 minutes —
 * and a library that taxes an idle host is defective as a library however good
 * its features are. "Approximately nothing" is a measurable claim, and this
 * measures it: the real classes, against a real MySQL, rather than a fake that
 * answers instantly with objects no driver had to parse.
 *
 * ## What it measures, and what each number means
 *
 * - **`sql`** — every statement that reached the driver, counted by wrapping the
 *   connection. Deterministic, so it is what the assertions are written against:
 *   a change that adds a query per scheduled graph per tick fails here rather
 *   than on somebody's deployment.
 * - **`blockedMs`** — how long the operation held the event loop *without
 *   yielding*, summed. Measured with a 1ms heartbeat: every gap longer than
 *   {@link BLOCK_FLOOR_MS} is time during which nothing else in the host could
 *   run, which for an embedded library is the number that actually matters. It
 *   is what separates "1.5% average CPU" from "10ms of event-loop lag": a burst
 *   of synchronous parsing is invisible in the first and is the whole of the
 *   second.
 * - **`longestBlockMs`** — the worst single gap. One 40ms stall and forty 1ms
 *   ones cost the same CPU and are not the same thing to a request waiting
 *   behind them.
 * - **`wallMs`** — context only. Most of it is the database answering, which
 *   costs the host nothing.
 *
 * ## What it does not prove
 *
 * One process against a local container, so `wallMs` says nothing about a
 * deployment whose database is a network away. Nothing about memory. And the
 * seed is a *shape*, not a census — the constants are named so a reader can
 * scale them to their own deployment rather than trusting that this one
 * resembles it. `sql` and `blockedMs` are the transferable numbers, because
 * neither depends on the link.
 *
 * Timings are reported, never asserted: a bound on a millisecond count is a test
 * that fails on a loaded CI box for no reason. The assertions are all on `sql`,
 * which is the same number everywhere.
 */

/** Scheduled, ready and enabled: the graphs that could cost a window. */
const RUNNABLE_WORKFLOWS = 12;
/** Scheduled and not runnable — a draft, or switched off. Costs a complaint. */
const PARKED_WORKFLOWS = 4;
/** No cron at all. Read on every tick regardless, which is the point. */
const UNSCHEDULED_WORKFLOWS = 4;
const ALL_WORKFLOWS = RUNNABLE_WORKFLOWS + PARKED_WORKFLOWS + UNSCHEDULED_WORKFLOWS;
/** Nodes per graph. A published pipeline of a source, some transforms, a sink. */
const NODES_PER_GRAPH = 10;

/**
 * How many finished run rows sit in the table.
 *
 * `RECONCILE_SCAN_LIMIT` is 200, so this is the reconciler's window filled: the
 * pass reads the 200 most recent runs on every deployment that has had 200 runs,
 * which after a fortnight of nightly loads on a dozen pipelines is all of them.
 */
const RUN_ROWS = 200;

/**
 * Log lines on a finished run, and characters per line — two sizes, because the
 * difference between them is the point.
 *
 * `ORDINARY` is a load that logged its plan and its per-node counts. `CAPPED` is
 * the largest row the runner will ever write: `LOG_LINES_PER_RUN` is 200 and
 * `LOG_LINE_CHARS` is 400, so 80KB in this one column, times 200 rows in the
 * window. Both are measured because an embedded library has to be judged on
 * what it permits, not only on what a tidy deployment happens to hold.
 */
const ORDINARY_LOG = { lines: 60, chars: 180 };
const CAPPED_LOG = { lines: 200, chars: 400 };

/** Gaps at or under this are the runtime's own noise, not this library's. */
const BLOCK_FLOOR_MS = 2;

const LONG_AGO = new Date('2026-01-01T00:00:00Z');

let container: StartedMySqlContainer;
/** The ordinary deployment. Every assertion below is about this one. */
let db: CatalogDatabase;
let store: MySqlPipelineStore;
/** The same shape with run logs at the bound the runner permits. */
let cappedDb: CatalogDatabase;
let cappedStore: MySqlPipelineStore;

interface Cost {
  sql: number;
  statements: string[];
  blockedMs: number;
  longestBlockMs: number;
  wallMs: number;
}

/**
 * Run `work`, and report what it cost the process that was hosting it.
 *
 * The heartbeat is a 1ms interval whose callback records how long it waited. A
 * gap of 40ms means the loop was held for 40ms, which is exactly what an
 * embedded library must not do to its host — and it is invisible to a CPU
 * percentage, because holding the loop and using the CPU are the same thing for
 * as long as it lasts, and the average over an hour is still nothing.
 *
 * The SQL counter wraps the connection rather than reading MikroORM's logger, so
 * it sees the raw statements the store issues directly as well as the ones the
 * ORM builds.
 */
async function measure(on: CatalogDatabase, work: () => Promise<void>): Promise<Cost> {
  const connection = on.orm.em.getConnection();
  const statements: string[] = [];
  const original = Reflect.get(connection, 'execute');
  if (typeof original !== 'function') {
    throw new Error('The connection has no execute to count through.');
  }
  Reflect.set(connection, 'execute', (...args: unknown[]) => {
    statements.push(String(args[0]).slice(0, 160));
    return Reflect.apply(original, connection, args);
  });

  try {
    return { ...(await measureLoop(work)), sql: statements.length, statements };
  } finally {
    Reflect.set(connection, 'execute', original);
  }
}

/**
 * The same instrument without the statement counter, for work that happens
 * before there is a connection to count through — a boot, most of all.
 */
async function measureLoop(work: () => Promise<void>): Promise<Cost> {
  const gaps: number[] = [];
  let last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 1);

  const started = performance.now();
  // Deliberately not a `finally` that returns the cost: a `return` inside
  // `finally` discards a throw, so a measurement whose work failed would report
  // a plausible zero rather than failing. That happened here once already.
  try {
    await work();
  } finally {
    clearInterval(heartbeat);
  }

  const wallMs = performance.now() - started;
  const blocking = gaps.filter((gap) => gap > BLOCK_FLOOR_MS);
  return {
    sql: 0,
    statements: [],
    blockedMs: round(blocking.reduce((total, gap) => total + gap, 0)),
    longestBlockMs: round(Math.max(0, ...blocking)),
    wallMs: round(wallMs),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function report(what: string, cost: Cost): void {
  console.log(
    `[idle-cost] ${what}: ${cost.sql} statements, ${cost.blockedMs}ms blocked (worst gap ${cost.longestBlockMs}ms), ${cost.wallMs}ms wall`,
  );
}

/**
 * An engine that answers and records, so a tick and a pass can be driven without
 * one.
 *
 * Built with `Object.create` on the `WorkflowEngine` the `vi.mock` above
 * installs, rather than with `new`: the real class's constructor takes a deps
 * object this environment cannot build, and the alternative — asserting a plain
 * object into the type — would be a claim the compiler cannot check. This is a
 * value genuinely linked to that prototype, so no assertion is needed anywhere.
 *
 * Every run it is asked about is `succeeded`, so the reconciler reaches its
 * "nothing to close" ending, which is the pass a healthy deployment makes.
 */
interface QuietEngine {
  readonly started: string[];
  readonly engine: WorkflowEngine;
}

function quietEngine(): QuietEngine {
  const started: string[] = [];
  const engine = Object.create(WorkflowEngine.prototype);
  engine.start = (_workflow: unknown, _input: unknown, runId: string) => {
    started.push(runId);
    return Promise.resolve(runId);
  };
  engine.getRun = () => Promise.resolve({ status: 'succeeded' });
  return { started, engine };
}

function graph(id: string): { nodes: unknown[]; edges: unknown[] } {
  const nodes: unknown[] = [
    {
      id: `${id}-in`,
      name: 'Warehouse',
      kind: 'source',
      sourceKind: 'sql',
      config: {
        url: 'mysql://reader@warehouse.internal:3306/staging',
        query: 'SELECT * FROM inbound WHERE updated_at > :watermark ORDER BY updated_at',
        watermarkColumn: 'updated_at',
      },
      position: { x: 0, y: 80 },
    },
  ];
  for (let index = 0; index < NODES_PER_GRAPH - 2; index += 1) {
    nodes.push({
      id: `${id}-t${index}`,
      name: `Normalise ${index}`,
      kind: 'transform',
      transformId: `transform-${id}-${index}`,
      position: { x: 120 * (index + 1), y: 80 },
    });
  }
  nodes.push({
    id: `${id}-out`,
    name: 'Publish',
    kind: 'sink',
    targetType: 'Mvr',
    position: { x: 120 * NODES_PER_GRAPH, y: 80 },
  });

  const edges: unknown[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push({
      from: String(Reflect.get(Object(nodes[index]), 'id')),
      to: String(Reflect.get(Object(nodes[index + 1]), 'id')),
    });
  }
  return { nodes, edges };
}

async function seed(on: CatalogDatabase, log: { lines: number; chars: number }): Promise<void> {
  const em = on.orm.em.fork();
  const kinds: Array<{ count: number; status: string; enabled: boolean; cron?: string }> = [
    { count: RUNNABLE_WORKFLOWS, status: 'ready', enabled: true, cron: '0 3 * * *' },
    { count: PARKED_WORKFLOWS, status: 'draft', enabled: true, cron: '0 4 * * *' },
    { count: UNSCHEDULED_WORKFLOWS, status: 'ready', enabled: true, cron: undefined },
  ];

  let n = 0;
  for (const kind of kinds) {
    for (let index = 0; index < kind.count; index += 1) {
      const id = `w${n}`;
      const { nodes, edges } = graph(id);
      em.create(WorkflowRow, {
        id,
        name: `Pipeline ${String(n).padStart(2, '0')}`,
        nodes,
        edges,
        status: kind.status,
        version: 4,
        graphHash: `hash-${id}`,
        targetType: 'Mvr',
        schedule: kind.cron,
        enabled: kind.enabled,
        createdBy: 'ana',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      });
      em.create(ConnectorRow, {
        id: `c${n}`,
        name: `Pipeline ${String(n).padStart(2, '0')}`,
        kind: 'sql',
        targetType: 'Mvr',
        config: { url: 'mysql://reader@warehouse.internal:3306/staging' },
        workflowId: id,
        enabled: true,
        createdBy: 'ana',
        createdAt: LONG_AGO,
        // Ahead of every window `0 3 * * *` can produce for "now", so the
        // scheduler reaches its not-due branch rather than starting real runs.
        // That is the steady state being measured: a tick on a deployment where
        // nothing is due, which is 2,879 ticks out of every 2,880 for a nightly
        // schedule.
        updatedAt: new Date(Date.now() + 86_400_000),
      });
      n += 1;
    }
  }

  const line = 'x'.repeat(log.chars);
  const logs = Array.from({ length: log.lines }, (_, index) => `${index}: ${line}`);
  for (let index = 0; index < RUN_ROWS; index += 1) {
    em.create(ConnectorRunRow, {
      id: `r${index}`,
      connectorId: `c${index % ALL_WORKFLOWS}`,
      snapshotId: `snap-${index}`,
      principalId: 'scheduler',
      status: 'succeeded',
      fetched: 1200,
      written: 1200,
      logs,
      executionMode: 'durable',
      workflowId: `w${index % RUNNABLE_WORKFLOWS}`,
      workflowVersion: 4,
      graphHash: 'hash',
      nodeOutcomes: {},
      startedAt: new Date(Date.now() - index * 60_000),
      finishedAt: new Date(Date.now() - index * 60_000 + 30_000),
    });
  }

  await em.flush();
}

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'idle_cost');
  store = new MySqlPipelineStore(db.em);
  await seed(db, ORDINARY_LOG);

  cappedDb = await openCatalogDatabase(container, 'idle_cost_capped');
  cappedStore = new MySqlPipelineStore(cappedDb.em);
  await seed(cappedDb, CAPPED_LOG);
}, 300_000);

afterAll(async () => {
  await db?.close();
  await cappedDb?.close();
  await container?.stop();
});

describe('a mounted but idle catalog', () => {
  /**
   * The steady-state tick: every graph is scheduled, none of them is due.
   *
   * Run twice, and the second one is the measurement, because that is the tick a
   * host actually pays for — the first of a process's life is allowed to be the
   * expensive one, and 2,879 of every 2,880 are not.
   */
  it('costs one statement per tick once it has seen the window', async () => {
    const engine = quietEngine();
    // `enabled` and the scope are left at their defaults, which is what a host
    // that mounts the module without opinions gets.
    const loop = new ConnectorScheduler(store, engine.engine);

    const first = await measure(db, () => loop.tick());
    report('scheduler tick (first)', first);

    const steady = await measure(db, () => loop.tick());
    report('scheduler tick (steady, 30s)', steady);

    // Nothing was due, so nothing started — the tick under measurement is the
    // idle one, not one doing real work.
    expect(engine.started).toEqual([]);
    // One `listWorkflows`. The connector lookup behind each scheduled graph is
    // what this pins: a tick that re-resolves them all is a tick whose cost
    // grows with how many pipelines the deployment has drawn.
    expect(steady.sql).toBe(1);
  });

  /**
   * The half of the tick that scales with what a deployment has drawn rather
   * than with how many of those graphs carry a cron. A tick needs six columns of
   * this row and is handed every node and edge as well.
   */
  it('reads every graph in full to find out which ones carry a cron', async () => {
    const cost = await measure(db, async () => {
      const workflows = await store.listWorkflows();
      expect(workflows).toHaveLength(ALL_WORKFLOWS);
    });
    report('listWorkflows', cost);
    expect(cost.sql).toBe(1);
  });

  /**
   * A pass over the run window with nothing to close, which is every pass on a
   * deployment where nothing is wrong.
   */
  it('costs one scan of the run window per reconciling pass', async () => {
    const reconciler = new AbandonedRunReconciler(store, quietEngine().engine);
    const cost = await measure(db, () => reconciler.pass());
    report('reconciler pass (5m)', cost);

    // One `listRuns`. A `listConnectors` beside it would be names read before
    // it is known that anything needs naming.
    expect(cost.sql).toBe(1);
  });

  /**
   * The same pass against run rows at the size the runner is allowed to write.
   *
   * Reported rather than asserted, and it is the number that says what the
   * remaining cost *is*: the window is read with its `logs` column, which the
   * pass does not look at except for the rows it closes.
   */
  it('pays for the run logs it reads, at the bound the runner permits', async () => {
    const reconciler = new AbandonedRunReconciler(cappedStore, quietEngine().engine);
    const cost = await measure(cappedDb, () => reconciler.pass());
    report('reconciler pass (5m, logs at the cap)', cost);
    expect(cost.sql).toBe(1);
  });
});

/**
 * The other half of the question, and on an API-role process the only half.
 *
 * A host turns both loops off there — `scheduler: false`, and `reconcileRuns`
 * defaults to it — so an API pod pays nothing above until somebody opens the
 * console. What it pays *then* is this, and it is main-thread work rather than
 * database work: the rows come back as JSON strings and something has to parse
 * them before the response can be built.
 */
describe('what the console costs the API process serving it', () => {
  /**
   * `GET pipeline/runs`, which is the runs screen's first request.
   *
   * The store's default page is 50 rows and every one of them carries its whole
   * `logs` array — which the screen does want, unlike the reconciler above. The
   * number is here so the size of that page is a decision somebody made with it
   * in front of them.
   */
  it('parses a page of run logs to answer the runs screen', async () => {
    const ordinary = await measure(db, async () => {
      const runs = await store.listRuns(undefined, 50);
      expect(runs).toHaveLength(50);
    });
    report('GET pipeline/runs (50 rows)', ordinary);

    const capped = await measure(cappedDb, async () => {
      await cappedStore.listRuns(undefined, 50);
    });
    report('GET pipeline/runs (50 rows, logs at the cap)', capped);

    expect(ordinary.sql).toBe(1);
    expect(capped.sql).toBe(1);
  });

  /**
   * What mounting the store costs before it answers anything.
   *
   * An API process pays this whether or not the console is ever opened: a second
   * MikroORM connection, discovery over this package's 15 entities, and
   * `ensureCatalogSchema`. The schema pass is fingerprint-gated — a steady-state
   * boot is one `CREATE TABLE IF NOT EXISTS` and one `SELECT` — so what is being
   * measured here is the ORM's own discovery, which is the synchronous half and
   * the one that could show up as a stall while the host is coming up.
   *
   * Measured against a database that already has the schema, because that is
   * every boot after the first.
   */
  it('costs one ORM discovery and two statements to mount on a booted database', async () => {
    let opened: CatalogDatabase | undefined;
    const cost = await measureLoop(async () => {
      opened = await openCatalogDatabase(container, 'idle_cost');
    });
    report('mounting the store (second connection, schema already applied)', cost);
    await opened?.close();
  });
});
