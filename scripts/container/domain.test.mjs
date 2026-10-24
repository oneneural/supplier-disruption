// D12 packaged seed (ADR 0004): the image's own init service creates the
// canonical C-01 inputs, the app runs with the system business clock, and
// repeat init and app recreation keep the records. Expectations are the
// independently written rows the D10 and D11 gates use.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CANONICAL_MANIFEST_SHA256,
  CANONICAL_QUERIES,
  DERIVED_ELIGIBLE,
  DERIVED_ELIGIBLE_QUERY,
  FIXTURE_VERSION,
  FROZEN_ORACLE_SHA256,
  sortRows,
} from "../../apps/api/test/canonical-inputs.ts";
import { GATE_BOUNDS, Project, must, record } from "./support.mjs";

const project = new Project("domain");
let started;

beforeAll(async () => {
  started = await project.start();
});

afterAll(async () => {
  await project.remove();
});

/** Every canonical table and the marker, read raw through the observer. */
async function inputs() {
  const result = {};
  for (const [name, query] of Object.entries(CANONICAL_QUERIES)) {
    result[name] = sortRows(await project.sql(query.sql));
  }
  result.marker = await project.sql(
    `SELECT fixture_version, manifest_sha256, oracle_sha256, completed_at::text
       FROM fixture_reference.seed_marker`,
  );
  return result;
}

describe("D12 packaged seed", () => {
  it("initializes the canonical inputs from the image without source mounts or provider keys", async () => {
    expect(started.init.stdout).toContain("migrate: schema tag 0010_model_spend_guards recorded");
    expect(started.init.stdout).toContain(
      `seed: canonical inputs ${FIXTURE_VERSION} initialized\n`,
    );

    const { stdout } = await project.mustCompose([
      "--profile",
      "init",
      "config",
      "--format",
      "json",
    ]);
    const { services } = JSON.parse(stdout);
    for (const name of ["init", "app"]) {
      expect(services[name].volumes ?? [], name).toEqual([]);
      const variables = Object.keys(services[name].environment ?? {});
      expect(
        variables.filter((key) => /ANTHROPIC|OPENAI|PROVIDER|MODEL|API_KEY/.test(key)),
      ).toEqual([]);
      expect(variables, name).not.toContain("DOMAIN_CLOCK_MODE");
    }
    expect(Object.keys(services.init.environment).sort()).toEqual([
      "APP_ID",
      "APP_ORIGIN",
      "BETTER_AUTH_SECRET_FILE",
      "DATABASE_URL_MIGRATOR_FILE",
      "FIXTURE_BUYER_PASSWORD_FILE",
      "FIXTURE_MANAGER_PASSWORD_FILE",
    ]);
  });

  it("matches the D11 input set through raw observer queries", async () => {
    const observed = await inputs();
    for (const [name, query] of Object.entries(CANONICAL_QUERIES)) {
      expect(observed[name], name).toEqual(sortRows(query.rows));
    }
    expect(observed.marker).toHaveLength(1);
    expect(observed.marker[0]).toMatchObject({
      fixture_version: FIXTURE_VERSION,
      manifest_sha256: CANONICAL_MANIFEST_SHA256,
      oracle_sha256: FROZEN_ORACLE_SHA256,
    });
    expect(sortRows(await project.sql(DERIVED_ELIGIBLE_QUERY))).toEqual(DERIVED_ELIGIBLE);
    record(
      `D12 manifest sha256 in the packaged seed marker: ${observed.marker[0].manifest_sha256}`,
    );
  });

  it("is healthy on the build's schema tag with the system business clock and no override", async () => {
    expect(await project.health()).toEqual({ status: "running", health: "healthy" });
    expect(await project.sql("SELECT tag FROM app.schema_tag")).toEqual([
      { tag: "0010_model_spend_guards" },
    ]);
    const image = JSON.parse(
      (await must("docker", ["image", "inspect", project.ct.image])).stdout,
    )[0];
    const container = await project.inspect();
    for (const env of [image.Config.Env, container.Config.Env]) {
      expect(env.filter((entry) => entry.startsWith("DOMAIN_CLOCK_MODE="))).toEqual([]);
    }
    const { stdout: environ } = await project.exec(
      'tr "\\0" "\\n" < /proc/$(s6-svstat -o pid /run/service/api)/environ',
    );
    expect(environ.split("\n").filter((entry) => entry.startsWith("DOMAIN_CLOCK_MODE="))).toEqual(
      [],
    );
    const boot = await project.bootId();
    const clockLines = (await project.boots())
      .find((segment) => segment.bootId === boot)
      .lines.map((line) => line.text)
      .filter((text) => text.includes('"msg":"business clock"'));
    expect(clockLines).toHaveLength(1);
    expect(JSON.parse(clockLines[0]).domainClockMode).toBe("system");
  });

  it("keeps the records and marker across repeat init and app recreation without volume deletion", async () => {
    const before = await inputs();

    const again = await project.mustCompose(["run", "--rm", "init"]);
    expect(again.stdout).toContain(
      `seed: canonical inputs ${FIXTURE_VERSION} already present; nothing changed\n`,
    );
    expect(await inputs()).toEqual(before);

    await project.mustCompose(["up", "--detach", "--no-build", "--force-recreate", "app"]);
    await project.waitReady(GATE_BOUNDS.recoveryMs);
    expect(await inputs()).toEqual(before);

    await project.mustCompose(["down", "--timeout", "60"]);
    await project.mustCompose(["up", "--detach", "--no-build", "app"]);
    await project.waitReady(GATE_BOUNDS.recoveryMs);
    expect(await inputs()).toEqual(before);
    const { stdout } = await must("docker", [
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project.name}`,
    ]);
    expect(stdout.trim().split("\n")).toEqual([`${project.name}_db-data`]);
  });
});
