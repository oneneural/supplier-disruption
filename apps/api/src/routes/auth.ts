import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import { AUTH_BASE_PATH, SignInLimiter, type Auth } from "../auth.js";

const SIGN_IN_PATH = `${AUTH_BASE_PATH}/sign-in/email`;

/**
 * Better Auth answers 404 to trailing-slash and repeated-slash spellings of
 * the sign-in path. The adapter folds them anyway, so an account's limit
 * covers every spelling even if routing changes.
 */
function isSignIn(pathname: string): boolean {
  return pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") === SIGN_IN_PATH;
}

/** The account a sign-in names; an unreadable body shares one bucket. */
function signInEmail(body: string | undefined): string {
  try {
    const email = (JSON.parse(body ?? "") as { email?: unknown }).email;
    return typeof email === "string" ? email : "";
  } catch {
    return "";
  }
}

/**
 * Mounts Better Auth under /api/auth. Bodies are forwarded unparsed, and every
 * Set-Cookie header is forwarded separately.
 */
export function authRoutes(
  app: FastifyInstance,
  options: { auth: Auth; appOrigin: string },
  done: (error?: Error) => void,
): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  // Only where Better Auth limits too (production), so tests and gates see one
  // policy. Created on the first request, once the auth instance is in use.
  let accounts: SignInLimiter | null | undefined;

  app.route({
    method: ["GET", "POST"],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => {
      // The fixed public origin is the base; the incoming Host header is never trusted.
      const url = new URL(request.url, options.appOrigin);
      const body =
        typeof request.body === "string" && request.body !== "" ? request.body : undefined;
      accounts ??= options.auth.options.rateLimit.enabled ? new SignInLimiter() : null;
      if (accounts !== null && request.method === "POST" && isSignIn(url.pathname)) {
        const retryAfter = accounts.consume(signInEmail(body));
        if (retryAfter !== null) {
          // The same refusal Better Auth sends for its own limit.
          return reply
            .status(429)
            .header("x-retry-after", String(retryAfter))
            .send({ message: "Too many requests. Please try again later." });
        }
      }
      // Better Auth keys its rate limit and the session's IP on X-Forwarded-For.
      // The Next proxy passes a client's header through unchanged and adds
      // none, so the client value is replaced by the connecting address
      // (127.0.0.1 behind the proxy): one shared bucket nobody can choose.
      const headers = fromNodeHeaders(request.headers);
      headers.delete("x-forwarded-for");
      if (request.socket.remoteAddress !== undefined) {
        headers.set("x-forwarded-for", request.socket.remoteAddress);
      }
      const response = await options.auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );

      reply.status(response.status);
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") {
          reply.header(name, value);
        }
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header("set-cookie", cookies);
      }
      return reply.send(response.body === null ? null : await response.text());
    },
  });
  done();
}
