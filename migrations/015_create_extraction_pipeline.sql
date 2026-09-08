-- 015_create_extraction_pipeline.sql
-- What the machine read, kept separate from what a human decided.
--
-- intake_draft.extraction (a JSONB blob) was enough while extraction was one
-- synchronous call producing four fields. It stops being enough here, for three
-- reasons the spec makes explicit: a correction must never overwrite the model's
-- original value; the review screen must highlight the exact region a value came
-- from; and per-field metrics must be broken down by field type, handwriting,
-- scan quality and form version. None of those are answerable against a blob.
--
--   extraction_job    one attempt to read one submission (retryable, idempotent)
--     -> document_page    one rendered page, stored, with its raster dimensions
--     -> extracted_field  one value the MODEL produced. Immutable.
--          -> field_correction  one value a HUMAN produced. Append-only.
--
-- The current value of a field is the newest correction if one exists, otherwise
-- the extracted value. Never a mutation of the row.

CREATE TABLE extraction_job (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      UUID NOT NULL REFERENCES intake_draft (id) ON DELETE CASCADE,

  -- At-least-once delivery is the normal case for Cloud Tasks and Pub/Sub, so
  -- the same job WILL arrive twice. This key is what makes the second delivery
  -- a no-op instead of a second set of extracted values - and, downstream, a
  -- second consent record. Uniqueness is the whole mechanism.
  idempotency_key TEXT NOT NULL,

  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),

  engine        TEXT,                    -- the engine that ACTUALLY ran
  engine_version TEXT,                   -- processor version, not SDK version
  processor_configuration_id UUID
                  REFERENCES processor_configuration (id) ON DELETE SET NULL,

  -- Why it failed, for the reviewer and for the quota/timeout metrics. Never the
  -- provider payload: that goes to evidence storage, not a text column.
  error_kind    TEXT CHECK (error_kind IN ('timeout', 'quota', 'auth',
                                           'unsupported', 'provider', 'internal')),
  error_detail  TEXT,

  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT extraction_job_idempotent UNIQUE (draft_id, idempotency_key),
  CONSTRAINT extraction_job_finished_has_outcome
    CHECK (status NOT IN ('succeeded', 'failed') OR finished_at IS NOT NULL),
  CONSTRAINT extraction_job_failed_has_kind
    CHECK (status <> 'failed' OR error_kind IS NOT NULL)
);

CREATE TRIGGER extraction_job_set_updated_at
  BEFORE UPDATE ON extraction_job FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX extraction_job_pending_idx
  ON extraction_job (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX extraction_job_draft_idx ON extraction_job (draft_id, created_at DESC);

CREATE TABLE document_page (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      UUID NOT NULL REFERENCES intake_draft (id) ON DELETE CASCADE,
  page_number   INTEGER NOT NULL CHECK (page_number >= 1),

  -- The rendered raster, stored like any other evidence. Kept because a bbox is
  -- pixels in SOME raster: without the exact image, stored geometry stops
  -- meaning anything the day RENDER_DPI changes.
  image_evidence_id UUID REFERENCES evidence_object (id) ON DELETE RESTRICT,

  -- The raster's own dimensions. Every bbox in extracted_field is in this space.
  width         INTEGER NOT NULL CHECK (width > 0),
  height        INTEGER NOT NULL CHECK (height > 0),
  render_dpi    INTEGER NOT NULL CHECK (render_dpi > 0),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT document_page_unique UNIQUE (draft_id, page_number)
);

CREATE TABLE extracted_field (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES extraction_job (id) ON DELETE CASCADE,
  draft_id      UUID NOT NULL REFERENCES intake_draft (id) ON DELETE CASCADE,

  -- Matches a key in form_version.field_schema. Never a database identifier:
  -- the extraction service returns keys and indices, and the app maps them onto
  -- its own catalogue (SEC-9).
  field_key     TEXT NOT NULL,

  -- Exactly as the model produced it, and NEVER edited afterwards. A correction
  -- is a new row in field_correction. This is enforced below, not merely
  -- intended: an UPDATE here would destroy the only record of what the machine
  -- actually saw, which is the evidence an accuracy claim rests on.
  raw_value     TEXT,
  normalized_value TEXT,

  confidence    NUMERIC(5,4) CHECK (confidence >= 0 AND confidence <= 1),

  -- For consent selections only. Four states, because collapsing them is the
  -- error that turns a failed read into a recorded refusal - or worse, a
  -- recorded grant. AMBIGUOUS when both yes and no are marked, or when one mark
  -- overlaps two options.
  consent_state TEXT CHECK (consent_state IN ('GRANTED', 'DECLINED',
                                              'NOT_SELECTED', 'AMBIGUOUS')),

  page_number   INTEGER CHECK (page_number >= 1),
  -- [x0,y0,x1,y1] in document_page's raster space, for the review overlay and
  -- the source crop. JSONB because it is coordinates, not queryable data.
  bounding_poly JSONB,
  -- Provider text offsets, kept so a value can be traced back into the original
  -- response held in evidence storage.
  text_anchor   JSONB,

  extracted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT extracted_field_unique UNIQUE (job_id, field_key)
);

CREATE TRIGGER extracted_field_no_update
  BEFORE UPDATE ON extracted_field FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER extracted_field_no_delete
  BEFORE DELETE ON extracted_field FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE INDEX extracted_field_draft_idx ON extracted_field (draft_id, field_key);
-- The review queue's real question: which fields need a human?
CREATE INDEX extracted_field_uncertain_idx
  ON extracted_field (draft_id) WHERE confidence IS NULL OR confidence < 0.95;

CREATE TABLE field_correction (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extracted_field_id UUID REFERENCES extracted_field (id) ON DELETE RESTRICT,
  draft_id      UUID NOT NULL REFERENCES intake_draft (id) ON DELETE CASCADE,

  -- Nullable extracted_field_id on purpose: a reviewer may supply a value for a
  -- field the model never produced at all. That is the 'no-ocr' case, and it is
  -- the single most valuable label in the corpus - the model was silent and a
  -- human knows the answer.
  field_key     TEXT NOT NULL,

  corrected_value TEXT,
  consent_state TEXT CHECK (consent_state IN ('GRANTED', 'DECLINED',
                                              'NOT_SELECTED', 'AMBIGUOUS')),

  -- accepted: the reviewer confirmed the model's value unchanged. Distinct from
  -- corrected, and the distinction IS the accuracy measurement.
  outcome       TEXT NOT NULL
                  CHECK (outcome IN ('accepted', 'corrected', 'entered', 'cleared')),

  comment       TEXT,
  corrected_by  UUID NOT NULL REFERENCES staff_user (id) ON DELETE RESTRICT,
  corrected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER field_correction_no_update
  BEFORE UPDATE ON field_correction FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER field_correction_no_delete
  BEFORE DELETE ON field_correction FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Newest correction per field wins when assembling the current value.
CREATE INDEX field_correction_current_idx
  ON field_correction (draft_id, field_key, corrected_at DESC);
