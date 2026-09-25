// A single-fight probe, for checking one change without re-flying the whole sweep.
// Edit FIGHTS, run `npx vitest run --config vitest.strength.config.ts
// src/raid/harness/report/strengthProbe.report.ts`, read tmp/strength/probe.txt.
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { buildFight } from "../../buildFight";
import { flyFight } from "../pilot";
import { CASUAL, EXPERT, IDLE, makePilot } from "../pilots";
import { harnessFight } from "../raidFight";
import { buildRoster } from "../roster";
import { strengthPool, sweepFights } from "../strengthSweep";
import { allMarks } from "../unlockArmy";

const FIGHTS = /^9 Zombies/;

describe("probe", () => {
  it("measures", () => {
    const lines: string[] = [];
    const pool = strengthPool();
    const fights = sweepFights().filter((f) => FIGHTS.test(f.label));
    const marks = new Map(allMarks(fights).map((m) => [m.label, m]));
    for (const fight of fights) {
      const m = marks.get(fight.label);
      if (!m) continue;
      const probes = [
        ["AFK   ", IDLE, 7],
        ["BLUE  ", CASUAL, m.ceiling.bin],
        ["PURPLE", EXPERT, m.moderate.bin],
        ["BITE  ", CASUAL, m.moderate.bin],
      ] as const;
      for (const [name, pilot, bin] of probes) {
        let n = 0, win = 0, loss = 0, to = 0, dl = 0;
        for (const roster of pool.filter((r) => r.bin === bin)) {
          for (let s = 0; s < 2; s++) {
            const built = buildRoster(roster.spec);
            const seed = `sweep:${fight.target.raidId}:${fight.target.tier ?? 0}:${s}`;
            const { spec } = harnessFight({
              raidId: fight.target.raidId,
              tier: fight.target.tier,
              elite: fight.target.elite,
              hazards: true,
              playerLevel: fight.fightLevel,
              playerUnits: built.units,
              waveSeed: seed,
            });
            const f = flyFight(buildFight(spec), makePilot(pilot), { seed });
            n++;
            if (f.win) win++;
            loss += f.losses;
            if (f.timedOut) to++;
            if (f.deadlocked) dl++;
          }
        }
        lines.push(
          `${fight.label.padEnd(30)} ${name}  ${(loss / n).toFixed(1)} lost  ` +
          `${Math.round(win / n * 100)}% win  ${Math.round(to / n * 100)}% timeout  ` +
          `${Math.round(dl / n * 100)}% deadlock`
        );
      }
    }
    writeFileSync("tmp/strength/probe.txt", `${lines.join("\n")}\n`);
  }, 1_800_000);
});
