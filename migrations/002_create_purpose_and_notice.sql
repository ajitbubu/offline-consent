-- 002_create_purpose_and_notice.sql
-- The purpose catalogue and the versioned notice (DPDP s.5).

-- Purposes are a table, not a CHECK constraint. They are whatever the paper
-- form printed next to its tick-boxes, which is not knowable in advance, and
-- adopting a new form must never require a schema migration.
CREATE TABLE purpose (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE
                    CHECK (code = lower(btrim(code)) AND btrim(code) <> ''),
  name            TEXT NOT NULL,

  -- Shown to the Data Principal in the withdrawal portal, so it must read as
  -- plain language rather than as an internal label.
  description     TEXT NOT NULL,

  -- s.5(1)(i): the notice must itemise the personal data being collected. Held
  -- per purpose so the portal can tell the person exactly what each tick-box
  -- covered.
  data_categories TEXT[] NOT NULL DEFAULT '{}',

  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER purpose_set_updated_at
  BEFORE UPDATE ON purpose FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The itemised notice, versioned and per language. This doubles as the paper
-- form template: at review time the operator selects the notice version that
-- was printed on the form physically in front of them.
CREATE TABLE consent_notice (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL CHECK (btrim(code) <> ''),
  version           INTEGER NOT NULL CHECK (version > 0),

  -- s.5(3): English or any language in the Eighth Schedule to the Constitution.
  language          TEXT NOT NULL DEFAULT 'en',

  form_label        TEXT NOT NULL,   -- 'Membership Application Form (Rev. 3, 2019)'
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,   -- itemised notice text, markdown

  -- s.5(1)(iii): how to reach the Data Protection Officer / grievance channel.
  fiduciary_contact TEXT NOT NULL,

  published_at      TIMESTAMPTZ,
  superseded_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT consent_notice_unique_version UNIQUE (code, version, language)
);

COMMENT ON TABLE consent_notice IS
  'A published notice version is immutable in practice: edits ship as a new version. Enforced in src/lib/notice.ts rather than by trigger, because consent_artifact pins the version by foreign key anyway.';

CREATE TRIGGER consent_notice_set_updated_at
  BEFORE UPDATE ON consent_notice FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which tick-boxes a given form version carries, in printed order, with the
-- exact wording that appeared beside each box. That wording is what the
-- extraction pipeline matches against, and what the reviewer reads back.
CREATE TABLE consent_notice_purpose (
  notice_id     UUID NOT NULL REFERENCES consent_notice (id) ON DELETE CASCADE,
  purpose_id    UUID NOT NULL REFERENCES purpose (id) ON DELETE RESTRICT,
  printed_label TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (notice_id, purpose_id)
);

CREATE INDEX consent_notice_purpose_label_trgm
  ON consent_notice_purpose USING GIN (printed_label gin_trgm_ops);
