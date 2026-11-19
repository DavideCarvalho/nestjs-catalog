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
  "created_at" timestamp (6) with time zone NOT NULL,
  "updated_at" timestamp (6) with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "catalog_saved_query_folder_index" ON "catalog_saved_query" ("folder");

CREATE TABLE IF NOT EXISTS "catalog_dashboard" (
  "id" varchar(64) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "description" text,
  "created_by" varchar(128) NOT NULL,
  "cards" jsonb NOT NULL,
  "shared" boolean NOT NULL DEFAULT false,
  "created_at" timestamp (6) with time zone NOT NULL,
  "updated_at" timestamp (6) with time zone NOT NULL
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

CREATE INDEX IF NOT EXISTS "catalog_audit_event_occurred_at_index" ON "catalog_audit_event" ("occurred_at");

CREATE INDEX IF NOT EXISTS "catalog_audit_event_type_name_occurred_at_index" ON "catalog_audit_event" ("type_name", "occurred_at");

CREATE INDEX IF NOT EXISTS "catalog_audit_event_principal_id_occurred_at_index" ON "catalog_audit_event" ("principal_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "catalog_audit_event_snapshot_id_occurred_at_index" ON "catalog_audit_event" ("snapshot_id", "occurred_at");

CREATE TABLE IF NOT EXISTS "catalog_revision" (
  "id" varchar(160) PRIMARY KEY,
  "subject_kind" varchar(16) NOT NULL,
  "subject_id" varchar(64) NOT NULL,
  "version" integer NOT NULL,
  "body" text NOT NULL,
  "authored_by" varchar(128) NOT NULL,
  "authored_at" timestamp (3) with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "catalog_revision_subject_kind_subject_id_version_index" ON "catalog_revision" ("subject_kind", "subject_id", "version");

CREATE TABLE IF NOT EXISTS "catalog_overlay" (
  "id" varchar(64) PRIMARY KEY,
  "document" jsonb NOT NULL,
  "updated_at" timestamp (3) with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "catalog_object_type" (
  "name" varchar(128) PRIMARY KEY,
  "owner_principal_id" varchar(128) NOT NULL,
  "display_name" varchar(255) NOT NULL,
  "plural_display_name" varchar(255) NOT NULL,
  "description" text,
  "icon" varchar(32),
  "group" varchar(128) NOT NULL DEFAULT 'Ungrouped',
  "title_property" varchar(128),
  "primary_key" jsonb NOT NULL,
  "physical_table" varchar(128) NOT NULL,
  "relations" jsonb,
  "current_snapshot_id" varchar(128),
  "created_at" timestamp (6) with time zone NOT NULL,
  "updated_at" timestamp (6) with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "catalog_property" (
  "id" varchar(300) PRIMARY KEY,
  "object_type_name" varchar(128) NOT NULL,
  "name" varchar(128) NOT NULL,
  "display_name" varchar(255) NOT NULL,
  "description" text,
  "type" varchar(32) NOT NULL,
  "source_column" varchar(255) NOT NULL,
  "physical_column" varchar(128) NOT NULL,
  "nullable" boolean NOT NULL DEFAULT true,
  "primary" boolean NOT NULL DEFAULT false,
  "hidden" boolean NOT NULL DEFAULT false,
  "position" integer NOT NULL DEFAULT 0,
  "classification" varchar(64),
  "unit" varchar(64),
  "updated_at" timestamp (6) with time zone,
  CONSTRAINT "catalog_property_object_type_name_foreign" FOREIGN KEY ("object_type_name") REFERENCES "catalog_object_type" ("name") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "catalog_snapshot" (
  "id" varchar(300) PRIMARY KEY,
  "type_name" varchar(128) NOT NULL,
  "snapshot_id" varchar(128) NOT NULL,
  "principal_id" varchar(128) NOT NULL,
  "row_count" integer NOT NULL DEFAULT 0,
  "committed" boolean NOT NULL DEFAULT false,
  "labels" jsonb,
  "created_at" timestamp (6) with time zone NOT NULL,
  "committed_at" timestamp (6) with time zone,
  "dropped_at" timestamp (6) with time zone,
  "archive" jsonb
);

CREATE INDEX IF NOT EXISTS "catalog_snapshot_type_name_created_at_index" ON "catalog_snapshot" ("type_name", "created_at");

CREATE TABLE IF NOT EXISTS "catalog_principal" (
  "id" varchar(128) PRIMARY KEY,
  "display_name" varchar(255) NOT NULL,
  "key_hash" varchar(64),
  "scopes" jsonb NOT NULL,
  "write_types" jsonb NOT NULL,
  "read_types" jsonb,
  "classifications" jsonb NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp (6) with time zone NOT NULL,
  "last_seen_at" timestamp (6) with time zone
);
