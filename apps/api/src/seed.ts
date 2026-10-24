import { ConfigError, loadSeedConfig } from "@supplier-disruption/config";
import {
  CANONICAL_FIXTURE_VERSION,
  SEED_LOCK_KEY,
  initializeCanonicalInputs,
} from "@supplier-disruption/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createAuth } from "./auth.js";
import { FIXTURE_BUYER_EMAIL, FIXTURE_MANAGER_EMAIL, FIXTURE_ORGANIZATION } from "./fixtures.js";
import { CASE_ACTORS, CASE_FIXTURE } from "./cases/fixture.js";
import { provisionCaseActors, provisionFixtures } from "./provision.js";

/**
 * One-off provisioning command: creates the synthetic pilot organization,
 * buyer and manager, then the canonical first-slice inputs (ADR 0004), then
 * the case workflow's simulated actors (ADR 0009). Uses a
 * seed-only Better Auth configuration that permits sign-up and never opens a
 * listener. Runs as the migrator role. A session advisory lock serializes
 * concurrent runs; the canonical inputs and their marker commit in one
 * transaction on the lock's own connection.
 */
async function main(): Promise<void> {
  const config = loadSeedConfig(process.env);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 3,
    application_name: "sd-seed",
  });
  const lock = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [SEED_LOCK_KEY]);
    const db = drizzle(pool);
    const auth = createAuth(db, {
      appOrigin: config.appOrigin,
      secret: config.betterAuthSecret,
      production: false,
      allowSignUp: true,
    });
    const result = await provisionFixtures(db, auth, FIXTURE_ORGANIZATION, [
      {
        email: FIXTURE_BUYER_EMAIL,
        name: "Synthetic Buyer",
        password: config.buyerPassword,
        role: "buyer",
      },
      {
        email: FIXTURE_MANAGER_EMAIL,
        name: "Synthetic Manager",
        password: config.managerPassword,
        role: "manager",
      },
    ]);
    const changes =
      Number(result.organizationCreated) +
      result.usersCreated.length +
      result.membershipsCreated.length;
    process.stdout.write(
      changes === 0
        ? "seed: fixtures already present; nothing changed\n"
        : `seed: organization created=${String(result.organizationCreated)}, users created=[${result.usersCreated.join(", ")}], memberships created=[${result.membershipsCreated.join(", ")}]\n`,
    );

    const canonical = await initializeCanonicalInputs(drizzle(lock));
    process.stdout.write(
      canonical === "initialized"
        ? `seed: canonical inputs ${CANONICAL_FIXTURE_VERSION} initialized\n`
        : `seed: canonical inputs ${CANONICAL_FIXTURE_VERSION} already present; nothing changed\n`,
    );

    // The same synthetic users act in the organization's cases as labeled
    // simulated actors.
    const actors = await provisionCaseActors(db, CASE_FIXTURE.organization.id, CASE_ACTORS, {
      buyer: FIXTURE_BUYER_EMAIL,
      manager: FIXTURE_MANAGER_EMAIL,
    });
    process.stdout.write(
      actors.length > 0
        ? `seed: simulated case actors created=[${actors.join(", ")}]\n`
        : "seed: simulated case actors already present; nothing changed\n",
    );
  } finally {
    // Closing the connection releases the session lock.
    lock.release(true);
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  // Query errors wrap the database error; its message names the violated constraint.
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  process.stderr.write(
    error instanceof ConfigError
      ? `${error.message}\n`
      : `seed: failed: ${String(error)}${cause}\n`,
  );
  process.exitCode = 1;
}
