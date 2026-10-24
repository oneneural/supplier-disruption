import { fileURLToPath } from "node:url";

// Fixed loopback upstream. Configuration chooses it at build time; user input never does.
const API_UPSTREAM = "http://127.0.0.1:3001";

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  // Trace from the repository root so workspace packages land in the standalone output.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  // Compression would hold proxied server-sent events until a buffer fills.
  // The API also marks its streams no-transform; nothing here is compressed.
  compress: false,
  async rewrites() {
    return {
      // Only /api/* is proxied. /internal/* is never rewritten, so worker
      // endpoints are unreachable through the browser origin.
      beforeFiles: [{ source: "/api/:path*", destination: `${API_UPSTREAM}/api/:path*` }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
