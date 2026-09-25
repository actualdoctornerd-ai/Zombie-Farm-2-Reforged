// WHAT A TUNED ARMY LOOKS LIKE — the search's per-fight winners, read as one answer.
//
// tools/search_table.mjs reports the frontier fight by fight, which answers "can this rung
// be cleared and how cheaply". It cannot answer the question underneath it: given that the
// search found a good army thirty-four times over, IS THERE A SHAPE the good armies share?
// That is a question about the population of winners, not about any one of them.
//
// Everything here is measured off `best.genome` — sixteen species keys in deploy order —
// so composition, species choice and deploy ORDER all come out of the same array. Order is
// the half that usually goes unreported and it is the half that moved a two-casualty clear
// to a loss-less one in the build grid, so it gets its own section.
//
// READ THE CONSENSUS WITH THE SPREAD NEXT TO IT. A class that every winner fields four of
// is a finding; a class averaging four with a spread of zero-to-nine is noise wearing a
// mean. Both are printed and the second is why.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

// Which run to read. `node tools/army_structure.mjs fast` reads the speed-objective
// search; no argument reads the cheapness one. They are different questions and they
// produce different armies — see search.ts `better`.
const DIR = process.argv[2] === "fast" ? "tmp/search-fast" : "tmp/search";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.target.raidId - b.target.raidId || (a.target.tier ?? 0) - (b.target.tier ?? 0));
if (!rows.length) { console.error(`no shard JSON in ${DIR} — run the search first`); process.exit(1); }

const zombies = JSON.parse(readFileSync("public/assets/zombies.json", "utf8"));
const catalog = new Map((Array.isArray(zombies) ? zombies : Object.values(zombies)).map((z) => [z.key, z]));
const GROUPS = ["Headless", "Garden", "Regular", "Female", "Large", "Small"];
const groupOf = (key) => catalog.get(key)?.group ?? "Regular";
const nameOf = (key) => catalog.get(key)?.name ?? key.replace("ZombieActor", "");

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pad = (s, n) => String(s).padEnd(n);

// ---------------------------------------------------------------------------
// WHICH WINNERS COUNT
// ---------------------------------------------------------------------------
//
// A genome that did not actually solve its fight is not evidence about what works. The
// population is split three ways and each is printed on its own, because a build that
// brings everybody home on a fight it was always going to win says less than one that does
// it on a fight the benchmark scores as brutal.
const CLEAN = rows.filter((r) => r.best.fitness.clean === 3);
const WON = rows.filter((r) => r.best.fitness.clean < 3 && r.best.fitness.wins === 3);
const HARD = rows.filter((r) => r.target.raidId >= 12 || r.target.elite);

const out = [];
const OBJECTIVE = rows[0]?.objective ?? "cheap";
out.push(OBJECTIVE === "fast"
  ? "WHAT A TUNED ARMY LOOKS LIKE — the FASTEST loss-less build per fight"
  : "THE LEAST ARMY THAT SUFFICES — the CHEAPEST loss-less build per fight");
out.push(OBJECTIVE === "fast"
  ? "  Tie-broken on time to clear: of the armies that bring everybody home, the soonest."
  : "  Tie-broken on effective strength: the smallest army that still brings everybody home.");
out.push("");
out.push(`  ${rows.length} fights searched under EXPERT play. ${CLEAN.length} found a build that cleared all`);
out.push(`  three seeds with no casualties; ${WON.length} more won every seed while losing somebody.`);
out.push("");
out.push("  Sixteen slots, because that is the base army cap the whole harness is pinned to.");
out.push("  A finished account fields twenty, so read every count below as a SHARE of the army");
out.push("  rather than as an absolute — the shape is the finding, not the arithmetic.");
out.push("");

// ---------------------------------------------------------------------------
// 1. COMPOSITION
// ---------------------------------------------------------------------------
const compo = (set) => {
  const per = {};
  for (const g of GROUPS) per[g] = set.map((r) => r.best.genome.filter((k) => groupOf(k) === g).length);
  return per;
};

const section = (title, set) => {
  if (!set.length) return;
  const per = compo(set);
  out.push(title);
  out.push("");
  out.push("  " + pad("class", 10) + pad("mean", 7) + pad("median", 8) + pad("range", 9) + pad("always?", 9) + "share");
  for (const g of GROUPS) {
    const xs = per[g];
    const lo = Math.min(...xs), hi = Math.max(...xs);
    const always = xs.every((n) => n > 0) ? "yes" : `${Math.round(xs.filter((n) => n > 0).length / xs.length * 100)}%`;
    const bar = "#".repeat(Math.round(mean(xs) * 2));
    out.push("  " + pad(g, 10) + pad(mean(xs).toFixed(1), 7) + pad(median(xs).toFixed(0), 8) +
      pad(`${lo}-${hi}`, 9) + pad(always, 9) + bar);
  }
  out.push("");
};

section("THE COMPOSITION OF EVERY LOSS-LESS WINNER", CLEAN);
section("THE COMPOSITION ON THE HARD FIGHTS ONLY (elites and dual invasions)", HARD);

// ---------------------------------------------------------------------------
// 2. DEPLOY ORDER
// ---------------------------------------------------------------------------
//
// Position is reported as the mean NORMALISED slot (0 = first out of the gate, 1 = last)
// so classes with different counts are comparable. The army takes about seventy seconds to
// deploy in full and the best clears finish in forty to eighty-five, so a class sitting at
// 0.8 is a class that in a fast fight does not arrive at all.
out.push("WHERE EACH CLASS STANDS IN THE QUEUE — 0.00 is first out, 1.00 is last");
out.push("");
out.push("  " + pad("class", 10) + pad("mean slot", 11) + pad("first third", 13) + "position of its members");
for (const g of GROUPS) {
  const slots = [];
  let early = 0, total = 0;
  for (const r of CLEAN) {
    r.best.genome.forEach((k, i) => {
      if (groupOf(k) !== g) return;
      const p = i / (r.best.genome.length - 1);
      slots.push(p);
      total++;
      if (p < 1 / 3) early++;
    });
  }
  if (!total) continue;
  // A sixteen-cell strip of where this class's bodies actually sit, pooled over winners.
  const hist = Array(16).fill(0);
  for (const r of CLEAN) r.best.genome.forEach((k, i) => { if (groupOf(k) === g) hist[i]++; });
  const peak = Math.max(...hist, 1);
  const strip = hist.map((n) => " .:-=+*#@"[Math.min(8, Math.round(n / peak * 8))]).join("");
  out.push("  " + pad(g, 10) + pad(mean(slots).toFixed(2), 11) +
    pad(`${Math.round(early / total * 100)}%`, 13) + strip);
}
out.push("");

// ---------------------------------------------------------------------------
// 3. SPECIES
// ---------------------------------------------------------------------------
out.push("THE SPECIES THE SEARCH KEEPS REACHING FOR — slots filled across all winners");
out.push("");
const tally = new Map();
for (const r of CLEAN) for (const k of r.best.genome) tally.set(k, (tally.get(k) ?? 0) + 1);
const slotsTotal = CLEAN.length * 16;
const ranked = [...tally].sort((a, b) => b[1] - a[1]);
out.push("  " + pad("species", 30) + pad("class", 10) + pad("slots", 8) + "share of army");
for (const [key, n] of ranked.slice(0, 18)) {
  out.push("  " + pad(nameOf(key), 30) + pad(groupOf(key), 10) + pad(n, 8) +
    `${(n / slotsTotal * 100).toFixed(1)}%  ` + "#".repeat(Math.round(n / slotsTotal * 120)));
}
out.push("");
out.push(`  ${ranked.length} distinct species used out of the alphabet the search was given.`);
out.push("");

// ---------------------------------------------------------------------------
// 4. THE CONSENSUS BUILD
// ---------------------------------------------------------------------------
//
// Not an average of the winners — an average army is not an army. This takes the median
// count per class, hands any rounding slack to the class the winners field most, and fills
// each class's slots with ITS most-used species, laid out in the winners' own mean order.
out.push("THE CONSENSUS BUILD — median class counts, each class's favourite species,");
out.push("laid out in the order the winners put them. A starting point, not a prescription.");
out.push("");
const per = compo(CLEAN);
const counts = {};
for (const g of GROUPS) counts[g] = Math.round(median(per[g]));
let slack = 16 - GROUPS.reduce((a, g) => a + counts[g], 0);
const byMean = [...GROUPS].sort((a, b) => mean(per[b]) - mean(per[a]));
for (let i = 0; slack !== 0; i = (i + 1) % byMean.length) {
  const g = byMean[i];
  if (slack > 0) { counts[g]++; slack--; } else if (counts[g] > 0) { counts[g]--; slack++; }
}
const favourite = (g) => {
  const best = ranked.filter(([k]) => groupOf(k) === g)[0];
  return best ? best[0] : null;
};
const meanSlot = (g) => {
  const xs = [];
  for (const r of CLEAN) r.best.genome.forEach((k, i) => { if (groupOf(k) === g) xs.push(i); });
  return mean(xs);
};
const build = [];
for (const g of GROUPS) {
  const key = favourite(g);
  for (let i = 0; i < counts[g]; i++) build.push({ g, key, at: meanSlot(g) + i * 0.01 });
}
build.sort((a, b) => a.at - b.at);
build.forEach((b, i) => {
  out.push(`  ${String(i + 1).padStart(2)}. ${pad(b.g, 10)} ${b.key ? nameOf(b.key) : "(none available)"}`);
});
out.push("");

// ---------------------------------------------------------------------------
// 5. THE THINGS WORTH ARGUING WITH
// ---------------------------------------------------------------------------
// WHO COUNTS AS A HEALER is not "who is a Garden" — that stopped being true at ruleset
// 62, when the job left the class: the Forest Zombie took `heal` on a Female body and Old
// McZombie took Heal All on a Regular one. The abilities themselves are computed from the
// trait ladder rather than stored in zombies.json, so they are not readable from here;
// these two are named instead, and floor.test.ts asserts that NOTHING else outside the
// Garden heals, so this list going stale is a test failure rather than a silent wrong
// number.
const GRANTED_HEALERS = ["ZombieActorForest", "ZombieActorOldMcZombie"];
const healerKeys = new Set([...tally.keys()]
  .filter((k) => groupOf(k) === "Garden" || GRANTED_HEALERS.includes(k)));
const healers = CLEAN.map((r) => r.best.genome.filter((k) => healerKeys.has(k)).length);
const line = CLEAN.map((r) => r.best.genome.filter((k) => groupOf(k) === "Headless").length);
out.push("AGAINST THE FLOOR");
out.push("");
out.push(`  The party floor requires 2 HEALERS (not two Gardens) and 1 Headless. The search is`);
out.push(`  held to the same floor, so what matters is whether it goes past it when free to —`);
out.push(`  and WHICH BODY it puts the job on, now that two species outside the Garden carry it.`);
out.push(`    healers:  mean ${mean(healers).toFixed(1)}, ` +
  `${Math.round(healers.filter((n) => n > 2).length / healers.length * 100)}% of winners field more than the floor`);
out.push(`    Headless: mean ${mean(line).toFixed(1)}, ` +
  `${Math.round(line.filter((n) => n > 1).length / line.length * 100)}% field more than the floor`);
out.push("");
const gardenHeal = CLEAN.map((r) => r.best.genome.filter((k) => groupOf(k) === "Garden").length);
const offGarden = CLEAN.map((r) => r.best.genome.filter((k) => GRANTED_HEALERS.includes(k)).length);
out.push(`  Of the healers the winners field, the split by body:`);
out.push(`    in the Garden:      mean ${mean(gardenHeal).toFixed(1)} per army` +
  `   (${Math.round(gardenHeal.filter((n) => n > 0).length / gardenHeal.length * 100)}% of winners field any)`);
out.push(`    on a fighting body: mean ${mean(offGarden).toFixed(1)} per army` +
  `   (${Math.round(offGarden.filter((n) => n > 0).length / offGarden.length * 100)}% of winners field any)`);
out.push("");
// ---------------------------------------------------------------------------
// WHO ACTUALLY ARRIVES
// ---------------------------------------------------------------------------
//
// One zombie charges at a time and CHARGE_MS is 3,600, so sixteen bodies need about
// fifty-eight seconds of queue. The winners here clear in half that. Most of the army
// below is therefore a list of zombies that were still standing in the staging group when
// the fight ended — which makes the composition section above a statement about a roster
// and NOT about a fight. This one is about the fight.
const CHARGE_S = 3.6;
out.push("THE HALF THAT ACTUALLY FIGHTS");
out.push("");
out.push("  One zombie charges at a time, 3.6s each, so a 16-body army needs ~58s to deploy in");
out.push("  full. These clears do not last that long. Counting only the slots that get out of");
out.push("  the gate before the median clear:");
out.push("");
const arrived = {};
for (const g of GROUPS) arrived[g] = [];
let deployedTotal = 0;
for (const r of CLEAN) {
  const n = Math.max(1, Math.min(16, Math.floor(r.best.fitness.medianSecs / CHARGE_S)));
  deployedTotal += n;
  const head = r.best.genome.slice(0, n);
  for (const g of GROUPS) arrived[g].push(head.filter((k) => groupOf(k) === g).length);
}
out.push(`  Median army that reaches the field: ${Math.round(deployedTotal / CLEAN.length)} of 16.`);
out.push("");
out.push("  " + pad("class", 10) + pad("on the field", 14) + pad("in the roster", 15) + "never arrives");
const rosterPer = compo(CLEAN);
for (const g of GROUPS) {
  const on = mean(arrived[g]);
  const all = mean(rosterPer[g]);
  out.push("  " + pad(g, 10) + pad(on.toFixed(1), 14) + pad(all.toFixed(1), 15) +
    (all > 0.05 ? `${Math.round((1 - on / all) * 100)}%` : "-"));
}
out.push("");

out.push("COST OF A WINNER");
out.push("");
const ladders = CLEAN.map((r) => r.best.fitness.effective);
const secs = CLEAN.map((r) => r.best.fitness.medianSecs).filter((s) => Number.isFinite(s));
out.push(`  Effective strength of the loss-less winners: ${Math.round(Math.min(...ladders))}` +
  ` to ${Math.round(Math.max(...ladders))}, median ${Math.round(median(ladders))}.`);
out.push(`  Median clear: ${median(secs).toFixed(0)}s against a 240s clock.`);
out.push("");

// Per-fight, so a reader can see which fights the consensus is drawn from and which
// refused to produce a clean winner at all.
out.push("PER FIGHT");
out.push("");
out.push("  " + pad("fight", 34) + pad("clean", 7) + pad("effect", 8) + pad("secs", 6) + "composition");
for (const r of rows) {
  const g = r.best.genome;
  const shape = GROUPS.map((x) => [x, g.filter((k) => groupOf(k) === x).length])
    .filter(([, n]) => n).map(([x, n]) => `${n}${x.slice(0, 2)}`).join(" ");
  out.push("  " + pad(r.label, 34) + pad(`${r.best.fitness.clean}/3`, 7) +
    pad(Math.round(r.best.fitness.effective), 8) +
    pad(Number.isFinite(r.best.fitness.medianSecs) ? r.best.fitness.medianSecs.toFixed(0) : "-", 6) + shape);
}

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/structure.txt`, `${text}\n`);
