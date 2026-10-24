import { defineConfig } from "vitest/config";

// Default runs replay recorded sandbox responses and never open a network connection.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
  },
});
