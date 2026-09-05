-- 009_create_otp_challenge.sql
-- One-time codes for the public withdrawal portal. The Data Principal has no
-- account and no password; proving control of a contact point printed on the
-- paper form is the whole authentication story.

CREATE TABLE otp_challenge (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           TEXT NOT NULL CHECK (channel IN ('sms', 'email')),

  -- sha256(normalised destination || OTP_PEPPER). The plaintext destination is
  -- used once, at send time, and never stored: this table must not become a
  -- phone directory if the database leaks.
  destination_hash  TEXT NOT NULL CHECK (destination_hash ~ '^[0-9a-f]{64}$'),

  -- bcrypt of the six-digit code. Being honest about what this buys: six digits
  -- is about twenty bits, so hashing only buys time against a leaked table. The
  -- real controls are the TTL and the attempt cap below.
  code_hash         TEXT NOT NULL,

  -- The principals this contact point resolved to AT SEND TIME. The /select
  -- endpoint validates the caller's chosen id against this array, so a client
  -- can never name an arbitrary principal and read someone else's consents.
  matched_principal_ids UUID[] NOT NULL,

  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at        TIMESTAMPTZ NOT NULL,
  verified_at       TIMESTAMPTZ,

  -- Set on token issue OR on attempt exhaustion OR when superseded by a newer
  -- challenge for the same destination. A consumed challenge is dead.
  consumed_at       TIMESTAMPTZ,

  ip_hash           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE otp_challenge IS
  'Rate limits are counted from this table - no Redis. Only one challenge per destination may be live at a time; issuing a new one consumes the previous.';

CREATE INDEX otp_challenge_destination_idx
  ON otp_challenge (destination_hash, created_at DESC);
CREATE INDEX otp_challenge_ip_idx
  ON otp_challenge (ip_hash, created_at DESC) WHERE ip_hash IS NOT NULL;

-- Finds the single live challenge for a destination.
CREATE INDEX otp_challenge_live_idx
  ON otp_challenge (destination_hash) WHERE consumed_at IS NULL;
