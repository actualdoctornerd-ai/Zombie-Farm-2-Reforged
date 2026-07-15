// A queue of farm jobs the farmer works one at a time. Tapping a plot with a tool
// (or a ripe crop in select mode) enqueues a job: the target plot stays highlighted
// green while queued; when the farmer reaches it and starts hoeing, a progress bar
// appears under that plot and fills green, then the action applies and the marker
// clears. Queue is FIFO so you can line up several actions at once.
import { Container, Graphics, Text } from "pixi.js";
import { CARROT, CropConfig, Field, PLOT } from "./Field";
import { Actor } from "./Actor";
import { WalkController } from "./WalkController";
import { GameState } from "./GameState";
import { HH, HW, TILE_W } from "./iso";
import { QuestBus, QuestEvent } from "./quest/events";
import { Sfx } from "./audio";

export type JobKind = "till" | "plant" | "harvest";
// "harvestTree" = harvest a placed fruit tree (uses the harvest animation, 2x fast).
type Kind = JobKind | "walk" | "harvestTree";

const WORK_MS = 1250; // ~1.25s of hoeing per plot
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
  diamond: Graphics | null; // green plot highlight while queued/working
  bar: Bar | null; // progress bar, created only while being worked
  cfg?: CropConfig; // what to plant (plant jobs only)
  objId?: string; // target object (harvestTree jobs only)
  pendKey?: string; // this job's dedupe key in `pending`
}

export class JobSystem {
  private queue: Job[] = [];
  private active: Job | null = null;
  private phase: "walk" | "work" | null = null;
  private workMs = 0;
  private workTotal = WORK_MS; // duration of the active job's work phase
  private pending = new Set<string>(); // dedupe key "kind:bc,br"

  constructor(
    private field: Field,
    private actor: Actor,
    private walk: WalkController,
    private state: GameState,
    private float: (x: number, y: number, msg: string) => void,
    private sfx: (name: Sfx) => void = () => {},
    // Fired when a zombie crop is harvested, to grow an owned zombie at its plot.
    // Returns the spawned unit's id (so an online harvest can tell the server which
    // verified unit the crop yielded), or null if nothing was spawned.
    private onZombieHarvest: (key: string, oc: number, or: number) => string | null = () => null,
    // Quest event bus: plow/plant/harvest post notifications that advance quests.
    private quest: QuestBus = new QuestBus(),
    // Fired after a veggie crop is planted, to let Garden zombies roll to fertilize
    // it. Returns the fertilizing zombie's name (for a toast) or null.
    private onCropPlanted: (oc: number, or: number, cfg: CropConfig) => string | null = () => null,
    // Carries the exact free-placement origin into the tutorial's next beat.
    private onPlotPlowed: (oc: number, or: number) => void = () => {}
  ) {}

  private key(kind: JobKind, oc: number, or: number) {
    return `${kind}:${oc},${or}`;
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
    if (kind === "till" && this.state.gold < this.plowCost()) return false;
    if (kind === "plant" && cfg) {
      if (this.state.level < cfg.unlockLevel) return false; // not unlocked yet
      const funds = cfg.brainsNeeded ? this.state.brains : this.state.gold;
      if (funds < cfg.cost) return false;
    }

    if (kind === "till") this.field.reserveTill(oc, or); // hold the area while queued
    const c = this.field.plotCenterOf(oc, or);
    const diamond = this.makeDiamond(c.x, c.y);
    this.queue.push({ kind, oc, or, cx: c.x, cy: c.y, diamond, bar: null, cfg, pendKey: k });
    this.pending.add(k);
    return true;
  }

  // Queue harvesting a ready fruit tree: the farmer walks to it and hoes (fast).
  enqueueTreeHarvest(objId: string, x: number, y: number): boolean {
    const k = `tree:${objId}`;
    if (this.pending.has(k)) return false;
    const area = this.field.objectHighlightArea(objId);
    const diamond = area ? this.makeDiamond(area.x, area.y, area.tiles) : null;
    this.queue.push({ kind: "harvestTree", oc: -1, or: -1, cx: x, cy: y, diamond, bar: null, objId, pendKey: k });
    this.pending.add(k);
    return true;
  }

  // Plain move-to-point, serialized behind any queued work so it never hijacks the
  // farmer mid-job.
  enqueueWalk(x: number, y: number) {
    this.queue.push({ kind: "walk", oc: -1, or: -1, cx: x, cy: y, diamond: null, bar: null });
  }

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
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
    if (!this.active) {
      const next = this.queue.shift();
      if (!next) return;
      this.active = next;
      this.phase = "walk";
      this.walk.goToPoint(next.cx, next.cy, () => {
        if (next.kind === "walk") {
          this.finish();
          return;
        }
        // Speed Monolith: farming is instant — apply on arrival, no hoe delay/bar.
        if (this.field.hasFastWork()) {
          this.sfx(next.kind === "harvestTree" ? "harvest" : (next.kind as JobKind));
          this.apply(next);
          this.finish();
          return;
        }
        // Fruit-tree harvest uses the harvest animation at 2x speed (half as long).
        const fast = next.kind === "harvestTree";
        this.phase = "work";
        this.workTotal = fast ? WORK_MS / 2 : WORK_MS;
        this.workMs = this.workTotal;
        this.actor.setWorking(true, fast ? 2 : 1);
        this.sfx(fast ? "harvest" : (next.kind as JobKind)); // hoe sound
        next.bar = this.makeBar(fast ? "Harvest" : LABEL[next.kind as JobKind], next.cx, next.cy);
      });
    } else if (this.phase === "work") {
      this.workMs -= dt * 1000;
      const progress = Math.max(0, Math.min(1, 1 - this.workMs / this.workTotal));
      if (this.active.bar) this.active.bar.fill.scale.x = progress;
      if (this.workMs <= 0) {
        this.actor.setWorking(false);
        this.apply(this.active);
        this.finish();
      }
    }
  }

  private apply(job: Job) {
    if (job.kind === "walk") return;
    if (job.kind === "harvestTree") {
      const treeName = job.objId ? this.field.objectDefOf(job.objId)?.name : undefined;
      const gold = job.objId ? this.field.harvestObject(job.objId) : null;
      if (gold) {
        if (this.state.onTreeHarvest && job.objId) this.state.onTreeHarvest(job.objId, gold);
        else this.state.addGold(gold);
        if (treeName) this.quest.post(QuestEvent.CropHarvested, treeName);
        this.float(job.cx, job.cy, `+${gold}g`);
        this.sfx("xp");
      }
      return;
    }
    if (job.kind === "till") {
      const cost = this.plowCost(); // 0 with a Plowing Monolith
      if (this.state.gold >= cost && this.field.tillAt(job.oc, job.or)) {
        // ONLINE: the server owns the plow cost + the +1 xp and RECORDS the soil, which
        // a later plant requires. Charging locally would just reconcile away (a free
        // plow) and leave the server with no soil to plant on. OFFLINE: charge locally.
        if (this.state.onFarm) {
          this.state.onFarm({ type: "plow", oc: job.oc, or: job.or }, { gold: -cost, xp: 1 });
        } else {
          if (cost > 0) this.state.spendGold(cost);
          this.state.addXp(1);
        }
        this.float(job.cx, job.cy, cost > 0 ? `-${cost}g  +1xp` : `+1xp`);
        this.sfx("xp");
        this.onPlotPlowed(job.oc, job.or);
        this.quest.post(QuestEvent.SoilPlowed, "Plow");
        this.quest.post(QuestEvent.NewSoilPlowed, "Plow");
      }
    } else if (job.kind === "plant") {
      const cfg = job.cfg ?? CARROT;
      // Planting costs gold — or brains for special zombies (brainsNeeded); XP (and
      // sell value) are awarded on harvest, matching the source economy where the
      // crop's xp is its harvest reward.
      const funds = cfg.brainsNeeded ? this.state.brains : this.state.gold;
      if (funds >= cfg.cost && this.field.plantAt(job.oc, job.or, cfg)) {
        // Zombie crops are now server-owned too (plant debits the cost, harvest yields a
        // verified unit), so they go through the server path like veggie crops.
        const online = !!this.state.onFarm;
        // Garden zombies fertilize a freshly-planted VEGGIE crop (zombie crops sell
        // for nothing, so they're never fertilized). A hit doubles the harvest.
        // OFFLINE: the client owns the roll + its visual. ONLINE: the SERVER owns the
        // fertilize roll (a client can't force it); the crop's fertilized visual is
        // applied when the plant flushes and the server reports its decision (main.ts
        // wires economy.onCropFertilized → field.markFertilized).
        if (!cfg.isZombie && !online) {
          const by = this.onCropPlanted(job.oc, job.or, cfg);
          if (by) {
            this.float(job.cx, job.cy - 18, `Fertilized by ${by}!`);
            this.sfx("place");
          }
        }
        // ONLINE veggie crop: the server prices the seed cost exactly (net/economy →
        // /farm/actions) and decides fertilization. Otherwise (offline, or a brains-cost
        // zombie crop the server doesn't model) charge locally as before.
        if (online) {
          // The server prices the seed cost exactly + (veggie) decides fertilization.
          // A zombie crop can cost BRAINS, so send the debit in the right currency.
          this.state.onFarm!(
            { type: "plant", oc: job.oc, or: job.or, cropKey: cfg.key },
            cfg.brainsNeeded ? { brains: -cfg.cost } : { gold: -cfg.cost }
          );
          if (cfg.cost > 0) this.float(job.cx, job.cy, `-${cfg.cost}${cfg.brainsNeeded ? "b" : "g"}`);
        } else if (cfg.cost > 0) {
          if (cfg.brainsNeeded) this.state.spendBrains(cfg.cost);
          else this.state.spendGold(cfg.cost);
          this.float(job.cx, job.cy, `-${cfg.cost}${cfg.brainsNeeded ? "b" : "g"}`);
        }
        this.quest.post(QuestEvent.CropPlanted, cfg.name);
      }
    } else {
      const r = this.field.harvestAt(job.oc, job.or);
      if (r) {
        const online = !!this.state.onFarm;
        // Spawn the harvested zombie FIRST (if any) so an online harvest can hand the
        // server the exact verified unit id it should record. spawnVerified suppresses
        // the generic onGrant — the server grants the unit via this farm harvest instead.
        const unitId = r.zombieKey ? this.onZombieHarvest(r.zombieKey, job.oc, job.or) : null;

        if (r.zombieKey) {
          // Zombie crop: ONLINE the server grow-gates + grants the verified unit + xp
          // (no gold). Offline (or if the army was full so nothing spawned) credit xp.
          if (online && unitId) {
            this.state.onFarm!({ type: "harvest", oc: job.oc, or: job.or, unitId }, { xp: r.xp });
          } else {
            this.state.addXp(r.xp);
          }
        } else if (online) {
          // Veggie crop: the server credits the EXACT sell + xp, grow-gated by its clock.
          this.state.onFarm!({ type: "harvest", oc: job.oc, or: job.or }, { gold: r.sell, xp: r.xp });
        } else {
          if (r.sell) this.state.addGold(r.sell);
          this.state.addXp(r.xp);
        }
        // Zombie crops pay no gold — they yield an owned zombie unit instead.
        const msg = r.zombieKey
          ? `+${r.xp}xp`
          : `+${r.sell}g${r.fertilized ? " ×2" : ""}  +${r.xp}xp`;
        this.float(job.cx, job.cy, msg);
        // A harvested zombie "resurrects"; a plain crop gives the reward chime.
        this.sfx(r.isZombie ? "harvestZombie" : "xp");
        this.quest.post(
          r.isZombie ? QuestEvent.ZombieHarvested : QuestEvent.CropHarvested,
          r.name
        );
      }
    }
  }

  private finish() {
    if (this.active) this.dropJob(this.active);
    this.active = null;
    this.phase = null;
  }

  // Green plot diamond marking a queued/working plot (under the farmer).
  private makeDiamond(cx: number, cy: number, tiles = PLOT): Graphics {
    const w = tiles * HW;
    const h = tiles * HH;
    const g = new Graphics();
    g.moveTo(0, -h).lineTo(w, 0).lineTo(0, h).lineTo(-w, 0).lineTo(0, -h)
      .fill({ color: 0x8df25a, alpha: 0.28 })
      .stroke({ width: 3, color: 0x8df25a, alpha: 0.95 });
    g.position.set(cx, cy);
    this.field.highlightLayer.addChild(g);
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
