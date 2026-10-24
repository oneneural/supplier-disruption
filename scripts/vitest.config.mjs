import { defineConfig } from "vitest/config";

// Workspace-level checks that belong to no single package, such as the lint rules.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.mjs"],
    testTimeout: 60_000,
  },
});
