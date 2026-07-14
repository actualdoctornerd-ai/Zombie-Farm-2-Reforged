// Boots a real `wrangler dev` Worker + local D1 once for the integration suite,
// then tears it down. Reads DEV_AUTH=1 etc. from .dev.vars (so dev sign-in works).
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | undefined;

function killStrayWorkerd() {
  try {
    execSync("taskkill /F /IM workerd.exe", { stdio: "ignore" });
  } catch {
    /* none running */
  }
}

export async function setup() {
  killStrayWorkerd();
  // Fresh, empty D1 so every run starts from a known-clean database.
  try {
    rmSync(".wrangler/state", { recursive: true, force: true });
  } catch {
    /* first run / busy — schema is idempotent anyway */
  }
  execSync("npx wrangler d1 execute zombiefarm --local --file=./schema.sql", {
    stdio: "ignore",
  });

  child = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: "ignore",
    shell: true,
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
  throw new Error("wrangler dev did not become ready within 45s");
}

export async function teardown() {
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  killStrayWorkerd();
}
