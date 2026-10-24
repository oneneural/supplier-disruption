import { caseActor, membership, organization, user } from "@supplier-disruption/db";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Auth } from "./auth.js";
import type { CaseActorBinding } from "./cases/fixture.js";
import type { FixtureOrganization, FixtureUser } from "./fixtures.js";

export interface ProvisionResult {
  organizationCreated: boolean;
  usersCreated: string[];
  membershipsCreated: string[];
}

/**
 * Creates a fixture organization, users and memberships if absent. Existing
 * rows are left untouched, including passwords, so rerunning changes nothing.
 * `auth` must be a provisioning configuration that permits sign-up.
 */
export async function provisionFixtures(
  db: NodePgDatabase,
  auth: Auth,
  org: FixtureOrganization,
  users: readonly FixtureUser[],
): Promise<ProvisionResult> {
  const created = await db
    .insert(organization)
    .values(org)
    .onConflictDoNothing({ target: organization.id })
    .returning({ id: organization.id });

  const result: ProvisionResult = {
    organizationCreated: created.length > 0,
    usersCreated: [],
    membershipsCreated: [],
  };

  for (const fixture of users) {
    let [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, fixture.email));
    if (row === undefined) {
      await auth.api.signUpEmail({
        body: { email: fixture.email, password: fixture.password, name: fixture.name },
      });
      [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, fixture.email));
      if (row === undefined) {
        throw new Error(`provisioning did not create ${fixture.email}`);
      }
      result.usersCreated.push(fixture.email);
    }
    const inserted = await db
      .insert(membership)
      .values({ organizationId: org.id, userId: row.id, role: fixture.role })
      .onConflictDoNothing()
      .returning({ userId: membership.userId });
    if (inserted.length > 0) {
      result.membershipsCreated.push(fixture.email);
    }
  }
  return result;
}

/**
 * Binds the simulated case actors to existing fixture users if absent.
 * Existing bindings are left untouched, so rerunning changes nothing.
 */
export async function provisionCaseActors(
  db: NodePgDatabase,
  organizationId: string,
  bindings: readonly CaseActorBinding[],
  emails: Record<CaseActorBinding["user"], string>,
): Promise<string[]> {
  const created: string[] = [];
  for (const binding of bindings) {
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, emails[binding.user]));
    if (row === undefined) {
      throw new Error(`case actor ${binding.actorId} needs the user ${emails[binding.user]}`);
    }
    const inserted = await db
      .insert(caseActor)
      .values({
        organizationId,
        actorId: binding.actorId,
        role: binding.role,
        vendorId: binding.vendorId,
        userId: row.id,
        simulated: true,
      })
      .onConflictDoNothing()
      .returning({ actorId: caseActor.actorId });
    if (inserted.length > 0) created.push(binding.actorId);
  }
  return created;
}
