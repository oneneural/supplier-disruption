import type {
  CaseActorsResponse,
  CaseDetail,
  CaseListResponse,
  DemonstrationStatus,
  SessionResponse,
} from "@supplier-disruption/contracts";

// Server-side calls go straight to the loopback API with the caller's own cookie.
const API_INTERNAL_ORIGIN = "http://127.0.0.1:3001";

export type SessionResult =
  | { kind: "signed-in"; session: SessionResponse }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

export async function fetchSession(cookieHeader: string): Promise<SessionResult> {
  try {
    const response = await fetch(`${API_INTERNAL_ORIGIN}/api/session`, {
      headers: cookieHeader === "" ? {} : { cookie: cookieHeader },
      cache: "no-store",
    });
    if (response.status === 401) return { kind: "signed-out" };
    if (!response.ok) return { kind: "unavailable" };
    return { kind: "signed-in", session: (await response.json()) as SessionResponse };
  } catch {
    return { kind: "unavailable" };
  }
}

/** An authoritative read: the API's body, or the status and error code it refused with. */
export type ReadResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function read<T>(cookieHeader: string, path: string): Promise<ReadResult<T>> {
  try {
    const response = await fetch(`${API_INTERNAL_ORIGIN}${path}`, {
      headers: cookieHeader === "" ? {} : { cookie: cookieHeader },
      cache: "no-store",
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (body as { error?: string } | null)?.error ?? "unknown_error";
      return { ok: false, status: response.status, error };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 503, error: "api_unavailable" };
  }
}

export function fetchCases(cookieHeader: string, organizationId: string) {
  return read<CaseListResponse>(
    cookieHeader,
    `/api/cases?organizationId=${encodeURIComponent(organizationId)}`,
  );
}

export function fetchActors(cookieHeader: string, organizationId: string) {
  return read<CaseActorsResponse>(
    cookieHeader,
    `/api/cases/actors?organizationId=${encodeURIComponent(organizationId)}`,
  );
}

export function fetchCase(cookieHeader: string, caseId: string) {
  return read<CaseDetail>(cookieHeader, `/api/cases/${encodeURIComponent(caseId)}`);
}

/** Whether the API runs the explicit demonstration mode (ADR 0012); unknown reads as inactive. */
export async function fetchDemonstration(): Promise<DemonstrationStatus> {
  try {
    const response = await fetch(`${API_INTERNAL_ORIGIN}/api/demonstration`, { cache: "no-store" });
    if (!response.ok) return { active: false };
    return (await response.json()) as DemonstrationStatus;
  } catch {
    return { active: false };
  }
}
