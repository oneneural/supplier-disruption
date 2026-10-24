import { describe, expect, it } from "vitest";
import { describeError, isAbortError } from "../src/errors.js";
import { isPermanentDatabaseError } from "../src/heartbeat.js";

/** A driver-style error carrying a SQLSTATE or Node error code. */
function coded(code: string, message = `code ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

describe("permanent database errors", () => {
  it.each(["42501", "42P01", "42601", "3F000"])("treats SQLSTATE %s as permanent", (code) => {
    expect(isPermanentDatabaseError(coded(code))).toBe(true);
  });

  it.each(["57014", "40P01", "55P03", "08006", "53300", "25006"])("retries SQLSTATE %s", (code) => {
    expect(isPermanentDatabaseError(coded(code))).toBe(false);
  });

  it("finds the driver's SQLSTATE under Drizzle's wrapper", () => {
    const wrapped = new Error("Failed query: insert ...", { cause: coded("42501") });
    expect(isPermanentDatabaseError(wrapped)).toBe(true);
    const timeout = new Error("Failed query: insert ...", { cause: coded("57014") });
    expect(isPermanentDatabaseError(timeout)).toBe(false);
  });

  it("retries errors without a SQLSTATE, such as a refused connection", () => {
    expect(isPermanentDatabaseError(coded("ECONNREFUSED"))).toBe(false);
    expect(isPermanentDatabaseError(new Error("Connection terminated"))).toBe(false);
    expect(isPermanentDatabaseError("not an error")).toBe(false);
  });
});

describe("describeError", () => {
  it("lists the error and its causes", () => {
    const error = new Error("first heartbeat failed", {
      cause: new Error("Failed query", { cause: new Error("permission denied") }),
    });
    expect(describeError(error)).toBe(
      "Error: first heartbeat failed; cause: Error: Failed query; cause: Error: permission denied",
    );
  });

  it("ends a cyclic cause chain after five causes", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(describeError(a).split("; cause: ")).toEqual([
      "Error: a",
      "Error: b",
      "Error: a",
      "Error: b",
      "Error: a",
      "Error: b",
    ]);
  });

  it("describes a value that is not an error", () => {
    expect(describeError("stopped")).toBe("stopped");
  });
});

describe("isAbortError", () => {
  it("recognizes an aborted signal's reason", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
    expect(isAbortError(new Error("statement timeout"))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
