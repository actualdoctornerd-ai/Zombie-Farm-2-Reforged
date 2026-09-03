// Mutation Almanac: the collection behind the Zombies menu's third tab.
//
// The Zombie Almanac collects SPECIES; this collects the sixteen mutations that can be
// grown onto them. It works the same way — a mutation is a black silhouette until the
// player has owned a zombie wearing it, and the entry only opens up once discovered —
// but what an entry shows is different, because a mutation is not a creature: it is a
// slot, a stat change, and a look that only exists on somebody else's body.
//
// WHICH BODY. Each mutation is drawn on the base Regular zombie of its own tier, so the
// ladder reads in the same four colours the zombie collection uses: a Tier-1 mutation
// sits on the Green Regular, Tier-4 on the Silver one. That is a deliberate choice over
// drawing everything on one body — the tier is a real property of the mutation (ZF2
// names it in each market mutant's actor key) and colour is how this game has always
// said "rank". Regular is the family every mutation can legally wear except Pumpking,
// which a Regular can only inherit through the Zombie Pot; drawing it there anyway is
// honest, since that IS a zombie the player can end up owning.
//
// Pure data — no DOM, no Pixi. The panel renders it (ui/panels/zombies.ts) and the
// portrait extraction happens there, one tile at a time.
import { CROP_MUTATIONS } from "./cropMutations";
import { MUTATION_ICON } from "./mutationDisplay";
import {
  MUTATION_LIST, mutationsOf, statEffectsOf,
  type MutationDef, type MutationKey, type MutationTier, type Slot, type Stat,
} from "./mutations";
import { CLASS_COLOR, classForTier, type ZClass } from "./taxonomy";

/** Lifetime count per mutation key, exactly like the species map. */
export type MutationDiscoveredMap = Record<MutationKey, number>;

/** Player-facing name for each slot. The internal keys are terse and one of them
 *  ("hair_eye") is not a phrase at all. */
export const SLOT_LABELS: Readonly<Record<Slot, string>> = {
  head: "Head",
  hair_eye: "Hair & Eyes",
  arm: "Arms",
  body: "Body",
  neck: "Neck",
};

/** The base Regular zombie that carries each tier's portrait. These four are the only
 *  un-mutated Regulars with a colour class, and they run Green -> Blue -> Red -> Silver,
 *  which is exactly the ladder a mutation tier needs. */
export const TIER_PORTRAIT_ZOMBIE: Readonly<Record<MutationTier, string>> = {
  1: "ZombieActorRegularTier1",
  2: "ZombieActorRegularTier2",
  3: "ZombieActorRegularTier3",
  4: "ZombieActorRegularTier4",
};

export interface MutationAlmanacEntry {
  key: MutationKey;
  /** Display name of the mutation ("Tomatohead"). */
  name: string;
  /** Its mask bit — what the portrait rig is asked to draw. */
  bit: number;
  slot: Slot;
  /** Player-facing slot name ("Hair & Eyes"). */
  slotLabel: string;
  tier: MutationTier;
  /** Colour class for this tier — Green through Silver. */
  className: ZClass;
  classColor: string;
  /** Catalog key of the zombie its portrait is drawn on. */
  portraitZombieKey: string;
  /** ZF2's own 40x40 icon for this mutation — the vegetable in its lab flask, the
   *  same one the zombie card's mutation rows use. It is a plain file, so it is what
   *  the tile can show without the renderer: see the panel's paintMutationPortrait. */
  icon: string;
  /** The stats it moves, in a fixed order, skipping the ones it leaves alone. */
  statEffects: { stat: Stat; amount: number }[];
  /** Lifetime count of owned zombies discovered wearing it. 0 = silhouette. */
  obtained: number;
  /** How to get it — the only thing an undiscovered entry reveals. */
  hint: string;
}

export interface MutationAlmanacSources {
  /** plants.json crop key -> display name, for the obtain hint. */
  cropName: (cropKey: string) => string | undefined;
}

// Which crop grows which mutation, inverted once at module load. CROP_MUTATIONS maps
// crop -> mutation ref(s); several crops may name one mutation, so the value is a list.
const CROPS_BY_MUTATION = ((): Readonly<Record<string, string[]>> => {
  const out: Record<string, string[]> = {};
  for (const [cropKey, refs] of Object.entries(CROP_MUTATIONS)) {
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      if (typeof ref === "string") (out[ref] ??= []).push(cropKey);
    }
  }
  return out;
})();

/** English list: "a, b or c". */
const orList = (items: readonly string[]): string =>
  items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

/** One-line "how do I get this?", shown on an undiscovered entry.
 *
 *  Every mutation in the catalog is grown from a crop, so that is the hint — plant the
 *  crop beside a zombie crop and the zombie comes up wearing it. The fallback covers a
 *  future mutation with no crop wired up yet, and names the other two routes rather
 *  than claiming a source that does not exist. */
export function mutationObtainHint(def: MutationDef, sources: MutationAlmanacSources): string {
  const crops = (CROPS_BY_MUTATION[def.key] ?? [])
    .map((cropKey) => sources.cropName(cropKey))
    .filter((name): name is string => !!name);
  if (!crops.length) return "Found on a bought or combined zombie.";
  return `Grow a zombie crop beside ${orList(crops)}.`;
}

/**
 * Every mutation as an almanac entry, in catalog order.
 *
 * Catalog order and not tier order: it is bit order, which is roughly the order a
 * player meets them, and it keeps a mutation's position in the grid stable forever —
 * the catalog is append-only, so an entry never moves once it has shipped. Sorting by
 * tier would reshuffle the whole grid the day a mid-tier mutation is added.
 */
export function mutationAlmanacEntries(
  discovered: MutationDiscoveredMap,
  sources: MutationAlmanacSources,
  list: readonly MutationDef[] = MUTATION_LIST,
): MutationAlmanacEntry[] {
  return list.map((def) => {
    const className = classForTier(def.tier);
    return {
      key: def.key,
      name: def.name,
      bit: def.bit,
      slot: def.slot,
      slotLabel: SLOT_LABELS[def.slot],
      tier: def.tier,
      className,
      classColor: CLASS_COLOR[className],
      portraitZombieKey: TIER_PORTRAIT_ZOMBIE[def.tier],
      icon: MUTATION_ICON[def.key] ?? "",
      statEffects: statEffectsOf(def),
      obtained: Math.max(0, Math.floor(discovered[def.key] ?? 0)),
      hint: mutationObtainHint(def, sources),
    };
  });
}

/** "+1 Strength", "-2 Speed" — one stat change, spelled out. */
export const STAT_LABELS: Readonly<Record<Stat, string>> = {
  str: "Strength",
  dex: "Speed",
  con: "Life",
};
export function statEffectText(effect: { stat: Stat; amount: number }): string {
  return `${effect.amount > 0 ? "+" : ""}${effect.amount} ${STAT_LABELS[effect.stat]}`;
}

/** Seed the map from an existing roster — the first run after this tab ships, or a save
 *  written before it existed. Every mutation currently worn counts once per zombie
 *  wearing it, which is the same "lifetime obtained" reading the species map uses. */
export function backfillMutationDiscovered(
  roster: readonly { mutation?: number }[]
): MutationDiscoveredMap {
  const out: MutationDiscoveredMap = {};
  for (const unit of roster) {
    for (const def of mutationsOf(unit.mutation ?? 0)) out[def.key] = (out[def.key] ?? 0) + 1;
  }
  return out;
}

/** The map a save should open with: seeded whole when it has none, and otherwise
 *  with every mutation the roster is wearing present at ONE or more. The second half
 *  is the repair for the gap the online harvest left — the species was counted, the
 *  mask arrived later and was never credited, and a backfill that only ran on an empty
 *  map could never reach it. Runs on every load: a floor, never an increment, so it is
 *  idempotent and never lowers a count the player earned. */
export function repairMutationDiscovered(
  existing: MutationDiscoveredMap,
  roster: readonly { mutation?: number }[]
): MutationDiscoveredMap {
  if (!Object.keys(existing).length) return backfillMutationDiscovered(roster);
  const out: MutationDiscoveredMap = { ...existing };
  for (const unit of roster) {
    for (const def of mutationsOf(unit.mutation ?? 0)) out[def.key] = Math.max(out[def.key] ?? 0, 1);
  }
  return out;
}

/** Keep only finite counts >= 1, exactly as the species map is sanitized. */
export function sanitizeMutationDiscovered(raw: unknown): MutationDiscoveredMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: MutationDiscoveredMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 1) out[key] = Math.floor(value);
  }
  return out;
}
