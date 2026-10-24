"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";

const FIXTURE_USERS = [
  { email: "manager@fixture.local", label: "Synthetic manager" },
  { email: "buyer@fixture.local", label: "Synthetic buyer" },
];

const FIELD =
  "mt-1 block h-10 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm";

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (!response.ok) {
        setError("Sign-in failed. Check the fixture password in .secrets/.");
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="space-y-4">
      <label className="block text-sm font-medium">
        Fixture identity
        <select name="email" defaultValue={FIXTURE_USERS[0]?.email} className={FIELD}>
          {FIXTURE_USERS.map((user) => (
            <option key={user.email} value={user.email}>
              {user.label} ({user.email})
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={FIELD}
        />
      </label>
      <Button type="submit" disabled={pending}>
        Sign in
      </Button>
      {error !== null && (
        <p role="alert" className="text-sm text-blocked-fg">
          {error}
        </p>
      )}
    </form>
  );
}
