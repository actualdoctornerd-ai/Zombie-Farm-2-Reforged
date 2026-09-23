// Merge the difficulty report's shards into one readable table.
//
// Run by `npm run test:difficulty` after the shards have written their JSON. Plain node,
// no build step — everything that needs the game's own modules already happened in the
// shards; this only formats.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/difficulty";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.recommendedLevel - b.recommendedLevel);

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the report first`);
  process.exit(1);
}

const pct = (v) => `${Math.round(v * 100)}%`.padStart(4);
/** One cell, as the three things that decide whether a rung is right:
 *  win rate / loss-less rate / median winning clear. A `T` flags timeouts, which are a
 *  different failure from losing — the fight ran out the four-minute clock. */
const cell = (c) => {
  const secs = c.medianWinSecs === null ? "  – " : `${String(Math.round(c.medianWinSecs)).padStart(3)}s`;
  // A deadlock outranks a plain timeout in the flag: it is a different failure.
  const to = c.deadlockRate > 0 ? "D" : c.timeoutRate > 0 ? "T" : " ";
  return `${pct(c.winRate)}/${pct(c.losslessRate)} ${secs}${to}`;
};

const HEAD = ["idle", "casual", "competent", "expert"];
const W = 17;
const out = [];
out.push("DIFFICULTY TABLE — win% / loss-less% / median winning clear");
out.push("  T = some flight hit the 4-min cap   D = some flight DEADLOCKED (living army that cannot advance)");
out.push("");
out.push("fight".padEnd(36) + "era".padEnd(9) + HEAD.map((h) => h.padEnd(W)).join(""));
out.push("-".repeat(36 + 9 + W * 4));
for (const r of rows) {
  out.push(r.label.padEnd(36) + r.era.padEnd(9) + r.cells.map((c) => cell(c).padEnd(W)).join(""));
}

out.push("");
out.push("LOSS-LESS AT EXPERT — the target: does a powerful army of the era clear it clean?");
out.push("");
out.push("fight".padEnd(36) + "lineups clean".padEnd(15) + "cheapest clean clear".padEnd(34) + "cheapest win");
out.push("-".repeat(36 + 15 + 34 + 30));
for (const r of rows) {
  const e = r.cells[r.cells.length - 1];
  const clean = e.cheapestLossless
    ? `${e.cheapestLossless.id} (${Math.round(e.cheapestLossless.strength)})`
    : "— none —";
  const win = e.cheapestWin ? `${e.cheapestWin.id} (${Math.round(e.cheapestWin.strength)})` : "— none —";
  out.push(r.label.padEnd(36) + `${e.breadth}/6`.padEnd(15) + clean.padEnd(34) + win);
}

out.push("");
out.push("INPUT DIVIDEND — what playing the fight is worth (expert minus idle)");
out.push("");
out.push("fight".padEnd(36) + "win%".padEnd(14) + "loss-less%".padEnd(16) + "clear time");
out.push("-".repeat(36 + 14 + 16 + 20));
for (const r of rows) {
  const [i, , , e] = r.cells;
  const dt = i.medianWinSecs !== null && e.medianWinSecs !== null
    ? `${(e.medianWinSecs - i.medianWinSecs).toFixed(0)}s` : "–";
  out.push(
    r.label.padEnd(36) +
    `${pct(i.winRate)} → ${pct(e.winRate)}`.padEnd(14) +
    `${pct(i.losslessRate)} → ${pct(e.losslessRate)}`.padEnd(16) + dt
  );
}

const flights = rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.flights, 0), 0);
const dropped = rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.budgetDropped, 0), 0);
out.push("");
out.push(`${rows.length} fights measured, ${flights} flights. ` +
  (dropped ? `WARNING: ${dropped} actions dropped on the transcript budget.` : "Transcript budget never bound."));

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
