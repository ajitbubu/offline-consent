-- 017_create_dataset_and_evaluation.sql
-- Measuring the model, and the rules that stop the measurement lying.
--
-- Three rules are enforced here rather than trusted to process, because each has
-- a well-known way of quietly destroying the number it produces:
--
--   1. A frozen test set. Once a document is in 'test' it can never move to
--      'train'. A test set that leaks into training reports an accuracy the
--      production system will never reach, and nothing about the number looks
--      wrong.
--   2. Explicit authorisation before a production document enters a dataset.
--      Reviewer corrections are personal data about a real person who consented
--      to a consent register, not to being training data.
--   3. Every prediction records the processor AND processor version that made
--      it. Without that, comparing two evaluation runs compares nothing.

CREATE TABLE dataset_document (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable: a synthetic document has no draft behind it, and synthetic is the
  -- default source precisely so the dataset can grow without touching real people.
  draft_id      UUID REFERENCES intake_draft (id) ON DELETE RESTRICT,
  evidence_id   UUID NOT NULL REFERENCES evidence_object (id) ON DELETE RESTRICT,
  form_version_id UUID REFERENCES form_version (id) ON DELETE RESTRICT,

  origin        TEXT NOT NULL
                  CHECK (origin IN ('synthetic', 'authorised_production')),

  -- Named, dated authority for using a real document. NOT a boolean: "who said
  -- yes, and when" is the question actually asked in an audit.
  authorised_by UUID REFERENCES staff_user (id) ON DELETE RESTRICT,
  authorised_at TIMESTAMPTZ,

  split         TEXT NOT NULL CHECK (split IN ('train', 'validation', 'test')),

  -- Break-down dimensions the spec asks metrics to be sliced by. Recorded at
  -- import, because scan quality cannot be recovered later from the image alone.
  scan_quality  TEXT CHECK (scan_quality IN ('clean', 'skewed', 'blurred',
                                             'low_contrast', 'rotated')),
  language      TEXT,
  dataset_version TEXT NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT dataset_document_production_is_authorised
    CHECK (origin <> 'authorised_production'
           OR (authorised_by IS NOT NULL AND authorised_at IS NOT NULL)),
  CONSTRAINT dataset_document_unique UNIQUE (evidence_id, dataset_version)
);

-- The frozen test set, enforced. A row may change split freely EXCEPT out of
-- 'test' - once frozen, always frozen, for every dataset version.
CREATE OR REPLACE FUNCTION reject_test_split_change() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.split = 'test' AND NEW.split <> 'test' THEN
    RAISE EXCEPTION
      'dataset_document % is in the frozen test set and cannot be moved to %',
      OLD.id, NEW.split;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dataset_document_test_is_frozen
  BEFORE UPDATE ON dataset_document
  FOR EACH ROW EXECUTE FUNCTION reject_test_split_change();

CREATE INDEX dataset_document_split_idx ON dataset_document (dataset_version, split);

CREATE TABLE dataset_annotation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_document_id UUID NOT NULL
                  REFERENCES dataset_document (id) ON DELETE CASCADE,

  field_key     TEXT NOT NULL,
  value         TEXT,
  consent_state TEXT CHECK (consent_state IN ('GRANTED', 'DECLINED',
                                              'NOT_SELECTED', 'AMBIGUOUS')),

  page_number   INTEGER CHECK (page_number >= 1),
  bounding_poly JSONB,

  annotated_by  UUID NOT NULL REFERENCES staff_user (id) ON DELETE RESTRICT,
  annotated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT dataset_annotation_unique UNIQUE (dataset_document_id, field_key)
);

CREATE TABLE evaluation_run (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  dataset_version TEXT NOT NULL,
  split         TEXT NOT NULL CHECK (split IN ('train', 'validation', 'test')),

  -- What was evaluated. Both, always: a processor id without its version says
  -- nothing, because the vendor may move the model underneath it.
  provider          TEXT NOT NULL DEFAULT 'documentai',
  processor_id      TEXT NOT NULL,
  processor_version TEXT,

  -- A shadow run scores a candidate without it serving any traffic. Promotion is
  -- a separate, human act - never a consequence of a good score.
  mode          TEXT NOT NULL DEFAULT 'shadow'
                  CHECK (mode IN ('shadow', 'baseline')),

  promoted_by   UUID REFERENCES staff_user (id) ON DELETE RESTRICT,
  promoted_at   TIMESTAMPTZ,

  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  notes         TEXT,

  CONSTRAINT evaluation_run_promotion_is_named
    CHECK ((promoted_by IS NULL) = (promoted_at IS NULL))
);

CREATE INDEX evaluation_run_recent_idx ON evaluation_run (started_at DESC);

CREATE TABLE extraction_metric (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id UUID NOT NULL REFERENCES evaluation_run (id) ON DELETE CASCADE,

  -- NULL field_key means the aggregate across all fields. A row per slice, so
  -- "how does it do on handwritten dates on version 3 of the SBI form" is a
  -- query rather than a rerun.
  field_key     TEXT,
  field_kind    TEXT CHECK (field_kind IN ('text', 'date', 'phone', 'email',
                                           'checkbox', 'signature')),
  writing       TEXT CHECK (writing IN ('printed', 'handwritten')),
  scan_quality  TEXT,
  language      TEXT,
  form_version_id UUID REFERENCES form_version (id) ON DELETE SET NULL,

  support       INTEGER NOT NULL CHECK (support >= 0),
  precision     NUMERIC(6,5) CHECK (precision >= 0 AND precision <= 1),
  recall        NUMERIC(6,5) CHECK (recall >= 0 AND recall <= 1),
  f1            NUMERIC(6,5) CHECK (f1 >= 0 AND f1 <= 1),
  exact_match   NUMERIC(6,5) CHECK (exact_match >= 0 AND exact_match <= 1),
  character_error_rate NUMERIC(7,5) CHECK (character_error_rate >= 0),

  -- Reported separately from text accuracy on purpose. A system that reads names
  -- at 95% and consent boxes at 80% is not a 93% system; it is a system that
  -- gets consent wrong one time in five, and averaging hides exactly that.
  checkbox_accuracy      NUMERIC(6,5) CHECK (checkbox_accuracy >= 0 AND checkbox_accuracy <= 1),
  consent_state_accuracy NUMERIC(6,5) CHECK (consent_state_accuracy >= 0 AND consent_state_accuracy <= 1),

  -- The failure that matters most: a wrong value the model was confident about,
  -- which a reviewer is most likely to accept without looking.
  plausible_wrong_above_gate INTEGER CHECK (plausible_wrong_above_gate >= 0),

  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX extraction_metric_run_idx ON extraction_metric (evaluation_run_id, field_key);
