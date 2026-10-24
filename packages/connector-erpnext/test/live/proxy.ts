import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A loopback fault proxy for the live proof. `forward_then_drop` sends the
 * request to the sandbox, waits for the complete upstream response and then
 * closes the client connection without answering: the source committed, the
 * client cannot know. `drop` closes the connection without forwarding.
 * Headers are passed through in memory and never recorded.
 */
export interface FaultProxy {
  readonly url: string;
  readonly forwarded: () => number;
  readonly upstreamStatuses: () => readonly number[];
  close(): Promise<void>;
}

function readBody(message: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    message.on("data", (chunk: Buffer) => chunks.push(chunk));
    message.on("end", () => resolve(Buffer.concat(chunks)));
    message.on("error", reject);
  });
}

export async function startFaultProxy(
  upstream: string,
  mode: "forward_then_drop" | "drop",
): Promise<FaultProxy> {
  const target = new URL(upstream);
  let forwarded = 0;
  const statuses: number[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      if (mode === "drop") {
        res.socket?.destroy();
        return;
      }
      forwarded += 1;
      const upstreamResponse = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: target.hostname,
            port: target.port,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: target.host },
          },
          resolve,
        );
        outgoing.on("error", reject);
        outgoing.end(body);
      });
      await readBody(upstreamResponse);
      statuses.push(upstreamResponse.statusCode ?? 0);
      res.socket?.destroy();
    })().catch(() => res.socket?.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    forwarded: () => forwarded,
    upstreamStatuses: () => statuses,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
