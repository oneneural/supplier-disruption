import { systemClock } from "@supplier-disruption/config";
import type { Clock } from "@supplier-disruption/contracts";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Auth } from "./auth.js";
import type { AgentSettings } from "./cases/extraction.js";
import { CaseWorkflow, type CaseFaultHooks } from "./cases/workflow.js";
import type { Demonstration } from "./demonstration/index.js";
import type { HealthDependencies } from "./health.js";
import { authRoutes } from "./routes/auth.js";
import { caseRoutes } from "./routes/cases.js";
import { demonstrationRoutes } from "./routes/demonstration.js";
import { healthRoutes } from "./routes/health.js";
import { internalRoutes } from "./routes/internal.js";
import { pilotRoutes, type PilotFaultHooks } from "./routes/pilot.js";
import { PilotStreams } from "./streams.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Business time for source and domain consumers; operational timers use real time. */
    businessClock: Clock;
  }
}

export interface AppDependencies {
  db: NodePgDatabase;
  /**
   * Connections for the fixture source modules. A database-backed business
   * clock must use its own pool, never this one (ADR 0005).
   */
  sourcePool: pg.Pool;
  auth: Auth;
  boss: PgBoss;
  appOrigin: string;
  workerServiceToken: string;
  health: HealthDependencies;
  logger: FastifyServerOptions["logger"];
  /** Business time. Defaults to the system clock. */
  clock?: Clock;
  /** Test-only. Production wiring in main.ts never passes fault hooks. */
  faults?: PilotFaultHooks;
  /**
   * Test-only, except the demonstration mode's labelled uncertain-write
   * control (ADR 0012); main.ts passes no other fault hooks.
   */
  caseFaults?: CaseFaultHooks;
  /** Extraction agent settings (ADR 0011); omitted, email cases pause without a provider. */
  agent?: AgentSettings;
  /** Only in the explicit demonstration mode (ADR 0012). */
  demonstration?: Demonstration;
}

/**
 * Replaces Fastify's "incoming request" line with the route pattern that will
 * handle the request ("none" when no route matched) and the raw request
 * target exactly as received. It is written on arrival, so a stream whose
 * client disconnects is recorded too. Routes registered with logLevel "warn"
 * (the readiness probes) are not logged; completion lines stay as Fastify writes them.
 */
class RouteLogController extends LogController {
  override incomingRequest(request: FastifyRequest, _reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? "none",
        target: request.raw.url,
      },
      "request",
    );
  }
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // The API listens on loopback behind the web proxy; it never trusts forwarding headers.
    trustProxy: false,
    bodyLimit: 64 * 1024,
    logController: new RouteLogController(),
  });
  const streams = new PilotStreams();
  const clock = deps.clock ?? systemClock;
  app.decorate("businessClock", clock);
  const workflow = new CaseWorkflow({
    db: deps.db,
    sourcePool: deps.sourcePool,
    clock,
    boss: deps.boss,
    ...(deps.caseFaults === undefined ? {} : { faults: deps.caseFaults }),
    ...(deps.agent === undefined ? {} : { agent: deps.agent }),
  });

  app.addHook("onSend", async (_request, reply) => {
    // Every response is no-store, whatever a handler or Better Auth set, except
    // event streams, which keep their own no-cache, no-transform policy.
    const type = reply.getHeader("content-type");
    if (typeof type !== "string" || !type.startsWith("text/event-stream")) {
      reply.header("cache-control", "no-store");
    }
  });

  // Open streams would otherwise hold close() until their own end.
  app.addHook("preClose", (done) => {
    streams.closeAll("shutdown");
    done();
  });

  void app.register(authRoutes, { auth: deps.auth, appOrigin: deps.appOrigin });
  void app.register(pilotRoutes, {
    db: deps.db,
    auth: deps.auth,
    boss: deps.boss,
    appOrigin: deps.appOrigin,
    streams,
    faults: deps.faults,
  });
  void app.register(caseRoutes, {
    db: deps.db,
    auth: deps.auth,
    appOrigin: deps.appOrigin,
    workflow,
  });
  void app.register(demonstrationRoutes, {
    db: deps.db,
    auth: deps.auth,
    appOrigin: deps.appOrigin,
    workflow,
    demonstration: deps.demonstration ?? null,
  });
  void app.register(healthRoutes, { ...deps.health, openStreams: () => streams.count });
  void app.register(internalRoutes, {
    db: deps.db,
    boss: deps.boss,
    workerServiceToken: deps.workerServiceToken,
    workflow,
  });
  return app;
}
