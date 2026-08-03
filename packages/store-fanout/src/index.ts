export {
  composeCapabilities,
  explainCapabilities,
  type NamedCapabilities,
} from './capabilities';
export {
  DEFAULT_COMPARE_PAGE_SIZE,
  digestSide,
  explainComparison,
  type FanoutComparison,
  type FanoutSideDigest,
  keyProperties,
} from './compare';
export {
  CATALOG_FANOUT_EVENTS,
  CATALOG_FANOUT_LIB,
  type CatalogFanoutEvent,
  type CatalogFanoutEventPayloads,
  emitFanout,
  fanoutChannelNameFor,
} from './events';
export { CatalogFanoutStoreModule } from './fanout.module';
export {
  asWriteStore,
  CatalogFanoutError,
  FanoutCatalogStore,
  type FanoutFailure,
  type FanoutFollower,
  type FanoutPrimary,
} from './fanout.store';
export {
  type CatalogFanoutJournal,
  FANOUT_ENTRY_STATUSES,
  FANOUT_SCHEMA_SCOPE,
  FANOUT_STAGES,
  type FanoutCommitMark,
  type FanoutEntryStatus,
  type FanoutJournalEntry,
  type FanoutJournalQuery,
  type FanoutStage,
  fanoutEntryKey,
  FileFanoutJournal,
  InMemoryFanoutJournal,
  isFanoutEntryStatus,
  isFanoutStage,
} from './journal';
export {
  CatalogFanoutMigration,
  DEFAULT_REPLAY_BATCH_SIZE,
  type FanoutFollowerStatus,
  type FanoutReplayResult,
  type FanoutStatus,
  type FanoutVerification,
} from './migration';
export {
  CATALOG_FANOUT_FOLLOWERS,
  CATALOG_FANOUT_JOURNAL,
  CATALOG_FANOUT_OPTIONS,
  CATALOG_FANOUT_PRIMARY,
  type CatalogFanoutStoreModuleOptions,
  DEFAULT_FOLLOWER_STRICTNESS,
  DEFAULT_JOURNAL_PATH,
  type FanoutFollowerOptions,
  type FanoutParticipantOptions,
  FOLLOWER_STRICTNESS,
  type FollowerStrictness,
  isFollowerStrictness,
} from './options';
