// What each player input is worth, per fight — the readable half of mechanicPrice.ts.
//
// The headline column is THE PRICE OF THE MECHANIC: how many win-rate points a fight
// loses when the pilot stops answering the thing the fight is built around. A
// mechanics-first ladder wants that number large and climbing with the rung; a fight
// whose price is near zero is decided by its statline whatever its design says.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/mechanics";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.raidId - b.raidId || a.tier - b.tier);

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the sweep first`);
  process.exit(1);
}

const CHANNELS = ["objection", "cancels", "interrupt", "hazards", "rescues", "bubbles"];
const SHORT = {
  objection: "placard", cancels: "cancels", interrupt: "interrupt",
  hazards: "hazards", rescues: "rescues", bubbles: "bubbles",
};
const pct = (v) => `${Math.round(v * 100)}%`;
const full = (r) => r.results.find((x) => x.channel === "expert");
const off = (r, c) => r.results.find((x) => x.channel === `expert-${c}`);
const price = (r, c) => {
  const a = full(r), b = off(r, c);
  return a && b ? (a.winRate - b.winRate) * 100 : 0;
};

const out = [];
out.push("WHAT EACH INPUT IS WORTH, per fight — expert play minus ONE channel");
out.push("");
out.push("  Every column is the same pilot with one thing switched off, flown over the same");
out.push("  armies. The number is win-rate points LOST by not doing it. Contaminated deltas");
out.push("  are the reason this exists: the strength grid's casual->competent step turns on");
out.push("  three channels at once and tightens reaction time, so nothing in it is attributable.");
out.push("");
out.push("  * marks the channel this fight's OWN mechanic lives on — the price of ignoring");
out.push("  what the fight is about. Raid 14 has no such channel (a copy is made per");
out.push("  DEPLOYMENT, so its lever is the roster order, not a tap); its row is marked on the");
out.push("  trapeze instead and should be read as 'answered before the fight, not during it'.");
out.push("");
out.push("  SIGN: +N means doing it WINS N more points. -N means doing it LOSES you N — a");
out.push("  negative price is a real result, not a rounding error: it says the pilot's answer");
out.push("  to that mechanic is worse than ignoring it.");
out.push("");
out.push("  CEILING rows are marked 'ceil': the full pilot already wins ~everything, so there");
out.push("  is no headroom for any channel to show a loss and every 0 in the row is vacuous.");
out.push("  Only rows with real losses can measure anything.");
out.push("");

const W = 11;
/** A fight the full pilot already wins outright cannot show a channel's value: every
 *  delta is clamped against the top of the scale. Say so rather than printing zeros. */
const CEILING = 0.98;

out.push("fight".padEnd(34) + "win%".padEnd(7) + CHANNELS.map((c) => SHORT[c].padEnd(W)).join(""));
out.push("-".repeat(34 + 7 + W * CHANNELS.length));
for (const r of rows) {
  const a = full(r);
  const ceil = a.winRate >= CEILING;
  out.push(
    r.label.padEnd(34) +
    (ceil ? `${pct(a.winRate)} ceil` : pct(a.winRate)).padEnd(7) +
    CHANNELS.map((c) => {
      const p = price(r, c);
      const mark = r.own === c ? "*" : " ";
      const val = ceil ? "·" : `${p > 0 ? "+" : p < 0 ? "-" : " "}${Math.abs(p).toFixed(0)}`;
      return `${mark}${val.padStart(3)}`.padEnd(W);
    }).join("")
  );
}

out.push("");
out.push("");
out.push("THE HEADLINE — price of ignoring the fight's own mechanic");
out.push("");
out.push("fight".padEnd(34) + "full win%   blind win%   price   clean full/blind");
out.push("-".repeat(90));
for (const r of rows) {
  if (!r.own) { out.push(r.label.padEnd(34) + "  — no input answers this fight's mechanic"); continue; }
  const a = full(r), b = off(r, r.own);
  const p = (a.winRate - b.winRate) * 100;
  out.push(
    r.label.padEnd(34) +
    pct(a.winRate).padStart(9) +
    pct(b.winRate).padStart(13) +
    `${p > 0 ? "+" : p < 0 ? "-" : ""}${Math.abs(p).toFixed(0)}pp`.padStart(8) +
    `   ${pct(a.losslessRate)} / ${pct(b.losslessRate)}` +
    (a.winRate >= CEILING ? "   (ceiling — nothing to measure)" : p < -2 ? "   <- WORSE than ignoring it" : "")
  );
}

const flights = rows.reduce((a, r) => a + r.results.reduce((b, x) => b + x.flights, 0), 0);
out.push("");
out.push(`${rows.length} fights x ${CHANNELS.length + 1} pilots x ${rows[0].rosters} armies. ${flights} flights.`);

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
