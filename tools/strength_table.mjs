// One table per level of play: invasions down the side in the order a player meets them,
// party strength across the top, win rate and average casualties in the cell.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/strength";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the sweep first`);
  process.exit(1);
}

// Where a player stands when each fight opens (src/raid/harness/unlockArmy.ts). Optional,
// so a table generated before the marks existed still prints.
let MARKS = new Map();
try {
  MARKS = new Map(JSON.parse(readFileSync(`${DIR}/markers.json`, "utf8")).map((m) => [m.label, m]));
} catch { /* printed without marks */ }

const PILOTS = ["idle", "casual", "competent", "expert"];
const PILOT_NOTE = {
  idle: "no player input at all — every ability unspent, every focus bubble un-popped",
  casual: "one eye on the fight: brain bubbles, abilities as they light up, no hazards",
  competent: "every bubble, every hazard, the placard answered, Explode held back",
  expert: "the ceiling a human can plausibly reach, still bounded by reaction time",
};

/** Column headers come off the data, so they cannot drift from the bin edges. */
const anyRow = rows[0];
const header = anyRow.cells.map((c, i) => {
  const across = rows.flatMap((r) => r.cells[i]).filter((x) => x.rosters > 0);
  const avg = (pick) => across.length
    ? Math.round(across.reduce((a, x) => a + pick(x), 0) / across.length) : 0;
  return {
    i,
    mean: avg((x) => x.meanEffective ?? x.meanStrength),
    ladder: avg((x) => x.meanStrength),
    rosters: across[0]?.rosters ?? 0,
  };
});

const W = 13;
const out = [];
out.push("WIN RATE / AVERAGE CASUALTIES, by party strength");
out.push("");
out.push("  Rows are every fight in the game in the order a player MEETS it. An elite (★) row is");
out.push("  filed at its raid's unlock plus that raid's elite-prize delay — 10 early, 5 at the");
out.push("  Ninjas, 4 at the Robots, 3 from the Aliens on — because a Brain Ticket fight is not");
out.push("  content you meet the day the raid opens.");
out.push("");
out.push("  Columns are EFFECTIVE STRENGTH, fitted from play (src/raid/harness/effectiveLadder.ts):");
out.push("  1,500 random armies flown over a six-fight battery, the result regressed on which");
out.push("  zombies were in them. On held-out armies those weights order results at Spearman");
out.push("  +0.78, over all 80 obtainable species. The OLD axis, the Strength Ladder, scores +0.23");
out.push("  on the same armies — it does know a Silver beats a Green — but -0.30 among TOP-TIER");
out.push("  armies alone, where only composition is left and it rates a tank below a glass cannon.");
out.push("  That half is what every column of this table before 2026-09-23 was built on.");
out.push("");
out.push("  The 'ladder' line under the column means is what the old metric said about the SAME");
out.push("  rosters. It is printed to be looked at: if it does not climb with the columns, that");
out.push("  is the two metrics disagreeing, and the held-out test says which one to believe.");
out.push("");
out.push("  Every roster is built at level 50, fields sixteen zombies, and meets the party floor");
out.push("  of two healers and one headless.");
out.push("");
out.push("  INVASIONS DO NOT SCALE WITH PLAYER LEVEL. Each has ONE authored wave with fixed stats");
out.push("  — raid 5 is 94,000 enemy hit points whether you meet it at level 10 or 50. So a row is");
out.push("  a fixed obstacle and the ONLY variable is the army. That is also why a strong enough");
out.push("  early army clears late content here: nothing about the fight knows your level.");
out.push("");
out.push("  A cell is  win% / mean casualties.  '–' is a column with no roster in that band.");
out.push("");
out.push("  [ ] marks the strongest party the level allows when the fight OPENS; ( ) an ordinary");
out.push("  account at that level; < > both at once. Everything right of [ ] is out of reach then.");
out.push("  A bracket marks the BAND, not a point in it: a party near a band's lower edge does worse");
out.push("  than its column says. markers.json carries the exact scores.");
out.push("");
out.push(`  Column means, effective: ${header.map((h) => `${h.mean}`).join("  ")}`);
out.push(`                   ladder: ${header.map((h) => `${h.ladder}`).join("  ")}`);
out.push("");

const cell = (c) => {
  if (!c || !c.flights) return "–".padStart(6);
  const win = `${Math.round(c.winRate * 100)}%`.padStart(4);
  return `${win}/${c.meanLosses.toFixed(1).padStart(4)}`;
};

/** Bracket the column the player is actually standing in when the fight opens — [ ] the
 *  strongest party the level allows, ( ) an ordinary account's. The page draws these as
 *  blue and purple rings; in a terminal they are brackets. */
const marked = (text, mark, i) => {
  if (!mark) return ` ${text} `;
  if (mark.ceiling.bin === i && mark.moderate.bin === i) return `<${text}>`;
  if (mark.ceiling.bin === i) return `[${text}]`;
  if (mark.moderate.bin === i) return `(${text})`;
  return ` ${text} `;
};

for (const pilot of PILOTS) {
  const mine = rows.filter((r) => r.pilot === pilot).sort((a, b) => a.unlock - b.unlock);
  if (!mine.length) continue;
  out.push("");
  out.push("=".repeat(34 + 7 + W * header.length));
  out.push(`ACTIVITY LEVEL: ${pilot.toUpperCase()}  —  ${PILOT_NOTE[pilot] ?? ""}`);
  out.push("=".repeat(34 + 7 + W * header.length));
  out.push("");
  out.push(
    "fight".padEnd(34) + "unlk".padEnd(7) +
    header.map((h) => `~${h.mean}`.padEnd(W)).join("")
  );
  out.push("-".repeat(34 + 7 + W * header.length));
  for (const r of mine) {
    const mark = MARKS.get(r.label);
    out.push(
      r.label.padEnd(34) +
      String(Math.floor(r.unlock)).padEnd(7) +
      r.cells.map((c, i) => marked(cell(c), mark, i).padEnd(W)).join("")
    );
  }
}

const flights = rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.flights, 0), 0);
const perBin = header.map((h) => h.rosters).join("/");
out.push("");
out.push(`${rows.length / PILOTS.length} fights x ${PILOTS.length} activity levels x ${header.length} strength bands.`);
out.push(`Rosters per band: ${perBin}. ${flights} flights.`);

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
