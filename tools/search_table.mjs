// The frontier the search found, per fight — the readable half of search.ts.
//
// Two numbers matter per row. CAN IT BE CLEARED CLEAN is the balance question: a rung
// nothing brings everybody home from is over-tuned for the loss-less target whatever its
// win rate says. HOW CHEAPLY is the follow-up: a rung only the very best army clears is a
// different problem from one a mid roster manages.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/search";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.target.raidId - b.target.raidId || (a.target.tier ?? 0) - (b.target.tier ?? 0));

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the search first`);
  process.exit(1);
}

const short = (g) => g.map((k) => k.replace("ZombieActor", "")).join(" ");
/** Class counts, which is what a reader actually wants from a sixteen-name list. */
const shape = (g) => {
  const tally = {};
  for (const k of g) {
    const n = k.replace("ZombieActor", "");
    tally[n] = (tally[n] ?? 0) + 1;
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}x${k}`).join(" ");
};

const out = [];
out.push("WHAT THE SEARCH FOUND — best army per fight, expert play");
out.push("");
out.push("  An evolutionary search over the sixteen-slot army genome: composition, species AND");
out.push("  deploy order are the same array, so one set of operators moves all three. Fitness is");
out.push("  lexicographic — bring everybody home, then win, then lose fewer, then do it with a");
out.push("  cheaper army — so a row that reached 3/3 clean spent the rest of its budget getting");
out.push("  the Strength Ladder number DOWN.");
out.push("");
out.push("  CONVERGED says whether the best candidate stopped improving before the budget ran");
out.push("  out. A row still climbing is a LOWER BOUND: the real frontier is at least this good.");
out.push("");

out.push("fight".padEnd(34) + "clean  win  losses  ladder  secs  converged");
out.push("-".repeat(88));
for (const r of rows) {
  const f = r.best.fitness;
  const h = r.history;
  // Converged when the last third of the run improved nothing on the primary keys.
  const tail = h.slice(Math.floor(h.length * 0.66));
  const converged = tail.every((x) => x.clean === h[h.length - 1].clean && x.wins === h[h.length - 1].wins);
  out.push(
    r.label.padEnd(34) +
    `${f.clean}/3`.padStart(5) +
    `${f.wins}/3`.padStart(6) +
    f.meanLosses.toFixed(1).padStart(8) +
    Math.round(f.strength).toString().padStart(8) +
    (Number.isFinite(f.medianSecs) ? f.medianSecs.toFixed(0) : "–").padStart(6) +
    (converged ? "   yes" : "   STILL CLIMBING")
  );
}

out.push("");
out.push("");
out.push("THE CHEAPEST ARMY THAT BRINGS EVERYBODY HOME");
out.push("");
for (const r of rows) {
  out.push(r.label);
  if (!r.cheapestClean) {
    out.push(`  none found in ${r.evaluations} evaluations — best was ${r.best.fitness.clean}/3 clean, ${r.best.fitness.meanLosses.toFixed(1)} lost`);
  } else {
    out.push(`  ladder ${Math.round(r.cheapestClean.fitness.strength)}   ${shape(r.cheapestClean.genome)}`);
    out.push(`  order: ${short(r.cheapestClean.genome)}`);
  }
  out.push("");
}

const evals = rows.reduce((a, r) => a + r.evaluations, 0);
out.push(`${rows.length} fights, ${evals} distinct armies flown, ${evals * 3} flights.`);

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
