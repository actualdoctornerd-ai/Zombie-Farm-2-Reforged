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
//   * Result SPECIES extends determineBaseClass with the recovered combining-special
//     rules: one Special wins, two Specials are refused, and level-25+ non-special
//     pairs have a 10% chance to become the tier-5 Special for an input body type.
//     Otherwise mutant donors and combat-tier comparison work as before.
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
import { createCombineRandom, selectCombineSpecies } from "./combineSpecies";

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
}

type ZombieSnapshot = Pick<OwnedZombieSave, "key"> & {
  id?: string;
  mutation: number;
  color?: [number, number, number];
  /** Combat tier (0..5). Used to pick the winner when both parents are non-veggie. */
  tier?: number;
  /** True if this is a veggie/mutant-tier zombie (a "mutation base class"). Such a
   *  parent loses its type in a mixed combine and only donates its mutation. */
  isBaseClass?: boolean;
  /** Body type and Special-category status used by the rare tier-5 promotion and
   * special-species override rules. */
  group?: string;
  isSpecial?: boolean;
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
    private rng: () => number = Math.random
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
   * the roster once this returns true.
   */
  start(
    a: ZombieSnapshot,
    b: ZombieSnapshot,
    hasMonolith: boolean,
    baseDurationMs: number = POT_DURATION_MS,
    playerLevel = 1
  ): boolean {
    if (this.job || (a.isSpecial && b.isSpecial)) return false;
    const startedAt = this.now();
    const duration = baseDurationMs * (hasMonolith ? MONOLITH_MULT : 1);
    this.job = {
      ...(a.id && b.id ? { parentAId: a.id, parentBId: b.id } : {}),
      keyA: a.key,
      keyB: b.key,
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
      specialA: a.isSpecial,
      specialB: b.isSpecial,
      playerLevel,
      startedAt,
      finishAt: startedAt + duration,
    };
    return true;
  }

  /**
   * Collect the finished result: species via determineBaseClass (see class header),
   * child mutation mask via deterministic per-slot inheritance. Clears the job.
   * Returns null if no job or it isn't ready yet.
   */
  collect(): PotResult | null {
    if (!this.job || !this.ready) return null;
    const j = this.job;
    const mutation = combineMasks(j.maskA, j.maskB);
    const key = this.pickSpecies(j);
    const color = mixColors(j.colorA, j.colorB);
    this.job = null;
    if (!key) return null;
    return { key, mutation, color };
  }

  /**
   * Result species from the shared client/server selector. Older saves without the
   * Special/group/level fields safely fall back to the original mutant/tier rules.
   */
  private pickSpecies(j: ZombiePotSave): string | null {
    const random = j.parentAId && j.parentBId
      ? createCombineRandom(j.parentAId, j.parentBId)
      : this.rng;
    return selectCombineSpecies(
      {
        key: j.keyA, tier: j.tierA, group: j.groupA,
        isMutant: j.baseA, isSpecial: j.specialA,
      },
      {
        key: j.keyB, tier: j.tierB, group: j.groupB,
        isMutant: j.baseB, isSpecial: j.specialB,
      },
      j.playerLevel ?? 1,
      random
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
