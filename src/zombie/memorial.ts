// The graveyard: zombies that died in an invasion and were not revived.
//
// Losses are permanent (GROUND TRUTH — raids cull the fallen), and the one chance
// to undo one is the brain-priced revival offer shown the moment the raid settles.
// Nothing here changes that. A fallen zombie is a MEMENTO: it can be enshrined on
// a Memorial Statue and inspected, and that is the whole of what it can ever do.
// It never returns to the roster, never fights, and cannot be sold.
//
// A fallen record carries the same minimal identity a living roster unit does —
// species key, mutation mask, veterancy, inherited tint — and the card is derived
// from the catalog exactly the way `makeOwned` derives a living unit's. The two
// extra fields are the ones that stop existing with the unit: the date it died and
// the name its owner gave it (names are not part of the catalog).
import type { ZombieDef } from "../assets";
import type { FallenZombieSave } from "../save/schema";
import type { ZombieInfo } from "../ui/hudTypes";
import { applyBodyTypeRestriction, mutationBonus } from "./mutations";
import { randomZombieName } from "./names";
import { classify } from "./taxonomy";
import { normalizeZombieName, type OwnedZombie } from "./types";

export type FallenZombie = FallenZombieSave;

/** How many unenshrined fallen zombies the graveyard remembers. A farm that raids
 *  for months would otherwise carry an unbounded list of the dead. Oldest are
 *  dropped first, so the losses a player is most likely to still want a statue for
 *  survive. Zombies already standing on a statue are NOT in this list and are never
 *  dropped — a memorial is permanent.
 *
 *  MUST match MEMORIAL_GRAVEYARD_CAP on the server (server/src/v3/engine.ts), which
 *  enforces the same ceiling authoritatively. */
export const MAX_REMEMBERED_FALLEN = 60;

/** Record one zombie at the moment it was lost. */
export function snapshotFallen(zombie: OwnedZombie, diedAt: number): FallenZombie {
  return {
    id: zombie.id,
    key: zombie.key,
    ...(zombie.name ? { name: zombie.name } : {}),
    mutation: zombie.mutation,
    invasions: zombie.invasions,
    ...(zombie.color ? { color: [...zombie.color] as [number, number, number] } : {}),
    diedAt,
  };
}

/**
 * The inspect card for a fallen zombie, derived from its catalog entry the same way
 * a living unit's is (see makeOwned) — so a memorial shows the species' real stats
 * with its mutation bonuses folded in, not a stale copy.
 *
 * `id` is deliberately omitted from the result: that is what makes the card
 * read-only, since openZombieInfo only builds Deploy/Store/Sell for a unit with an
 * id. Exactly right for something that no longer exists as a unit.
 */
export function fallenToInfo(
  fallen: FallenZombie,
  def: ZombieDef | undefined,
  portrait: string,
): ZombieInfo {
  const tax = classify(fallen.key);
  const group = def?.group ?? tax.group;
  const mask = applyBodyTypeRestriction(fallen.mutation, group === "Headless");
  const bonus = mutationBonus(mask, fallen.key);
  const typeName = def?.name ?? fallen.key;
  return {
    // Same ladder makeOwned uses for a living unit, so a plaque is never blank.
    name: fallenName(fallen, group) || typeName,
    typeName,
    key: fallen.key,
    group,
    className: def?.className ?? tax.className,
    classColor: def?.classColor ?? tax.classColor,
    str: (def?.str ?? 1) + bonus.str,
    dex: (def?.dex ?? 1) + bonus.dex,
    con: (def?.con ?? 1) + bonus.con,
    focus: def?.focus ?? 0,
    mutation: mask,
    portrait,
    color: fallen.color,
    invasions: fallen.invasions,
  };
}

/** The name on the plaque. An unnamed unit falls back to the same deterministic
 *  name it answered to while alive, which is derived from its id. */
export function fallenName(fallen: FallenZombie, group?: string): string {
  return fallen.name || randomZombieName(group ?? classify(fallen.key).group, fallen.id);
}

/** "12 Mar 2026" — the date on the plaque. */
export function fallenDateLabel(fallen: FallenZombie): string {
  const when = new Date(fallen.diedAt);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Drop anything that is not a well-formed record, and keep only the newest
 *  MAX_REMEMBERED_FALLEN. Applied to save data and to the server projection alike,
 *  so nothing half-built can reach a plinth.
 *
 *  The cap counts UNENSHRINED zombies only, so a list that mixes the two must be
 *  split before it gets here — see `sanitizeFallenUncapped`. */
export function sanitizeFallen(raw: unknown): FallenZombie[] {
  return trimFallen(sanitizeFallenUncapped(raw));
}

/** The same shape check with NO cap applied. Enshrined zombies go through this one:
 *  a memorial is permanent, and an occupant that died long ago must not be trimmed
 *  out from under its statue by sixty more recent losses. Bounded in practice by the
 *  number of statues a farm can hold. */
export function sanitizeFallenUncapped(raw: unknown): FallenZombie[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FallenZombie[] = [];
  for (const entry of raw) {
    const fallen = entry as Partial<FallenZombie> | null;
    if (!fallen || typeof fallen.id !== "string" || typeof fallen.key !== "string") continue;
    if (seen.has(fallen.id)) continue;
    seen.add(fallen.id);
    const name = normalizeZombieName(fallen.name);
    out.push({
      id: fallen.id,
      key: fallen.key,
      ...(name ? { name } : {}),
      mutation: Number.isFinite(fallen.mutation) ? Number(fallen.mutation) : 0,
      invasions: Number.isFinite(fallen.invasions) ? Math.max(0, Number(fallen.invasions)) : 0,
      ...(Array.isArray(fallen.color) && fallen.color.length === 3
        ? { color: [...fallen.color] as [number, number, number] }
        : {}),
      diedAt: Number.isFinite(fallen.diedAt) ? Number(fallen.diedAt) : 0,
      ...(Number.isFinite(fallen.releasedAt) ? { releasedAt: Number(fallen.releasedAt) } : {}),
    });
  }
  return out;
}

/** Where a zombie sits in the graveyard: the moment it last became one of the
 *  unenshrined. Normally that is when it died, but a zombie taken back off a statue
 *  rejoins the list at the top instead of at its date of death — otherwise selling a
 *  statue to re-site it could evict its occupant on the spot, which is the opposite
 *  of what the sell confirmation promises. It still ages out, once the next
 *  MAX_REMEMBERED_FALLEN losses have pushed past it.
 *
 *  Ordering only. The plaque's date is always `diedAt`. */
export function graveyardRank(fallen: FallenZombie): number {
  return fallen.releasedAt ?? fallen.diedAt;
}

/** Stamp a zombie as freshly returned to the graveyard (see graveyardRank). */
export function releasedToGraveyard(fallen: FallenZombie, at: number): FallenZombie {
  return { ...fallen, releasedAt: at };
}

/** Newest first, capped. Exported so the runtime list stays in the same shape the
 *  save is written in — the memorial picker shows the most recent losses at the top
 *  and the cap is enforced in one place.
 *
 *  Ties break on id, ascending, because ONE raid settlement stamps every casualty
 *  with the same timestamp — a fight that loses three zombies produces three equal
 *  ranks, so ties are the normal case rather than a curiosity. The server's two
 *  queries (the bootstrap's ORDER BY in v3/db.ts and the settlement trim in
 *  v3/raid.ts) both end `... DESC, unit_id`, and if the cap falls inside a tied group
 *  and the two sides break it differently they keep DIFFERENT zombies: the picker
 *  then offers one the server has deleted, and enshrining it comes back `not_owned`.
 *  Plain `<`/`>` rather than localeCompare — unit ids are ASCII, and this has to
 *  match SQLite's BINARY collation, not the device's locale. */
export function trimFallen(fallen: FallenZombie[]): FallenZombie[] {
  return [...fallen]
    .sort((a, b) =>
      graveyardRank(b) - graveyardRank(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_REMEMBERED_FALLEN);
}
