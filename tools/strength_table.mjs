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
  const mean = across.length
    ? Math.round(across.reduce((a, x) => a + x.meanStrength, 0) / across.length) : 0;
  return { i, mean, rosters: across[0]?.rosters ?? 0 };
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
out.push("  Columns are the Strength Ladder, √(Σ str·dex·con) over the army: one number covering");
out.push("  species, size, mutations and veterancy together. Every roster is built at level 50 so");
out.push("  the stat ramp is not a second hidden axis, and every fight is scaled to its OWN");
out.push("  recommended level — the raid is fixed, the party is the variable.");
out.push("");
out.push("  Every party fields AT LEAST TWO HEALERS AND ONE HEADLESS. Without that floor the top");
out.push("  band selected for armies with neither — the ladder weights dex as heavily as con, and");
out.push("  the healer and the tank are the two classes with the least of it — so win rate fell as");
out.push("  strength rose. Mutations are the best-in-slot mask per species, ~x1.47 on the ladder.");
out.push("");
out.push("  A cell is  win% / mean casualties.  '–' is a column with no roster in that band.");
out.push("");
out.push("  [ ] marks the strongest party the level allows when the fight OPENS; ( ) an ordinary");
out.push("  account at that level; < > both at once. Everything right of [ ] is out of reach then.");
out.push("  A bracket marks the BAND, not a point in it: a party near a band's lower edge does worse");
out.push("  than its column says. markers.json carries the exact scores.");
out.push("");
out.push(`  Column means: ${header.map((h) => `${h.mean}`).join("  ")}`);
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
