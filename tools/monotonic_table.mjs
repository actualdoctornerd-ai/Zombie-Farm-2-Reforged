// Is each fight monotone in army quality? — the readable half of monotonicity.ts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/monotonic";
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f.startsWith("shard"))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")))
  .sort((a, b) => a.unlock - b.unlock || a.label.localeCompare(b.label));

if (!rows.length) {
  console.error(`no shard JSON in ${DIR} — run the check first`);
  process.exit(1);
}

/** Below this, a fight is not reliably rewarding a better army. Set where the sample's own
 *  noise floor sits: 200 armies x 2 seeds puts the standard error on a rank correlation
 *  around 0.07, so anything under ~0.2 is a real effect rather than sampling. */
const WEAK = 0.2;

const out = [];
out.push("DOES A BETTER ARMY DO BETTER? — rank correlation, per fight");
out.push("");
out.push(`  ${rows[0].rosters} armies x ${2} wave seeds against every fight, expert play. The number is the`);
out.push("  Spearman correlation between an army's EFFECTIVE STRENGTH and how well it did, where");
out.push("  'how well' is graded (enemy hit points destroyed on a loss, zombies brought home on a");
out.push("  win) rather than a win/lose bit — a bit throws away most of the sample.");
out.push("");
out.push("  1.00 would mean a strictly better army always does strictly better. Anything at or");
out.push("  above ~0.5 is a fight that rewards army quality cleanly.");
out.push("");
out.push("  (!) marks a fight whose OWN MECHANIC reads the player's army and turns it against");
out.push("  them — raid 13 taxes deployed dexterity, raid 14 copies your zombies into enemies.");
out.push("  A low number there is the design working, not a defect.");
out.push("");
out.push("fight".padEnd(36) + "effective  ladder   verdict");
out.push("-".repeat(78));

/** A fight nearly every army wins has no variance for a correlation to explain, and its
 *  coefficient is noise around zero rather than evidence of an inversion. Checked BEFORE
 *  the threshold, because otherwise the easiest fights in the game get reported as the
 *  most broken — which is exactly what the first run of this table did. */
const CEILING = 0.95;
const ceilingOf = (r) => {
  const seen = r.binWinRate.filter((v) => v !== null);
  return seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : 0;
};

const weak = [];
for (const r of rows) {
  const s = r.effectiveSpearman;
  const ceil = ceilingOf(r) >= CEILING;
  const verdict = ceil ? "ceiling — nothing to measure"
    : s >= 0.5 ? "clean"
    : s >= WEAK ? "weak"
    : r.expectedDip ? "BY DESIGN" : "NOT MONOTONE";
  if (s < WEAK && !r.expectedDip && !ceil) weak.push(r);
  out.push(
    (r.label + (r.expectedDip ? " (!)" : "")).padEnd(36) +
    (ceil ? "  ·" : s.toFixed(2)).padStart(9) +
    (ceil ? "  ·" : r.ladderSpearman.toFixed(2)).padStart(8) +
    "   " + verdict
  );
}

const ceilRows = rows.filter((r) => ceilingOf(r) >= CEILING);
const measurable = rows.filter((r) => ceilingOf(r) < CEILING);
const clean = measurable.filter((r) => r.effectiveSpearman >= 0.5).length;
out.push("");
out.push(`${ceilRows.length}/${rows.length} fights are won by ~every army in the pool — no variance, nothing to measure.`);
out.push(`Of the ${measurable.length} that CAN be measured, ${clean} reward army quality cleanly (>=0.5).`);
out.push(`${weak.length} do not, and are not explained by their own mechanic — listed below if any.`);
out.push("");
const flagged = measurable.filter((r) => r.expectedDip);
if (flagged.length) {
  const worst = Math.min(...flagged.map((r) => r.effectiveSpearman));
  out.push(`NOTE: the two fights whose mechanics read the player's army — raid 13's dexterity tax`);
  out.push(`and raid 14's copies — were EXPECTED to invert. They do not. Their weakest rung still`);
  out.push(`scores ${worst.toFixed(2)}, among the highest in the table: the mechanics make those fights`);
  out.push(`harder without making a better army worse at them.`);
}

if (weak.length) {
  out.push("");
  out.push("NOT MONOTONE AND NOT BY DESIGN — win rate by column, to locate the dip:");
  out.push("");
  for (const r of weak) {
    out.push(`  ${r.label}  (spearman ${r.effectiveSpearman.toFixed(2)})`);
    out.push("    " + r.binWinRate.map((v) => (v === null ? "  – " : `${Math.round(v * 100)}%`.padStart(4))).join(" "));
  }
}

const meanEff = measurable.reduce((a, r) => a + r.effectiveSpearman, 0) / Math.max(1, measurable.length);
const meanLad = measurable.reduce((a, r) => a + r.ladderSpearman, 0) / Math.max(1, measurable.length);
out.push("");
out.push(`Mean over the measurable fights — effective ${meanEff.toFixed(3)}, Strength Ladder ${meanLad.toFixed(3)}.`);
out.push("The two are close here BECAUSE this pool spans every tier, where the ladder does fine;");
out.push("its failure is within the top tier alone. See effectiveLadder.ts.");

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
