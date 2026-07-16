// The quest engine. Data-driven from quests.json: each quest has AND'd requirements,
// each requirement counts a game notification up to its target. Completing every
// requirement dispatches the quest's reward and unlocks any quest gated behind it.
//
// Quests activate when their prerequisite is complete AND the player meets the level
// gate. All 96 quests load; the farm loop, raids/invasions (loot/perfect/success),
// and the Zombie Pot combiner have live emitters (see LIVE_EVENTS below). Quests
// gated on still-unsupported categories (social, photo/camera, Epic Boss) simply
// never advance — dormant, not broken.
import { GameState } from "../GameState";
import { QuestBus, QuestEvent } from "./events";
import { QuestDef, QuestView, RewardType } from "./types";
import { QuestSave } from "../save/schema";

// Notification IDs that have live emitters. A quest only auto-activates once one of
// its requirements listens to a live event, so quests whose trigger events aren't
// emitted stay off the rail. Covered: the farm loop, raids/invasions (RaidManager
// wins → loot / perfect-game / success), and the Zombie Pot combiner.
// Intentionally NOT covered: social quests (kSocialManager* — the online friends
// system exists, but these quest events aren't wired to it yet), camera/photo
// (kPhotoTaken — excluded), and the Epic Boss system (unbuilt).
const LIVE_EVENTS = new Set<string>([
  // farm loop
  QuestEvent.SoilPlowed, QuestEvent.NewSoilPlowed, QuestEvent.CropPlanted,
  QuestEvent.CropHarvested, QuestEvent.ZombieHarvested, QuestEvent.ItemBought,
  // raids / invasions
  QuestEvent.InvasionSuccessful, QuestEvent.InvasionPerfectGame, QuestEvent.LootItemWon,
  // mutation combiner (Zombie Pot)
  QuestEvent.CombinerCombined, QuestEvent.CombinerHarvested,
  // Epic Boss events are additionally gated by setEpicBossActive().
  QuestEvent.EpicStageEnemyDefeated, QuestEvent.EpicBossEpicItemWon,
]);
const DR_GROUNDHOG_QUESTS = new Set(["1000", "1001", "1002", "1003", "1010", "1011"]);

// There is NO cap on how many quests are active: every quest whose prerequisite is
// complete, level gate is met, and trigger event is live becomes active at once.
// The prerequisite chains still pace what becomes AVAILABLE (you can't start a quest
// before its predecessor), and the opening tutorial reveals one at a time because
// each step gates the next. The HUD shows a handful on the rail and all of them in
// the quest log — the display limit is a HUD concern, not an activation cap.

export interface QuestHooks {
  /** Online mode: local notifications are presentation-only; server command events
   * are the sole source of progress and rewards. */
  authoritative?: boolean;
  /** Claim a completed quest's reward EXTERNALLY (online: the server grants the
   *  currency authoritatively + any level-up it triggers). Return true if handled —
   *  the local currency add is then skipped so it isn't double-counted / rejected by
   *  the spend-only economy endpoint. Item/zombie rewards are still granted locally
   *  regardless (the server records but defers them). Absent / returns false → grant
   *  currency locally as before (offline / local-only play). */
  grantReward?: (def: QuestDef) => boolean;
  /** Grant a reward item (rewardType 3) — e.g. into storage/received. */
  grantItem: (key: string) => void;
  /** Grant a reward zombie unit (rewardType 5). */
  grantZombie: (key: string) => void;
  /** A quest just completed (reward already dispatched): celebrate it with the
   *  completion popup. main owns the icon/label lookups off the def. */
  completed: (def: QuestDef) => void;
  /** Push the current active-quest views to the HUD rail. */
  render: (views: QuestView[]) => void;
}

export class QuestSystem {
  private active = new Map<string, number[]>(); // quest id -> count per requirement
  private completed = new Set<string>();
  private epicBossActive = false;

  constructor(
    private defs: Map<string, QuestDef>,
    private state: GameState,
    bus: QuestBus,
    private hooks: QuestHooks
  ) {
    bus.subscribe((nid, object, n) => this.onEvent(nid, object, n));
    // Leveling up can satisfy a level gate, so re-check activation on state change.
    this.state.onChange(() => {
      if (this.tryActivate()) this.hooks.render(this.views());
    });
  }

  /** Whether a quest is currently eligible to take an active slot. */
  private eligible(id: string): boolean {
    const def = this.defs.get(id);
    if (!def || this.completed.has(id) || this.active.has(id)) return false;
    // Seasonal (date-gated) and epic-event quests are driven by their own systems,
    // not the normal progression rail.
    if (def.seasonal || (def.epicEvent && (!this.epicBossActive || !DR_GROUNDHOG_QUESTS.has(id)))) return false;
    // Prerequisite must be finished, and the level gate met.
    if (def.prerequisiteQuest >= 0 && !this.completed.has(String(def.prerequisiteQuest))) return false;
    if (def.levelRequired >= 0 && this.state.level < def.levelRequired) return false;
    // Only surface quests the player can actually make progress on right now, so a
    // dormant quest (e.g. a raid quest before raids exist) never occupies a slot.
    return this.actionable(id);
  }

  /** Activate every currently-eligible quest (no cap). Returns true if anything
   *  newly activated. Eligibility (prerequisite complete, level met, actionable)
   *  is static within a pass, so one sweep over all defs suffices; completing a
   *  quest calls this again to pick up newly-unlocked successors. */
  private tryActivate(): boolean {
    let changed = false;
    for (const id of this.defs.keys()) {
      if (!this.eligible(id)) continue;
      this.active.set(id, new Array(this.defs.get(id)!.requirements.length).fill(0));
      changed = true;
    }
    return changed;
  }

  private onEvent(nid: string, object: string, n: number) {
    if (this.hooks.authoritative) return;
    let dirty = false;
    const finished: string[] = [];
    for (const [id, counts] of this.active) {
      const def = this.defs.get(id);
      if (!def) continue;
      if (def.epicEvent && !this.epicBossActive) continue;
      let advanced = false;
      def.requirements.forEach((r, i) => {
        if (counts[i] >= r.countTotal) return;
        if (r.notificationID !== nid) return;
        // "" object = match any subject; otherwise require an exact (case-insensitive) name.
        if (r.notificationObject && r.notificationObject.toLowerCase() !== object.toLowerCase()) return;
        counts[i] = Math.min(r.countTotal, counts[i] + n);
        advanced = true;
      });
      if (advanced) {
        dirty = true;
        if (def.requirements.every((r, i) => counts[i] >= r.countTotal)) finished.push(id);
      }
    }
    // Complete after the loop so we don't mutate `active` mid-iteration.
    for (const id of finished) this.complete(id);
    if (dirty || finished.length) this.hooks.render(this.views());
  }

  private complete(id: string) {
    const def = this.defs.get(id);
    if (!def || this.completed.has(id)) return;
    this.active.delete(id);
    this.completed.add(id);
    this.dispatchReward(def);
    this.hooks.completed(def); // celebrate with the completion popup
    this.tryActivate(); // a completed prerequisite may unlock the next quest(s)
  }

  private dispatchReward(def: QuestDef) {
    // Online, the server grants the currency (and any level-up) authoritatively; the
    // local add is then skipped so it isn't double-counted or bounced by the spend-only
    // economy endpoint. Item/zombie rewards are always granted locally (server defers).
    const handled = this.hooks.grantReward?.(def) ?? false;
    switch (def.rewardType) {
      case RewardType.Gold:
        if (!handled && def.rewardValue) this.state.addGold(def.rewardValue);
        break;
      case RewardType.Xp:
        if (!handled && def.rewardValue) this.state.addXp(def.rewardValue);
        break;
      case RewardType.Brains:
        if (!handled && def.rewardValue) this.state.addBrains(def.rewardValue);
        break;
      case RewardType.Item:
        if (def.rewardItemKey) this.hooks.grantItem(def.rewardItemKey);
        break;
      case RewardType.Zombie:
        if (def.rewardItemKey) this.hooks.grantZombie(def.rewardItemKey);
        break;
    }
  }

  /** True if any requirement listens to an event that currently has an emitter. */
  private actionable(id: string): boolean {
    const def = this.defs.get(id);
    return !!def && def.requirements.some((r) => LIVE_EVENTS.has(r.notificationID));
  }

  /** Current active quests as HUD views, actionable (playable) ones first. */
  views(): QuestView[] {
    const out: QuestView[] = [];
    for (const [id, counts] of this.active) {
      const def = this.defs.get(id);
      if (!def) continue;
      if (def.epicEvent && !this.epicBossActive) continue;
      out.push({
        id,
        title: def.title,
        icon: def.sprite,
        tip: def.tip,
        objectives: def.requirements.map((r, i) => ({
          text: r.text,
          count: counts[i],
          total: r.countTotal,
          done: counts[i] >= r.countTotal,
        })),
      });
    }
    out.sort((a, b) =>
      (this.actionable(b.id) ? 1 : 0) - (this.actionable(a.id) ? 1 : 0) ||
      Number(a.id) - Number(b.id)
    );
    return out;
  }

  get completedCount(): number {
    return this.completed.size;
  }

  /** Surface/pause Epic Boss quests without discarding their lifetime progress. */
  setEpicBossActive(active: boolean) {
    if (this.epicBossActive === active) return;
    this.epicBossActive = active;
    if (active) this.tryActivate();
    this.hooks.render(this.views());
  }

  // ---- persistence ----
  serialize(): QuestSave {
    return {
      active: [...this.active].map(([id, counts]) => ({ id, counts })),
      completed: [...this.completed],
    };
  }

  /** Restore from a save (or start fresh), then activate eligible quests + render. */
  restore(save?: QuestSave) {
    if (save) {
      this.completed = new Set(save.completed);
      this.active = new Map();
      // Epic quests remain stored while an event is inactive so lifetime progress
      // survives expiration and later paid activations; views/events hide them until
      // setEpicBossActive(true).
      for (const a of save.active) {
        const savedDef = this.defs.get(a.id);
        if (savedDef?.epicEvent && DR_GROUNDHOG_QUESTS.has(a.id) && !this.completed.has(a.id)) {
          const counts = a.counts.length === savedDef.requirements.length
            ? a.counts.slice()
            : new Array(savedDef.requirements.length).fill(0);
          this.active.set(a.id, counts);
          continue;
        }
        if (!this.eligible(a.id)) continue; // active is empty here, so eligible() is valid
        const def = this.defs.get(a.id)!;
        const counts =
          a.counts.length === def.requirements.length
            ? a.counts.slice()
            : new Array(def.requirements.length).fill(0);
        this.active.set(a.id, counts);
      }
    }
    this.tryActivate();
    this.hooks.render(this.views());
  }

  /** Merge the server's paid-completion ledger into local quest presentation. Local
   * progress stays responsive and survives reloads; older server counts can only move
   * a requirement forward, never backward. */
  restoreAuthoritative(state: {
    completed: string[];
    progress: { questId: string; counts: number[] }[];
  }): void {
    const localCompleted = new Set(this.completed);
    const localActive = new Map([...this.active].map(([id, counts]) => [id, counts.slice()]));
    this.completed = new Set([
      ...[...localCompleted].filter((id) => this.defs.has(id)),
      ...state.completed.filter((id) => this.defs.has(id)),
    ]);
    this.active = new Map();
    const supplied = new Map(state.progress.map((p) => [p.questId, p.counts]));
    for (const [id, def] of this.defs) {
      const remote = supplied.get(id) ?? [];
      const local = localActive.get(id) ?? [];
      const pausedEpic = def.epicEvent && DR_GROUNDHOG_QUESTS.has(id) && !this.completed.has(id) && (remote.length > 0 || local.length > 0);
      if (!pausedEpic && !this.eligible(id)) continue;
      this.active.set(
        id,
        def.requirements.map((r, i) => {
          const remoteCount = Number.isInteger(remote[i]) ? remote[i] : 0;
          const localCount = Number.isInteger(local[i]) ? local[i] : 0;
          const n = Math.max(remoteCount, localCount);
          return Math.max(0, Math.min(r.countTotal, n));
        })
      );
    }
    this.tryActivate();
    this.hooks.render(this.views());
  }

  /** Apply the progress delta returned with the trusted command that caused it. */
  applyAuthoritativeChanges(changes: { questId: string; counts: number[]; completed: boolean }[]): void {
    for (const change of changes) {
      const def = this.defs.get(change.questId);
      if (!def) continue;
      const wasCompleted = this.completed.has(change.questId);
      if (change.completed) {
        this.active.delete(change.questId);
        this.completed.add(change.questId);
        if (!wasCompleted) this.hooks.completed(def);
      } else if (!this.completed.has(change.questId)) {
        this.active.set(
          change.questId,
          def.requirements.map((r, i) => Math.max(0, Math.min(r.countTotal, change.counts[i] ?? 0)))
        );
      }
    }
    this.tryActivate();
    this.hooks.render(this.views());
  }
}
