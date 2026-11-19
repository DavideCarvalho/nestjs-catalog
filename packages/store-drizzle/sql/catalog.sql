CREATE TABLE IF NOT EXISTS "catalog_saved_query" (
  "id" varchar(64) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "description" text,
  "sql" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "folder" varchar(128),
  "created_by" varchar(128) NOT NULL,
  "cache_ttl_seconds" integer NOT NULL DEFAULT 0,
  "visualization" jsonb NOT NULL,
  "shared" boolean NOT NULL DEFAULT false,
  "created_at" timestamp (3) with time zone NOT NULL,
  "updated_at" timestamp (3) with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "catalog_saved_query_folder_idx" ON "catalog_saved_query" ("folder");

CREATE TABLE IF NOT EXISTS "catalog_dashboard" (
  "id" varchar(64) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "description" text,
  "created_by" varchar(128) NOT NULL,
  "cards" jsonb NOT NULL,
  "shared" boolean NOT NULL DEFAULT false,
  "created_at" timestamp (3) with time zone NOT NULL,
  "updated_at" timestamp (3) with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "catalog_audit_event" (
  "id" varchar(64) PRIMARY KEY,
  "event" varchar(64) NOT NULL,
  "type_name" varchar(128),
  "principal_id" varchar(128),
  "snapshot_id" varchar(128),
  "detail" jsonb NOT NULL,
  "occurred_at" timestamp (3) with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "catalog_audit_event_occurred_at_idx" ON "catalog_audit_event" ("occurred_at");

CREATE INDEX IF NOT EXISTS "catalog_audit_event_type_name_idx" ON "catalog_audit_event" ("type_name", "occurred_at");

CREATE INDEX IF NOT EXISTS "catalog_audit_event_principal_id_idx" ON "catalog_audit_event" ("principal_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "catalog_audit_event_snapshot_id_idx" ON "catalog_audit_event" ("snapshot_id", "occurred_at");

CREATE TABLE IF NOT EXISTS "catalog_revision" (
  "id" varchar(160) PRIMARY KEY,
  "subject_kind" varchar(16) NOT NULL,
  "subject_id" varchar(64) NOT NULL,
  "version" integer NOT NULL,
  "body" text NOT NULL,
  "authored_by" varchar(128) NOT NULL,
  "authored_at" timestamp (3) with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "catalog_revision_subject_idx" ON "catalog_revision" ("subject_kind", "subject_id", "version");

CREATE TABLE IF NOT EXISTS "catalog_overlay" (
  "id" varchar(64) PRIMARY KEY,
  "document" jsonb NOT NULL,
  "updated_at" timestamp (3) with time zone NOT NULL
);
