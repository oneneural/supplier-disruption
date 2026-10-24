import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { numeric } from "drizzle-orm/pg-core";

/** Exact integral quantity storage, matching the contracts' 18-digit bound. */
export const quantity = (name: string) => numeric(name, { precision: 18, scale: 0 });

/**
 * The seed transaction an initialization function writes in. Initialization
 * functions only insert; they never update or repair existing rows.
 */
export type InitTransaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
