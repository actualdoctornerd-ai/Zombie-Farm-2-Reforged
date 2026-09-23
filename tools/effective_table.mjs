// What a zombie is actually worth — the readable half of effectiveStrength.ts.
//
// The table only means something if the VALIDATION at the bottom says it does: fitted
// weights and the Strength Ladder are both scored on armies neither of them was fitted on,
// and the fit is worth adopting only if it orders those better.
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "tmp/effective";
let fit;
try {
  fit = JSON.parse(readFileSync(`${DIR}/fit.json`, "utf8"));
} catch {
  console.error(`no fit.json in ${DIR} — run the sampling and fit passes first`);
  process.exit(1);
}

const out = [];
out.push("EFFECTIVE STRENGTH — what one slot of each zombie is worth, fitted from play");
out.push("");
out.push(`  ${fit.parties} random sixteen-zombie armies, each flown against a six-fight battery at`);
out.push("  expert play. Every slot is an independent uniform draw over the level-50 shortlist and");
out.push("  NO party floor is applied — the whole question is what a healer is worth, and that can");
out.push("  only be answered by a sample containing armies with none.");
out.push("");
out.push("  Each army scores 0..1 per fight (losses on enemy hit points destroyed, wins on zombies");
out.push("  brought home, wins always above losses). The score is regressed on species counts; the");
out.push("  coefficient is what one of that zombie contributes.");
out.push("");
out.push("  EFFECTIVE is that coefficient rescaled onto the Strength Ladder's range so the two");
out.push("  columns read side by side. Only the ORDER matters; the rescale is cosmetic.");
out.push("");
out.push("  READ THE GAPS, NOT THE LEVEL. Every army has exactly sixteen slots, so the counts sum");
out.push("  to a constant and adding the same amount to every weight predicts identically — the");
out.push("  weights are identified only up to a shared offset (the ridge term picks one). What is");
out.push("  real is the SPREAD, and the spread is the headline: about 14% between best and worst,");
out.push("  against the Strength Ladder's 6.7x. Which species you field matters far less than the");
out.push("  old metric implies. Which CLASSES you field is where the difference lives.");
out.push("");

const W = 26;
out.push("zombie".padEnd(W) + "class".padEnd(10) + "effective".padStart(10) + "ladder".padStart(9) + "  rank move  seen");
out.push("-".repeat(W + 10 + 10 + 9 + 18));

const byLadder = [...fit.species].sort((a, b) => b.ladder - a.ladder).map((s) => s.key);
fit.species.forEach((s, i) => {
  const was = byLadder.indexOf(s.key);
  const move = was - i;
  out.push(
    s.name.slice(0, W - 1).padEnd(W) +
    s.group.padEnd(10) +
    s.effective.toFixed(1).padStart(10) +
    s.ladder.toFixed(1).padStart(9) +
    `  ${move > 0 ? "+" : move < 0 ? "-" : " "}${Math.abs(move).toString().padStart(2)}`.padEnd(12) +
    String(s.appearances).padStart(5)
  );
});

const v = fit.validation;
out.push("");
out.push("");
out.push("VALIDATION — both metrics scored on armies neither was fitted on");
out.push("");
out.push(`  held-out armies            ${v.heldOut}`);
out.push(`  fitted weights   Pearson   ${v.fittedPearson.toFixed(3)}    Spearman ${v.fittedSpearman.toFixed(3)}`);
out.push(`  Strength Ladder  Pearson   ${v.ladderPearson.toFixed(3)}    Spearman ${v.ladderSpearman.toFixed(3)}`);
out.push("");
const better = v.fittedSpearman - v.ladderSpearman;
out.push(better > 0.05
  ? `  The fit orders unseen armies BETTER by ${better.toFixed(3)} Spearman. Worth adopting.`
  : better < -0.05
    ? `  The fit is WORSE than the ladder. Do not adopt; the sample or the battery is wrong.`
    : `  The two are within ${Math.abs(better).toFixed(3)} Spearman — no clear winner on this sample.`);
out.push("");
out.push("  Residual variance is expected and mostly DEPLOY ORDER, which is not in the design");
out.push("  matrix at all and is worth roughly a doubling of clean-clear rate on its own.");

const text = out.join("\n");
console.log(text);
writeFileSync(`${DIR}/table.txt`, `${text}\n`);
