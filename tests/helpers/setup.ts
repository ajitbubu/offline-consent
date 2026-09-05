/**
 * Loads .env for the test run. Vitest does not read it, and src/lib/env.ts
 * validates at import time, so this has to happen before any module under test
 * is imported - hence a setupFile rather than an import in each spec.
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
