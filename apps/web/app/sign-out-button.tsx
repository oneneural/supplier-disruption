"use client";

import { Button } from "../components/ui/button";

export function SignOutButton() {
  async function signOut() {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    // A full document load: a client navigation would keep the root layout,
    // and with it the signed-in header, from the old session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/");
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}
