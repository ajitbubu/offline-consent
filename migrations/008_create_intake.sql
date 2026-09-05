-- 008_create_intake.sql
-- The converged intake pipeline. All four intake modes - manual entry, scan
-- review, bulk CSV, kiosk - produce rows here, and nothing writes
-- consent_artifact except commitDraft() reading one of these.

CREATE TABLE intake_batch (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_evidence_id UUID NOT NULL REFERENCES evidence_object (id) ON DELETE RESTRICT,
  filename           TEXT NOT NULL,

  -- {"full_name": "Name", "phone": "Mobile No", "purpose:newsletter": "Newsletter?"}
  column_mapping     JSONB NOT NULL DEFAULT '{}'::jsonb,

  notice_id          UUID REFERENCES consent_notice (id) ON DELETE RESTRICT,
  row_count          INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'mapping'
                       CHECK (status IN ('mapping', 'validated', 'partially_committed',
                                         'committed', 'abandoned')),
  created_by         UUID NOT NULL REFERENCES staff_user (id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER intake_batch_set_updated_at
  BEFORE UPDATE ON intake_batch FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE intake_draft (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  source        TEXT NOT NULL CHECK (source IN ('manual', 'scan', 'bulk_csv', 'kiosk')),

  -- Three states only. Extraction is not a state: if the extraction service is
  -- unavailable the draft is simply not pre-filled, and the review screen is
  -- the manual entry form. One degradation path, not two.
  status        TEXT NOT NULL DEFAULT 'needs_review'
                  CHECK (status IN ('needs_review', 'committed', 'rejected')),

  batch_id      UUID REFERENCES intake_batch (id) ON DELETE CASCADE,
  row_number    INTEGER,     -- position in the source CSV, for the import report
  source_row    JSONB,       -- the raw CSV row, verbatim

  -- One shape for all four modes; see draftPayloadSchema in src/lib/intake.ts.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Word-level OCR output: [{text, bbox:[x0,y0,x1,y1], confidence}]. Retained on
  -- committed drafts because the pair (tokens, human-verified payload) IS the
  -- training set for the extraction model - the review screen doubles as the
  -- annotation tool, so every correction improves the next model.
  ocr_tokens    JSONB,

  -- Extraction service output including per-field confidence and model version.
  -- Never read by commitDraft(): only `payload` is committed, and a value moves
  -- from extraction into payload solely by a reviewer accepting it.
  extraction    JSONB,

  evidence_id           UUID REFERENCES evidence_object (id) ON DELETE RESTRICT,
  signature_evidence_id UUID REFERENCES evidence_object (id) ON DELETE RESTRICT,

  -- Set by the identity matcher, confirmed or overridden by the reviewer.
  matched_principal_id UUID REFERENCES data_principal (id) ON DELETE SET NULL,
  match_reason         TEXT CHECK (match_reason IN ('exact_contact_and_name',
                                                    'fuzzy_name', 'none')),

  -- [{"field": "phone", "severity": "error", "message": "..."}]
  validation    JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_by    UUID NOT NULL REFERENCES staff_user (id) ON DELETE RESTRICT,
  reviewed_by   UUID REFERENCES staff_user (id) ON DELETE RESTRICT,
  reviewed_at   TIMESTAMPTZ,
  committed_artifact_id UUID REFERENCES consent_artifact (id) ON DELETE RESTRICT,
  rejected_reason TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A committed draft must name the artifact it produced and the human who
  -- approved it. Without this a row could claim to be committed with nothing
  -- behind it.
  CONSTRAINT intake_draft_committed_has_evidence
    CHECK (status <> 'committed'
           OR (committed_artifact_id IS NOT NULL
               AND reviewed_by IS NOT NULL
               AND reviewed_at IS NOT NULL)),
  CONSTRAINT intake_draft_rejected_has_reason
    CHECK (status <> 'rejected' OR rejected_reason IS NOT NULL)
);

-- The review queue: open drafts, oldest first.
CREATE INDEX intake_draft_queue_idx
  ON intake_draft (created_at) WHERE status = 'needs_review';

CREATE INDEX intake_draft_batch_idx ON intake_draft (batch_id, row_number);

-- Training-set export: committed drafts that carry both OCR tokens and a
-- human-verified payload.
CREATE INDEX intake_draft_trainable_idx
  ON intake_draft (reviewed_at) WHERE status = 'committed' AND ocr_tokens IS NOT NULL;
