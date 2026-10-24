#!/usr/bin/env node
// The milestone demonstration on any day (ADR 0012).
//
//   corepack pnpm demo        fresh demonstration stack on http://127.0.0.1:3102
//   corepack pnpm demo:down   remove the demonstration's containers, network and volume
//
// Everything runs in the Compose project supplier-disruption-demo, with its
// own database volume and the image tag supplier-disruption-app:demo; the
// documented supplier-disruption stack is never touched. Each `demo` starts
// from fresh fixture data. No model is called: email extraction replays the
// recorded C-01 run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = "supplier-disruption-demo";
const IMAGE = "supplier-disruption-app:demo";
const ORIGIN = "http://127.0.0.1:3102";
const OVERRIDE = join(ROOT, "scripts", "demo", "compose.demo.yaml");

function env() {
  const vars = { ...process.env, SD_APP_IMAGE: IMAGE, SD_BUILD_REVISION: revision() };
  // The project and files are named on the command line, never inherited.
  delete vars.COMPOSE_PROJECT_NAME;
  delete vars.COMPOSE_FILE;
  delete vars.SD_APP_HOST_PORT;
  return vars;
}

function revision() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "local";
}

function step(text) {
  process.stdout.write(`\n==> ${text}\n`);
}

function compose(...args) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      PROJECT,
      "--project-directory",
      ROOT,
      "--file",
      join(ROOT, "compose.yaml"),
      "--file",
      OVERRIDE,
      ...args,
    ],
    { cwd: ROOT, env: env(), stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} exited ${String(result.status)}`);
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function up() {
  step("Secrets (kept when they exist; no value is printed)");
  const secrets = spawnSync("sh", [join(ROOT, "scripts", "init-secrets.sh")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (secrets.status !== 0) throw new Error("scripts/init-secrets.sh failed");

  step(`Removing any earlier demonstration data (${PROJECT} only)`);
  compose("down", "--volumes", "--remove-orphans");
  if (!(await portFree(3102))) {
    throw new Error(
      "127.0.0.1:3102 is in use. If the documented stack is running, stop it first with `docker compose stop app`.",
    );
  }

  step(`Building or reusing the image ${IMAGE}`);
  compose("build", "app");
  step("Initializing the database: migrations, grants and the synthetic C-01 fixture");
  compose("run", "--rm", "init");
  step("Starting the application in demonstration mode");
  compose("up", "--detach", "--wait", "app");

  const response = await fetch(`${ORIGIN}/api/demonstration`);
  const status = response.ok ? await response.json() : { active: false };
  if (status.active !== true) {
    throw new Error("the application started but does not report the demonstration mode");
  }
  const secret = (name) => relative(process.cwd(), join(ROOT, ".secrets", name));
  process.stdout.write(`
Supplier disruption demonstration: ${ORIGIN}

  Mode           demonstration (ADR 0012)
  Business clock ${status.businessClock}, simulated and fixed inside the C-01 fixture window
  Agent          recorded replay of the C-01 email run; no model call, no spend
  Data           synthetic fixtures, simulated actors and fixture source adapters

Sign in with a synthetic fixture identity (passwords stay in .secrets/):
  buyer@fixture.local     cat ${secret("fixture_buyer_password")}
  manager@fixture.local   cat ${secret("fixture_manager_password")}

Next steps: follow docs/demo/README.md. Part 1 runs the structured C-01
message to a verified plan through an uncertain write; for part 2 (the replayed
email and a stale approval) run \`corepack pnpm demo\` again for fresh data.
Stop and remove the demonstration with \`corepack pnpm demo:down\`.
`);
}

function down() {
  step(`Removing the demonstration (${PROJECT}: containers, network and database volume)`);
  compose("down", "--volumes", "--remove-orphans");
  process.stdout.write(
    `\nRemoved. The image ${IMAGE} is kept for the next run; remove it with \`docker image rm ${IMAGE}\`.\n`,
  );
}

const command = process.argv[2];
try {
  if (!existsSync(join(ROOT, "compose.yaml"))) throw new Error("run from the repository");
  if (command === "up") await up();
  else if (command === "down") down();
  else throw new Error("usage: node scripts/demo/demo.mjs up|down");
} catch (error) {
  process.stderr.write(`demo: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
