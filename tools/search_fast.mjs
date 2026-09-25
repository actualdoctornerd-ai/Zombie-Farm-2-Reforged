// The speed-objective run of the build search.
//
// Exists only because this project has no cross-env and a whole dependency for one
// environment variable is a bad trade. `SEARCH_OBJECTIVE=fast npm run test:search` works
// on a POSIX shell and does nothing on Windows cmd, which is where this is developed.
//
// The two objectives are two different questions and neither is the default answer — see
// search.ts `better`. This one asks what a player should BUILD; `npm run test:search`
// asks what a fight minimally COSTS.
import { spawnSync } from "node:child_process";

const env = { ...process.env, SEARCH_OBJECTIVE: "fast" };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("npx", ["vitest", "run", "--config", "vitest.search.config.ts"]);
run("node", ["tools/army_structure.mjs", "fast"]);
