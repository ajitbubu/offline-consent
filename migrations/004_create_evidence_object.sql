-- 004_create_evidence_object.sql
-- Metadata for a stored blob: a scanned consent form, a captured signature, or
-- the source file of a bulk import. The bytes live on disk under
-- EVIDENCE_DIR; this table is the index and the retention record.

CREATE TABLE evidence_object (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Always generated server-side as 'YYYY/MM/<uuid>', never client-supplied, so
  -- path traversal is impossible by construction. The download route re-asserts
  -- containment under the root anyway.
  storage_key       TEXT NOT NULL UNIQUE,

  kind              TEXT NOT NULL
                      CHECK (kind IN ('scan', 'signature', 'csv_source')),

  -- Sniffed from the file's magic bytes, never taken from the browser's
  -- Content-Type header.
  content_type      TEXT NOT NULL
                      CHECK (content_type IN ('image/jpeg', 'image/png',
                                              'application/pdf', 'text/csv')),

  original_filename TEXT NOT NULL,   -- display only; never used to build a path
  byte_size         BIGINT NOT NULL CHECK (byte_size > 0),
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),

  -- Stamped at upload from EVIDENCE_RETENTION_YEARS. Stored rather than
  -- computed on read, so changing that setting can never retroactively move the
  -- retention date of something already held.
  retention_until   TIMESTAMPTZ NOT NULL,

  -- Set once the bytes have been sent to the extraction service. That transfer
  -- is a disclosure to a processor and has to be provable after the fact.
  extraction_processed_at TIMESTAMPTZ,

  uploaded_by       UUID NOT NULL REFERENCES staff_user (id) ON DELETE RESTRICT,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft delete. The blob is unlinked from disk but the row and its hash
  -- survive, as proof that the evidence existed and when it was destroyed.
  deleted_at        TIMESTAMPTZ,
  deleted_reason    TEXT,
  CONSTRAINT evidence_object_deleted_has_reason
    CHECK (deleted_at IS NULL OR deleted_reason IS NOT NULL)
);

COMMENT ON TABLE evidence_object IS
  'No foreign key to consent_artifact by design: a scan is uploaded during drafting, before any artifact exists. The artifact points at the evidence, not the reverse.';

-- Detects a re-upload of a form already on file.
CREATE INDEX evidence_object_sha256_idx ON evidence_object (sha256);

-- Drives the retention sweep.
CREATE INDEX evidence_object_retention_idx
  ON evidence_object (retention_until) WHERE deleted_at IS NULL;
