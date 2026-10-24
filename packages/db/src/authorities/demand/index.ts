// Public read-only runtime surface of the fixture demand authority. Its tables
// and initialization stay private to this directory and the seed.
export { createDemandSource, type DemandRead, type DemandSource } from "./source.js";
export {
  DEFAULT_SOURCE_TIMEOUTS,
  SourceRejectedError,
  type SourceOptions,
  type SourceTimeouts,
} from "../runtime.js";
