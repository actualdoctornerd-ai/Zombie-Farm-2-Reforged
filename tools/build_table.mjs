// What the best party can do on the hardest fights — the readable half of bestBuilds.ts.
//
// Four sections, each answering a different form of the same question:
//   1. per fight, what a win costs the typical build and what the BEST build pays;
//   2. the loss-less roll of honour — every fight some build clears clean on every seed;
//   3. which axis is doing the work, marginalised one at a time;
//   4. the single best build per fight, named in full so it can be reproduced.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/builds";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.unlock - b.unlock || a.label.localeCompare(b.label));

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the sweep first`);
  process.exit(1);
}

const out = [];
const pct = (v) => `${Math.round(v * 100)}%`;
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

out.push("BEST BUILDS ON THE HARD FIGHTS — expert play, 16 zombies, level 50, Master, best mutations");
out.push("");
out.push("  Every build is flown on 3 wave seeds. 'clean' means a win that cost ZERO zombies;");
out.push("  a build CLEARS CLEAN only if all three seeds won and all three cost nothing.");
out.push("");
out.push("  'typical win costs' is the median over builds of the mean casualties on their WINNING");
out.push("  flights — what a win costs when you are not trying. It is not comparable to the");
out.push("  strength grid's figure, which averages sixteen-zombie wipes into the same number.");
out.push("");

// ---------------------------------------------------------------------------
// 1. Per fight: the spread, and whether the floor of it is zero.
// ---------------------------------------------------------------------------
const W = 34;
out.push("");
out.push("THE SPREAD — what a win costs, across all builds");
out.push("");
out.push("  'clean' counts a revived zombie as alive, which is the game's own rule. 'untouched'");
out.push("  is the stricter reading: won, cost nothing, and never spent a Resurrect. The gap");
out.push("  between the two columns is how much of the loss-less result is second chances.");
out.push("");
out.push("fight".padEnd(W) + "always  typical  best   clean   un-    typical");
out.push("".padEnd(W) + "  win   win cost win    builds  touched revives");
out.push("-".repeat(W + 50));

for (const r of rows) {
  const winners = r.builds.filter((b) => b.wins > 0);
  const typical = median(winners.map((b) => b.meanLossOnWin));
  const best = winners.length ? Math.min(...winners.map((b) => b.meanLossOnWin)) : NaN;
  const anyWin = r.builds.filter((b) => b.alwaysWins).length;
  const clean = r.builds.filter((b) => b.alwaysClean).length;
  const untouched = r.builds.filter((b) => b.alwaysUntouched).length;
  out.push(
    r.label.padEnd(W) +
    String(anyWin).padStart(6) +
    (winners.length ? typical.toFixed(1) : "–").padStart(9) +
    (winners.length ? best.toFixed(1) : "–").padStart(7) +
    String(clean).padStart(8) +
    String(untouched).padStart(8) +
    (winners.length ? median(winners.map((b) => b.meanRevivesOnWin)).toFixed(1) : "–").padStart(8)
  );
}

// ---------------------------------------------------------------------------
// 2. The loss-less roll of honour.
// ---------------------------------------------------------------------------
out.push("");
out.push("");
out.push("LOSS-LESS CLEARS — fights some build takes with ZERO casualties on every seed");
out.push("  'typical' is what a win costs the median build on the same fight, for contrast.");
out.push("");
out.push("fight".padEnd(W) + "clean builds  typical win cost  cheapest clean build");
out.push("-".repeat(W + 62));
for (const r of rows) {
  const clean = r.builds.filter((b) => b.alwaysClean);
  if (!clean.length) continue;
  const winners = r.builds.filter((b) => b.wins > 0);
  const typical = median(winners.map((b) => b.meanLossOnWin));
  const cheapest = clean.reduce((a, b) => (b.strength < a.strength ? b : a));
  out.push(
    r.label.padEnd(W) +
    `${clean.length}/${r.builds.length}`.padStart(12) +
    typical.toFixed(1).padStart(18) + "  " +
    `${cheapest.id} (ladder ${cheapest.strength}, ${cheapest.meanRevivesOnWin.toFixed(1)} revives)`
  );
}

// The stricter reading: cleared without spending a single second chance.
out.push("");
out.push("UNTOUCHED CLEARS — won, cost nothing, and never spent a Resurrect");
out.push("");
out.push("fight".padEnd(W) + "untouched     cheapest untouched build");
out.push("-".repeat(W + 62));
for (const r of rows) {
  const pure = r.builds.filter((b) => b.alwaysUntouched);
  if (!pure.length) { out.push(r.label.padEnd(W) + "        none     — every clean clear spends revives"); continue; }
  const cheapest = pure.reduce((a, b) => (b.strength < a.strength ? b : a));
  out.push(
    r.label.padEnd(W) +
    `${pure.length}/${r.builds.length}`.padStart(12) + "     " +
    `${cheapest.id} (ladder ${cheapest.strength})`
  );
}

const never = rows.filter((r) => !r.builds.some((b) => b.alwaysClean));
out.push("");
out.push("NOT LOSS-LESS BY ANY BUILD MEASURED:");
for (const r of never) {
  const winners = r.builds.filter((b) => b.wins > 0);
  const best = winners.length ? winners.reduce((a, b) => (b.meanLossOnWin < a.meanLossOnWin ? b : a)) : null;
  out.push(`  ${r.label.padEnd(W)} best win costs ${best ? `${best.meanLossOnWin.toFixed(1)} — ${best.id}` : "no build wins"}`);
}

// ---------------------------------------------------------------------------
// 3. Which axis is doing the work.
// ---------------------------------------------------------------------------
const all = rows.flatMap((r) => r.builds.map((b) => ({ ...b, fight: r.label })));

const marginal = (title, key, note) => {
  out.push("");
  out.push("");
  out.push(title);
  if (note) out.push(`  ${note}`);
  out.push("");
  out.push("value".padEnd(20) + "builds   always-win%  always-clean%  mean win cost  untouched%");
  out.push("-".repeat(90));
  const groups = new Map();
  for (const b of all) {
    const k = String(b[key]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    b[1].filter((x) => x.alwaysClean).length / b[1].length -
    a[1].filter((x) => x.alwaysClean).length / a[1].length);
  for (const [k, xs] of ordered) {
    const winners = xs.filter((x) => x.wins > 0);
    out.push(
      k.padEnd(20) +
      String(xs.length).padStart(6) +
      pct(xs.filter((x) => x.alwaysWins).length / xs.length).padStart(13) +
      pct(xs.filter((x) => x.alwaysClean).length / xs.length).padStart(15) +
      (winners.length
        ? (winners.reduce((a, x) => a + x.meanLossOnWin, 0) / winners.length).toFixed(2)
        : "–").padStart(15) +
      pct(xs.filter((x) => x.alwaysUntouched).length / xs.length).padStart(12)
    );
  }
};

marginal("SUPPORT SHAPE", "shape", "Headless / Garden counts out of sixteen, every fight pooled");
marginal("DEPLOY ORDER", "order", "the array IS the formation; one zombie charges every 3.6 s");
marginal("SPECIES PLAN", "plan", "power = strongest; reviveGarden = Resurrect carrier leads the Gardens; boomRevive adds Explode");
marginal("DUPLICATE CAP", "cap", "0 = a ceiling roster; 2 = what an account earning prizes one at a time can field");
marginal("FILLER", "filler", "what the non-support slots are");

// ---------------------------------------------------------------------------
// 4. The single best build per fight.
// ---------------------------------------------------------------------------
out.push("");
out.push("");
out.push("BEST BUILD PER FIGHT — fewest casualties per win, ties broken by win rate then by strength");
out.push("");
out.push("fight".padEnd(W) + "build".padEnd(46) + "win  cost  rev  secs");
out.push("-".repeat(W + 64));
for (const r of rows) {
  const winners = r.builds.filter((b) => b.wins > 0);
  if (!winners.length) { out.push(r.label.padEnd(W) + "no build wins"); continue; }
  // Fewest casualties, then fewest revives spent getting there — a build that wins clean
  // without touching its second chances is strictly better than one that needs them.
  const best = [...winners].sort((a, b) =>
    a.meanLossOnWin - b.meanLossOnWin || b.wins - a.wins ||
    a.meanRevivesOnWin - b.meanRevivesOnWin || a.strength - b.strength)[0];
  out.push(
    r.label.padEnd(W) + best.id.padEnd(46) +
    `${best.wins}/${best.flights}`.padStart(4) +
    best.meanLossOnWin.toFixed(1).padStart(6) +
    best.meanRevivesOnWin.toFixed(1).padStart(5) +
    (best.medianWinSecs === null ? "–" : best.medianWinSecs.toFixed(0)).padStart(6)
  );
}

const flights = all.reduce((a, b) => a + b.flights, 0);
out.push("");
out.push(`${rows.length} fights x ${rows[0].builds.length} builds x ${rows[0].builds[0].flights} seeds = ${flights} flights.`);

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
