/**
 * Loads .env for the test run. Vitest does not read it, and src/lib/env.ts
 * validates at import time, so this has to happen before any module under test
 * is imported - hence a setupFile rather than an import in each spec.
 *
 * OTP_DEV_ECHO must be true. The OTP specs learn the code they just issued from
 * requestOtp's devCode, which is only populated when it is on - the stored hash
 * is bcrypt and there is no provider to read the message from. Without it the
 * suite fails deep inside bcrypt with "Illegal arguments: undefined, string",
 * which does not point anywhere near the cause.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));

try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // Falls through to whatever the environment already provides.
}
