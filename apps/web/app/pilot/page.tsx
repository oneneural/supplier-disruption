import { cookies } from "next/headers";
import { fetchSession } from "../../lib/api";
import { PilotOperationPanel } from "./pilot-operation-panel";

export const dynamic = "force-dynamic";

/** The toolchain pilot: a placeholder command and its bounded status stream. */
export default async function PilotPage() {
  const result = await fetchSession((await cookies()).toString());

  if (result.kind === "unavailable") {
    return <p role="alert">The API is unavailable. Start it and reload this page.</p>;
  }
  if (result.kind === "signed-out") {
    return <p role="alert">Sign in on the exception queue page first.</p>;
  }

  const { user, memberships } = result.session;
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Pilot operation</h1>
      <section aria-labelledby="session-heading" className="text-sm">
        <h2 id="session-heading" className="font-semibold">
          Session
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4">
          <dt className="font-medium">Signed in as</dt>
          <dd>
            {user.name} ({user.email})
          </dd>
          {memberships.map((membership) => (
            <div key={membership.organizationId} className="contents">
              <dt className="font-medium">{membership.organizationName}</dt>
              <dd>Role: {membership.role}</dd>
            </div>
          ))}
        </dl>
      </section>
      {memberships.map((membership) => (
        <PilotOperationPanel
          key={membership.organizationId}
          organizationId={membership.organizationId}
          organizationName={membership.organizationName}
          role={membership.role}
        />
      ))}
    </div>
  );
}
