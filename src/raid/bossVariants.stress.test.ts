import { describe, expect, it } from "vitest";
import raidsJson from "../../public/assets/raids/raids.json";
import { buildFight } from "./buildFight";
import { CHARGE_X, PHASE_INVULN_MS, type BattleSim } from "./BattleSim";
import { advanceRaidSegment, replayRaid, type RaidReplayInput } from "./replay";
import { harnessFight } from "./harness/raidFight";
import { buildExplicit } from "./harness/roster";
import { flyFight } from "./harness/pilot";
import { EXPERT, makePilot } from "./harness/pilots";
import type { RaidDef } from "./types";

// STRESS: the Boss Zombie colour variants' six abilities in full fights, on every raid.
//
// Three armies built to lean on the new code paths — a mixed endgame party, an all-variant
// party with no healer (Berserk bleeding, Phase with nobody to catch it), and a wall of Megas
// with Omegas behind it (Support stacking, shields soaking the front) — fly every story raid
// (base and Brain Ticket) and tiers 1/5/10 of every dual invasion. Each tick checks the
// invariants below; each flight is then REPLAYED from its transcript on a fresh fight (the
// Worker's path) and RESUMED from a JSON checkpoint taken mid-fight (the checkpoint path), and
// both must reproduce the flight exactly. Hazards are off: client-only taps never reach a
// transcript, so a hazard flight is not meant to replay.
//
// STRESS_SEEDS=4 npx vitest run src/raid/bossVariants.stress.test.ts for a heavier pass.

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEEDS = Number(ENV.STRESS_SEEDS ?? 1);
const raids = raidsJson as RaidDef[];

const OMEGA = "ZombieActorRegularOmegaBoss";
const MEGA = "ZombieActorRegularMegaBoss";
const SECRET = "ZombieActorRegularSecretBoss";
const ARMIES: Record<string, string[]> = {
  mixed: ["ZombieActorOmegaZombieBot", "ZombieActorOmegaDrZombie", "ZombieActorOmegaDrZombie",
    OMEGA, MEGA, SECRET, OMEGA, MEGA, SECRET, "ZombieActorPoseidon", "ZombieActorMasterNinjombie",
    "ZombieActorVagabond"],
  variantsOnly: [MEGA, OMEGA, SECRET, MEGA, OMEGA, SECRET, MEGA, OMEGA, SECRET, MEGA, OMEGA, SECRET],
  megaWall: [MEGA, MEGA, MEGA, "ZombieActorOmegaDrZombie", MEGA, MEGA, MEGA,
    OMEGA, OMEGA, OMEGA, OMEGA, "ZombieActorOmegaDrZombie", SECRET, SECRET],
};

interface Target { label: string; raidId: number; elite: boolean; tier: number; level: number }
const TARGETS: Target[] = raids.flatMap((r): Target[] => {
  const level = Math.max(20, Math.min(45, Math.floor(r.unlockLevel ?? 0) + 5));
  if (r.id >= 12 && r.id <= 15) {
    return [1, 5, 10].map((tier) => ({ label: `${r.id} t${tier}`, raidId: r.id, elite: false, tier, level: 45 }));
  }
  return [
    { label: `${r.id}`, raidId: r.id, elite: false, tier: 0, level },
    { label: `${r.id} elite`, raidId: r.id, elite: true, tier: 0, level: Math.max(level, 30) },
  ];
});

function build(t: Target, army: string, seed: string): BattleSim {
  const roster = buildExplicit(ARMIES[army], { mutation: "best", invasions: 5, playerLevel: t.level });
  const { spec } = harnessFight({
    raidId: t.raidId, tier: t.tier || undefined, elite: t.elite, hazards: false,
    playerLevel: t.level, playerUnits: roster.units, waveSeed: seed,
  });
  return buildFight(spec);
}

/** Every per-tick invariant the six abilities must keep. Returns the first violation. */
function watch(sim: BattleSim): { violation: () => string | null; stats: Record<string, number> } {
  let violation: string | null = null;
  const stats = { ticks: 0, phases: 0, teleports: 0, shieldPeak: 0, berserkDeaths: 0, revives: 0 };
  const seen = new Map<string, { alive: boolean; tp: number; ph: number; revives: number }>();
  const step = sim.step.bind(sim);
  (sim as { step: (dt: number) => boolean }).step = (dt: number) => {
    const r = step(dt);
    stats.ticks++;
    for (const u of sim.units) {
      if (u.team !== "player" || violation) continue;
      const fail = (m: string) => { violation = `tick ${stats.ticks} ${u.sourceKey} ${u.id}: ${m}`; };
      const prev = seen.get(u.id) ?? { alive: u.alive, tp: 0, ph: 0, revives: 0 };
      if (!Number.isFinite(u.hp) || !Number.isFinite(u.shield) || !Number.isFinite(u.x)) fail("non-finite state");
      if (u.hp < 0 || u.hp > u.maxHp + 1e-6) fail(`hp ${u.hp} outside [0, ${u.maxHp}]`);
      if (u.shield < 0 || u.shield > u.maxHp + 1e-6) fail(`shield ${u.shield} outside [0, maxHp]`);
      if (u.shield > 0 && !u.abilities.includes("shieldBar")) fail("shield without Shield Bar");
      if (u.phaseMs < 0 || u.phaseMs > PHASE_INVULN_MS) fail(`phaseMs ${u.phaseMs}`);
      if (u.phaseMs > 0 && !u.phaseUsed) fail("phase window without the latch");
      if (u.phaseFxSeq > 1) fail("Phase fired twice");
      if (u.phaseFxSeq > 0 && !u.abilities.includes("phase")) fail("Phase without the ability");
      if (u.alive && !(u.hp > 0)) fail("alive at 0 Life");
      if (!u.alive && u.hp !== 0) fail("dead with Life left");
      const revived = !prev.alive && u.alive ? 1 : 0;
      const revives = prev.revives + revived;
      if (u.teleportFxSeq > 1 + revives) fail(`teleported ${u.teleportFxSeq}x with ${revives} revives`);
      if (u.teleportFxSeq > prev.tp) {
        if (!u.abilities.includes("teleport")) fail("Teleport without the ability");
        if (u.x < CHARGE_X) fail(`teleported BACKWARDS to x ${u.x}`);
        stats.teleports++;
      }
      if (u.phaseFxSeq > prev.ph) stats.phases++;
      if (prev.alive && !u.alive && u.abilities.includes("berserk")) stats.berserkDeaths++;
      stats.revives += revived;
      stats.shieldPeak = Math.max(stats.shieldPeak, u.shield / u.maxHp);
      seen.set(u.id, { alive: u.alive, tp: u.teleportFxSeq, ph: u.phaseFxSeq, revives });
    }
    return r;
  };
  return { violation: () => violation, stats };
}

const outcomeKey = (o: { win: boolean; survivors: string[] } | undefined) =>
  o ? `${o.win}:${[...o.survivors].sort().join(",")}` : "none";

describe.each(Object.keys(ARMIES))("boss-variant stress: %s army", (army) => {
  it.each(TARGETS.map((t) => [t.label, t] as const))("raid %s holds every invariant and replays exactly", (_label, t) => {
    for (let s = 0; s < SEEDS; s++) {
      const seed = `stress:${army}:${t.label}:${s}`;
      const sim = build(t, army, seed);
      const w = watch(sim);
      const f = flyFight(sim, makePilot(EXPERT), { seed });
      expect(w.violation(), seed).toBeNull();
      expect(f.untranscribed, seed).toBe(0);
      // The flight's own result. A retreat is never issued by the pilot.
      const flown = outcomeKey(f.outcome as never);

      // 1. The Worker's path: the transcript on a fresh fight.
      const replay = replayRaid(build(t, army, seed), f.ticks, f.inputs);
      expect(replay.ok, `${seed} ${JSON.stringify(replay)}`).toBe(true);
      if (replay.ok) expect(outcomeKey(replay.outcome), seed).toBe(flown);

      // 2. The checkpoint path: stop a third of the way in, serialise, resume.
      const k = Math.max(1, Math.floor(f.ticks / 3));
      const before: RaidReplayInput[] = f.inputs.filter((i) => i.tick <= k);
      const after: RaidReplayInput[] = f.inputs.filter((i) => i.tick > k);
      const first = advanceRaidSegment(build(t, army, seed), 0, k, 0, before, false);
      expect(first.ok, seed).toBe(true);
      if (!first.ok || first.finished) continue;
      const resumed = build(t, army, seed);
      resumed.restore(JSON.parse(JSON.stringify(first.snapshot)));
      const second = advanceRaidSegment(resumed, k, f.ticks, first.lastSeq, after, true, true);
      expect(second.ok, seed).toBe(true);
      if (second.ok) expect(outcomeKey(second.outcome), seed).toBe(flown);
    }
  }, 300_000);
});

describe("boss-variant stress: the abilities actually fire", () => {
  it("across the mixed army's fights, every ability is exercised", () => {
    const totals = { phases: 0, teleports: 0, shieldPeak: 0, berserkDeaths: 0 };
    for (const t of TARGETS.filter((x) => x.raidId >= 9)) {
      const sim = build(t, "variantsOnly", `fire:${t.label}`);
      const w = watch(sim);
      flyFight(sim, makePilot(EXPERT), { seed: `fire:${t.label}` });
      totals.phases += w.stats.phases;
      totals.teleports += w.stats.teleports;
      totals.berserkDeaths += w.stats.berserkDeaths;
      totals.shieldPeak = Math.max(totals.shieldPeak, w.stats.shieldPeak);
    }
    expect(totals.teleports).toBeGreaterThan(0);
    expect(totals.phases).toBeGreaterThan(0);
    expect(totals.berserkDeaths).toBeGreaterThan(0);
    expect(totals.shieldPeak).toBeGreaterThan(0.1);
  }, 300_000);
});
