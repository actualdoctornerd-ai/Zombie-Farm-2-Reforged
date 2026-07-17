// Raid difficulty knobs — the tunable layer that sits ON TOP of the faithful, disassembled
// combat math. MELEE damage is NOT here: enemies deal finalPower × mult × 1.0 and player
// zombies use the recovered lineup-depth band (see combatStats.ts / COMBAT_STATS_RECOVERED.md).
// Everything below scales mechanics whose exact source value is NOT recovered, so they stay
// adjustable without corrupting the ground-truth model.

// Effective enemy swing interval, as a MULTIPLE of the raw fight-data clock (1/dex). The
// disassembled clock is exactly 1/dex (ATTACK_INTERVAL_SEC.enemy), i.e. twice a zombie's rate.
// But in the real fight the next strike is gated by the attack ANIMATION finishing — time the
// reimpl sim doesn't model — so enemies visibly swing slower than the raw clock. Reference
// footage reads ~2/dex (a Pirate brute at dex 0.5 hits ~every 4 s), so we keep the effective
// cadence at 2× the clock. This is the ONLY enemy-tempo knob; per-hit enemy damage is faithful
// (×1.0), unlike the old model which also inflated it ×2.
export const ENEMY_ATTACK_PACE = 2;

// Heuristic hazard damage — no recovered ground-truth source for these, so they're scaled to
// stay proportional to the con×100 HP / str×10 power melee scale and keep bosses threatening.
export const PROJECTILE_DAMAGE_MULT = 2; // boss thrown-debris chip
export const BOSS_SPECIAL_DAMAGE_MULT = 2; // alienLaser / pixelFire / telekinesis chip
