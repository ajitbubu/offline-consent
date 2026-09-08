/**
 * Writes to the append-only audit log.
 *
 * Every write that changes consent state must record an entry in the same
 * transaction as the change itself - a consent change with no audit entry is a
 * compliance gap - so these functions take an Executor rather than reaching for
 * the pool.
 */
import "server-only";
import { pool, type Executor } from "@/lib/db";
import { env } from "@/lib/env";

export type AuditAction =
  | "consent_digitised"
  | "consent_withdrawn"
  | "withdrawal_reaffirmed"
  | "draft_created"
  | "draft_rejected"
  | "extraction_performed"
  | "evidence_accessed"
  | "evidence_destroyed"
  | "otp_issued"
  | "otp_verified"
  | "otp_failed"
  | "principal_selected"
  | "staff_viewed_principal"
  | "staff_login"
  | "staff_login_failed"
  | "principals_merged"
  | "notice_delivered"
  | "cessation_completed"
  | "lookup_request_filed"
  | "lookup_request_resolved"
  | "lookup_request_rejected";

export type ComplianceTag =
  | "dpdp_s5_2"
  | "dpdp_s6_1"
  | "dpdp_s6_4"
  | "dpdp_s6_6"
  | "dpdp_s8_7";

export interface AuditEntry {
  action: AuditAction;
  actorType: "staff" | "data_principal" | "system";
  actorId?: string | null;
  dataPrincipalId?: string | null;
  artifactId?: string | null;
  previousState?: unknown;
  newState?: unknown;
  reason?: string | null;
  complianceTags?: readonly ComplianceTag[];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function writeAudit(
  entry: AuditEntry,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_log
       (action, actor_type, actor_id, data_principal_id, artifact_id,
        previous_state, new_state, reason, compliance_tags, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.action,
      entry.actorType,
      entry.actorId ?? null,
      entry.dataPrincipalId ?? null,
      entry.artifactId ?? null,
      JSON.stringify(entry.previousState ?? {}),
      JSON.stringify(entry.newState ?? {}),
      entry.reason ?? null,
      entry.complianceTags ?? [],
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
    ],
  );
}

/**
 * Client IP, or null when it cannot be established.
 *
 * X-Forwarded-For is read ONLY when TRUST_PROXY says a proxy is overwriting it.
 * Believing it unconditionally would let anyone defeat every per-IP rate limit
 * in the app by rotating one header, and would write attacker-chosen addresses
 * into a compliance record. Returning null is the honest answer, and the limits
 * that depend on it fall back to their per-identity clause.
 */
export function clientIp(request: Request): string | null {
  if (!env.TRUST_PROXY) return null;

  const forwarded = request.headers.get("x-forwarded-for");
  const candidate = forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip");
  if (!candidate) return null;
  // Postgres INET rejects anything malformed; screen it here so a header cannot
  // abort the insert that carries the evidence.
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate);
  const isIpv6 = /^[0-9a-fA-F:]+$/.test(candidate) && candidate.includes(":");
  return isIpv4 || isIpv6 ? candidate : null;
}

export const userAgent = (request: Request): string | null =>
  request.headers.get("user-agent")?.slice(0, 500) ?? null;
