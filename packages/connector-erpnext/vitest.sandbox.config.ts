import { defineConfig } from "vitest/config";

// Opt-in live proof against the disposable ERPNext sandbox (ADR 0018). The
// suite skips itself unless ERPNEXT_BASE_URL and ERPNEXT_CREDENTIALS_FILE are set.
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
