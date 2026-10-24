import type { CaseSummary } from "@supplier-disruption/contracts";
import { cookies } from "next/headers";
import Link from "next/link";
import { CaseStateBadge } from "../components/state-badge";
import { Notice, Panel } from "../components/ui/panel";
import { Table, Td, Th } from "../components/ui/table";
import { DemonstrationNotice } from "../components/demonstration-notice";
import { fetchCases, fetchDemonstration, fetchSession } from "../lib/api";
import { age, codeLabel, roleLabel } from "../lib/format";
import { LoadFixtureButton } from "./load-fixture-button";
import { SignInForm } from "./sign-in-form";
import { SupplierEmailForm } from "./supplier-email-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieHeader = (await cookies()).toString();
  const result = await fetchSession(cookieHeader);

  if (result.kind === "unavailable") {
    return <p role="alert">The API is unavailable. Start it and reload this page.</p>;
  }

  if (result.kind === "signed-out") {
    // Signed out, the layout reads nothing from the API, so this page shows the mode itself.
    const demonstration = await fetchDemonstration();
    return (
      <div className="mx-auto max-w-md space-y-4">
        {demonstration.active && (
          <div className="overflow-hidden rounded-[var(--radius-panel)] border border-border">
            <DemonstrationNotice status={demonstration} />
          </div>
        )}
        <div className="rounded-[var(--radius-panel)] border border-border bg-surface p-6">
          <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
          <p className="mb-4 text-sm text-muted">
            Choose a synthetic fixture identity. Its simulated roles decide what the API accepts.
          </p>
          <SignInForm />
        </div>
      </div>
    );
  }

  const { memberships } = result.session;
  const demonstration = await fetchDemonstration();
  const queues = await Promise.all(
    memberships.map(async (membership) => ({
      membership,
      cases: await fetchCases(cookieHeader, membership.organizationId),
    })),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Exception queue</h1>
        <p className="text-sm text-muted">
          Supplier changes that need a decision, oldest first. State and next action come from the
          API&apos;s case records.
        </p>
      </div>
      {queues.map(({ membership, cases }) => (
        <Panel
          key={membership.organizationId}
          id={`queue-${membership.organizationId}`}
          title={membership.organizationName}
          description={`Your membership role: ${membership.role}`}
          actions={<LoadFixtureButton organizationId={membership.organizationId} />}
        >
          {cases.ok ? (
            <CaseQueue cases={cases.data.cases} />
          ) : (
            <p role="alert">
              The case list could not be read (HTTP {cases.status}: {cases.error}).
            </p>
          )}
        </Panel>
      ))}
      {queues.map(({ membership }) => (
        <Panel
          key={`email-${membership.organizationId}`}
          id={`email-${membership.organizationId}`}
          title="Supplier email"
          description={
            demonstration.active
              ? "Demonstration mode: the extraction agent replays the recorded model run of the C-01 sample email, with no model call; any other text pauses for the buyer. Intake and assessment then validate the proposal as for any message."
              : "Paste an unstructured supplier email. The extraction agent proposes structured terms with cited evidence; intake and assessment then validate them as for any message."
          }
        >
          <SupplierEmailForm organizationId={membership.organizationId} />
        </Panel>
      ))}
    </div>
  );
}

function CaseQueue({ cases }: { cases: CaseSummary[] }) {
  if (cases.length === 0) {
    return (
      <Notice>No open cases. Load the fixture message to open the C-01 schedule change.</Notice>
    );
  }
  return (
    <Table label="Supplier cases">
      <thead>
        <tr>
          <Th>Case</Th>
          <Th>State</Th>
          <Th>Severity reason</Th>
          <Th>Owner</Th>
          <Th>Next action</Th>
          <Th className="text-right">Age</Th>
          <Th>Message</Th>
        </tr>
      </thead>
      <tbody>
        {cases.map((item) => (
          <tr key={item.caseId} data-case-ref={item.caseRef}>
            <Td>
              <Link
                href={`/cases/${item.caseId}`}
                className="font-mono font-semibold text-accent underline underline-offset-4"
              >
                {item.caseRef}
              </Link>
            </Td>
            <Td>
              <CaseStateBadge state={item.state} />
            </Td>
            <Td>
              {codeLabel(item.reason)}
              {item.reason !== null && (
                <code className="block text-xs text-muted">{item.reason}</code>
              )}
            </Td>
            <Td>{roleLabel(item.owner)}</Td>
            <Td className="max-w-80">{item.nextAction}</Td>
            <Td className="text-right whitespace-nowrap">{age(item.ageSeconds)}</Td>
            <Td className="font-mono text-xs">
              {item.messageId}
              {item.proposalId !== null && ` / ${item.proposalId}`}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
