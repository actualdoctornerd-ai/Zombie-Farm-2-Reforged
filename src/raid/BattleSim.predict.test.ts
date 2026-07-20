import { describe, it, expect } from "vitest";
import { BattleSim, BOSS_STRUCT_X, BOSS_STRUCT_Y } from "./BattleSim";
import type { BossThrowConfig, CombatUnit } from "./types";

const GRAVITY = 820; // must match BattleSim's internal constant
const STEP_MS = 16;

function mk(over: Partial<CombatUnit> & { id: string; team: "player" | "enemy" }): CombatUnit {
  return {
    sourceKey: over.id,
    name: over.id,
    str: 1,
    dex: 5,
    con: 80,
    focus: 100,
    hp: 8000,
    maxHp: 8000,
    attackCooldownMs: 1000,
    attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false,
    alive: true,
    isGarden: false,
    isHeadless: false,
    abilities: [],
    ...over,
  };
}

/** Run a fight with a single advancing player of the given dex and capture the FIRST
 *  boss throw that fires while the player is cruising forward (moving right at speed). */
function cruisingThrow(dex: number) {
  const player = mk({ id: "p", team: "player", dex });
  // A tanky wall keeps the boss perched (so it throws) and both sides survive the window.
  const wall = mk({ id: "w", team: "enemy", con: 800 });
  const boss = mk({ id: "b", team: "enemy", isBoss: true, con: 800 });
  const bossThrow: BossThrowConfig = {
    intervalMs: 120,
    options: [{ damage: 6, sprite: "x", spriteSize: 32, weight: 1 }],
  };
  const sim = new BattleSim([player], [wall, boss], bossThrow, /* concentration */ true);
  const p = sim.units.find((u) => u.id === "p")!;
  for (let i = 0; i < 100000 && !sim.finished; i++) {
    // snap.vx/vy is the velocity leadVelocity() will use for a throw fired THIS step.
    const snap = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, state: p.state };
    const before = sim.projectiles.length;
    sim.step(STEP_MS);
    if (snap.state === "advance" && snap.vx > 50 && sim.projectiles.length > before) {
      return { snap, pr: sim.projectiles[sim.projectiles.length - 1] };
    }
  }
  throw new Error(`no cruising throw captured for dex ${dex}`);
}

/** Recover the lead the throw actually used: un-integrate the one frame of gravity the
 *  just-launched projectile already took, invert the ballistic solve to the aim point,
 *  and measure how far ahead of the target's position that aim sits. */
function leadOf(snap: { x: number; y: number }, pr: { vx: number; vy: number }, preX: number) {
  const x0 = BOSS_STRUCT_X;
  const y0 = BOSS_STRUCT_Y;
  const T = Math.max(0.85, Math.min(1.7, Math.abs(preX - x0) / 520 + 0.7));
  const launchVy = pr.vy - GRAVITY * (STEP_MS / 1000); // stepProjectiles already ran once
  const tx = x0 + pr.vx * T; // vx = (tx - x0)/T
  const ty = y0 + (launchVy + 0.5 * GRAVITY * T) * T; // vy = (ty - y0)/T - 0.5 g T
  return { leadX: tx - snap.x, leadSpeed: Math.hypot(tx - snap.x, ty - snap.y) / T };
}

describe("boss throws are predictive, with a speed cap", () => {
  it("leads a moving zombie AHEAD of its current position (not a stale aim)", () => {
    const { snap, pr } = cruisingThrow(3);
    const { leadX } = leadOf(snap, pr, snap.x);
    expect(pr.damage).toBe(22); // round(raw 6 x chip scale 1.75) x projectile multiplier 2
    expect(leadX).toBeGreaterThan(20); // a no-lead throw would aim at leadX ≈ 0
  });

  it("leads a SLOW zombie by its true speed (so it connects)", () => {
    const { snap, pr } = cruisingThrow(1); // advanceSpeed(1) = 112 (< cap)
    const speed = Math.hypot(snap.vx, snap.vy);
    expect(speed).toBeLessThan(150); // genuinely slow
    const { leadSpeed } = leadOf(snap, pr, snap.x);
    expect(leadSpeed).toBeCloseTo(speed, -0.5); // full, uncapped lead (~within a few px/s)
    expect(Math.abs(leadSpeed - speed)).toBeLessThan(6);
  });

  it("caps the lead on a FAST zombie — led as if it were 'lowish speed'", () => {
    const { snap, pr } = cruisingThrow(10); // advanceSpeed clamps to 260 (>> cap)
    const speed = Math.hypot(snap.vx, snap.vy);
    expect(speed).toBeGreaterThan(200); // genuinely fast
    const { leadSpeed } = leadOf(snap, pr, snap.x);
    // Led at the ~150 cap, well under its true speed — so the shot lands behind it.
    expect(Math.abs(leadSpeed - 150)).toBeLessThan(6);
    expect(leadSpeed).toBeLessThan(speed - 40);
  });
});
