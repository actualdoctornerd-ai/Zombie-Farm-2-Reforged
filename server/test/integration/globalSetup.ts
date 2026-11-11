// Boots a real `wrangler dev` Worker + local D1 once for the integration suite,
// then tears it down. Test-only bindings are passed explicitly so CI does not
// depend on a developer's ignored .dev.vars file.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_STATE = ".wrangler/test-state";
const TEST_ENV_FILE = "./test/integration/wrangler.test.env";
let child: ChildProcess | undefined;

function runWrangler(args: string[]) {
  // Invoke the installed CLI with the current Node runtime. Keep successful
  // setup quiet, but surface Wrangler's output when bootstrap fails in CI.
  try {
    execFileSync(process.execPath, ["./node_modules/wrangler/bin/wrangler.js", ...args], { stdio: "pipe" });
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown };
    const output = [failure.stdout, failure.stderr].filter(Boolean).map(String).join("\n");
    if (output) console.error(output);
    throw error;
  }
}

function stopWorker() {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      // child.kill() only stops the intermediate npx/cmd process on Windows. Kill
      // its process tree so Wrangler and workerd cannot leak into later test runs.
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    /* already stopped */
  }
  child = undefined;
}

export async function setup() {
  // Pointed at a deployed Worker (IT_BASE=https://..., e.g. staging with IT_DEV_KEY): run the
  // specs against it and boot nothing. This used to boot the local Worker regardless and
  // overwrite IT_BASE with its address, so a "staging" run quietly tested local code.
  if (process.env.IT_BASE && !process.env.IT_BASE.startsWith("http://127.0.0.1")) return;
  // Fresh, isolated D1 so tests neither reuse nor delete a developer's local state.
  try {
    rmSync(TEST_STATE, { recursive: true, force: true });
  } catch {
    throw new Error(`could not clear isolated integration state: ${TEST_STATE}`);
  }
  // "zombiefarm-staging" is the DEFAULT (top-level) database in wrangler.toml — the
  // same one the bare `wrangler dev` below binds. --persist-to isolates the state,
  // so nothing here touches the real staging (or prod) database.
  runWrangler(["d1", "execute", "zombiefarm-staging", "--local", `--persist-to=${TEST_STATE}`, "--file=./schema.sql"]);
  runWrangler(["d1", "execute", "zombiefarm-staging", "--local", `--persist-to=${TEST_STATE}`, "--file=./scripts/baseline-migrations.sql"]);

  child = spawn(process.execPath, [
    "./node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--port",
    String(PORT),
    "--local",
    `--persist-to=${TEST_STATE}`,
    "--env-file",
    TEST_ENV_FILE,
  ], {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });

  // Poll until the Worker answers.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) {
        // Expose the base URL to the specs.
        process.env.IT_BASE = BASE;
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stopWorker();
  throw new Error("wrangler dev did not become ready within 45s");
}

export async function teardown() {
  stopWorker();
}
