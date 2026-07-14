// Server-side raid reward economics. Mirrors the reward-relevant fields of
// public/assets/raids/raids.json and the client's winGold() (src/raid/RaidCatalog.ts),
// so the SERVER computes the base win gold + first-clear XP instead of trusting the
// client's claimed amount.
//
// KEEP IN SYNC with raids.json (11 playable raids) and RaidCatalog.winGold.
//
// Scope: this covers the DETERMINISTIC base reward (win gold from raid + survival
// fraction, and first-clear XP). The random loot roll (an item, "Bonus Gold", or a
// brain drop) stays on the bounds-validated economy/inventory path — server-owned
// inventory + a server-side loot roll are later layers. And whether the player
// actually WON is still client-asserted (deferred: deterministic input replay); the
// server only bounds the reward to what that specific raid legitimately pays.

export interface RaidEcon {
  /** Base "no casualties" gold reward (wiki figure). */
  gold: number;
  /** Possible bonus gold on a flawless win (wiki figure). */
  bonus: number;
  /** XP awarded the FIRST time this raid is cleared (0 = none). */
  xp: number;
  /** Recommended/stage level — only used by the no-data fallback (unused for the 11
   *  catalog raids, which all have gold data; kept for formula parity). */
  recLevel: number;
}

export const RAIDS: Readonly<Record<number, RaidEcon>> = {
  1: { gold: 1200, bonus: 400, xp: 100, recLevel: 5 }, // Old McDonnell's Farm
  2: { gold: 1500, bonus: 750, xp: 800, recLevel: 16 }, // Zombies vs Lawyers
  3: { gold: 2000, bonus: 750, xp: 1500, recLevel: 21 }, // Zombies vs Pirates
  4: { gold: 2500, bonus: 1250, xp: 2500, recLevel: 26 }, // Zombies vs Ninjas
  5: { gold: 3000, bonus: 1500, xp: 3500, recLevel: 31 }, // Zombies vs Robots
  6: { gold: 4000, bonus: 2000, xp: 4500, recLevel: 36 }, // Zombies vs Aliens
  7: { gold: 1200, bonus: 600, xp: 500, recLevel: 8 }, // Summer Break
  8: { gold: 1200, bonus: 600, xp: 500, recLevel: 12 }, // Zombies vs Circus
  9: { gold: 5000, bonus: 1200, xp: 5500, recLevel: 43 }, // Zombies vs Video Games
  10: { gold: 1200, bonus: 600, xp: 500, recLevel: 8 }, // Tree World
  11: { gold: 1200, bonus: 600, xp: 500, recLevel: 8 }, // Valentine's Day
};

export function raidEcon(id: number): RaidEcon | undefined {
  return Object.prototype.hasOwnProperty.call(RAIDS, id) ? RAIDS[id] : undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Base win gold, mirroring RaidCatalog.winGold: both the base and the bonus are
 *  scaled by the fraction of the deployed army still standing, so a flawless win
 *  earns the full base+bonus and every casualty cuts the take. The no-data fallback
 *  (level×230 base + level×100 bonus) matches the client for parity, though every
 *  catalog raid has real gold data. survivalFrac is the ONLY client-supplied lever,
 *  and it's clamped to [0,1] — so the credit can't exceed this raid's real ceiling. */
export function winGold(r: RaidEcon, survivalFrac: number): number {
  const f = clamp01(survivalFrac);
  const hasData = r.gold > 0 || r.bonus > 0;
  const base = hasData ? r.gold : Math.round(r.recLevel * 230);
  const bonus = hasData ? r.bonus : Math.round(r.recLevel * 100);
  return Math.round(base * f) + Math.round(bonus * f);
}
