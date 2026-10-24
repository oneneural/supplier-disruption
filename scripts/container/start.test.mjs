// C2 source-independent start, the running half of C9 (secrets and
// privileges) and C10 persistence, in one disposable project.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATE_BOUNDS, Project, context, must, waitFor, record } from "./support.mjs";

const project = new Project("start");
let started;

beforeAll(async () => {
  started = await project.start();
});

afterAll(async () => {
  await project.remove();
});

const APP_SECRETS = [
  "better_auth_secret",
  "database_url_api",
  "database_url_worker",
  "worker_service_token",
];

describe("C2 source-independent start", () => {
  it("initializes from the image and serves the page and a static asset", async () => {
    expect(started.init.stdout).toContain("migrate: done");
    expect(started.init.stdout).toMatch(/seed: organization created=true/);

    const page = await fetch(`${project.origin}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const asset = /\/_next\/static\/[^"']+\.(?:js|css)/.exec(html)?.[0];
    expect(asset).toBeDefined();
    const response = await fetch(`${project.origin}${asset}`);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("logs the API start probe only when its result changes", async () => {
    const boot = await project.bootId();
    const lines = (await project.boots())
      .find((segment) => segment.bootId === boot)
      .lines.map((line) => line.text)
      .filter((text) => text.startsWith("api="));
    record(`C2 start probe lines in the container log: ${lines.length} (${lines.join(" | ")})`);
    expect(lines.at(-1)).toBe("api=ready");
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]).not.toBe(lines[i - 1]);
  });

  it("publishes only the web port and keeps the health endpoints internal", async () => {
    const info = await project.inspect();
    expect(Object.keys(info.NetworkSettings.Ports)).toEqual(["3000/tcp"]);
    expect(info.NetworkSettings.Ports["3000/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: String(project.port) },
    ]);
    for (const path of ["/internal/health/ready", "/internal/health/worker"]) {
      const response = await fetch(`${project.origin}${path}`);
      const body = await response.text();
      expect(response.status).not.toBe(200);
      expect(body).not.toContain('"ready"');
      expect(body).not.toContain('"fresh"');
    }
  });

  it("runs with only the declared secret mounts and a hardened configuration", async () => {
    const { sourceDir } = context();
    const info = await project.inspect();
    const mounts = info.Mounts.map((mount) => ({
      type: mount.Type,
      source: mount.Source,
      destination: mount.Destination,
    }));
    expect(mounts.map((mount) => mount.destination).sort()).toEqual(
      APP_SECRETS.map((name) => `/run/secrets/${name}`),
    );
    for (const mount of mounts) {
      expect(mount.type).toBe("bind");
      expect(mount.source.startsWith(join(sourceDir, ".secrets") + "/")).toBe(true);
    }
    expect(JSON.stringify(info.Mounts)).not.toContain("docker.sock");
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.Config.User).toBe("10001:10001");
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.CapAdd ?? []).toEqual([]);
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
    expect(Object.keys(info.HostConfig.Tmpfs).sort()).toEqual(["/run", "/tmp"]);
    expect(info.HostConfig.RestartPolicy.Name).toBe("unless-stopped");
  });

  it("runs every process as UID 10001 from the standalone build in production mode", async () => {
    const { stdout } = await must("docker", [
      "exec",
      project.app,
      "sh",
      "-c",
      'for d in /proc/[0-9]*; do u=$(awk \'/^Uid:/ {print $2}\' "$d/status" 2>/dev/null) && echo "$u $(tr "\\0" " " < "$d/cmdline")"; done',
    ]);
    const processes = stdout
      .trim()
      .split("\n")
      .filter((line) => line.split(" ")[1] !== "");
    expect(processes.length).toBeGreaterThan(5);
    for (const line of processes) expect(line.split(" ")[0]).toBe("10001");
    expect(processes.some((line) => line.includes("node /opt/api/dist/main.js"))).toBe(true);
    expect(processes.some((line) => line.includes("node /opt/worker/dist/main.js"))).toBe(true);
    // The web service is Node running the traced standalone server.js, which
    // retitles itself within its original argv length; not a Next dev or start command.
    const web = await project.exec(
      'p=$(s6-svstat -o pid /run/service/web); echo "$(readlink /proc/$p/exe) $(readlink /proc/$p/cwd) $(tr "\\0" " " < /proc/$p/cmdline)"',
    );
    expect(web.stdout.trim()).toMatch(/^\/usr\/local\/bin\/node \/opt\/web\/apps\/web next-server/);
    expect(processes.some((line) => /next (dev|start)/.test(line))).toBe(false);
    const { stdout: environ } = await project.exec(
      'tr "\\0" "\\n" < /proc/$(s6-svstat -o pid /run/service/web)/environ',
    );
    expect(environ.split("\n")).toContain("NODE_ENV=production");
  });

  it("can write only to /tmp and /run", async () => {
    const targets = [
      "/opt/api",
      "/opt/worker",
      "/opt/web/apps/web",
      "/opt/sd",
      "/",
      "/etc",
      "/usr",
      "/home/sd",
      "/tmp",
      "/run",
    ];
    const script = targets
      .map(
        (dir) =>
          `if touch ${dir}/.ct-write 2>/dev/null; then echo "${dir} writable"; rm -f ${dir}/.ct-write; else echo "${dir} denied"; fi`,
      )
      .join("; ");
    const { stdout } = await project.exec(script);
    const result = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" ")),
    );
    expect(result).toEqual({
      "/opt/api": "denied",
      "/opt/worker": "denied",
      "/opt/web/apps/web": "denied",
      "/opt/sd": "denied",
      "/": "denied",
      "/etc": "denied",
      "/usr": "denied",
      "/home/sd": "denied",
      "/tmp": "writable",
      "/run": "writable",
    });
  });
});

describe("C9 secrets in the running container", () => {
  it("mounts only the app's secrets and cannot read the migrator URL or fixture passwords", async () => {
    const { stdout } = await project.exec("stat -c '%n %U:%G %a' /run/secrets/*");
    const modes = stdout.trim().split("\n").sort();
    // Recorded for the run log: owner and mode as seen inside the container.
    record(`secret mounts:\n${modes.join("\n")}`);
    expect(modes.map((line) => line.split(" ")[0])).toEqual(
      APP_SECRETS.map((name) => `/run/secrets/${name}`),
    );
    for (const name of [
      "database_url_migrator",
      "fixture_buyer_password",
      "fixture_manager_password",
      "postgres_password",
    ]) {
      const result = await project.exec(`cat /run/secrets/${name}`);
      expect(result.code).not.toBe(0);
    }
    // The secrets the app mounts are readable by the container user.
    const readable = await project.exec(
      "cat /run/secrets/worker_service_token >/dev/null && echo ok",
    );
    expect(readable.stdout.trim()).toBe("ok");
  });

  it("keeps secret values out of logs, inspect output and the browser bundle", async () => {
    const { canaries, secretFiles } = context();
    const values = [...canaries.map((c) => c.value), ...secretFiles.map((f) => f.value)];
    const { stdout: logs, stderr: logErrors } = await must("docker", ["logs", project.app]);
    const { stdout: initLogs } = started.init;
    const inspect = JSON.stringify(await project.inspect());

    const html = await (await fetch(`${project.origin}/`)).text();
    const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)]+/g) ?? [])];
    expect(assets.length).toBeGreaterThan(0);
    let bundle = html;
    for (const asset of assets) bundle += await (await fetch(`${project.origin}${asset}`)).text();

    for (const value of values) {
      expect(logs).not.toContain(value);
      expect(logErrors).not.toContain(value);
      expect(initLogs).not.toContain(value);
      expect(inspect).not.toContain(value);
      expect(bundle).not.toContain(value);
    }
    // The environment names the files, never their contents.
    const env = (await project.inspect()).Config.Env;
    expect(env).toContain("DATABASE_URL_API_FILE=/run/secrets/database_url_api");
  });
});

describe("C10 persistence", () => {
  it("keeps users, operations and receipts across down and up without volumes", async () => {
    const submitted = await project.submitOperation({ note: "persistence" });
    expect(submitted.status).toBe(202);
    await waitFor(
      "the operation's receipt",
      async () => (await project.operation(submitted.operationId))?.receipt_id ?? undefined,
      { timeoutMs: 30_000 },
    );
    const snapshot = () =>
      project.sql(
        `SELECT (SELECT json_agg(email ORDER BY email) FROM auth."user") AS users,
                (SELECT json_agg(json_build_object('id', operation_id, 'receipt', receipt_id) ORDER BY operation_id)
                   FROM app.pilot_operation) AS operations`,
      );
    const before = await snapshot();
    expect(before[0].users).toEqual(["buyer@fixture.local", "manager@fixture.local"]);

    await project.mustCompose(["down", "--timeout", "60"]);
    await project.mustCompose(["up", "--detach", "--no-build", "app"]);
    await project.waitHealthy(GATE_BOUNDS.healthyMs);

    expect(await snapshot()).toEqual(before);
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
