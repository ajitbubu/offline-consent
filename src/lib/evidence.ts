/**
 * Evidence storage: the scanned forms and captured signatures that prove
 * consent was given.
 *
 * Local disk is the only backend, so there is no storage interface here - three
 * functions and a path. Moving to object storage later is a change to this file
 * and nothing else.
 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "@/lib/env";
import { pool, type Executor } from "@/lib/db";

export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;

export type EvidenceKind = "scan" | "signature" | "csv_source";

export type EvidenceContentType =
  | "image/jpeg"
  | "image/png"
  | "application/pdf"
  | "text/csv";

export interface EvidenceObject {
  id: string;
  storage_key: string;
  kind: EvidenceKind;
  content_type: EvidenceContentType;
  original_filename: string;
  byte_size: string;
  sha256: string;
}

const root = () => resolve(process.cwd(), env.EVIDENCE_DIR);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Control characters that never appear in a real CSV: NUL and friends. */
const BINARY_MARKER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Content type from the file's own bytes, never from the browser's
 * Content-Type header - which is attacker-controlled and, for a bulk upload of
 * scans from outside the organisation, so is the file.
 *
 * CSV has no magic number, so it is accepted only when the caller already
 * expects one and the bytes decode as text without control characters.
 */
export function sniffContentType(
  bytes: Buffer,
  expectCsv: boolean,
): EvidenceContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return "image/png";
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }

  if (expectCsv) {
    const head = bytes.subarray(0, 4096).toString("utf8");
    // Reject anything carrying NULs or stray control bytes: that is a binary
    // file wearing a .csv extension.
    if (head.length > 0 && !BINARY_MARKER.test(head)) return "text/csv";
  }

  return null;
}

/**
 * Writes bytes to disk and records the metadata row.
 *
 * The storage key is generated here and never derived from the uploaded
 * filename, so path traversal is impossible by construction rather than by
 * sanitising a hostile string.
 */
export async function putEvidence(
  bytes: Buffer,
  meta: {
    kind: EvidenceKind;
    contentType: EvidenceContentType;
    originalFilename: string;
    uploadedBy: string;
  },
  executor: Executor = pool,
): Promise<EvidenceObject> {
  if (bytes.length === 0) throw new Error("Empty file");
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error("File is too large");

  const now = new Date();
  const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // The same bytes are the same file. evidence_object_sha256_idx has existed
  // since migration 004, commented "Detects a re-upload of a form already on
  // file", and nothing read it - so re-uploading a scan wrote the bytes to disk
  // again under a new key, and eighteen rows in this database are byte-identical
  // copies of each other. Reuse rather than duplicate: the retention date stays
  // the one stamped when the bytes were first held, which is when the clock
  // actually started.
  //
  // A destroyed object is not reused. Its row survives as the record that the
  // evidence existed and was destroyed, but the bytes are gone.
  const { rows: identical } = await executor.query<EvidenceObject>(
    `SELECT id, storage_key, kind, content_type, original_filename, byte_size, sha256
       FROM evidence_object
      WHERE sha256 = $1 AND kind = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sha256, meta.kind],
  );
  if (identical.length > 0) return identical[0];

  // Retention is stamped now and stored, so that changing
  // EVIDENCE_RETENTION_YEARS later can never move the retention date of
  // something already held.
  const retentionUntil = new Date(now);
  retentionUntil.setUTCFullYear(
    retentionUntil.getUTCFullYear() + env.EVIDENCE_RETENTION_YEARS,
  );

  // The row is written BEFORE the bytes.
  //
  // Writing the file first meant a failed or rolled-back insert left a scan of
  // somebody's signed consent form on disk with nothing referencing it - and
  // an unreferenced object is one no retention sweep and no destroyEvidence
  // call will ever reach, so it sits there permanently. In this order the
  // failure mode is a row whose file is missing, which is detectable, and the
  // compensating delete below usually removes even that.
  const { rows } = await executor.query<EvidenceObject>(
    `INSERT INTO evidence_object
       (storage_key, kind, content_type, original_filename, byte_size, sha256,
        retention_until, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, storage_key, kind, content_type, original_filename, byte_size, sha256`,
    [
      storageKey,
      meta.kind,
      meta.contentType,
      // Kept for display only. Truncated so a pathological filename cannot
      // bloat the row, and never used to build a path.
      meta.originalFilename.slice(0, 255),
      bytes.length,
      sha256,
      retentionUntil,
      meta.uploadedBy,
    ],
  );

  const absolute = join(root(), storageKey);
  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes, { flag: "wx" });
  } catch (error) {
    // Best effort: drop the row we just wrote so the two do not disagree. If
    // this delete fails too, or the caller is inside a transaction that later
    // rolls back, the row simply has no file - which getEvidenceBytes reports
    // as ENOENT rather than hiding.
    await executor
      .query("DELETE FROM evidence_object WHERE id = $1", [rows[0].id])
      .catch(() => {});
    throw error;
  }

  return rows[0];
}

/**
 * Reads the bytes back. Re-asserts that the resolved path is still inside the
 * evidence root: the key comes from our own database, but a defence that only
 * holds while every writer is well behaved is not a defence.
 */
export async function getEvidenceBytes(storageKey: string): Promise<Buffer> {
  const base = root();
  const absolute = resolve(base, storageKey);
  if (absolute !== base && !absolute.startsWith(base + sep)) {
    throw new Error("Evidence path escapes the storage root");
  }
  return readFile(absolute);
}

/**
 * Destroys the bytes but keeps the row, its hash and its audit trail: the
 * record that evidence existed, and when it was destroyed, is itself evidence.
 */
export async function destroyEvidence(
  id: string,
  reason: string,
  executor: Executor = pool,
): Promise<void> {
  const { rows } = await executor.query<{ storage_key: string }>(
    `UPDATE evidence_object
        SET deleted_at = now(), deleted_reason = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING storage_key`,
    [id, reason],
  );
  if (rows.length === 0) return;

  try {
    await unlink(join(root(), rows[0].storage_key));
  } catch (error) {
    // The row is already marked destroyed. A missing file means it was removed
    // out of band, which is not a reason to fail the caller.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
