import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { account, session, user, verification } from "@supplier-disruption/db";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** All five local projects share host 127.0.0.1; ports do not isolate cookies. */
export const COOKIE_PREFIX = "supplier-disruption";
export const AUTH_BASE_PATH = "/api/auth";

/**
 * Sign-in limits (ADR 0020). Each account gets Better Auth's own sign-in
 * rule, 3 attempts per 10 s, keyed on its normalized email, so one user can
 * neither evade its limit nor spend another user's. Better Auth's per-address
 * bucket stays as a shared ceiling: behind the proxy every request comes
 * from 127.0.0.1, so it bounds attempts across all accounts together.
 */
export const SIGN_IN_ACCOUNT_LIMIT = { window: 10, max: 3 } as const;
export const SIGN_IN_SHARED_LIMIT = { window: 10, max: 30 } as const;

export interface AuthSettings {
  appOrigin: string;
  secret: string;
  production: boolean;
  /** Only the one-off provisioning command may register users. */
  allowSignUp: boolean;
}

export function createAuth(db: NodePgDatabase, settings: AuthSettings) {
  return betterAuth(authOptions(settings, db));
}

/** Better Auth options, exported so tests can inspect the security settings directly. */
export function authOptions(settings: AuthSettings, db: NodePgDatabase) {
  return {
    appName: "Supplier disruption",
    baseURL: settings.appOrigin,
    basePath: AUTH_BASE_PATH,
    secret: settings.secret,
    trustedOrigins: [settings.appOrigin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !settings.allowSignUp,
      // Provisioning must not leave live sessions behind.
      autoSignIn: false,
    },
    session: {
      // Authorization reads sessions and roles fresh from PostgreSQL.
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: new URL(settings.appOrigin).protocol === "https:",
      // Better Auth turns both checks off by default when NODE_ENV=test or TEST
      // is set. Setting them explicitly keeps tests and deployments identical.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    rateLimit: {
      enabled: settings.production,
      customRules: { "/sign-in/email": SIGN_IN_SHARED_LIMIT },
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

export type Auth = ReturnType<typeof createAuth>;

interface Bucket {
  count: number;
  lastRequest: number;
}

/**
 * The per-account sign-in limit, with Better Auth's rule semantics: up to
 * `max` allowed attempts, and the count resets once `window` seconds pass
 * after the last allowed attempt. A rejected attempt changes nothing. Kept in
 * this process's memory, like Better Auth's own limiter here.
 */
export class SignInLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly rule: { window: number; max: number } = SIGN_IN_ACCOUNT_LIMIT) {}

  /** Seconds to wait, or null when the attempt is allowed and counted. */
  consume(email: string, now = Date.now()): number | null {
    const windowMs = this.rule.window * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRequest >= windowMs) this.buckets.delete(key);
    }
    const key = email.trim().toLowerCase();
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, { count: 1, lastRequest: now });
      return null;
    }
    if (bucket.count >= this.rule.max) {
      return Math.ceil((bucket.lastRequest + windowMs - now) / 1000);
    }
    bucket.count += 1;
    bucket.lastRequest = now;
    return null;
  }
}
