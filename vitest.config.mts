import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [here("./tests/helpers/setup.ts")],
    // These tests share one Postgres database and coordinate through advisory
    // state, so they run in one process rather than racing across workers.
    fileParallelism: false,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "server-only": here("./tests/stubs/server-only.ts"),
      "@": here("./src"),
    },
  },
});
