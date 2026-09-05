-- 003_create_staff_user.sql
-- Operators, DPOs and administrators. A separate credential class from the
-- Data Principal, who never has a password and never appears in this table.

CREATE TABLE staff_user (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE
                   CHECK (email = lower(btrim(email))
                          AND email ~ '^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$'),
  password_hash  TEXT NOT NULL,          -- bcryptjs, cost 12
  full_name      TEXT NOT NULL CHECK (btrim(full_name) <> ''),

  -- operator: upload evidence, draft, review, commit, run the kiosk.
  --           Cannot browse the principal register or the audit log.
  -- dpo:      the above, plus register search, principal detail, audit log,
  --           notices, purposes, cessation, exports.
  -- admin:    the above, plus staff user management.
  role           TEXT NOT NULL CHECK (role IN ('operator', 'dpo', 'admin')),

  is_active      BOOLEAN NOT NULL DEFAULT TRUE,

  -- Revocation cutoff. Set on password change, deactivation or role change so
  -- a downgrade takes effect on the next request rather than at token expiry.
  tokens_valid_from TIMESTAMPTZ,

  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER staff_user_set_updated_at
  BEFORE UPDATE ON staff_user FOR EACH ROW EXECUTE FUNCTION set_updated_at();
