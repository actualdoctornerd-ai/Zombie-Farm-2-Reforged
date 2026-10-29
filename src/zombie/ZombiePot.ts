// ---------------------------------------------------------------------------
// Zombie Pot — combines two zombies into one (ZF2's mutation-stacking tool).
// ---------------------------------------------------------------------------
// Rules — GROUND TRUTH recovered by disassembling the shipped iOS binary
// (`ZFZombieCombiner` getCombineTime / determineBaseClass / combineZombieMutationFlag:;
// see docs/mechanics/BINARY_RE_METHODOLOGY.md). These replace the earlier guesses:
//   * Combine takes 1 HOUR by default; the CLAY Monolith cuts it to 15 min (0.25×,
//     NOT the previously-guessed 30 min / 0.5×) — two hardcoded doubles 3600.0 / 900.0.
//     (getCombineTime checks purchase flag 28; flag 28 = Clay Monolith, whose in-game
//     tooltip is literally "Zombie Pots combine in 15 minutes". The Mutant Monolith
//     (flag 15) is a SEPARATE item that halves mutant-zombie GROW times, not this.)
//   * SPECIES IS A DELIBERATE DIVERGENCE, not recovered behavior. Slot 1 determines
//     the result species, so the player picks the outcome. Named Specials are
//     restricted to slot 1 and are always inherited; a pair of the SAME species climbs
//     the colour ladder — Green -> Blue -> Red once the matching grave is owned, then
//     Red -> that body type's Silver (tier-4) at level 25+ — and level-25+ non-special
//     pairs retain their chance to promote the slot-1 body type to its tier-5
//     Special instead.
//     The recovered `determineBaseClass` instead resolved species from the catalog —
//     non-veggie parent wins, then higher combat tier, then a coin flip on a tie.
//     See docs/SPECIAL_ZOMBIE_ACQUISITION.md. Everything else in this list IS
//     ground truth.
//   * The result's color is the mixed parent color; identical colors lighten.
//   * Mutations inherit per-slot (combineMasks): non-conflicting slots carry over; a
//     same-slot conflict keeps the HIGHER-tier bit — DETERMINISTIC, no RNG.
//   * Both parents are consumed when the combine STARTS (they leave the roster and
//     stop counting toward the army cap); the result appears when it finishes.
//   * Offline-safe: the finish time is an absolute epoch, so a combine completes
//     while the game is closed.
//
// This class is pure data/logic (no Pixi) so it is unit-testable headlessly. It
// holds at most one job, mirroring the single in-game Zombie Pot building.
import { OwnedZombieSave, ZombiePotSave } from "../save/schema";
import { combineMasks } from "./mutations";
import {
  createCombineRandom, selectCombineSpecies, SLOT1_RECORD_SINCE_MS, type CombineGraveUnlock,
} from "./combineSpecies";

/** Default combine duration: 1 hour, in ms (binary: getCombineTime = 3600.0 s). */
export const POT_DURATION_MS = 60 * 60 * 1000;
/** Clay Monolith multiplier on the combine timer: 0.25× -> 15 min (binary:
 *  getCombineTime returns 900.0 s when purchase flag 28 = Clay Monolith is set). */
export const MONOLITH_MULT = 0.25;

/** What a finished combine yields: a species key + the child's mutation mask. */
export interface PotResult {
  key: string;
  mutation: number;
  color?: [number, number, number];
  /** Slot 1's name, carried onto the child (see ZombiePotSave.nameA). Undefined
   *  leaves naming to the caller's usual id-derived roll. */
  name?: string;
}

type ZombieSnapshot = Pick<OwnedZombieSave, "key"> & {
  id?: string;
  mutation: number;
  color?: [number, number, number];
  /** This parent's display name. Only slot 1's is kept — it becomes the child's. */
  name?: string;
  /** Combat tier (0..5). No longer used for species selection (slot 1 decides);
   *  persisted so a job started by an older client still round-trips. */
  tier?: number;
  /** True if this is a veggie/mutant-tier zombie (a "mutation base class"). Also no
   *  longer used for species selection — kept for the same round-trip reason. */
  isBaseClass?: boolean;
  /** Body type and Special-category status used by the rare tier-5 promotion and
   * special-species override rules. */
  group?: string;
  isSpecial?: boolean;
  /** Colour class, which decides how far a matched pair breeds up the ladder. */
  className?: string;
};

const mixColors = (
  a?: [number, number, number],
  b?: [number, number, number]
): [number, number, number] | undefined => {
  if (!a || !b) return a ?? b;
  const same = a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  if (same) {
    return a.map((c) => Math.round(c + (255 - c) * 0.35)) as [number, number, number];
  }
  return [
    Math.round((a[0] + b[0]) / 2),
    Math.round((a[1] + b[1]) / 2),
    Math.round((a[2] + b[2]) / 2),
  ];
};

export class ZombiePot {
  private job: ZombiePotSave | null = null;

  // `now` and `rng` are injectable so tests are deterministic; production uses
  // wall-clock + Math.random.
  constructor(
    private now: () => number = () => Date.now(),
    private rng: () => number = Math.random,
    /** Is this species headless? Injected because the pot carries no catalog, and the
     *  child's body type decides which inherited mutations survive (see combineMasks).
     *  The default answers "no", which only misses the headless-only Pumpking bit. */
    private isHeadlessKey: (key: string) => boolean = () => false,
    /** Does the farm own this coloured grave? Read when the result is derived rather
     *  than captured at start, so it always agrees with what the server sees at
     *  collection. The default answers "no", leaving the ladder switched off. */
    private hasGrave: CombineGraveUnlock = () => false
  ) {}

  /** Is a combine currently running (started, not yet collected)? */
  get busy(): boolean {
    return this.job !== null;
  }

  /** Has the running combine finished (ready to collect)? */
  get ready(): boolean {
    return this.job !== null && this.now() >= this.job.finishAt;
  }

  /** ms left until the combine is ready (0 if none / already done). */
  remainingMs(): number {
    return this.job ? Math.max(0, this.job.finishAt - this.now()) : 0;
  }

  /** Full combine duration of the running job (0 if idle). For progress bars. */
  totalMs(): number {
    return this.job ? this.job.finishAt - this.job.startedAt : 0;
  }

  /** Combine progress 0..1 (0 if idle). */
  progress(): number {
    const total = this.totalMs();
    return total > 0 ? Math.min(1, (this.totalMs() - this.remainingMs()) / total) : 0;
  }

  /** Finish an active timer immediately. Returns false when idle or already ready. */
  finishNow(): boolean {
    if (!this.job || this.ready) return false;
    this.job.finishAt = this.now();
    return true;
  }

  /** The running job (read-only), or null. */
  get pending(): Readonly<ZombiePotSave> | null {
    return this.job;
  }

  /**
   * Start combining two parent snapshots. Refused (returns false) if a combine is
   * already running. `hasMonolith` quarters the timer. The parents' keys+masks are
   * captured here; the caller is responsible for removing the parent units from
   * the roster once this returns true. `reserved` records that an authoritative
   * server was asked to hold both parents, which lets a later reconcile tell a
   * genuine job apart from one whose start never landed (see ZombiePotSave).
   */
  start(
    a: ZombieSnapshot,
    b: ZombieSnapshot,
    hasMonolith: boolean,
    baseDurationMs: number = POT_DURATION_MS,
    playerLevel = 1,
    reserved = false
  ): boolean {
    if (this.job || b.isSpecial) return false;
    const startedAt = this.now();
    const duration = baseDurationMs * (hasMonolith ? MONOLITH_MULT : 1);
    this.job = {
      ...(a.id && b.id ? { parentAId: a.id, parentBId: b.id } : {}),
      keyA: a.key,
      keyB: b.key,
      ...(a.name ? { nameA: a.name } : {}),
      maskA: a.mutation,
      maskB: b.mutation,
      colorA: a.color,
      colorB: b.color,
      tierA: a.tier,
      tierB: b.tier,
      baseA: a.isBaseClass,
      baseB: b.isBaseClass,
      groupA: a.group,
      groupB: b.group,
      classA: a.className,
      classB: b.className,
      specialA: a.isSpecial,
      specialB: b.isSpecial,
      playerLevel,
      ...(reserved ? { reserved: true } : {}),
      startedAt,
      finishAt: startedAt + duration,
    };
    return true;
  }

  /**
   * Collect the finished result: species from slot 1 (see class header), child
   * mutation mask via deterministic per-slot inheritance. Clears the job.
   * Returns null if no job or it isn't ready yet.
   */
  collect(): PotResult | null {
    const result = this.preview();
    if (!result) {
      // A ready job whose species no longer resolves still has to leave the pot,
      // matching the pre-preview behaviour (the caller restores it if it can).
      if (this.job && this.ready) this.job = null;
      return null;
    }
    this.job = null;
    return result;
  }

  /**
   * The finished zombie WITHOUT collecting it, so the panel can show what came
   * out while it waits to be picked up. Deterministic — same job, same result —
   * so the preview always matches what collect() hands over. Null unless a job
   * is ready (a running combine keeps its result hidden).
   */
  preview(): PotResult | null {
    if (!this.job || !this.ready) return null;
    const j = this.job;
    const key = this.pickSpecies(j);
    if (!key) return null;
    return {
      key,
      mutation: combineMasks(j.maskA, j.maskB, this.isHeadlessKey(key)),
      color: mixColors(j.colorA, j.colorB),
      // Slot 1 supplies the species; it supplies the name with it, so the zombie the
      // player chose to keep still answers to the same name after the combine.
      ...(j.nameA ? { name: j.nameA } : {}),
    };
  }

  /**
   * Result species from the shared client/server selector. A job persisted without the
   * Special/group/level fields still collects safely: with no group there is no tier-5
   * promotion to roll, so it yields slot 1's species like any other combine.
   */
  private pickSpecies(j: ZombiePotSave): string | null {
    const random = j.parentAId && j.parentBId
      ? createCombineRandom(j.parentAId, j.parentBId)
      : this.rng;
    return selectCombineSpecies(
      {
        key: j.keyA, tier: j.tierA, group: j.groupA, className: j.classA,
        isMutant: j.baseA, isSpecial: j.specialA,
      },
      {
        key: j.keyB, tier: j.tierB, group: j.groupB, className: j.classB,
        isMutant: j.baseB, isSpecial: j.specialB,
      },
      j.playerLevel ?? 1,
      random,
      this.hasGrave,
      j.startedAt < SLOT1_RECORD_SINCE_MS
    );
  }

  /** Abandon a running combine (the parents are already gone — no refund). */
  cancel(): void {
    this.job = null;
  }

  serialize(): ZombiePotSave | undefined {
    return this.job ? { ...this.job } : undefined;
  }

  restore(save?: ZombiePotSave): void {
    this.job = save ? { ...save } : null;
  }
}
