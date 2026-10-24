import type { FastifyInstance } from "fastify";
import { apiReadiness, currentBootHeartbeat, type HealthDependencies } from "../health.js";

/**
 * Readiness probes for the container's healthcheck and watchdog. They live
 * under /internal, which the web proxy never forwards, so they are reachable
 * only on the loopback API listener inside the container. They need no
 * credential because they return status codes and reasons, never data.
 * Probes arrive every second or two, so only warnings and errors are logged.
 */
export function healthRoutes(
  app: FastifyInstance,
  options: HealthDependencies & { openStreams: () => number },
  done: (error?: Error) => void,
): void {
  app.get("/internal/health/ready", { logLevel: "warn" }, async (_request, reply) => {
    const readiness = await apiReadiness(options);
    return reply.status(readiness.ready ? 200 : 503).send(readiness);
  });

  app.get("/internal/health/worker", { logLevel: "warn" }, async (_request, reply) => {
    const heartbeat = await currentBootHeartbeat(options);
    return reply.status(heartbeat.fresh ? 200 : 503).send(heartbeat);
  });

  // The number of pilot status streams open in this API process. Tests read
  // it to observe that a disconnected stream released its resources.
  app.get("/internal/health/streams", { logLevel: "warn" }, async (_request, reply) => {
    return reply.send({ openPilotStreams: options.openStreams() });
  });
  done();
}
