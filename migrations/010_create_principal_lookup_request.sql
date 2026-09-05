-- 010_create_principal_lookup_request.sql
-- The escape hatch for a mistyped contact point.
--
-- If the phone number transcribed from a paper form is wrong, that person can
-- never reach the withdrawal portal and s.6(4) fails for them invisibly. This
-- queue is how they reach a human instead. It is not optional: without it a
-- transcription typo permanently blocks a statutory right.
--
-- Public search by name or date of birth is deliberately NOT offered - that
-- would be an enumeration oracle over the whole register.

CREATE TABLE principal_lookup_request (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claimed_name   TEXT NOT NULL CHECK (btrim(claimed_name) <> ''),

  -- Free text the person supplies: how to reach them, what they remember.
  -- Deliberately not parsed into columns - this is a note to a human.
  contact_note   TEXT NOT NULL CHECK (btrim(contact_note) <> ''),

  form_reference TEXT,

  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'resolved', 'rejected')),
  resolved_principal_id UUID REFERENCES data_principal (id) ON DELETE SET NULL,
  handled_by     UUID REFERENCES staff_user (id) ON DELETE RESTRICT,
  handled_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lookup_request_handled_has_actor
    CHECK (status = 'open' OR (handled_by IS NOT NULL AND handled_at IS NOT NULL))
);

CREATE INDEX principal_lookup_request_open_idx
  ON principal_lookup_request (created_at) WHERE status = 'open';
