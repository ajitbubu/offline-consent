-- 016_create_review_queue.sql
-- Who has to look at this, and who is allowed to say yes.
--
-- intake_draft already has a status and a reviewed_by. That was enough when one
-- person did the whole job. It stops being enough the moment reviewer and
-- approver must be different people: a single reviewed_by column cannot record
-- that A checked the values and B authorised the consent, and separation of
-- duties is exactly the control an auditor tests.
--
-- This table is the queue and the segregation record. It does not hold values -
-- those live in extracted_field and field_correction - only the question of who
-- must act, and whether they have.

CREATE TABLE review_task (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      UUID NOT NULL REFERENCES intake_draft (id) ON DELETE CASCADE,

  kind          TEXT NOT NULL
                  CHECK (kind IN ('field_review', 'consent_review', 'approval')),

  -- Why this landed in a human's queue. Recorded rather than recomputed: the
  -- thresholds are configurable, so "why was this reviewed" must survive a
  -- later config change.
  reason        TEXT NOT NULL
                  CHECK (reason IN ('low_confidence', 'always_review',
                                    'conflicting_values', 'ambiguous_consent',
                                    'unknown_form_version', 'extraction_failed',
                                    'policy')),

  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'completed',
                                    'sent_back', 'cancelled')),

  assigned_to   UUID REFERENCES staff_user (id) ON DELETE SET NULL,
  completed_by  UUID REFERENCES staff_user (id) ON DELETE RESTRICT,
  completed_at  TIMESTAMPTZ,
  notes         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT review_task_completed_has_actor
    CHECK (status <> 'completed' OR (completed_by IS NOT NULL AND completed_at IS NOT NULL))
);

-- One open task per kind per draft. Without this, a retried job or a
-- double-clicked button silently doubles the queue and two reviewers do the same
-- work and disagree. Partial unique index rather than EXCLUDE, which would need
-- btree_gist; both columns are NOT NULL so no null handling is involved.
CREATE UNIQUE INDEX review_task_one_open
  ON review_task (draft_id, kind)
  WHERE status IN ('open', 'in_progress');

CREATE TRIGGER review_task_set_updated_at
  BEFORE UPDATE ON review_task FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The queue itself: open work, oldest first.
CREATE INDEX review_task_queue_idx
  ON review_task (created_at) WHERE status IN ('open', 'in_progress');
CREATE INDEX review_task_assignee_idx
  ON review_task (assigned_to, created_at) WHERE status IN ('open', 'in_progress');

-- Separation of duties, recorded on the draft rather than inferred from tasks.
--
-- NOT a general "approved_by": it names the approval of CONSENT ACTIVATION
-- specifically, which is the act with legal weight. Whether it must differ from
-- reviewed_by is configurable policy, so it is enforced in application code -
-- but the two columns exist separately so that after the fact you can always
-- answer "were these the same person?", whatever the policy was that day.
ALTER TABLE intake_draft
  ADD COLUMN approved_by UUID REFERENCES staff_user (id) ON DELETE RESTRICT,
  ADD COLUMN approved_at TIMESTAMPTZ;

COMMENT ON COLUMN intake_draft.approved_by IS
  'Who authorised consent activation, as distinct from who reviewed the values. '
  'Kept separate from reviewed_by so segregation of duties is auditable after '
  'the fact regardless of what the policy was configured to require at the time.';
