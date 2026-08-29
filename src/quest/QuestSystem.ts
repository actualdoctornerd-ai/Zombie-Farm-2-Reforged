// The quest engine. Data-driven from quests.json: each quest has AND'd requirements,
// each requirement counts a game notification up to its target. Completing every
// requirement dispatches the quest's reward and unlocks any quest gated behind it.
//
// Quests activate when their prerequisite is complete AND the player meets the level
// gate. All 123 shipped quest records load (106 recovered from Quests.plist via quests.json,
// plus 17 Reforged-original ones from quests_reforged.json — assets.ts merges the two into one
// map, ids disjoint by construction); the farm loop, raids/invasions (loot/perfect/success),
// and the Zombie Pot combiner have live emitters (see LIVE_EVENTS below). Quests
// gated on still-unsupported categories (social and photo/camera) simply never
// advance — dormant, not broken. Epic quests are selected per active boss event.
import { GameState } from "../GameState";
import { QuestBus, QuestEvent } from "./events";
import { QuestDef, QuestView, RewardType, questBonusRewardInfo, questRewardInfo } from "./types";
import { QuestSave } from "../save/schema";
import { questSubjectMatches } from "./matching";

// Notification IDs that have live emitters. A quest only auto-activates once one of
// its requirements listens to a live event, so quests whose trigger events aren't
// emitted stay off the rail. Covered: the farm loop, raids/invasions (RaidManager
// wins → loot / perfect-game / success), and the Zombie Pot combiner.
// Intentionally NOT covered: social quests (kSocialManager* — the online friends
// system exists, but these quest events aren't wired to it yet), camera/photo
// (kPhotoTaken — excluded).
const LIVE_EVENTS = new Set<string>([
  // farm loop
  QuestEvent.SoilPlowed, QuestEvent.NewSoilPlowed, QuestEvent.CropPlanted,
  QuestEvent.CropHarvested, QuestEvent.ZombieHarvested, QuestEvent.ItemBought,
  // raids / invasions
  QuestEvent.InvasionSuccessful, QuestEvent.InvasionPerfectGame, QuestEvent.LootItemWon,
  // elite invasions + combat technique (derived from the fight's RaidFeats)
  QuestEvent.EliteInvasionSuccessful, QuestEvent.ElitePerfectGame,
  QuestEvent.EnemyDefeatedByAbility, QuestEvent.BossDefeatedByAbility,
  QuestEvent.ZombieResurrected,
  // mutation combiner (Zombie Pot)
  QuestEvent.CombinerCombined, QuestEvent.CombinerHarvested, QuestEvent.CombinerCollected,
  // Epic Boss events are additionally gated by setEpicBossActive().
  QuestEvent.EpicStageEnemyDefeated, QuestEvent.EpicBossEpicItemWon,
]);

// There is NO cap on how many quests are active: every quest whose prerequisite is
// complete, level gate is met, and trigger event is live becomes active at once.
// The prerequisite chains still pace what becomes AVAILABLE (you can't start a quest
// before its predecessor), and the opening tutorial reveals one at a time because
// each step gates the next. The HUD shows a handful on the rail and all of them in
// the quest log — the display limit is a HUD concern, not an activation cap.

export interface QuestHooks {
  /** Online mode: local notifications update an optimistic presentation layer;
   * server command events remain the sole durable source of progress and rewards. */
  authoritative?: boolean;
  /** Claim a completed quest's reward EXTERNALLY (online: the server grants it
   *  authoritatively — currency + any level-up it triggers, items into the
   *  authoritative inventory/Received, epic zombie rewards via the epic-boss result).
   *  Return true if handled and NO local grant of any kind happens. Absent / returns
   *  false → grant everything locally (offline / local-only play). */
  grantReward?: (def: QuestDef) => boolean;
  /** Grant a reward item (rewardType 3) — e.g. into storage/received. */
  grantItem: (key: string) => void;
  /** Grant a reward zombie unit (rewardType 5). */
  grantZombie: (key: string) => void;
  /** Celebrate a displayed completion. Offline rewards have already been dispatched;
   * online presentation is optimistic and the server grants the durable reward. */
  completed: (def: QuestDef) => void;
  /** Online mode: a local event predicts that an objective may now be complete.
   * Flush the authoritative command lane promptly so its optimistic celebration is
   * confirmed (or rolled back) without waiting for the normal batch window. */
  requestAuthoritativeCompletionCheck?: () => void;
  /** Push the current active-quest views to the HUD rail. */
  render: (views: QuestView[]) => void;
}

export class QuestSystem {
  private active = new Map<string, number[]>(); // quest id -> count per requirement
  private completed = new Set<string>();
  private epicBossActive = false;
  private epicBossQuestIds = new Set<string>();
  private authoritativePreview = new Map<string, number[]>();
  private optimisticallyCelebrated = new Set<string>();
  private authoritativeCompletionRequested = new Set<string>();

  constructor(
    private defs: Map<string, QuestDef>,
    private state: GameState,
    bus: QuestBus,
    private hooks: QuestHooks
  ) {
    bus.subscribe((nid, object, n, aliases) => this.onEvent(nid, object, n, aliases));
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
    if (def.seasonal || (def.epicEvent && (!this.epicBossActive || !this.epicBossQuestIds.has(id)))) return false;
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

  private onEvent(nid: string, object: string, n: number, aliases: readonly string[] = []) {
    if (this.hooks.authoritative) {
      const { advanced, completed } = this.previewAuthoritativeEvent(nid, object, n, aliases);
      if (advanced) this.hooks.render(this.views());
      if (completed) this.hooks.requestAuthoritativeCompletionCheck?.();
      return;
    }
    let dirty = false;
    const finished: string[] = [];
    for (const [id, counts] of this.active) {
      const def = this.defs.get(id);
      if (!def) continue;
      if (def.epicEvent && (!this.epicBossActive || !this.epicBossQuestIds.has(id))) continue;
      let advanced = false;
      def.requirements.forEach((r, i) => {
        if (counts[i] >= r.countTotal) return;
        if (r.notificationID !== nid) return;
        // "" object = match any subject; otherwise require an exact (case-insensitive)
        // name — either the event's own subject or one of its mutation aliases.
        if (!questSubjectMatches(r.notificationObject, object, aliases)) return;
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
    // Retire it from the rail BEFORE the already-completed guard. Bailing out with the
    // id still in `active` is what would turn `sweepSatisfied` into an infinite loop —
    // it re-finds the same satisfied quest every pass, never empties `finished`, and
    // freezes the tab outright. No path reaches that today (every writer to `active`
    // fences on `completed`), which is exactly why it is worth making unreachable by
    // construction rather than by audit.
    this.active.delete(id);
    if (!def || this.completed.has(id)) return;
    this.completed.add(id);
    this.dispatchReward(def);
    this.hooks.completed(def); // celebrate with the completion popup
    this.tryActivate(); // a completed prerequisite may unlock the next quest(s)
  }

  /** Close out any active quest whose requirements are ALREADY satisfied.
   *
   *  Completion used to be tested ONLY inside an event that advanced a counter, so a
   *  quest that arrived on the rail already finished stayed there forever, unrewarded:
   *  a capped requirement bails out of onEvent before `advanced` is set, so no later
   *  event can re-run the check. That is not hypothetical — lowering a requirement's
   *  countTotal (Master Combiner went from 50 collections to 15) turns every save
   *  holding a count at or above the new target into exactly this state: "Collect 15
   *  zombies from the Zombie Pot (15/15) ✓", stuck in the quest log.
   *
   *  Online the server owns completion (it re-checks every eligible quest on each
   *  command batch, so it heals itself), and self-completing here would grant a reward
   *  the server never agreed to — hence the authoritative bail-out.
   *
   *  Completing can unlock a successor, so this repeats until it finds nothing new.
   *  It terminates: every pass moves at least one id into `completed`, which
   *  `eligible` then permanently excludes. */
  private sweepSatisfied(): boolean {
    if (this.hooks.authoritative) return false;
    let closedAny = false;
    for (;;) {
      const finished: string[] = [];
      for (const [id, counts] of this.active) {
        const def = this.defs.get(id);
        if (!def) continue;
        if (def.epicEvent && (!this.epicBossActive || !this.epicBossQuestIds.has(id))) continue;
        if (def.requirements.every((r, i) => (counts[i] ?? 0) >= r.countTotal)) finished.push(id);
      }
      if (!finished.length) return closedAny;
      closedAny = true;
      // Complete after the loop so we don't mutate `active` mid-iteration.
      for (const id of finished) this.complete(id);
    }
  }

  private dispatchReward(def: QuestDef) {
    // Online, the server grants EVERY reward authoritatively (currency and any level-up
    // it triggers, items into the authoritative inventory/Received, and epic zombie
    // rewards through the epic-boss result). The local grant is skipped in that case:
    // currency would be double-counted or bounced by the spend-only economy endpoint,
    // and a local item write is worse than useless — `adoptGameplay` replaces Received
    // and the boost inventory wholesale with server truth, so it would silently vanish
    // at the next sync. Offline (`grantReward` absent or false) grants everything here.
    const handled = this.hooks.grantReward?.(def) ?? false;
    if (handled) return;
    switch (def.rewardType) {
      case RewardType.Gold:
        if (def.rewardValue) this.state.addGold(def.rewardValue);
        break;
      case RewardType.Xp:
        if (def.rewardValue) this.state.addXp(def.rewardValue);
        break;
      case RewardType.Brains:
        if (def.rewardValue) this.state.addBrains(def.rewardValue);
        break;
      case RewardType.Item:
        if (def.rewardItemKey) this.hooks.grantItem(def.rewardItemKey);
        break;
      case RewardType.Zombie:
        if (def.rewardItemKey) this.hooks.grantZombie(def.rewardItemKey);
        break;
    }
    // Paid on top of whichever reward the switch handled, never instead of it.
    if (def.rewardBrains) this.state.addBrains(def.rewardBrains);
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
      if (def.epicEvent && (!this.epicBossActive || !this.epicBossQuestIds.has(id))) continue;
      const displayCounts = this.hooks.authoritative
        ? this.authoritativePreview.get(id) ?? counts
        : counts;
      out.push({
        id,
        title: def.title,
        icon: def.sprite,
        tip: def.tip,
        reward: questRewardInfo(def),
        bonus: questBonusRewardInfo(def),
        objectives: def.requirements.map((r, i) => ({
          text: r.text,
          count: displayCounts[i],
          total: r.countTotal,
          done: displayCounts[i] >= r.countTotal,
        })),
      });
    }
    // Playable first, then by id. The id ordering is also what keeps the four-slot rail
    // showing PROGRESSION: the imported catalog stops at 10011 and the Reforged
    // achievements start at 20001, so a long-running achievement can never displace the
    // next authored quest — it waits in the quest log instead. That is a real ordering
    // guarantee, not a coincidence of the numbers (quest/reforgedQuests.test.ts).
    out.sort((a, b) =>
      (this.actionable(b.id) ? 1 : 0) - (this.actionable(a.id) ? 1 : 0) ||
      Number(a.id) - Number(b.id)
    );
    return out;
  }

  get completedCount(): number {
    return this.completed.size;
  }

  /** Apply unconfirmed events to display state only. The authoritative maps and
   * serialized save remain untouched until the server accepts the command. */
  private previewAuthoritativeEvent(
    nid: string,
    object: string,
    n: number,
    aliases: readonly string[] = []
  ): { advanced: boolean; completed: boolean } {
    let anyAdvanced = false;
    let anyCompleted = false;
    for (const [id, authoritativeCounts] of this.active) {
      const def = this.defs.get(id);
      if (!def) continue;
      if (def.epicEvent && (!this.epicBossActive || !this.epicBossQuestIds.has(id))) continue;
      const counts = this.authoritativePreview.get(id) ?? authoritativeCounts.slice();
      let advanced = false;
      def.requirements.forEach((requirement, index) => {
        if (counts[index] >= requirement.countTotal || requirement.notificationID !== nid) return;
        if (!questSubjectMatches(requirement.notificationObject, object, aliases)) return;
        counts[index] = Math.min(requirement.countTotal, counts[index] + n);
        advanced = true;
      });
      if (!advanced) continue;
      anyAdvanced = true;
      this.authoritativePreview.set(id, counts);
      if (def.requirements.every((requirement, index) => counts[index] >= requirement.countTotal) &&
          !this.optimisticallyCelebrated.has(id)) {
        this.optimisticallyCelebrated.add(id);
        this.hooks.completed(def);
      }
      if (this.optimisticallyCelebrated.has(id) && !this.authoritativeCompletionRequested.has(id)) {
        this.authoritativeCompletionRequested.add(id);
        anyCompleted = true;
      }
    }
    return { advanced: anyAdvanced, completed: anyCompleted };
  }

  private resetAuthoritativePreview(): void {
    this.authoritativePreview.clear();
    this.optimisticallyCelebrated.clear();
    this.authoritativeCompletionRequested.clear();
  }

  /** Surface/pause Epic Boss quests without discarding their lifetime progress. */
  setEpicBossActive(active: boolean, questIds: readonly string[] = ["1000", "1001", "1002", "1003", "1010", "1011"]) {
    const nextIds = new Set(questIds);
    if (this.epicBossActive === active &&
        nextIds.size === this.epicBossQuestIds.size &&
        [...nextIds].every((id) => this.epicBossQuestIds.has(id))) return;
    this.epicBossActive = active;
    this.epicBossQuestIds = nextIds;
    if (active) {
      this.tryActivate();
      // An epic quest carries lifetime progress across events, so the one that comes
      // back into view can already be at target (see sweepSatisfied).
      this.sweepSatisfied();
    }
    this.hooks.render(this.views());
  }

  /** Put an event's finished quests back on the rail for a new run of it.
   *
   *  Activating an Epic Boss again re-offers its quest chain, prizes included, so the
   *  event's signature zombie is earnable on every run rather than once per account.
   *  Offline this IS the reset; online the Worker does the same to the authoritative
   *  document and this applies its answer (see reopenEpicQuests in epicBoss/rewards).
   *  Untouched quests keep their lifetime progress, which is why only completed ids
   *  are cleared here. */
  reopenEpicQuests(questIds: readonly string[]): void {
    let changed = false;
    for (const id of questIds) {
      if (!this.completed.delete(id)) continue;
      changed = true;
      this.active.delete(id);
      this.authoritativePreview.delete(id);
      this.optimisticallyCelebrated.delete(id);
      this.authoritativeCompletionRequested.delete(id);
    }
    if (!changed) return;
    this.tryActivate();
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
    this.resetAuthoritativePreview();
    if (save) {
      this.completed = new Set(save.completed);
      this.active = new Map();
      // Epic quests remain stored while an event is inactive so lifetime progress
      // survives expiration and later paid activations; views/events hide them until
      // setEpicBossActive(true).
      for (const a of save.active) {
        const savedDef = this.defs.get(a.id);
        if (savedDef?.epicEvent && !this.completed.has(a.id)) {
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
    // A restored count can already satisfy its requirement (see sweepSatisfied).
    this.sweepSatisfied();
    this.hooks.render(this.views());
  }

  /** Reconcile quest presentation with the server. In online mode this replaces the
   * optimistic layer (and therefore rolls rejected events back); offline imports keep
   * the historical forward-only merge behavior. */
  restoreAuthoritative(state: {
    completed: string[];
    progress: { questId: string; counts: number[] }[];
  }): void {
    this.resetAuthoritativePreview();
    const localCompleted = new Set(this.completed);
    const localActive = new Map([...this.active].map(([id, counts]) => [id, counts.slice()]));
    this.completed = this.hooks.authoritative
      ? new Set(state.completed.filter((id) => this.defs.has(id)))
      : new Set([
          ...[...localCompleted].filter((id) => this.defs.has(id)),
          ...state.completed.filter((id) => this.defs.has(id)),
        ]);
    this.active = new Map();
    const supplied = new Map(state.progress.map((p) => [p.questId, p.counts]));
    for (const [id, def] of this.defs) {
      const remote = supplied.get(id) ?? [];
      const local = localActive.get(id) ?? [];
      const pausedEpic = def.epicEvent && !this.completed.has(id) && (remote.length > 0 || local.length > 0);
      if (!pausedEpic && !this.eligible(id)) continue;
      this.active.set(
        id,
        def.requirements.map((r, i) => {
          const remoteCount = Number.isInteger(remote[i]) ? remote[i] : 0;
          const localCount = Number.isInteger(local[i]) ? local[i] : 0;
          const n = this.hooks.authoritative ? remoteCount : Math.max(remoteCount, localCount);
          return Math.max(0, Math.min(r.countTotal, n));
        })
      );
    }
    this.tryActivate();
    // Offline path only (importing an online export into Local Farm): the merged
    // counts can already be at target with the quest still open. Online this is a
    // no-op — `state.completed` is the server's answer and it stays the authority.
    this.sweepSatisfied();
    this.hooks.render(this.views());
  }

  /** Apply the progress delta returned with the trusted command that caused it. */
  applyAuthoritativeChanges(changes: { questId: string; counts: number[]; completed: boolean }[]): void {
    for (const change of changes) {
      const def = this.defs.get(change.questId);
      if (!def) continue;
      const wasCompleted = this.completed.has(change.questId);
      const wasOptimisticallyCelebrated = this.optimisticallyCelebrated.has(change.questId);
      if (change.completed) {
        this.active.delete(change.questId);
        this.completed.add(change.questId);
        this.authoritativePreview.delete(change.questId);
        this.optimisticallyCelebrated.delete(change.questId);
        this.authoritativeCompletionRequested.delete(change.questId);
        if (!wasCompleted && !wasOptimisticallyCelebrated) this.hooks.completed(def);
      } else if (!this.completed.has(change.questId)) {
        const authoritative = def.requirements.map(
          (r, i) => Math.max(0, Math.min(r.countTotal, change.counts[i] ?? 0))
        );
        this.active.set(change.questId, authoritative);
        // The rail draws the optimistic preview in preference to these counts, and
        // the preview only ever grows from LOCAL events. If the server counted
        // something this client did not post — another device, or a command whose
        // optimistic post was skipped — the preview would sit below the truth and,
        // because nothing cleared it, keep shadowing it for the rest of the session:
        // the player does the thing twice and the objective still reads 1.
        // Keep the preview only where it is genuinely AHEAD (an unconfirmed local
        // event), and drop it once the server has caught up.
        const preview = this.authoritativePreview.get(change.questId);
        if (preview) {
          const merged = preview.map((count, i) => Math.max(count, authoritative[i] ?? 0));
          if (merged.every((count, i) => count === authoritative[i])) {
            this.authoritativePreview.delete(change.questId);
          } else {
            this.authoritativePreview.set(change.questId, merged);
          }
        }
      }
    }
    this.tryActivate();
    this.hooks.render(this.views());
  }
}
