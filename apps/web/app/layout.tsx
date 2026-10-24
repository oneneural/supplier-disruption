import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { DemonstrationNotice } from "../components/demonstration-notice";
import { fetchDemonstration, fetchSession } from "../lib/api";
import { SessionKeepAlive } from "./session-keep-alive";
import { SignOutButton } from "./sign-out-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "Supplier disruption workbench",
  description: "Operator workbench for supplier schedule changes, with synthetic fixture data",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The layout also wraps Next's own 404 pages, so a cookie-less request (such
  // as a probe of an internal path through the proxy) must not reach the API
  // at all (P4). Without a cookie the API would only answer 401 anyway.
  const cookieHeader = (await cookies()).toString();
  const session = cookieHeader === "" ? null : await fetchSession(cookieHeader);
  const demonstration = cookieHeader === "" ? null : await fetchDemonstration();
  const user = session?.kind === "signed-in" ? session.session.user : null;
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-10 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <p
          className="bg-banner-bg px-4 py-1.5 text-center text-sm font-semibold text-banner-fg"
          role="note"
        >
          Synthetic fixture identities. Simulated roles, not enterprise authentication.
        </p>
        {demonstration !== null && <DemonstrationNotice status={demonstration} />}
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <Link href="/" className="text-base font-semibold">
              Supplier disruption workbench
            </Link>
            {user !== null && (
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <nav aria-label="Primary">
                  <ul className="flex gap-4">
                    <li>
                      <Link href="/" className="underline-offset-4 hover:underline">
                        Exception queue
                      </Link>
                    </li>
                    <li>
                      <Link href="/pilot" className="underline-offset-4 hover:underline">
                        Pilot operation
                      </Link>
                    </li>
                  </ul>
                </nav>
                <span className="text-muted">
                  Signed in as {user.name} ({user.email})
                </span>
                <SignOutButton />
              </div>
            )}
          </div>
        </header>
        {user !== null && <SessionKeepAlive />}
        <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          {children}
        </main>
      </body>
    </html>
  );
}
