import { defineConfig } from "drizzle-kit";

// Generation reads the compiled schema so NodeNext ".js" imports resolve.
// Run `tsc -b` before `pnpm --filter @supplier-disruption/db generate`.
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./dist/schema/auth.js",
    "./dist/schema/app.js",
    "./dist/schema/cases.js",
    "./dist/schema/agent.js",
    "./dist/schema/spend.js",
    "./dist/schema/worker.js",
    "./dist/authorities/purchasing/schema.js",
    "./dist/authorities/inventory/schema.js",
    "./dist/authorities/demand/schema.js",
    "./dist/authorities/reference/schema.js",
  ],
  out: "./drizzle",
  schemaFilter: [
    "auth",
    "app",
    "agent_checkpoint",
    "worker",
    "fixture_purchasing",
    "fixture_inventory",
    "fixture_demand",
    "fixture_reference",
  ],
  strict: true,
});
