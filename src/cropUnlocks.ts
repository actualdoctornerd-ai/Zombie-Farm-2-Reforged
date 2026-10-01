// CROPS UNLOCKED BY CLEARING A DUAL-INVASION TIER, not by player level.
//
// The late-game crops (Golden Carrot, Cosmic Potato, ...) are prizes for the hardest
// content in the game: clearing tier N of a post-45 dual invasion (raid ids 12-15) opens
// the crop for good. Nothing new is stored for it. The ladder position already lives in
// server state — `raid_state_v3.tier_json`, {"<raidId>": <highest tier CLEARED>}, read by
// the Worker into `raids.tiers` and mirrored on the client as `GameState.raidTiers` — so
// "is this crop unlocked" is a pure function of that map. No migration, no save field.
//
// Import-free on purpose: the Worker's engine (the one that rejects `farm.plant`), the
// client's market/picker and the raid settlement all read it, and RaidCatalog already
// imports a lot.
//
// A crop in this table STILL needs its own `level` met (plants.json); the unlock is an
// additional gate, never a substitute. Practice mode (src/raid/practice.ts) records no
// tier clears, so nothing here unlocks until DUAL_PRACTICE is switched off.
//
// THE MASTER SWITCH. The six prize crops and their zombie mutations are fully in the code
// but NOT in the game: `PRIZE_CROPS.live` is false. While it is, they are invisible and
// unobtainable everywhere —
//   · the client drops their `prize: true` rows from plants.json at load (no art fetched,
//     no market card, no quest pool entry — see marketOrder.cropAvailableInMarket);
//   · the Worker refuses `farm.plant` for them whatever the ladder says (cropUnlocked);
//   · their mutations are not appended to the mutation catalog, so no bit is assigned and
//     the almanac, the Pot, the Black Market and the difficulty harness never see them;
//   · their crop -> mutation entries are absent from the crop adjacency table.
// To ship them: set `live` to true, turn DUAL_PRACTICE off so tier clears record, bump the
// raid ruleset (the mutations change zombie stats), and re-run the difficulty harness.
// The design and numbers: docs/PRIZE_CROPS.md.

/** The switch described above. An object (not a bare const) so tests can flip it; code
 *  that must be stable for a whole session (the mutation catalog) reads it once, at load. */
export const PRIZE_CROPS: { live: boolean } = { live: false };

export interface CropUnlock {
  /** The dual invasion (raid id 12-15) whose ladder opens the crop. */
  readonly raidId: number;
  /** The tier that must have been CLEARED (the ladder stores the highest cleared tier). */
  readonly tier: number;
}

/** crop key -> what unlocks it: t5 and t10 of the dual invasions (raid ids 12-15).
 *  Circus + Video Games (14) has no crop yet. */
export const CROP_UNLOCKS: Readonly<Record<string, CropUnlock>> = {
  golden_carrot: { raidId: 12, tier: 5 },
  golden_turnip: { raidId: 12, tier: 10 },
  obsidibeans: { raidId: 13, tier: 5 },
  cauliglower: { raidId: 13, tier: 10 },
  cosmic_potato: { raidId: 15, tier: 5 },
  brainato: { raidId: 15, tier: 10 },
};

type Tiers = Readonly<Record<string, number>> | undefined;
type Table = Readonly<Record<string, CropUnlock>>;

/** What a crop needs, or null for an ordinary level-gated crop. */
export function cropUnlockOf(cropKey: string, table: Table = CROP_UNLOCKS): CropUnlock | null {
  return Object.prototype.hasOwnProperty.call(table, cropKey) ? table[cropKey] : null;
}

/** Highest tier cleared on a raid, tolerating a missing/garbled map. */
function clearedTier(tiers: Tiers, raidId: number): number {
  const v = tiers?.[String(raidId)];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/** Whether this account may plant `cropKey` as far as the tier unlock is concerned.
 *  True for every crop that has no unlock requirement. A crop that HAS one is never
 *  unlocked while the prize crops are not live, whatever the ladder says. */
export function cropUnlocked(
  cropKey: string, tiers: Tiers, table: Table = CROP_UNLOCKS, live: boolean = PRIZE_CROPS.live,
): boolean {
  const need = cropUnlockOf(cropKey, table);
  return !need || (live && clearedTier(tiers, need.raidId) >= need.tier);
}

/** The crops a settlement just opened: unlocked AFTER but not BEFORE. */
export function newlyUnlockedCrops(
  before: Tiers, after: Tiers, table: Table = CROP_UNLOCKS, live: boolean = PRIZE_CROPS.live,
): string[] {
  return Object.keys(table).filter(
    (key) => !cropUnlocked(key, before, table, live) && cropUnlocked(key, after, table, live));
}
