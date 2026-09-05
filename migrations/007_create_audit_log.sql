-- 007_create_audit_log.sql
-- Immutable, append-only compliance evidence. This table is the legal record of
-- what was done, by whom, and when.

CREATE TABLE audit_log (
  id                BIGSERIAL PRIMARY KEY,

  "timestamp"       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Deliberately NOT foreign keys. An erasure request removes the principal
  -- row, but the proof that the erasure happened must survive it; a foreign key
  -- would force a cascade that destroys exactly the evidence being relied on.
  data_principal_id UUID,
  artifact_id       UUID,

  actor_type        TEXT NOT NULL CHECK (actor_type IN ('staff', 'data_principal', 'system')),
  actor_id          TEXT,   -- staff_user.id, data_principal.id, or a job name

  -- 'consent_digitised', 'consent_withdrawn', 'withdrawal_reaffirmed',
  -- 'draft_created', 'draft_rejected', 'extraction_performed',
  -- 'evidence_accessed', 'evidence_destroyed', 'otp_issued', 'otp_verified',
  -- 'otp_failed', 'principal_selected', 'staff_viewed_principal',
  -- 'staff_login', 'staff_login_failed', 'principals_merged',
  -- 'notice_delivered', 'cessation_completed'.
  --
  -- Intentionally unconstrained: an append-only log has to accept new action
  -- types without a migration, and a CHECK here would reject writes at the
  -- exact moment evidence matters most.
  action            TEXT NOT NULL,

  previous_state    JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_state         JSONB NOT NULL DEFAULT '{}'::jsonb,

  reason            TEXT,

  -- 'dpdp_s5_2', 'dpdp_s6_1', 'dpdp_s6_4', 'dpdp_s6_6', 'dpdp_s8_7'
  compliance_tags   TEXT[] NOT NULL DEFAULT '{}',

  ip_address        INET,
  user_agent        TEXT
);

COMMENT ON TABLE audit_log IS
  'Append-only. INSERT only - UPDATE, DELETE and TRUNCATE are blocked by trigger.';
COMMENT ON COLUMN audit_log.data_principal_id IS
  'Not a foreign key by design: audit entries must outlive erasure of the identity they describe.';
COMMENT ON COLUMN audit_log.id IS
  'BIGSERIAL. node-pg returns int8 as a string; treat as opaque and never expose in an API response.';

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- A person's history, newest first, for the DPO principal detail screen.
CREATE INDEX audit_log_principal_timestamp_idx
  ON audit_log (data_principal_id, "timestamp" DESC) WHERE data_principal_id IS NOT NULL;

-- Rate limiting reads staff_login and otp_* actions by actor within a window.
CREATE INDEX audit_log_action_timestamp_idx ON audit_log (action, "timestamp" DESC);

CREATE INDEX audit_log_compliance_tags_idx ON audit_log USING GIN (compliance_tags);
