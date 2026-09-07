// A queue of farm jobs the farmer works one at a time. Tapping a plot with a tool
// (or a ripe crop in select mode) enqueues a job: the target plot stays highlighted
// green while queued; when the farmer reaches it and starts hoeing, a progress bar
// appears under that plot and fills green, then the action applies and the marker
// clears. Queue is FIFO so you can line up several actions at once.
import { Container, Graphics, Text } from "pixi.js";
import { CARROT, CropConfig, Field, HarvestResult, PLOT, ZombieMutationContext } from "./Field";
import { Actor } from "./Actor";
import { WalkController } from "./WalkController";
import { GameState } from "./GameState";
import { HH, HW, TILE_W } from "./iso";
import { QuestBus, QuestEvent } from "./quest/events";
import { Sfx } from "./audio";
import { harvestXp, plowXp } from "./farmRewards";
import type { FarmJobQueueSave, FarmJobSave } from "./save/schema";

export type JobKind = "till" | "plant" | "harvest";
export type JobCurrency = "gold" | "brains";
// "harvestTree" = harvest a placed fruit tree (uses the harvest animation, 2x fast).
type Kind = JobKind | "walk" | "harvestTree";

const WORK_MS = 1250; // ~1.25s of hoeing per plot
// Match the foreground loop's existing maximum step. Catch-up intentionally
// replays logical movement/work in small slices: WalkController and JobSystem
// cross waypoint, arrival, work, and next-job boundaries through callbacks, so
// one giant dt would otherwise stop at the first boundary and discard the rest.
const CATCH_UP_STEP_SEC = 0.05;
const PLOW_COST = 10;
const LABEL: Record<JobKind, string> = { till: "Plow", plant: "Plant", harvest: "Harvest" };

// Progress bar: about half a tilled plot wide, squarish, filled left-to-right.
const BAR_W = PLOT * TILE_W * 0.5;
const BAR_H = 26;
const BAR_PAD = 3;

interface Bar {
  cont: Container;
  fill: Graphics;
}
interface Job {
  kind: Kind; // "walk" = plain move, no work / no marker
  oc: number; // plot origin (or -1 for walk/tree)
  or: number;
  cx: number; // world target (plot center, or exact point for walk)
  cy: number;
  queuedAt: number;
  diamond: Graphics | null; // green plot highlight while queued/working
  bar: Bar | null; // progress bar, created only while being worked
  cfg?: CropConfig; // what to plant (plant jobs only)
  objId?: string; // target object (harvestTree jobs only)
  pendKey?: string; // this job's dedupe key in `pending`
}

export class JobSystem {
  /** Presentation persistence hook. Set by main after SaveManager is constructed. */
  onQueueChanged: (() => void) | null = null;
  private queue: Job[] = [];
  private active: Job | null = null;
  private phase: "walk" | "work" | null = null;
  private workMs = 0;
  private workTotal = WORK_MS; // duration of the active job's work phase
  private pending = new Set<string>(); // dedupe key "kind:bc,br"
  // Raids own the screen and suspend farm mutations/audio behind the battle.
  private paused = false;
  // When the current pause began, so resuming can replay it (see setPaused).
  private pausedAt: number | null = null;
  // While elapsed background time is replayed, actions must use the replay
  // cursor rather than Date.now(). Otherwise every planting completed by one
  // catch-up pass receives the same (late) timestamp.
  private replayNow: number | null = null;

  constructor(
    private field: Field,
    private actor: Actor,
    private walk: WalkController,
    private state: GameState,
    private float: (x: number, y: number, msg: string, delay?: number) => void,
    private sfx: (name: Sfx) => void = () => {},
    // Fired when a zombie crop is harvested, to grow an owned zombie at its plot.
    // Returns the spawned unit's id (so an online harvest can tell the server which
    // verified unit the crop yielded) plus the quest subjects the unit answers to —
    // a field-grown mutation makes it count as the matching Market mutant. Null when
    // nothing was spawned.
    private onZombieHarvest: (
      key: string, oc: number, or: number, mutation: ZombieMutationContext
    ) => { id: string; subjectAliases: readonly string[] } | null = () => null,
    // Quest event bus: plow/plant/harvest post notifications that advance quests.
    private quest: QuestBus = new QuestBus(),
    // Fired after a veggie crop is planted, to let Garden zombies roll to fertilize
    // it. Returns the fertilizing zombie's name (for a toast) or null.
    private onCropPlanted: (oc: number, or: number, cfg: CropConfig) => string | null = () => null,
    // Carries the exact free-placement origin into the tutorial's next beat.
    private onPlotPlowed: (oc: number, or: number) => void = () => {},
    // Epic Boss token roll, performed HERE in both modes and returning whether this
    // crop yielded one. Online it is reported to the server rather than checked by it.
    // The crop KEY rides along because the running boss's favourite crop rolls at a
    // better rate (epicBoss/favoriteCrops.ts); `name` is display text and cannot be
    // matched on. The rarer favourite-crop event LURE is not reported back here — it
    // announces itself with a modal rather than a float over the plot.
    private onCropHarvested: (
      crop: { key: string; growMs: number; value: number }, x: number, y: number
    ) => boolean = () => false,
    // Immediate affordability feedback. Queue validation used to fail silently,
    // making a valid plot look unresponsive when the player lacked currency.
    private onInsufficientFunds: (currency: JobCurrency, needed: number) => void = () => {},
    // Visual-only collection feedback. Called after a successful crop harvest.
    private onHarvestFx: (result: HarvestResult, x: number, y: number) => void = () => {},
    // How many more grown zombies the farm can take RIGHT NOW: free army slots plus
    // free Mausoleum slots. Read at three points — enqueue, arrival, and the instant
    // before the crop is consumed — because capacity moves under a queued harvest
    // (an earlier queued crop lands, a combine is collected, a raid party returns).
    private zombieHarvestRoom: () => number = () => Number.POSITIVE_INFINITY
  ) {}

  private key(kind: JobKind, oc: number, or: number) {
    return `${kind}:${oc},${or}`;
  }

  /** Is there anywhere for one more grown zombie to go? */
  private hasZombieRoom(): boolean {
    return this.zombieHarvestRoom() > 0;
  }

  /** Zombie crops already queued (or being worked): each one has claimed a slot that
   *  the room count still shows as free, because nothing is spawned until the farmer
   *  finishes. Without this, a farm one slot from full accepts every ripe zombie on
   *  the field and refuses them one by one on arrival. */
  private pendingZombieHarvests(): number {
    let count = 0;
    for (const job of this.active ? [this.active, ...this.queue] : this.queue) {
      if (job.kind === "harvest" && this.field.ripeZombieAt(job.oc, job.or)) count++;
    }
    return count;
  }

  // Gold charged to plow one plot — 0 while a Plowing Monolith is placed.
  private plowCost(): number {
    return this.field.hasPlowFree() ? 0 : PLOW_COST;
  }

  // Queue a tool action on the plot under (col,row) if it's valid and not already
  // queued. Returns true if a job was added.
  enqueue(kind: JobKind, col: number, row: number, cfg?: CropConfig): boolean {
    // Resolve the target plot origin (till may place a NEW plot; plant/harvest act
    // on the existing plot under the tile).
    let oc: number, or: number;
    if (kind === "till") {
      const t = this.field.resolveTill(col, row);
      if (!t.valid) return false;
      oc = t.oc; or = t.or;
    } else {
      const at = this.field.plotOriginAt(col, row);
      const ok = kind === "plant" ? this.field.canPlant(col, row) : this.field.isRipe(col, row);
      if (!at || !ok) return false;
      oc = at.oc; or = at.or;
    }
    const k = this.key(kind, oc, or);
    if (this.pending.has(k)) return false;
    if (kind === "till" && this.state.gold < this.plowCost()) {
      this.onInsufficientFunds("gold", this.plowCost());
      return false;
    }
    if (kind === "plant" && cfg) {
      if (this.state.level < cfg.unlockLevel) return false; // not unlocked yet
      const funds = cfg.brainsNeeded ? this.state.brains : this.state.gold;
      if (funds < cfg.cost) {
        this.onInsufficientFunds(cfg.brainsNeeded ? "brains" : "gold", cfg.cost);
        return false;
      }
    }
    // A zombie crop may only be queued if a home for the unit is still unclaimed —
    // counting the zombie harvests already in the queue, which have not spawned yet.
    if (kind === "harvest" && this.field.ripeZombieAt(oc, or) &&
        this.zombieHarvestRoom() <= this.pendingZombieHarvests()) {
      const at = this.field.plotCenterOf(oc, or);
      this.float(at.x, at.y, "Army full!");
      return false;
    }

    if (kind === "till") this.field.reserveTill(oc, or); // hold the area while queued
    const c = this.field.plotCenterOf(oc, or);
    const diamond = this.makeDiamond(c.x, c.y, PLOT, kind === "till");
    this.queue.push({ kind, oc, or, cx: c.x, cy: c.y, queuedAt: Date.now(), diamond, bar: null, cfg, pendKey: k });
    this.pending.add(k);
    this.onQueueChanged?.();
    return true;
  }

  // Queue harvesting a ready fruit tree: the farmer walks to it and hoes (fast).
  enqueueTreeHarvest(objId: string, x: number, y: number): boolean {
    const k = `tree:${objId}`;
    if (this.pending.has(k)) return false;
    const area = this.field.objectHighlightArea(objId);
    const diamond = area ? this.makeDiamond(area.x, area.y, area.tiles) : null;
    this.queue.push({
      kind: "harvestTree", oc: -1, or: -1, cx: x, cy: y, queuedAt: Date.now(),
      diamond, bar: null, objId, pendKey: k,
    });
    this.pending.add(k);
    this.onQueueChanged?.();
    return true;
  }

  /** Input previews use these read-only checks so crossing a queued harvest does
   * not show it as a new swipe target. enqueue()/enqueueTreeHarvest() remain the
   * authoritative deduplication boundary. */
  isPlotHarvestPending(col: number, row: number): boolean {
    const at = this.field.plotOriginAt(col, row);
    return !!at && this.pending.has(this.key("harvest", at.oc, at.or));
  }

  isPlotTillPending(col: number, row: number): boolean {
    const at = this.field.plotOriginAt(col, row);
    return !!at && this.pending.has(this.key("till", at.oc, at.or));
  }

  isTreeHarvestPending(objId: string): boolean {
    return this.pending.has(`tree:${objId}`);
  }

  /** The queued/active plot job whose 4x4 area covers tile (col,row), if any.
   * Lets the cancel stroke resolve and preview the job a drag would un-queue
   * without touching the queue; cancelAtTile()/cancelObject() stay authoritative. */
  pendingPlotJobAt(col: number, row: number): { kind: JobKind; oc: number; or: number } | null {
    for (const job of this.active ? [this.active, ...this.queue] : this.queue) {
      if (job.kind === "walk" || job.kind === "harvestTree") continue;
      if (col >= job.oc && col < job.oc + PLOT && row >= job.or && row < job.or + PLOT)
        return { kind: job.kind, oc: job.oc, or: job.or };
    }
    return null;
  }

  // Plain move-to-point, serialized behind any queued work so it never hijacks the
  // farmer mid-job.
  enqueueWalk(x: number, y: number) {
    this.queue.push({
      kind: "walk", oc: -1, or: -1, cx: x, cy: y, queuedAt: Date.now(), diamond: null, bar: null,
    });
    this.onQueueChanged?.();
  }

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  /** Jobs the farmer still has to do (the active one included). Online, none of
   *  these has reached the server yet — the command is emitted when the farmer
   *  finishes the plot — so the sync badge counts them as work still waiting. */
  get pendingWork(): number {
    return (this.active ? 1 : 0) + this.queue.length;
  }

  /** Suspend/resume queued farmer work without cancelling it.
   *
   *  Resuming REPLAYS the paused interval through the same elapsed-time catch-up a
   *  backgrounded tab uses. An invasion hides the farm for two to four minutes, and
   *  before this the queue simply stood still through all of it: a player who lined up
   *  a field of plowing and then went raiding came back to a farmer standing exactly
   *  where they left them, having done nothing. The farm is never simulated DURING the
   *  battle — the raid owns the frame budget — it is caught up in one pass on the way
   *  out, and `advanceElapsed` stops the moment the queue drains, so the cost is the
   *  queue's own length rather than the time spent away.
   *
   *  Wall clock, not frame time, so a tab backgrounded mid-invasion still settles up. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return; // nested pauses must not restart the clock
    this.paused = paused;
    if (paused) {
      this.pausedAt = Date.now();
      return;
    }
    const since = this.pausedAt;
    this.pausedAt = null;
    if (since === null) return;
    // Silent: a queue that drains in one pass would otherwise fire every completion
    // one-shot at once, over the victory panel.
    this.advanceElapsed(Math.max(0, Date.now() - since) / 1000, true);
  }

  /** Persist action intent, not Pixi animation state. A partially-walked/worked
   * action safely restarts from its target and elapsed wall time replays it. */
  serializePending(): FarmJobQueueSave | undefined {
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    if (!jobs.length) return undefined;
    return {
      savedAt: Math.min(...jobs.map((job) => job.queuedAt)),
      jobs: jobs.map((job): FarmJobSave => ({
        kind: job.kind,
        oc: job.oc,
        or: job.or,
        cx: job.cx,
        cy: job.cy,
        queuedAt: job.queuedAt,
        cropKey: job.cfg?.key,
        objectId: job.objId,
      })),
    };
  }

  /** Restore a saved queue after the field and objects are hydrated. Invalid or
   * obsolete targets are dropped by the same validation used for fresh taps.
   *
   * Returns whether this call took responsibility for `save`. An unusable save is
   * consumed (there is nothing to retry), but a restore declined because the queue is
   * already busy returns false so an online caller can keep the journal parked and try
   * again once the live queue drains. */
  restorePending(
    save: FarmJobQueueSave | undefined,
    cropOf: (key: string) => CropConfig | undefined,
  ): boolean {
    if (!save || !Array.isArray(save.jobs)) return true;
    if (this.busy) return false;
    for (const job of save.jobs) {
      if (job.kind === "walk") this.enqueueWalk(job.cx, job.cy);
      else if (job.kind === "harvestTree" && job.objectId) {
        this.enqueueTreeHarvest(job.objectId, job.cx, job.cy);
      } else if (job.kind === "plant") {
        const crop = job.cropKey ? cropOf(job.cropKey) : undefined;
        if (crop) this.enqueue("plant", job.oc, job.or, crop);
      } else if (job.kind === "till" || job.kind === "harvest") {
        this.enqueue(job.kind, job.oc, job.or);
      }
    }
    const oldest = save.jobs.reduce(
      (value, job) => Number.isFinite(job.queuedAt) ? Math.min(value, job.queuedAt!) : value,
      Number.POSITIVE_INFINITY,
    );
    const savedAt = Number.isFinite(oldest) ? oldest
      : Number.isFinite(save.savedAt) ? save.savedAt : Date.now();
    this.advanceElapsed(Math.max(0, Date.now() - savedAt) / 1000, true);
    return true;
  }

  /** Advance farmer movement and queued work by real elapsed time.
   *
   * Browsers pause Pixi's requestAnimationFrame ticker in hidden/background
   * tabs. Main feeds this method time from a separate wall clock, allowing the
   * queue to catch up on the first background tick or when focus returns. Only
   * the farmer/job pipeline is stepped; raids, pets, particles, and other visual
   * systems remain paused. The loop exits once there is no useful work left, so
   * returning after hours with an empty/short queue is bounded by that queue's
   * actual duration rather than the time spent away.
   */
  advanceElapsed(elapsedSec: number, suppressAudio = false) {
    if (this.paused) return;
    let remaining = Number.isFinite(elapsedSec) ? Math.max(0, elapsedSec) : 0;
    const endAt = Date.now();
    let cursor = endAt - remaining * 1000;
    const prior = this.audioSuppressed;
    const priorReplayNow = this.replayNow;
    this.audioSuppressed ||= suppressAudio;
    try {
      while (remaining > 0 && (this.busy || this.walk.moving)) {
        // The queue is stalled on an unreachable server, so no amount of further time
        // moves it. Leave now rather than grinding out one no-op step per 50 ms of the
        // whole absence — an overnight tab would otherwise burn hundreds of thousands.
        if (!this.active && this.queue.length && this.mutationBlocked(this.queue[0].kind)) break;
        const step = Math.min(CATCH_UP_STEP_SEC, remaining);
        cursor += step * 1000;
        this.replayNow = cursor;
        this.update(step);

        // A job in its walking phase should always own a live WalkController
        // target. Avoid spinning through a very large elapsed interval if an
        // invalid/off-field destination ever slips into the queue.
        if (this.active && this.phase === "walk" && !this.walk.moving) break;

        this.walk.update(step);
        remaining -= step;
      }
    } finally {
      this.audioSuppressed = prior;
      this.replayNow = priorReplayNow;
    }
  }

  private audioSuppressed = false;
  private playSfx(name: Sfx) {
    if (!this.audioSuppressed) this.sfx(name);
  }

  // Cancel any queued/active job whose plot covers tile (col,row). Returns true if
  // something was un-queued (so the caller can skip its normal click action).
  cancelAtTile(col: number, row: number): boolean {
    const covers = (j: Job) =>
      j.kind !== "walk" && j.kind !== "harvestTree" &&
      col >= j.oc && col < j.oc + PLOT && row >= j.or && row < j.or + PLOT;
    let cancelled = false;
    this.queue = this.queue.filter((j) => {
      if (!covers(j)) return true;
      this.dropJob(j);
      cancelled = true;
      return false;
    });
    if (this.active && covers(this.active)) {
      this.walk.stop(); // farmer may be walking to it — halt
      if (this.phase === "work") this.actor.setWorking(false);
      this.dropJob(this.active);
      this.active = null;
      this.phase = null;
      cancelled = true;
    }
    if (cancelled) this.onQueueChanged?.();
    return cancelled;
  }

  // Cancel a queued/active fruit-tree harvest by object id. Mirrors plot
  // cancellation so tapping the highlighted tree removes its pending action.
  cancelObject(objId: string): boolean {
    let cancelled = false;
    this.queue = this.queue.filter((j) => {
      if (j.kind !== "harvestTree" || j.objId !== objId) return true;
      this.dropJob(j);
      cancelled = true;
      return false;
    });
    if (this.active?.kind === "harvestTree" && this.active.objId === objId) {
      this.walk.stop();
      if (this.phase === "work") this.actor.setWorking(false);
      this.dropJob(this.active);
      this.active = null;
      this.phase = null;
      cancelled = true;
    }
    if (cancelled) this.onQueueChanged?.();
    return cancelled;
  }

  // Tear down a job's markers/reservations (shared by finish + cancel).
  private dropJob(job: Job) {
    job.diamond?.destroy();
    job.bar?.cont.destroy();
    if (job.pendKey) this.pending.delete(job.pendKey);
    if (job.kind === "till") this.field.unreserveTill(job.oc, job.or);
  }

  update(dt: number) {
    if (this.paused) return;
    if (!this.active) {
      // Don't start work the server can't be told about — the head of the queue simply
      // waits for the command lane to come back. Checked HERE as well as at the payoff
      // so the farmer doesn't walk out and mime a plow that cannot land.
      if (this.queue.length && this.mutationBlocked(this.queue[0].kind)) return;
      const next = this.queue.shift();
      if (!next) return;
      this.active = next;
      this.phase = "walk";
      const walking = this.walk.goToPoint(next.cx, next.cy, () => {
        if (next.kind === "walk") {
          this.finish();
          return;
        }
        // Still walk to a queued zombie, but do not begin the work animation or
        // mutate the plot once both the active army and Mausoleum are full.
        if (next.kind === "harvest" && this.field.ripeZombieAt(next.oc, next.or) &&
            !this.hasZombieRoom()) {
          this.float(next.cx, next.cy, "Army full!");
          this.finish();
          return;
        }
        // Speed Monolith: farming is instant — apply on arrival, no hoe delay/bar.
        if (this.field.hasFastWork()) {
          // apply() emits the completion sound. Playing a separate start sound here
          // would overlap it because instant work has no delay between the two.
          if (this.apply(next)) this.finish();
          else this.hold();
          return;
        }
        // Fruit-tree harvest uses the harvest animation at 2x speed (half as long).
        const fast = next.kind === "harvestTree";
        this.phase = "work";
        this.workTotal = fast ? WORK_MS / 2 : WORK_MS;
        this.workMs = this.workTotal;
        this.actor.setWorking(true, fast ? 2 : 1);
        this.playSfx(fast ? "harvest" : (next.kind as JobKind)); // hoe sound
        next.bar = this.makeBar(fast ? "Harvest" : LABEL[next.kind as JobKind], next.cx, next.cy);
      });
      // A malformed/off-field destination must not leave this job active forever
      // and block every queued action behind its persistent green marker.
      if (!walking) this.finish();
    } else if (this.phase === "work") {
      this.workMs -= dt * 1000;
      const progress = Math.max(0, Math.min(1, 1 - this.workMs / this.workTotal));
      if (this.active.bar) this.active.bar.fill.scale.x = progress;
      if (this.workMs <= 0) {
        this.actor.setWorking(false);
        if (this.apply(this.active)) this.finish();
        else this.hold();
      }
    }
  }

  /** Put the active job back at the head of the queue, untouched, and stand down.
   *
   *  Used only when `apply` refused because the server is unreachable. The job keeps its
   *  plot reservation and its pending key, so nothing else can claim the plot and a fresh
   *  swipe over it still dedupes; only the walk/work animation is thrown away. The next
   *  `update` after the lane recovers re-walks it. */
  private hold() {
    if (!this.active) return;
    this.active.bar?.cont.destroy();
    this.active.bar = null;
    this.queue.unshift(this.active);
    this.active = null;
    this.phase = null;
    this.onQueueChanged?.();
  }

  /** Whether this job's outcome has to reach the server, and the server is currently
   *  unreachable. Online, the farm document is authoritative: applying locally while the
   *  command lane is paused produces work the server never hears about, which the next
   *  reconcile silently erases.
   *
   *  This used to be checked inside `apply` as a bare early return, and `update` finished
   *  the job either way — so every plot the farmer reached during a pause was quietly
   *  consumed. A player who drag-plowed a field and then lost the lane (a rate limit, a
   *  bad connection, a writer hand-off) got holes in it with no error anywhere, which is
   *  the "drag-plowing skips plots" report. Now the job WAITS. */
  private mutationBlocked(kind: Kind): boolean {
    if (kind === "walk") return false;
    const serverOwned = kind === "harvestTree" ? !!this.state.onTreeHarvest : !!this.state.onFarm;
    return serverOwned && !!this.state.canMutateOnline && !this.state.canMutateOnline();
  }

  /** Returns false when the job could not be applied because the server is unreachable,
   *  so the caller must put it back rather than finish it. Every other outcome —
   *  including a legitimate refusal like insufficient funds — returns true: the job was
   *  judged, and repeating it would only produce the same refusal forever. */
  private apply(job: Job): boolean {
    if (job.kind === "walk") return true;
    if (this.mutationBlocked(job.kind)) return false;
    if (job.kind === "harvestTree") {
      const treeName = job.objId ? this.field.objectDefOf(job.objId)?.name : undefined;
      const baseGold = job.objId ? this.field.harvestObject(job.objId) : null;
      if (baseGold) {
        const gold = this.state.farmerHarvestGold(baseGold);
        if (this.state.onTreeHarvest && job.objId) this.state.onTreeHarvest(job.objId, gold);
        else this.state.addGold(gold);
        this.state.recordTreeHarvest();
        if (treeName) this.quest.post(QuestEvent.CropHarvested, treeName);
        this.float(job.cx, job.cy, `+${gold}g`);
        this.playSfx("xp");
      }
      return true;
    }
    if (job.kind === "till") {
      const cost = this.plowCost(); // 0 with a Plowing Monolith
      const xp = plowXp(cost === 0);
      if (this.state.gold < cost) {
        this.onInsufficientFunds("gold", cost);
        return true;
      }
      if (this.state.gold >= cost && this.field.tillAt(job.oc, job.or)) {
        // ONLINE: the server owns the plow cost + XP and RECORDS the soil, which
        // a later plant requires. Charging locally would just reconcile away (a free
        // plow) and leave the server with no soil to plant on. OFFLINE: charge locally.
        if (this.state.onFarm) {
          this.state.onFarm({ type: "plow", oc: job.oc, or: job.or }, { gold: -cost, xp });
        } else {
          if (cost > 0) this.state.spendGold(cost);
          if (xp) this.state.addXp(xp);
        }
        this.float(job.cx, job.cy, cost > 0 ? `-${cost}g` : "Plowed!");
        if (xp) this.float(job.cx, job.cy, `+${xp}xp`, 0.42);
        this.playSfx(xp ? "xp" : "till");
        this.state.recordPlowed();
        this.onPlotPlowed(job.oc, job.or);
        this.quest.post(QuestEvent.SoilPlowed, "Plow");
        this.quest.post(QuestEvent.NewSoilPlowed, "Plow");
      }
    } else if (job.kind === "plant") {
      const baseCfg = job.cfg ?? CARROT;
      const cfg = baseCfg.isZombie
        ? { ...baseCfg, growMs: this.state.farmerZombieGrowMs(baseCfg.growMs) }
        : baseCfg;
      // Planting costs gold — or brains for special zombies (brainsNeeded); XP (and
      // sell value) are awarded on harvest, matching the source economy where the
      // crop's xp is its harvest reward.
      const funds = cfg.brainsNeeded ? this.state.brains : this.state.gold;
      if (funds < cfg.cost) {
        this.onInsufficientFunds(cfg.brainsNeeded ? "brains" : "gold", cfg.cost);
        return true;
      }
      // Zombie crops are now server-owned too (plant debits the cost, harvest yields a
      // verified unit), so they go through the server path like veggie crops.
      const online = !!this.state.onFarm;
      // The crop's clock. OFFLINE the elapsed-time replay is the farm's own truth, so a
      // planting the catch-up completes is stamped at the moment the farmer would have
      // reached it (the replay cursor). ONLINE the server is the truth and it stamps the
      // plant at the moment the command applies — which for a replayed journal is NOW.
      // Back-dating locally there made a field planted on the way out look half grown on
      // the way back in while the server had only just started every timer: the local
      // crop read ripe, the harvest came back `not_grown`, and the next resync snapped
      // every one of those plots back to a fresh timer.
      const plantedAt = online ? Date.now() : (this.replayNow ?? Date.now());
      if (funds >= cfg.cost && this.field.plantAt(job.oc, job.or, cfg, plantedAt)) {
        // Garden zombies fertilize a freshly-planted VEGGIE crop (zombie crops sell
        // for nothing, so they're never fertilized). A hit doubles the harvest.
        // The client owns the roll in both modes so its visual appears immediately.
        // Online play persists that result in the already-batched plant command.
        let fertilized = false;
        if (!cfg.isZombie) {
          const by = this.onCropPlanted(job.oc, job.or, cfg);
          fertilized = !!by;
          if (by) {
            this.float(job.cx, job.cy - 18, `Fertilized by ${by}!`);
          }
        }
        // ONLINE: the server prices the seed exactly and persists the client roll.
        // OFFLINE: charge locally as before.
        if (online) {
          // A zombie crop can cost BRAINS, so send the debit in the right currency.
          this.state.onFarm!(
            { type: "plant", oc: job.oc, or: job.or, cropKey: cfg.key, fertilized },
            cfg.brainsNeeded ? { brains: -cfg.cost } : { gold: -cfg.cost }
          );
          if (cfg.cost > 0) this.float(job.cx, job.cy, `-${cfg.cost}${cfg.brainsNeeded ? "b" : "g"}`);
        } else if (cfg.cost > 0) {
          if (cfg.brainsNeeded) this.state.spendBrains(cfg.cost);
          else this.state.spendGold(cfg.cost);
          this.float(job.cx, job.cy, `-${cfg.cost}${cfg.brainsNeeded ? "b" : "g"}`);
        }
        this.state.recordPlanted();
        this.quest.post(QuestEvent.CropPlanted, cfg.name);
        this.playSfx("place");
      }
    } else {
      // Last fence before the crop is destroyed. The arrival check ran a full work
      // phase ago, and the army/Mausoleum can fill inside it (a combine collected, a
      // reward claimed, a raid party returning, an online reconcile). harvestAt clears
      // the plot unconditionally, so harvesting here with nowhere to put the unit
      // would delete a grown zombie outright rather than merely refusing it.
      if (this.field.ripeZombieAt(job.oc, job.or) && !this.hasZombieRoom()) {
        this.float(job.cx, job.cy, "Army full!");
        return true;
      }
      const r = this.field.harvestAt(job.oc, job.or);
      if (r) {
        this.onHarvestFx(r, job.cx, job.cy);
        if (!r.zombieKey) r.sell = this.state.farmerHarvestGold(r.sell);
        const xp = harvestXp(r.xp, this.field.hasPlowFree());
        const online = !!this.state.onFarm;
        // Spawn the harvested zombie FIRST (if any) so an online harvest can hand the
        // server the exact verified unit id it should record. spawnVerified suppresses
        // the generic onGrant — the server grants the unit via this farm harvest instead.
        const spawned = r.zombieKey
          ? this.onZombieHarvest(r.zombieKey, job.oc, job.or, r.mutationContext!)
          : null;

        if (r.zombieKey) {
          // Zombie crop: ONLINE the server grow-gates + grants the verified unit + xp
          // (no gold). Offline (or if the army was full so nothing spawned) credit xp.
          if (online && spawned) {
            this.state.onFarm!({ type: "harvest", oc: job.oc, or: job.or, unitId: spawned.id }, { xp });
          } else {
            this.state.addXp(xp);
          }
        } else if (online) {
          // Veggie crop: the server credits the EXACT sell + xp, grow-gated by its clock.
          this.state.onFarm!({ type: "harvest", oc: job.oc, or: job.or }, { gold: r.sell, xp });
        } else {
          if (r.sell) this.state.addGold(r.sell);
          this.state.addXp(xp);
        }
        // Always report veggie harvests: the Boss Token roll happens now, in both
        // modes, so the token pops out of the crop that produced it.
        const bossToken = !r.isZombie
          && this.onCropHarvested({ key: r.key, growMs: r.growMs, value: r.sell }, job.cx, job.cy);
        // Zombie crops pay no gold — they yield an owned zombie unit instead.
        if (r.zombieKey) {
          this.float(job.cx, job.cy, `+${xp}xp`);
        } else {
          this.float(job.cx, job.cy, `+${r.sell}g${r.fertilized ? " ×2" : ""}`);
          if (xp) this.float(job.cx, job.cy, `+${xp}xp`, 0.42);
          if (bossToken) this.float(job.cx, job.cy, "+1 Boss Token!", xp ? 0.84 : 0.42);
        }
        this.state.recordHarvest(r.key, !!r.zombieKey);
        // A harvested zombie "resurrects"; a plain crop gives the reward chime.
        this.playSfx(r.isZombie ? "harvestZombie" : "xp");
        this.quest.post(
          r.isZombie ? QuestEvent.ZombieHarvested : QuestEvent.CropHarvested,
          r.name,
          1,
          spawned?.subjectAliases
        );
      }
    }
    return true;
  }

  private finish() {
    if (this.active) this.dropJob(this.active);
    this.active = null;
    this.phase = null;
    this.onQueueChanged?.();
  }

  // Green plot diamond marking a queued/working plot (under the farmer).
  private makeDiamond(cx: number, cy: number, tiles = PLOT, plow = false): Graphics {
    const w = tiles * HW;
    const h = tiles * HH;
    const g = new Graphics();
    g.moveTo(0, -h).lineTo(w, 0).lineTo(0, h).lineTo(-w, 0).lineTo(0, -h)
      .fill({ color: 0x8df25a, alpha: 0.28 })
      .stroke({ width: 3, color: 0x8df25a, alpha: 0.95 });
    g.position.set(cx, cy);
    (plow ? this.field.plowHighlightLayer : this.field.highlightLayer).addChild(g);
    return g;
  }

  // Progress bar under the plot being worked: dark empty track + a green fill that
  // grows from the left (fill.scale.x driven 0 -> 1 by the work timer), with a white
  // task label (Plow / Plant / Harvest) centered on it.
  private makeBar(labelText: string, cx: number, cy: number): Bar {
    const cont = new Container();
    const bg = new Graphics();
    bg.roundRect(-BAR_W / 2, -BAR_H / 2, BAR_W, BAR_H, 3)
      .fill({ color: 0x1a1a24, alpha: 0.9 })
      .stroke({ width: 2, color: 0x05050a, alpha: 1 });
    const fill = new Graphics();
    fill.roundRect(0, 0, BAR_W - 2 * BAR_PAD, BAR_H - 2 * BAR_PAD, 2)
      .fill({ color: 0x5fd83a });
    fill.position.set(-BAR_W / 2 + BAR_PAD, -BAR_H / 2 + BAR_PAD);
    fill.scale.x = 0; // starts empty
    const label = new Text({
      text: labelText,
      style: {
        fontFamily: "system-ui, sans-serif", fontSize: 15, fontWeight: "700",
        fill: 0xffffff, stroke: { color: 0x0a1406, width: 3 },
      },
    });
    label.anchor.set(0.5, 0.5);
    cont.addChild(bg, fill, label); // label on top of the fill
    cont.position.set(cx, cy + PLOT * HH * 0.5); // just under the worked plot
    this.field.labelLayer.addChild(cont);
    return { cont, fill };
  }
}
