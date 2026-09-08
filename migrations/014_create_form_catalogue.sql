-- 014_create_form_catalogue.sql
-- What a form IS, and which processor read it.
--
-- consent_notice already versions the NOTICE - the wording a person consented
-- to. That is a legal object. This is a different thing: the LAYOUT, the paper
-- geometry. One notice version can be printed on three different form layouts,
-- and a layout can outlive the notice printed on it. Conflating them would mean
-- a redesigned form silently invalidating consent that was lawfully given.

CREATE TABLE form_definition (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable across layout revisions: "SBI account opening", "PrivacyOS consent".
  name        TEXT NOT NULL UNIQUE,
  description TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER form_definition_set_updated_at
  BEFORE UPDATE ON form_definition FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE form_version (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_definition_id UUID NOT NULL REFERENCES form_definition (id) ON DELETE RESTRICT,

  -- The printed revision mark, verbatim off the paper. Not ours to invent: a
  -- reviewer has to be able to read it off the form in front of them.
  version_label      TEXT NOT NULL,

  -- The blank template, for registration and for cropping field regions. Held
  -- as evidence like any other document so retention and access logging are the
  -- same code path.
  template_evidence_id UUID REFERENCES evidence_object (id) ON DELETE RESTRICT,

  -- Field geometry and extraction rules for this layout:
  -- [{"key":"customer_name","label":"Full name","type":"text","required":true,
  --   "repeatable":false,"confidence_threshold":0.95,"always_review":false,
  --   "sensitive":true,"destination":"payload.fullName","region":[x0,y0,x1,y1]}]
  -- JSONB because it is per-layout configuration, not queryable domain data.
  field_schema       JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- FR-17 requires human confirmation regardless of model confidence for
  -- consent selections. That is a floor, not a default: a layout may raise it,
  -- never lower it. Enforced in application code; recorded here so the value a
  -- given submission was judged against is recoverable years later.
  effective_from     DATE NOT NULL,
  retired_on         DATE,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT form_version_unique_label UNIQUE (form_definition_id, version_label),
  CONSTRAINT form_version_retired_after_effective
    CHECK (retired_on IS NULL OR retired_on >= effective_from)
);

CREATE TRIGGER form_version_set_updated_at
  BEFORE UPDATE ON form_version FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX form_version_current_idx
  ON form_version (form_definition_id, effective_from) WHERE retired_on IS NULL;

-- Which processor read which form, and at which version.
--
-- Environment variables carry the DEFAULT processor; this table exists so one
-- form type can be routed elsewhere without a deploy, and so a stored accuracy
-- number stays attributable after the default moves. It holds identifiers and
-- region names only - never a credential. Credentials come from Application
-- Default Credentials or Secret Manager, never from a row a staff user can read.
CREATE TABLE processor_configuration (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_version_id  UUID REFERENCES form_version (id) ON DELETE RESTRICT,

  purpose          TEXT NOT NULL
                     CHECK (purpose IN ('ocr', 'form_parser', 'custom_extractor')),

  provider         TEXT NOT NULL DEFAULT 'documentai',
  location         TEXT NOT NULL,          -- e.g. 'asia-south1'; never hard-coded
  processor_id     TEXT NOT NULL,
  processor_version TEXT,                  -- null = unpinned, and that is a choice

  enabled          BOOLEAN NOT NULL DEFAULT TRUE,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live processor per (form version, purpose). A second would make "which
-- model produced this reading" unanswerable.
--
-- A partial unique index rather than EXCLUDE: EXCLUDE with the = operator on
-- uuid/text needs btree_gist, and this schema only installs pg_trgm. Same
-- guarantee, no extension. NULLS NOT DISTINCT (PG15+, we are on 16) because a
-- NULL form_version_id means "the global default", and two global defaults for
-- one purpose is precisely the collision being forbidden - default NULL
-- handling would let both through.
CREATE UNIQUE INDEX processor_configuration_one_live
  ON processor_configuration (form_version_id, purpose)
  NULLS NOT DISTINCT
  WHERE enabled;

CREATE TRIGGER processor_configuration_set_updated_at
  BEFORE UPDATE ON processor_configuration FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which layout a submission was read as. Nullable: an unrecognised form is a
-- review task, not a rejected upload, and FR-17 requires review when the form or
-- notice version cannot be determined.
ALTER TABLE intake_draft
  ADD COLUMN form_version_id UUID REFERENCES form_version (id) ON DELETE RESTRICT;

COMMENT ON COLUMN intake_draft.form_version_id IS
  'The paper layout this scan was read as. NULL means undetermined, which forces '
  'human review and blocks consent activation - a value read against the wrong '
  'layout is worse than no value.';
