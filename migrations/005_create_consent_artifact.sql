-- 005_create_consent_artifact.sql
-- What the paper said. Immutable.
--
-- This is the evidence half of the artifact/record split. When someone
-- withdraws, the fact "granted" must simultaneously change - so processing
-- stops - and not change - so the Fiduciary can still prove consent was validly
-- obtained on the day it was signed. Those are two different rows, and this is
-- the one that never moves. A correction ships as a NEW artifact.

CREATE TABLE consent_artifact (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  data_principal_id   UUID NOT NULL REFERENCES data_principal (id) ON DELETE RESTRICT,

  -- The notice version printed on or attached to the form. NULL is the COMMON
  -- case for pre-2023 paper and is precisely what drives the s.5(2) retro-notice
  -- queue - it is a compliance finding, not a data-entry omission.
  notice_id           UUID REFERENCES consent_notice (id) ON DELETE RESTRICT,
  notice_at_collection TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (notice_at_collection IN
                               ('attached', 'printed_on_form', 'none', 'unknown')),

  -- DATE, not TIMESTAMPTZ: paper has no clock and no timezone. Nullable because
  -- undated forms are real and must be recorded as undated rather than guessed.
  collected_on           DATE,
  collected_on_precision TEXT NOT NULL
                           CHECK (collected_on_precision IN
                                  ('day', 'month', 'year', 'unknown')),
  CONSTRAINT consent_artifact_date_matches_precision
    CHECK ((collected_on_precision = 'unknown') = (collected_on IS NULL)),

  collection_location TEXT,

  -- The consent wording as printed on the form ("I agree to ...").
  subject_declaration TEXT,

  intake_mode         TEXT NOT NULL
                        CHECK (intake_mode IN ('manual', 'scan_reviewed',
                                               'bulk_csv', 'kiosk')),

  -- Provenance back to the draft this came from. Deliberately not a foreign
  -- key: drafts may be pruned, and evidence must not depend on that.
  intake_draft_id     UUID,

  evidence_id           UUID REFERENCES evidence_object (id) ON DELETE RESTRICT,
  signature_evidence_id UUID REFERENCES evidence_object (id) ON DELETE RESTRICT,

  transcribed_by      UUID NOT NULL REFERENCES staff_user (id) ON DELETE RESTRICT,
  committed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- sha256 over the canonical JSON of {principal, notice, date, items, evidence
  -- hashes}, computed in the application. Tamper evidence that does not depend
  -- on the triggers below still being in place.
  payload_hash        TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE consent_artifact IS
  'Append-only. INSERT only - UPDATE, DELETE and TRUNCATE are blocked by trigger. Corrections are new artifacts.';

CREATE TABLE consent_artifact_item (
  artifact_id    UUID NOT NULL REFERENCES consent_artifact (id) ON DELETE RESTRICT,
  purpose_id     UUID NOT NULL REFERENCES purpose (id) ON DELETE RESTRICT,

  -- TRUE = the box was ticked. FALSE = it was left blank or ticked "no". There
  -- is deliberately no NULL: a box the reviewer could not read must be resolved
  -- while looking at the scan, not carried forward into evidence as a maybe.
  granted        BOOLEAN NOT NULL,

  -- What the box actually said on that form version.
  verbatim_label TEXT NOT NULL,

  PRIMARY KEY (artifact_id, purpose_id)
);

CREATE INDEX consent_artifact_principal_idx
  ON consent_artifact (data_principal_id, collected_on DESC NULLS LAST);

-- Feeds the s.5(2) notice-owed queue.
CREATE INDEX consent_artifact_notice_owed_idx
  ON consent_artifact (committed_at)
  WHERE notice_at_collection IN ('none', 'unknown');

-- Immutability. Statement-level so that a blanket "UPDATE consent_artifact SET
-- ..." is rejected even when it happens to match zero rows.
CREATE TRIGGER consent_artifact_no_update
  BEFORE UPDATE ON consent_artifact
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER consent_artifact_no_delete
  BEFORE DELETE ON consent_artifact
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER consent_artifact_no_truncate
  BEFORE TRUNCATE ON consent_artifact
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER consent_artifact_item_no_update
  BEFORE UPDATE ON consent_artifact_item
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER consent_artifact_item_no_delete
  BEFORE DELETE ON consent_artifact_item
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER consent_artifact_item_no_truncate
  BEFORE TRUNCATE ON consent_artifact_item
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
