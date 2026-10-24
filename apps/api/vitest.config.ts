import { defineConfig } from "vitest/config";

// Integration tests share one Compose PostgreSQL database, so files run one at a time.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
