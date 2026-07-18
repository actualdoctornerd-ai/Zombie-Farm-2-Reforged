// Boots a real `wrangler dev` Worker + local D1 once for the integration suite,
// then tears it down. Reads DEV_AUTH=1 etc. from .dev.vars (so dev sign-in works).
import { spawn, execFileSync, execSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | undefined;

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
  // Fresh, empty D1 so every run starts from a known-clean database.
  try {
    rmSync(".wrangler/state", { recursive: true, force: true });
  } catch {
    /* first run / busy — schema is idempotent anyway */
  }
  execSync("npx wrangler d1 execute zombiefarm --local --file=./schema.sql", {
    stdio: "ignore",
  });
  execSync("npx wrangler d1 execute zombiefarm --local --file=./scripts/baseline-migrations.sql", {
    stdio: "ignore",
  });

  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npx";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `npx wrangler dev --port ${PORT} --local --var BLACK_MARKET_ENABLED:1`]
    : ["wrangler", "dev", "--port", String(PORT), "--local", "--var", "BLACK_MARKET_ENABLED:1"];
  child = spawn(command, args, {
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
