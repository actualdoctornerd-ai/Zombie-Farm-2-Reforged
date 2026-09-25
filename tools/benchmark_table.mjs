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
// THE PURPLE CEILING WAS RE-CUT ON 2026-09-24. It used to be 0-0.5 in the mid band,
// against a BITE floor of 1.5 at the same power — a demand that the same army, on the
// same fight, cost three times as much played casually as played perfectly. The measured
// casual:expert casualty ratio comes in under 3x on FOURTEEN OF THIRTY-TWO fights, so for
// nearly half the game no damage number exists that satisfies both halves: every change
// that lifts BITE into band lifts PURPLE out of it. Six of the pre-45 "too hard" verdicts
// were exactly that, two of them missing by 0.04 of a zombie.
//
// So PURPLE is now cut at roughly HALF the band's BITE floor — a 2x skill gradient, which
// the measured fights can actually deliver — and it is kept MONOTONIC across the bands.
// It was not going to be: lifting the mid ceiling to 1.5 while `late` stayed at 1.0 would
// have let a level-31 fight cost a well-played account MORE than a level-43 one, which is
// the ladder running backwards.
const BANDS = [
  { id: "tutorial", upto: 11, label: "0-11   tutorial",
    afk: [0, 0.2], blue: [0, 0.5], purple: [0, 0.2], bite: null,    winFloor: 0.98 },
  { id: "early",    upto: 25, label: "12-25  early",
    afk: [0, 0.5], blue: [0, 1.5], purple: [0, 0.5], bite: [0.5, 3], winFloor: 0.98 },
  { id: "mid",      upto: 39, label: "26-39  mid",
    afk: [0, 1],   blue: [0.5, 2], purple: [0, 1.5], bite: [1.5, 5], winFloor: 0.95 },
  { id: "late",     upto: 45, label: "40-45  late",
    afk: [0, 2],   blue: [1, 4],   purple: [0, 2],   bite: [3, 7],   winFloor: 0.9 },
  { id: "dual",     upto: 99, label: "46-49  dual invasions",
    afk: [1, 4],   blue: [2, 6],   purple: [0, 3],   bite: [5, 10],  winFloor: 0.8 },
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
out.push("  A cell shows the measured mean casualties, then its verdict against the band:");
out.push("  ok / HARD (costs too much) / EASY (costs too little) / STALL (in band on cost,");
out.push("  but running the four-minute clock out — a rules problem, not a difficulty one).");
out.push("");
out.push("fight".padEnd(34) + "lv   AFK         BLUE        PURPLE      BITE");
out.push("-".repeat(92));

const score = { ok: 0, hard: 0, easy: 0, stall: 0 };
const problems = [];

/** A cell fails its win floor for one of two completely different reasons, and until
 *  2026-09-24 this table scored them the same.
 *
 *  A DEFEAT is the army being killed. A STALL is the four-minute clock running out with
 *  the army alive and unable to advance — the Garden deadlock, or a line that never
 *  reaches the boss. Both settle as losses. Only one of them is difficulty.
 *
 *  The tell is that a stall is FREE: `7 Summer Break` at idle measured an 84% win rate
 *  with 0.00 mean casualties, and there is no way to lose a fight without losing a zombie
 *  except by never finishing it. So when the flights that failed are mostly flights that
 *  timed out, the verdict is STALL, reported on its own rather than folded into "too
 *  hard" — because the fix is a rules fix, and adding damage to a stalling fight only
 *  makes the flights that DO finish worse.
 *
 *  Half is the threshold rather than all: a cell can hold a couple of genuine wipes
 *  alongside a majority of stalls and still be a stalling fight. */
const stalling = (c) => {
  const failed = 1 - c.winRate;
  if (failed <= 0) return false;
  return (c.timeoutRate ?? 0) >= failed * 0.5;
};

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
    // COST IS JUDGED FIRST, and on its own. A fight that costs more than its band allows
    // is too hard whatever its win rate says; only a cell already INSIDE its cost band
    // lets the win floor decide anything, and there the stall test splits the two kinds
    // of failure apart.
    const overCost = c.meanLosses > target[1];
    const missedFloor = c.winRate < b.winFloor - 0.021;
    const verdict = overCost ? "HARD"
      : missedFloor ? (stalling(c) ? "STALL" : "HARD")
      : c.meanLosses < target[0] ? "EASY" : "ok";
    if (verdict === "ok") score.ok++;
    else {
      score[verdict === "HARD" ? "hard" : verdict === "EASY" ? "easy" : "stall"]++;
      problems.push({
        label: f.label, lv, probe: name, got: c.meanLosses, win: c.winRate,
        stalled: c.timeoutRate ?? 0, deadlocked: c.deadlockRate ?? 0, target, verdict,
      });
    }
    return `${c.meanLosses.toFixed(1)} ${verdict}`.padEnd(12);
  });

  out.push(f.label.padEnd(34) + String(lv).padEnd(4) + cells.join(""));
}

out.push("");
out.push(`SCORE   ${score.ok} on target, ${score.hard} too hard, ${score.easy} too easy, ` +
  `${score.stall} stalling`);

const HEADINGS = {
  EASY: "TOO EASY — costs less than the band asks:",
  HARD: "TOO HARD — costs more than the band allows (or is being killed under the win floor):",
  STALL: "STALLING — inside its cost band, but running the clock out. NOT a tuning number:",
};

for (const kind of ["EASY", "HARD", "STALL"]) {
  const list = problems.filter((p) => p.verdict === kind);
  if (!list.length) continue;
  out.push("");
  out.push(HEADINGS[kind]);
  out.push("");
  for (const p of list.sort((a, c) => a.lv - c.lv || a.probe.localeCompare(c.probe))) {
    const tail = kind === "STALL"
      ? `   ${Math.round(p.win * 100)}% win, ${Math.round(p.stalled * 100)}% timed out` +
        (p.deadlocked > 0 ? `, ${Math.round(p.deadlocked * 100)}% deadlocked` : "")
      : p.win < 1 ? `   (${Math.round(p.win * 100)}% win)` : "";
    out.push(`  lv ${String(p.lv).padStart(2)}  ${p.probe.padEnd(7)} ${p.label.padEnd(36)} ` +
      `${p.got.toFixed(1)} lost vs target ${p.target[0]}-${p.target[1]}${tail}`);
  }
}

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/benchmark.txt`, `${text}\n`);
