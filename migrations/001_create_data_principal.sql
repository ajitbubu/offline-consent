-- 001_create_data_principal.sql
-- The person whose consent was collected on paper. DPDP Act 2023 calls them the
-- Data Principal.

-- Fuzzy name matching at review time, to catch a duplicate person before a
-- second identity is created for them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shared by every table carrying updated_at.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Shared by every append-only table. Statement-level triggers using this fire
-- even when the statement matches zero rows, so a blanket "DELETE FROM x" is
-- rejected outright rather than silently succeeding against an empty match.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE data_principal (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  full_name     TEXT NOT NULL
                  CONSTRAINT data_principal_full_name_present
                  CHECK (btrim(full_name) <> ''),

  -- Normalised join key. Collapses case and runs of whitespace so "Ajit  Kumar"
  -- and "ajit kumar" resolve to one person, without altering the displayed name
  -- (which must keep whatever the person actually wrote on the form).
  name_key      TEXT GENERATED ALWAYS AS
                  (lower(regexp_replace(btrim(full_name), '\s+', ' ', 'g'))) STORED,

  -- E.164. Normalisation happens in src/lib/phone.ts; this CHECK is the backstop
  -- so that no writer - manual entry, CSV import, kiosk, or a hand-run backfill -
  -- can store "98765 4321" and quietly make the person unreachable.
  phone_e164    TEXT CONSTRAINT data_principal_phone_e164_format
                  CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),

  email         TEXT CONSTRAINT data_principal_email_normalised
                  CHECK (email = lower(btrim(email))
                         AND email ~ '^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$'),

  -- Without a contact point the person can never reach the withdrawal portal,
  -- and DPDP s.6(4) - withdrawal as easy as giving - is unsatisfiable for them.
  CONSTRAINT data_principal_has_contact_point
    CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL),

  -- Set when this row is absorbed by another during a DPO-performed merge.
  -- Reads follow the chain; consent artifacts are never rewritten to point
  -- elsewhere, because an artifact records what one piece of paper said.
  merged_into_id UUID REFERENCES data_principal (id) ON DELETE RESTRICT,

  -- Revocation cutoff for portal sessions: every token issued before this
  -- instant is refused. A cutoff rather than a deny list, because after a leak
  -- you rarely know which token escaped.
  portal_tokens_valid_from TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN data_principal.name_key IS
  'Normalised name used for identity resolution. Never displayed.';
COMMENT ON COLUMN data_principal.merged_into_id IS
  'Non-null means this identity was merged into another. Follow the chain on read.';

-- Uniqueness is (contact point + name), NOT contact point alone. A shared
-- household or workplace phone number is ordinary in India; making phone
-- globally unique would either fuse two real people into one consent record or
-- block the second person's form from ever being digitised.
CREATE UNIQUE INDEX data_principal_phone_name_key
  ON data_principal (phone_e164, name_key) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX data_principal_email_name_key
  ON data_principal (email, name_key) WHERE email IS NOT NULL;

-- Portal lookup finds every person at a contact point, regardless of name.
CREATE INDEX data_principal_phone_idx
  ON data_principal (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX data_principal_email_idx
  ON data_principal (email) WHERE email IS NOT NULL;

-- Duplicate detection at commit time.
CREATE INDEX data_principal_name_trgm
  ON data_principal USING GIN (name_key gin_trgm_ops);

CREATE TRIGGER data_principal_set_updated_at
  BEFORE UPDATE ON data_principal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
