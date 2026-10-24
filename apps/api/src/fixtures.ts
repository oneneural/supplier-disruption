import type { MembershipRole } from "@supplier-disruption/contracts";

/** Synthetic fixture identities. They are not enterprise identities. */
export interface FixtureOrganization {
  id: string;
  slug: string;
  name: string;
}

export interface FixtureUser {
  email: string;
  name: string;
  password: string;
  role: MembershipRole;
}

export const FIXTURE_ORGANIZATION: FixtureOrganization = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  slug: "fixture-distributor",
  name: "Fixture Distributor (synthetic)",
};

export const FIXTURE_BUYER_EMAIL = "buyer@fixture.local";
export const FIXTURE_MANAGER_EMAIL = "manager@fixture.local";
