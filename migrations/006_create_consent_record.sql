-- 006_create_consent_record.sql
-- Current state, one row per (person, purpose). Mutable.
--
-- The projection half of the artifact/record split: what the artifacts say,
-- plus any withdrawal since. This is what the withdrawal portal reads and what
-- a withdrawal writes. Enforcement should consult this table and nothing else.

CREATE TABLE consent_record (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_principal_id  UUID NOT NULL REFERENCES data_principal (id) ON DELETE RESTRICT,
  purpose_id         UUID NOT NULL REFERENCES purpose (id) ON DELETE RESTRICT,

  -- 'declined' is recorded, not omitted: the portal must show the person every
  -- purpose they were asked about, including the ones they refused, since that
  -- is the only way they can check the refusal was captured correctly.
  status             TEXT NOT NULL CHECK (status IN ('active', 'withdrawn', 'declined')),

  -- The artifact that last set this state. Not a history - history is audit_log.
  source_artifact_id UUID NOT NULL REFERENCES consent_artifact (id) ON DELETE RESTRICT,

  -- Copied from the artifact so the portal can say "given on 4 March 2019"
  -- without a join, and so it survives an identity merge.
  consent_given_on   DATE,

  withdrawn_at       TIMESTAMPTZ,
  withdrawal_channel TEXT CHECK (withdrawal_channel IN ('portal', 'staff', 'letter')),
  withdrawal_reason  TEXT,
  CONSTRAINT consent_record_withdrawn_has_timestamp
    CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),

  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT consent_record_one_per_purpose UNIQUE (data_principal_id, purpose_id)
);

-- No separate index on data_principal_id: the UNIQUE constraint's B-tree
-- already leads with that column and serves the portal's lookup.

CREATE TRIGGER consent_record_set_updated_at
  BEFORE UPDATE ON consent_record FOR EACH ROW EXECUTE FUNCTION set_updated_at();
