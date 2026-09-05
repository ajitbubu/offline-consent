-- 012_create_cessation.sql
-- s.6(6): when consent is withdrawn, the Fiduciary must cease processing and
-- cause its Processors to cease too.
--
-- Until now a withdrawal changed consent_record and stopped there. That makes
-- the obligation unverifiable: nothing recorded which systems hold this person's
-- data, whether any of them were told, or when. A register that cannot answer
-- "did we actually stop?" is evidence of intent, not of compliance.
--
-- Two tables. One says where data goes; the other says what happened per
-- withdrawal per destination.

CREATE TABLE downstream_system (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  code          TEXT NOT NULL UNIQUE
                  CHECK (code = lower(btrim(code)) AND btrim(code) <> ''),
  name          TEXT NOT NULL CHECK (btrim(name) <> ''),
  description   TEXT,

  -- Who to chase. A task with no owner is a task nobody does.
  owner_contact TEXT NOT NULL CHECK (btrim(owner_contact) <> ''),

  -- How long this system gets before a raised task is overdue. Stored per
  -- system because a nightly batch and a live API are not the same promise.
  sla_days      INTEGER NOT NULL DEFAULT 7 CHECK (sla_days > 0),

  -- Retiring a system must not delete the tasks already raised against it, so
  -- this is a flag rather than a DELETE. Inactive systems stop receiving new
  -- tasks; the old ones stay as evidence of what was asked and when.
  is_active     BOOLEAN NOT NULL DEFAULT true,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER downstream_system_set_updated_at
  BEFORE UPDATE ON downstream_system FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE downstream_system IS
  'Systems that hold personal data and must stop processing when consent is withdrawn. The s.6(6) checklist is only as honest as this list is complete.';

CREATE TABLE cessation_task (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE RESTRICT like everything else that points at a person. This is an
  -- operational queue rather than an audit table, so unlike audit_log it does
  -- carry the foreign key.
  data_principal_id UUID NOT NULL REFERENCES data_principal (id) ON DELETE RESTRICT,
  purpose_id        UUID NOT NULL REFERENCES purpose (id) ON DELETE RESTRICT,
  system_id         UUID NOT NULL REFERENCES downstream_system (id) ON DELETE RESTRICT,

  raised_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at            TIMESTAMPTZ NOT NULL,

  -- 'on_hold' is the statutory carve-out, not a snooze. s.6(6) requires
  -- cessation unless the processing is required or authorised under the Act, so
  -- a hold is a legal claim and the reason is mandatory below.
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'completed', 'on_hold')),

  completed_at      TIMESTAMPTZ,
  completed_by      UUID REFERENCES staff_user (id) ON DELETE RESTRICT,
  completion_note   TEXT,

  hold_reason       TEXT,
  held_by           UUID REFERENCES staff_user (id) ON DELETE RESTRICT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A completed task must name who stopped the processing and when. Without
  -- this a row could claim the obligation was met with nobody behind it.
  CONSTRAINT cessation_task_completed_has_actor
    CHECK (status <> 'completed'
           OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)),

  -- A hold without a stated legal basis is just an unfinished task wearing a
  -- different label.
  CONSTRAINT cessation_task_hold_has_reason
    CHECK (status <> 'on_hold'
           OR (hold_reason IS NOT NULL AND btrim(hold_reason) <> '' AND held_by IS NOT NULL))
);

CREATE TRIGGER cessation_task_set_updated_at
  BEFORE UPDATE ON cessation_task FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One live task per person, purpose and system. Consent can be granted again on
-- new paper and withdrawn again, which legitimately raises a second task - so
-- this constrains only the OPEN ones and keeps the closed history.
CREATE UNIQUE INDEX cessation_task_one_open
  ON cessation_task (data_principal_id, purpose_id, system_id)
  WHERE status = 'open';

-- The worked queue: oldest due first, which is the order a DPO should work it.
CREATE INDEX cessation_task_open_due_idx
  ON cessation_task (due_at) WHERE status = 'open';

CREATE INDEX cessation_task_principal_idx
  ON cessation_task (data_principal_id);

COMMENT ON COLUMN cessation_task.status IS
  'open | completed | on_hold. on_hold is the s.6(6) statutory carve-out and requires a stated reason; it is not a snooze.';
