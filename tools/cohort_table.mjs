// Merge the cohort sweep's shards into a readable table.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/cohorts";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.order - b.order);

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the sweep first`);
  process.exit(1);
}

const COHORTS = ["powerful", "capped", "unmutated", "outdated", "veryOutdated"];
const SHORT = {
  powerful: "powerful", capped: "capped(2)", unmutated: "unmutated",
  outdated: "outdated", veryOutdated: "v.outdated",
};
const pct = (v) => `${Math.round(v * 100)}%`.padStart(4);
const get = (row, cohort, pilot) => row.cells.find((c) => c.cohort === cohort && c.pilot === pilot);

const out = [];
const W = 13;

const section = (title, note, pilot, render) => {
  out.push("");
  out.push(title);
  if (note) out.push(`  ${note}`);
  out.push("");
  out.push("fight".padEnd(30) + "era".padEnd(9) + COHORTS.map((c) => SHORT[c].padEnd(W)).join(""));
  out.push("-".repeat(30 + 9 + W * COHORTS.length));
  for (const r of rows) {
    out.push(r.label.padEnd(30) + r.era.padEnd(9) +
      COHORTS.map((c) => render(get(r, c, pilot)).padEnd(W)).join(""));
  }
};

section(
  "ARMIES THAT CLEAR IT — share of sampled armies winning on EVERY seed, played well (expert)",
  "D = some flight deadlocked (living army that cannot advance)",
  "expert",
  (c) => (c ? `${pct(c.armiesClearing)}${c.deadlockRate > 0 ? " D" : "  "}` : "–")
);

section(
  "ARMIES THAT CLEAR IT CLEAN — share winning with ZERO casualties on every seed (expert)",
  "the loss-less target, as a fraction of plausible armies rather than of one",
  "expert",
  (c) => (c ? pct(c.armiesClean) : "–")
);

section(
  "MEAN CASUALTIES PER FIGHT (expert)",
  "out of an army of 8–20, depending on era",
  "expert",
  (c) => (c ? c.meanLosses.toFixed(1).padStart(4) : "–")
);

section(
  "ARMIES THAT CLEAR IT — competent play, for comparison",
  "the gap to the expert table above is what skill is worth to that cohort",
  "competent",
  (c) => (c ? pct(c.armiesClearing) : "–")
);

// One row per (era, cohort): what the sample actually contained.
out.push("");
out.push("THE SAMPLES — distinct armies flown, and their Strength Ladder span");
out.push("");
out.push("era".padEnd(10) + "cohort".padEnd(14) + "armies".padEnd(9) + "strength min/median/max");
out.push("-".repeat(70));
const seen = new Set();
for (const r of rows) {
  for (const cohort of COHORTS) {
    const key = `${r.era}/${cohort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = get(r, cohort, "expert");
    if (!c) continue;
    out.push(r.era.padEnd(10) + SHORT[cohort].padEnd(14) + String(c.rosters).padEnd(9) +
      `${Math.round(c.strength.min)} / ${Math.round(c.strength.median)} / ${Math.round(c.strength.max)}`);
  }
}

const flights = rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.flights, 0), 0);
const armies = [...seen].length;
out.push("");
out.push(`${rows.length} fights x 4 cohorts x 2 pilots, ${armies} army pools, ${flights} flights.`);

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
