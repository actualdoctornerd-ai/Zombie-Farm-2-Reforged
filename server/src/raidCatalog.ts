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
  /** Player level required to invade. Mirrors raids.json `unlockLevel` and the client's
   *  `isUnlocked` (RaidCatalog.ts): unlocked iff `playable && level >= unlockLevel`. */
  unlockLevel: number;
  /** Whether the raid is playable at all (raids.json `playable`). */
  playable: boolean;
}

export const RAIDS: Readonly<Record<number, RaidEcon>> = {
  1: { gold: 1200, bonus: 400, xp: 100, recLevel: 5, unlockLevel: 0, playable: true }, // Old McDonnell's Farm
  2: { gold: 1500, bonus: 750, xp: 800, recLevel: 16, unlockLevel: 16, playable: true }, // Zombies vs Lawyers
  3: { gold: 2000, bonus: 750, xp: 1500, recLevel: 21, unlockLevel: 21, playable: true }, // Zombies vs Pirates
  4: { gold: 2500, bonus: 1250, xp: 2500, recLevel: 26, unlockLevel: 26, playable: true }, // Zombies vs Ninjas
  5: { gold: 3000, bonus: 1500, xp: 3500, recLevel: 31, unlockLevel: 31, playable: true }, // Zombies vs Robots
  6: { gold: 4000, bonus: 2000, xp: 4500, recLevel: 36, unlockLevel: 36, playable: true }, // Zombies vs Aliens
  7: { gold: 1200, bonus: 600, xp: 500, recLevel: 8, unlockLevel: 8, playable: true }, // Summer Break
  8: { gold: 1200, bonus: 600, xp: 500, recLevel: 12, unlockLevel: 12, playable: true }, // Zombies vs Circus
  9: { gold: 5000, bonus: 1200, xp: 5500, recLevel: 43, unlockLevel: 43, playable: true }, // Zombies vs Video Games
  10: { gold: 1200, bonus: 600, xp: 500, recLevel: 8, unlockLevel: 8, playable: true }, // Tree World
  11: { gold: 1200, bonus: 600, xp: 500, recLevel: 8, unlockLevel: 8, playable: true }, // Valentine's Day
};

export function raidEcon(id: number): RaidEcon | undefined {
  return Object.prototype.hasOwnProperty.call(RAIDS, id) ? RAIDS[id] : undefined;
}

/** Plausibility ceiling on an imported lifetime win count. Only bounds the migration
 *  seed — real wins accrue one at a time through settleRaid. Generous vs. legit play
 *  (a 2h cooldown caps organic wins far below this); it exists so a save can't declare
 *  an absurd count, not to model anything. Ability unlocks cap out in single digits. */
export const MAX_RAID_WINS = 100_000;

/** Is this raid invadable at `level`? Mirrors RaidCatalog.isUnlocked exactly. `level` is
 *  derived from server-owned xp, never client-sent — without this a level-1 account could
 *  invade raid 9 (5000 gold + 1200 bonus + 5500 first-clear XP, unlock level 43) and,
 *  since XP drives level-up brains, convert a fabricated win into premium currency. */
export function raidUnlocked(r: RaidEcon, level: number): boolean {
  return r.playable && level >= r.unlockLevel;
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
