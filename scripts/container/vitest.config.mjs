import { defineConfig } from "vitest/config";

// Container gate tests (ADR 0002). They build the app image from a fresh clone
// and drive Docker in disposable Compose projects, one file at a time.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["**/*.test.mjs"],
    globalSetup: ["./global-setup.mjs"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    teardownTimeout: 300_000,
  },
});
