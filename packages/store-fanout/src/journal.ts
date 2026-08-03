import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Where a follower's debt to the primary is written down.
 *
 * **Why this exists at all.** The whole risk of writing to two stores is that
 * one of them quietly stops keeping up. Nobody notices, because nothing reads
 * from it — that is the point of a follower — and the discovery happens at
 * cutover, three days and four hundred loads later, when it is far too late to
 * reconstruct what was missed. So every interaction with a follower leaves a
 * durable trace: an entry is written *before* the attempt and removed only when
 * the attempt is known to have succeeded. A process that dies mid-attempt
 * therefore leaves an entry behind, which is exactly right — a crash and a
 * failure are the same fact from the primary's point of view, and both mean the
 * follower may not hold what the primary holds.
 *
 * **Why it is not a table in another package.** The obvious home would be
 * alongside the snapshot rows of whichever adapter is in use, but this package
 * composes adapters it must not depend on, and the record has to survive the
 * adapter being swapped — that is the entire migration story. It also has to
 * survive the *follower* being unreachable, which rules out storing it there.
 * So the journal is an interface with a file-backed default, and a deployment
 * that wants it in its own database implements four methods.
 *
 * **What it is not.** It is not a queue and not a retry loop. Nothing in this
 * package drains it in the background: a recorded failure is repaired by an
 * operator running a replay, or by the load's own retry re-sending the batches.
 * A journal that silently healed itself would be a journal whose entries nobody
 * ever reads, and the whole value here is that somebody reads them.
 */

/** Which step of a load an entry is about. */
export const FANOUT_STAGES = ['ensureType', 'write', 'carryForward', 'commit', 'drop'] as const;

export type FanoutStage = (typeof FANOUT_STAGES)[number];

export function isFanoutStage(value: unknown): value is FanoutStage {
  return typeof value === 'string' && FANOUT_STAGES.some((stage) => stage === value);
}

export const FANOUT_ENTRY_STATUSES = [
  /** An attempt was announced and never reported back. A crash looks like this. */
  'pending',
  /** The attempt returned an error. */
  'failed',
  /** Not attempted, because earlier steps of this snapshot had already failed. */
  'heldBack',
] as const;

export type FanoutEntryStatus = (typeof FANOUT_ENTRY_STATUSES)[number];

export function isFanoutEntryStatus(value: unknown): value is FanoutEntryStatus {
  return typeof value === 'string' && FANOUT_ENTRY_STATUSES.some((status) => status === value);
}

/**
 * One thing a follower owes the primary.
 *
 * Keyed down to the batch on purpose. A load whose batch 3 failed and whose
 * batch 4 succeeded owes exactly batch 3, and an entry recorded per snapshot
 * rather than per batch would be cleared by the success of batch 4 — which is
 * how a follower ends up committing a snapshot that is one batch short while
 * the journal reports it clean.
 */
export interface FanoutJournalEntry {
  /** `type:snapshot:follower:stage:batch`. Built by {@link fanoutEntryKey}. */
  key: string;
  typeName: string;
  snapshotId: string;
  follower: string;
  stage: FanoutStage;
  /** Only meaningful for `write`. Absent for the whole-snapshot stages. */
  batch?: number;
  status: FanoutEntryStatus;
  /** The message the follower produced. Absent while `pending`. */
  error?: string;
  /** How many times this exact step has been announced and not settled. */
  attempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * The snapshot the fan-out last committed on the primary, per type.
 *
 * Kept here because there is nowhere else to keep it. A `SnapshotRef` carries no
 * "is this the one being served" flag and `CatalogWriteStore` exposes no way to
 * ask which snapshot is current, so a replay has no way to tell whether the
 * snapshot it is repairing is the live one — and committing an old snapshot on a
 * follower is precisely how a follower ends up serving last week. The fan-out
 * knows the answer because it performed the commit, so it writes it down.
 */
export interface FanoutCommitMark {
  typeName: string;
  snapshotId: string;
  at: string;
  principalId?: string;
}

export interface FanoutJournalQuery {
  typeName?: string;
  snapshotId?: string;
  follower?: string;
}

export interface CatalogFanoutJournal {
  /**
   * Write or update an entry. Idempotent per `key`: a second announcement of the
   * same step bumps `attempts` and `lastSeenAt` rather than adding a row.
   *
   * Returns whether an entry for that key already existed. Announcing a step
   * that was already owed is the only way to tell a first attempt from a repair,
   * and the caller needs to know so that an ordinary successful load is not
   * reported as a recovery from a debt it never had.
   */
  record(entry: FanoutJournalEntry): Promise<boolean>;

  /**
   * The step succeeded; the follower no longer owes it.
   *
   * Returns whether anything was actually owed. That is not bookkeeping: a
   * success that cleared a real debt is a recovery worth announcing, and a
   * success on the first attempt is not — and asking the journal afterwards
   * would cost a second round trip on the load path for every batch of every
   * follower.
   */
  resolve(key: string): Promise<boolean>;

  /** Everything still owed, newest last. */
  outstanding(query?: FanoutJournalQuery): Promise<FanoutJournalEntry[]>;

  /** Record that the primary committed this snapshot for this type. */
  markCommitted(mark: FanoutCommitMark): Promise<void>;

  /** The last snapshot the primary committed for a type, if this journal saw it. */
  lastCommitted(typeName: string): Promise<FanoutCommitMark | undefined>;
}

/**
 * The one place the entry key is assembled, so it cannot drift.
 *
 * Joined with unit separators rather than colons, because a snapshot id is
 * opaque and caller-supplied — the core interface says so, and a durable run id
 * is the suggested choice. A caller whose ids contained the separator would
 * collapse two distinct steps onto one key, and resolving either would resolve
 * both.
 */
export function fanoutEntryKey(parts: {
  typeName: string;
  snapshotId: string;
  follower: string;
  stage: FanoutStage;
  batch?: number;
}): string {
  const batch = parts.batch === undefined ? '-' : String(parts.batch);
  return `${parts.typeName}\u001f${parts.snapshotId}\u001f${parts.follower}\u001f${parts.stage}\u001f${batch}`;
}

/**
 * A sentinel snapshot id for entries that belong to a type rather than a load.
 *
 * `ensureType` runs outside any snapshot, and a schema change a follower refused
 * still has to be recorded somewhere a commit will look. Given a value no caller
 * produces, it is separable from a real snapshot id by comparison rather than by
 * convention — the same reasoning that makes the MikroORM store's carry-forward
 * batch negative.
 */
export const FANOUT_SCHEMA_SCOPE = '\u001fschema\u001f';

function matches(entry: FanoutJournalEntry, query?: FanoutJournalQuery): boolean {
  if (!query) return true;
  if (query.typeName !== undefined && entry.typeName !== query.typeName) {
    return false;
  }
  if (query.snapshotId !== undefined && entry.snapshotId !== query.snapshotId) {
    return false;
  }
  if (query.follower !== undefined && entry.follower !== query.follower) {
    return false;
  }
  return true;
}

/**
 * The journal for tests, and for a deployment that genuinely does not care.
 *
 * Not the default, and it should not be: a follower failure that disappears on
 * the next deploy is the failure mode this whole design exists to prevent. It is
 * offered because a test that has to touch the filesystem to assert on a
 * dual-write is a test nobody writes.
 */
export class InMemoryFanoutJournal implements CatalogFanoutJournal {
  private readonly entries = new Map<string, FanoutJournalEntry>();
  private readonly commits = new Map<string, FanoutCommitMark>();

  async record(entry: FanoutJournalEntry): Promise<boolean> {
    const existing = this.entries.get(entry.key);
    this.entries.set(entry.key, mergeEntry(existing, entry));
    return existing !== undefined;
  }

  async resolve(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async outstanding(query?: FanoutJournalQuery): Promise<FanoutJournalEntry[]> {
    return Array.from(this.entries.values()).filter((entry) => matches(entry, query));
  }

  async markCommitted(mark: FanoutCommitMark): Promise<void> {
    this.commits.set(mark.typeName, mark);
  }

  async lastCommitted(typeName: string): Promise<FanoutCommitMark | undefined> {
    return this.commits.get(typeName);
  }
}

/** One line of the log file. Discriminated so a reader can fold the file. */
type JournalLine =
  | { op: 'record'; entry: FanoutJournalEntry }
  | { op: 'resolve'; key: string }
  | { op: 'commit'; mark: FanoutCommitMark };

/**
 * The default: an append-only JSONL file, folded on read.
 *
 * Append-only rather than rewrite-on-change because the write happens on the
 * load path, once per follower per batch, and rewriting the whole file there
 * would put the cost of every past failure into every future load. Folding on
 * read is cheap by comparison — the file is read once per process and compacted
 * when the dead lines outnumber the live entries.
 *
 * **The limit, stated plainly:** this is a single-process journal. Two pods
 * writing the same file interleave appends safely enough for a small line, but
 * compaction rewrites it, and a rewrite racing an append loses entries. A
 * deployment running more than one loader must supply a journal backed by
 * whatever it already uses for coordination. The interface is four methods
 * precisely so that is a short thing to write.
 */
export class FileFanoutJournal implements CatalogFanoutJournal {
  private entries = new Map<string, FanoutJournalEntry>();
  private commits = new Map<string, FanoutCommitMark>();
  private loaded = false;
  /** Lines in the file, live or dead. Drives compaction. */
  private lines = 0;
  /**
   * Every mutation goes through this chain.
   *
   * Not a nicety: `record` and `resolve` are called from a loop that does not
   * await between followers, and two overlapping `appendFile` calls on the same
   * descriptor can interleave partial lines. Serialising them keeps each line
   * whole, which is the only thing a JSONL file needs to stay parseable.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async record(entry: FanoutJournalEntry): Promise<boolean> {
    return this.mutate(async () => {
      await this.load();
      const existing = this.entries.get(entry.key);
      const merged = mergeEntry(existing, entry);
      this.entries.set(entry.key, merged);
      await this.append({ op: 'record', entry: merged });
      return existing !== undefined;
    });
  }

  async resolve(key: string): Promise<boolean> {
    return this.mutate(async () => {
      await this.load();
      const owed = this.entries.delete(key);
      // The line is appended even when nothing was owed. The file is the record
      // of what happened, not only of what is still wrong, and skipping the line
      // for a clean success would mean a `pending` written a moment earlier by
      // another process's interleaved append could never be cancelled.
      await this.append({ op: 'resolve', key });
      return owed;
    });
  }

  async outstanding(query?: FanoutJournalQuery): Promise<FanoutJournalEntry[]> {
    await this.load();
    return Array.from(this.entries.values()).filter((entry) => matches(entry, query));
  }

  async markCommitted(mark: FanoutCommitMark): Promise<void> {
    return this.mutate(async () => {
      await this.load();
      this.commits.set(mark.typeName, mark);
      await this.append({ op: 'commit', mark });
    });
  }

  async lastCommitted(typeName: string): Promise<FanoutCommitMark | undefined> {
    await this.load();
    return this.commits.get(typeName);
  }

  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    // The chain must not inherit a rejection, or one failed append would poison
    // every later journal write in the process — which would turn a transient
    // disk error into permanent silence about follower failures.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      // A journal that does not exist yet is an empty journal. Distinguishing
      // "missing" from "unreadable" here would buy nothing: both are repaired by
      // the same act, and refusing to boot over it would take the loader down
      // for a file that has never mattered until the first failure.
      return;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.lines += 1;
      const parsed = parseLine(trimmed);
      if (!parsed) continue;
      if (parsed.op === 'record') this.entries.set(parsed.entry.key, parsed.entry);
      else if (parsed.op === 'resolve') this.entries.delete(parsed.key);
      else this.commits.set(parsed.mark.typeName, parsed.mark);
    }
  }

  private async append(line: JournalLine): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8');
    this.lines += 1;
    await this.maybeCompact();
  }

  /**
   * Rewrite the file when most of it is dead.
   *
   * A healthy deployment resolves nearly everything it records, so the file is
   * almost entirely `resolve` lines for steps that succeeded. Left alone it
   * grows without bound and the fold at boot gets slower every day. The
   * threshold is deliberately loose — this runs on the load path, and trading a
   * larger file for fewer rewrites is the right way round.
   */
  private async maybeCompact(): Promise<void> {
    const live = this.entries.size + this.commits.size;
    if (this.lines < 512 || this.lines < live * 4) return;

    const lines: JournalLine[] = [
      ...Array.from(this.entries.values()).map((entry): JournalLine => ({ op: 'record', entry })),
      ...Array.from(this.commits.values()).map((mark): JournalLine => ({ op: 'commit', mark })),
    ];
    const body = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
    // Through a temporary file and a rename, because rename is atomic within a
    // filesystem: a crash during compaction leaves either the old journal or the
    // new one, never a truncated file. Truncating in place would have a window
    // in which the record of every outstanding failure is an empty file, and
    // that window is exactly when a crash is most likely — the process is
    // already doing something unusual.
    const temporary = `${this.path}.compacting`;
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, this.path);
    this.lines = lines.length;
  }
}

/**
 * Fold a re-announcement into what was already known.
 *
 * `firstSeenAt` survives and `attempts` accumulates, because "this follower has
 * failed the same batch nine times" and "it failed once" are different
 * situations and the second one is not worth waking anybody for.
 */
function mergeEntry(
  existing: FanoutJournalEntry | undefined,
  incoming: FanoutJournalEntry,
): FanoutJournalEntry {
  if (!existing) return incoming;
  return {
    ...incoming,
    firstSeenAt: existing.firstSeenAt,
    attempts: existing.attempts + incoming.attempts,
  };
}

/**
 * Parse one line, tolerating anything that is not one.
 *
 * A half-written last line is the normal state of an append-only file whose
 * process was killed, and refusing to read the journal because of it would
 * throw away every entry before it — the entries that say what the follower is
 * missing.
 */
function parseLine(line: string): JournalLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const op = Reflect.get(parsed, 'op');
  if (op === 'resolve') {
    const key = Reflect.get(parsed, 'key');
    return typeof key === 'string' ? { op: 'resolve', key } : undefined;
  }
  if (op === 'commit') {
    const mark = toCommitMark(Reflect.get(parsed, 'mark'));
    return mark ? { op: 'commit', mark } : undefined;
  }
  if (op === 'record') {
    const entry = toEntry(Reflect.get(parsed, 'entry'));
    return entry ? { op: 'record', entry } : undefined;
  }
  return undefined;
}

function toCommitMark(value: unknown): FanoutCommitMark | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const typeName = Reflect.get(value, 'typeName');
  const snapshotId = Reflect.get(value, 'snapshotId');
  const at = Reflect.get(value, 'at');
  const principalId = Reflect.get(value, 'principalId');
  if (typeof typeName !== 'string' || typeof snapshotId !== 'string' || typeof at !== 'string') {
    return undefined;
  }
  return {
    typeName,
    snapshotId,
    at,
    principalId: typeof principalId === 'string' ? principalId : undefined,
  };
}

function toEntry(value: unknown): FanoutJournalEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const key = Reflect.get(value, 'key');
  const typeName = Reflect.get(value, 'typeName');
  const snapshotId = Reflect.get(value, 'snapshotId');
  const follower = Reflect.get(value, 'follower');
  const stage = Reflect.get(value, 'stage');
  const status = Reflect.get(value, 'status');
  const attempts = Reflect.get(value, 'attempts');
  const firstSeenAt = Reflect.get(value, 'firstSeenAt');
  const lastSeenAt = Reflect.get(value, 'lastSeenAt');
  const batch = Reflect.get(value, 'batch');
  const error = Reflect.get(value, 'error');
  if (
    typeof key !== 'string' ||
    typeof typeName !== 'string' ||
    typeof snapshotId !== 'string' ||
    typeof follower !== 'string' ||
    !isFanoutStage(stage) ||
    !isFanoutEntryStatus(status) ||
    typeof firstSeenAt !== 'string' ||
    typeof lastSeenAt !== 'string'
  ) {
    return undefined;
  }
  return {
    key,
    typeName,
    snapshotId,
    follower,
    stage,
    status,
    batch: typeof batch === 'number' ? batch : undefined,
    error: typeof error === 'string' ? error : undefined,
    attempts: typeof attempts === 'number' ? attempts : 1,
    firstSeenAt,
    lastSeenAt,
  };
}
