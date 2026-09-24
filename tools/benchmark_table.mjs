// THE DIFFICULTY BENCHMARK — every fight against a target that SLOPES with its level.
//
// Owner, 2026-09-24, four pieces of direction folded in here:
//
//  1. "It should be sloped — McDonnell should be easy, but the later ones should slowly
//     increase the bar." So there is no single target: fights are banded by the level they
//     become reachable and each band has its own.
//  2. "The highest tier raids (40+) should not be as reachable at casual. This is
//     especially true for the level 45+ dual raids." So the casual-at-blue target stops
//     being "win cleanly" and becomes a COST that grows with the band.
//  3. "I agree with tuning on casualties. Players value their zombies more than winning
//     later on anyways." So every target below is a casualty band; win rate is kept only
//     as a floor, to catch a fight that has become unwinnable rather than merely costly.
//  4. Idle is measured at OUT-LEVELLED power, not at the fight's own level. A player
//     idling an elite has moved past it — and measured that way the harness reproduces the
//     live report exactly: an ordinary endgame account idles every elite for nothing except
//     the Pirates, which costs it 3.8 zombies to burst.
//
// EVERY TARGET IS A BAND [min, max] OF MEAN CASUALTIES. Over the max is too hard; under
// the min is too easy. The second half is the point — a difficulty target with only a
// ceiling is how content drifts easy over a long project, because every change that makes
// something more winnable passes and nothing ever pushes back.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/strength";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));
if (!rows.length) { console.error(`no shard JSON in ${DIR}`); process.exit(1); }

let MARKS = new Map();
try {
  MARKS = new Map(JSON.parse(readFileSync(`${DIR}/markers.json`, "utf8")).map((m) => [m.label, m]));
} catch { console.error("no markers.json — run the strength sweep first"); process.exit(1); }

// ---------------------------------------------------------------------------
// THE TARGET. This table is the whole design — everything else is plumbing.
// ---------------------------------------------------------------------------
//
// Columns are the four places a fight is probed, each one a (power, skill) pair:
//   afk     idle play, endgame power      — revisiting content you have out-levelled
//   blue    casual play, the blue mark    — a maxed account for the level, half-watching
//   purple  expert play, the purple mark  — an ordinary account, played perfectly
//   bite    casual play, the purple mark  — an ordinary account, half-watching
//
// Values are [minLosses, maxLosses]. `null` means the band is not policed there.
const BANDS = [
  { id: "tutorial", upto: 11, label: "0-11   tutorial",
    afk: [0, 0.2], blue: [0, 0.5], purple: [0, 0.2], bite: null,    winFloor: 0.98 },
  { id: "early",    upto: 25, label: "12-25  early",
    afk: [0, 0.5], blue: [0, 1.5], purple: [0, 0.5], bite: [0.5, 3], winFloor: 0.98 },
  { id: "mid",      upto: 39, label: "26-39  mid",
    afk: [0, 1],   blue: [0.5, 2], purple: [0, 0.5], bite: [1.5, 5], winFloor: 0.95 },
  { id: "late",     upto: 45, label: "40-45  late",
    afk: [0, 2],   blue: [1, 4],   purple: [0, 1],   bite: [3, 7],   winFloor: 0.9 },
  { id: "dual",     upto: 99, label: "46-49  dual invasions",
    afk: [1, 4],   blue: [2, 6],   purple: [0, 2],   bite: [5, 10],  winFloor: 0.8 },
];

const bandFor = (level) => BANDS.find((b) => level <= b.upto) ?? BANDS[BANDS.length - 1];

const cell = (label, pilot, bin) => {
  const r = rows.find((x) => x.label === label && x.pilot === pilot);
  const c = r?.cells?.[bin];
  return c && c.flights ? c : null;
};

/** The strongest band in the grid — "you have out-levelled this". */
const TOP_BIN = (rows[0]?.cells?.length ?? 8) - 1;

const fights = [...new Set(rows.map((r) => r.label))]
  .map((label) => ({ label, unlock: rows.find((r) => r.label === label).unlock }))
  .sort((a, b) => a.unlock - b.unlock);

const out = [];
out.push("THE DIFFICULTY BENCHMARK — sloped by level, scored on CASUALTIES");
out.push("");
out.push("  Four probes per fight. Each is a (power, skill) pair and each target is a BAND of");
out.push("  mean casualties: over it the fight is too hard, under it too easy.");
out.push("");
out.push("    AFK     idle play at endgame power   — content you have out-levelled");
out.push("    BLUE    casual play at the blue mark — maxed for the level, half-watching");
out.push("    PURPLE  expert play at the purple mark — ordinary account, played perfectly");
out.push("    BITE    casual play at the purple mark — ordinary account, half-watching");
out.push("");
out.push("  THE TARGET, by the level a fight becomes reachable:");
out.push("");
out.push("  band".padEnd(26) + "AFK".padEnd(12) + "BLUE".padEnd(12) + "PURPLE".padEnd(12) + "BITE");
const band = (v) => (v === null ? "—" : `${v[0]}-${v[1]}`).padEnd(12);
for (const b of BANDS) {
  out.push("  " + b.label.padEnd(24) + band(b.afk) + band(b.blue) + band(b.purple) + band(b.bite));
}
out.push("");
out.push("  A cell shows the measured mean casualties, then ok / HARD / EASY against the band.");
out.push("");
out.push("fight".padEnd(34) + "lv   AFK         BLUE        PURPLE      BITE");
out.push("-".repeat(92));

const score = { ok: 0, hard: 0, easy: 0 };
const problems = [];

for (const f of fights) {
  const m = MARKS.get(f.label);
  if (!m) continue;
  const lv = Math.floor(f.unlock);
  const b = bandFor(lv);

  const probes = [
    ["AFK", b.afk, cell(f.label, "idle", TOP_BIN)],
    ["BLUE", b.blue, cell(f.label, "casual", m.ceiling.bin)],
    ["PURPLE", b.purple, cell(f.label, "expert", m.moderate.bin)],
    ["BITE", b.bite, cell(f.label, "casual", m.moderate.bin)],
  ];

  const cells = probes.map(([name, target, c]) => {
    if (!c) return "–".padEnd(12);
    if (!target) return `${c.meanLosses.toFixed(1)} —`.padEnd(12);
    // A fight nobody can win any more is HARD whatever its casualty count says. The
    // tolerance is not slack: a cell is 50 flights, so it cannot resolve finer than 2pp,
    // and a literal floor would mark a perfect fight HARD for one unlucky seed.
    const unwinnable = c.winRate < b.winFloor - 0.021;
    const verdict = unwinnable || c.meanLosses > target[1] ? "HARD"
      : c.meanLosses < target[0] ? "EASY" : "ok";
    if (verdict === "ok") score.ok++;
    else {
      score[verdict === "HARD" ? "hard" : "easy"]++;
      problems.push({ label: f.label, lv, probe: name, got: c.meanLosses, win: c.winRate, target, verdict });
    }
    return `${c.meanLosses.toFixed(1)} ${verdict}`.padEnd(12);
  });

  out.push(f.label.padEnd(34) + String(lv).padEnd(4) + cells.join(""));
}

out.push("");
out.push(`SCORE   ${score.ok} on target, ${score.hard} too hard, ${score.easy} too easy`);

for (const kind of ["EASY", "HARD"]) {
  const list = problems.filter((p) => p.verdict === kind);
  if (!list.length) continue;
  out.push("");
  out.push(kind === "EASY"
    ? "TOO EASY — costs less than the band asks:"
    : "TOO HARD — costs more than the band allows (or drops under the win floor):");
  out.push("");
  for (const p of list.sort((a, c) => a.lv - c.lv || a.probe.localeCompare(c.probe))) {
    out.push(`  lv ${String(p.lv).padStart(2)}  ${p.probe.padEnd(7)} ${p.label.padEnd(36)} ` +
      `${p.got.toFixed(1)} lost vs target ${p.target[0]}-${p.target[1]}` +
      (p.win < 1 ? `   (${Math.round(p.win * 100)}% win)` : ""));
  }
}

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/benchmark.txt`, `${text}\n`);
