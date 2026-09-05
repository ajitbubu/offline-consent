/**
 * The only module in the app that reads process.env.
 *
 * Validation runs at import time so a misconfigured deployment fails at boot
 * with a readable message rather than at the first request that needs a secret.
 */
import "server-only";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),

  // 32 chars is the floor for HS256 to be worth anything. Both credential
  // classes (staff and data principal) are signed with this, separated by
  // audience rather than by key.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

  // Peppers the OTP destination hash so a database leak does not hand the
  // attacker a phone directory.
  OTP_PEPPER: z.string().min(16, "OTP_PEPPER must be at least 16 characters"),

  EVIDENCE_DIR: z.string().default("./.evidence"),
  EVIDENCE_RETENTION_YEARS: z.coerce.number().int().positive().default(8),

  // Compared against the Origin header on every mutating staff route.
  APP_ORIGIN: z.string().url().default("http://localhost:1002"),

  OTP_DEV_ECHO: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  ML_SERVICE_URL: z.string().url().optional(),

  // Whether X-Forwarded-For may be believed. Only set this when the app really
  // does sit behind a proxy that overwrites the header, because a spoofable
  // client IP defeats every per-IP rate limit that reads it.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${detail}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

// Echoing OTP codes to the console is a development affordance. Shipping it
// would put every live code into the server log, so a production server refuses
// to start with it on.
//
// Skipped during `next build`, which runs with NODE_ENV=production while
// collecting page data but is a compiler, not a running server - the deployed
// process still hits this check on boot.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (isProduction && !isBuildPhase && env.OTP_DEV_ECHO) {
  throw new Error("OTP_DEV_ECHO must not be enabled in production");
}
