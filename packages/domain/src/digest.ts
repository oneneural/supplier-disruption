import { createHash } from "node:crypto";
import { canonicalJson } from "@supplier-disruption/contracts";

/** SHA-256 of the canonical JSON's UTF-8 bytes, as lowercase hex. */
export function contentSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * A detached, deeply frozen copy of a JSON value. Nothing in the copy refers
 * to the caller's objects, and no nested object or array can be changed.
 */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
