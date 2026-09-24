// The proposed damage numbers, and the curve behind each one.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/lethality";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.unlock - b.unlock);
if (!rows.length) { console.error(`no shard JSON in ${DIR}`); process.exit(1); }

// Current elite profiles, so a multiplier can be shown as the number to actually write.
const src = readFileSync("src/raid/eliteInvasion.ts", "utf8");
const PROFILE = new Map();
for (const m of src.matchAll(/^\s*(\d+):\s*\{([^}]*)\}/gm)) {
  const f = {};
  for (const kv of m[2].matchAll(/(\w+):\s*([\d.]+)/g)) f[kv[1]] = Number(kv[2]);
  PROFILE.set(Number(m[1]), f);
}
const raidIdOf = (label) => Number(label.split(" ")[0]);

const out = [];
out.push("PROPOSED LETHALITY — what each too-easy fight would have to hit for");
out.push("");
out.push("  Damage only: enemy per-hit, boss throw, boss special. NOT hit points — the fight");
out.push("  clock is already slack (best builds finish in 40-85 s of 240), so bulk buys");
out.push("  duration rather than casualties and pushes toward the settle budget. NOT attack");
out.push("  cadence either: dex compounds with str, so moving both applies the change twice.");
out.push("");
out.push("  PICK is the CHEAPEST multiplier that lands the BITE probe (casual play, ordinary");
out.push("  account) inside its band while leaving that same account able to clear the fight");
out.push("  when played well. Smallest change that works, because each one edits a live fight.");
out.push("");

out.push("fight".padEnd(36) + "lv  target    now     PICK   ->  bite  blue  expert   apply to");
out.push("-".repeat(112));
for (const r of rows) {
  const at = (l) => r.curve.find((p) => p.lethality === l);
  const now = at(1);
  const pick = r.pick ? at(r.pick) : null;
  out.push(
    r.label.padEnd(36) + String(Math.floor(r.unlock)).padEnd(4) +
    `${r.target[0]}-${r.target[1]}`.padEnd(10) +
    now.biteLosses.toFixed(1).padStart(5) + "   " +
    (r.pick ? `x${r.pick.toFixed(2)}` : "none ").padStart(6) + "  ->" +
    (pick ? pick.biteLosses.toFixed(1).padStart(6) : "     –") +
    (pick ? pick.blueLosses.toFixed(1).padStart(6) : "     –") +
    (pick ? `${Math.round(pick.expertWin * 100)}%`.padStart(8) : "       –") +
    "   " + r.knob
  );
}

out.push("");
out.push("AS NUMBERS TO WRITE — elite profiles (src/raid/eliteInvasion.ts ELITE_PROFILES):");
out.push("");
for (const r of rows) {
  if (r.knob !== "elite profile" || !r.pick) continue;
  const id = raidIdOf(r.label);
  const p = PROFILE.get(id);
  if (!p) continue;
  const scale = (v) => (v * r.pick).toFixed(2).replace(/\.?0+$/, "");
  out.push(`  raid ${id}  ${r.label}`);
  out.push(`    str ${p.str} -> ${scale(p.str)}   throwDamage ${p.throwDamage} -> ${scale(p.throwDamage)}   specialDamage ${p.specialDamage} -> ${scale(p.specialDamage)}`);
}

const noProfile = rows.filter((r) => r.knob.startsWith("NO PROFILE"));
if (noProfile.length) {
  out.push("");
  out.push("NO KNOB EXISTS YET — these are non-elite story raids and `eliteProfile` returns null");
  out.push("for them, so their damage is purely the authored wave. The multiplier is the SIZE of");
  out.push("the change needed, not a number to paste:");
  out.push("");
  for (const r of noProfile) {
    out.push(`  ${r.label.padEnd(30)} ${r.pick ? `needs x${r.pick.toFixed(2)}` : "not reachable on the ladder"}`);
  }
}

out.push("");
out.push("THE CURVES — mean casualties at the BITE probe, by multiplier");
out.push("");
out.push("fight".padEnd(36) + rows[0].curve.map((p) => `x${p.lethality}`.padStart(7)).join(""));
out.push("-".repeat(36 + 7 * rows[0].curve.length));
for (const r of rows) {
  out.push(r.label.padEnd(36) + r.curve.map((p) => p.biteLosses.toFixed(1).padStart(7)).join(""));
}

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
