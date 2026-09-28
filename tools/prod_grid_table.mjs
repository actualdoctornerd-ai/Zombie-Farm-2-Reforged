// The prod grid as a terminal table — the same JSON the page renders, for a diff or a
// paste. See src/raid/harness/prodGrid.ts for what a row and a column mean.
//
// Cell is `win% / mean lost`. A trailing flag marks the failures that are NOT "the army
// was too weak": T = some flight ran the four-minute clock out, D = some flight deadlocked
// (a living army that cannot advance, which is a rules bug rather than a tuning number).
import { readdirSync, readFileSync } from "node:fs";

const DIR = "tmp/prodgrid";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the sweep first`);
  process.exit(1);
}

const pilot = process.argv[2] ?? "expert";
const mine = rows
  .filter((r) => r.pilot === pilot)
  .sort((a, b) => b.rowLevel - a.rowLevel || a.raidId - b.raidId || Number(a.elite) - Number(b.elite));

if (!mine.length) {
  console.error(`no rows for pilot "${pilot}" — have ${[...new Set(rows.map((r) => r.pilot))].join(", ")}`);
  process.exit(1);
}

const COLS = mine[0].cells.map((c) => c.level);
const W = 14;
const cell = (c) => {
  const flag = c.deadlockRate > 0 ? "D" : c.timeoutRate > 0 ? "T" : " ";
  return `${`${Math.round(c.winRate * 100)}%`.padStart(4)}/${c.meanLosses.toFixed(1).padStart(4)}${flag}`;
};

const flights = rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.flights, 0), 0);
console.log(`PROD ARMY DIFFICULTY GRID — pilot: ${pilot}   (win% / mean zombies lost, nobody retreating)`);
console.log(`${flights.toLocaleString()} flights total · real parties from settled invasions · T = timeout, D = deadlock`);
console.log("");
console.log("lv  invasion".padEnd(38) + COLS.map((L) => `L${L}`.padStart(W)).join(""));
console.log("-".repeat(38 + W * COLS.length));
let prev = null;
for (const r of mine) {
  if (prev !== null && prev !== r.rowLevel) console.log("");
  prev = r.rowLevel;
  const name = `${String(r.rowLevel).padStart(2)}  ${r.label}`;
  console.log(name.padEnd(38) + r.cells.map((c) => cell(c).padStart(W)).join(""));
}

// The counterfactual in one line per row: where does this fight first stop being free?
console.log("");
console.log("FIRST COLUMN THAT COSTS ANYTHING — the level at which the threat becomes real");
console.log("");
console.log("lv  invasion".padEnd(38) + "first cell >0.5 lost".padEnd(24) + "worst cell".padEnd(22) + "at L45");
console.log("-".repeat(38 + 24 + 22 + 16));
for (const r of mine) {
  const first = r.cells.find((c) => c.meanLosses > 0.5);
  const worst = r.cells.reduce((a, c) => (c.meanLosses > a.meanLosses ? c : a), r.cells[0]);
  const last = r.cells[r.cells.length - 1];
  console.log(
    `${String(r.rowLevel).padStart(2)}  ${r.label}`.padEnd(38)
    + (first ? `L${first.level} (${first.meanLosses.toFixed(1)} lost)` : "— never —").padEnd(24)
    + `L${worst.level} (${worst.meanLosses.toFixed(1)} lost)`.padEnd(22)
    + `${Math.round(last.winRate * 100)}% / ${last.meanLosses.toFixed(1)} lost`
  );
}
