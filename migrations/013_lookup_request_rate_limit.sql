-- 013_lookup_request_rate_limit.sql
-- Make the escape hatch defensible without closing it.
--
-- principal_lookup_request is the only route back for someone whose contact
-- point was transcribed wrongly. Migration 010 said it plainly: without it a
-- typo permanently blocks a statutory right. But the endpoint that fills it
-- accepted 2000 characters of free text from anyone, unauthenticated and
-- unthrottled, so flooding it was trivial - and flooding it buries the genuine
-- requests under noise, which destroys the fallback for exactly the people who
-- have no other way in. An escape hatch nobody can find in the pile is the same
-- as no escape hatch.
--
-- The rate limit therefore protects the queue's USEFULNESS, not the server.
-- That is why the limit is generous and per-IP rather than per-person: a
-- household behind one address may legitimately file several, and there is no
-- identity to count against - the whole point is that we cannot identify them
-- yet.
--
-- The address is stored as a peppered hash, the same shape as otp_challenge.
-- The plain address would make this table a log of who is trying to find
-- themselves in a consent register, which is more sensitive than the register.

ALTER TABLE principal_lookup_request
  ADD COLUMN ip_hash TEXT;

COMMENT ON COLUMN principal_lookup_request.ip_hash IS
  'sha256(ip || OTP_PEPPER). Rate limiting only; never displayed, never reversed.';

-- Counting recent requests from one address is the only read of this column.
CREATE INDEX principal_lookup_request_ip_idx
  ON principal_lookup_request (ip_hash, created_at DESC)
  WHERE ip_hash IS NOT NULL;
