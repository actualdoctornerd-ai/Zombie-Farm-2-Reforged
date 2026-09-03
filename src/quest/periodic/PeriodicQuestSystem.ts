// The client half of daily / weekly quests.
//
// It runs in one of two modes, chosen once at construction from whether this build
// talks to a server at all:
//
//   OFFLINE (`authoritative: false`) — this system IS the authority. It generates the
//     sets, counts game events off the quest bus, pays the XP on claim, and persists
//     everything in the save. Exactly the same generator the server uses, so the two
//     builds agree about what a Tuesday looks like.
//
//   ONLINE (`authoritative: true`) — the server owns the counts and the claims. The
//     state is whatever the last projection said, and a claim is a command whose result
//     arrives as a new projection. Bus events are applied to a display-only COPY of
//     that state, with the server's own counting function, so the bar and the badge
//     move the moment the chore is done rather than when the batch window closes (up
//     to thirty seconds later — "my quests take ages to update"). The copy is thrown
//     away on every projection. What the preview never does is offer the Claim: a
//     quest done in preview but not yet in the server's count shows as `pending`, and
//     claim() itself reads the authoritative state — a claim the server would refuse
//     must not be offered, and that reasoning still stands.
//
//     The BOARD, though, is authored here. The generator is deterministic and shared,
//     so the instant this client qualifies for a scope (the level-up it just saw, or
//     a period rollover) it draws the board itself, shows it, and sends a
//     `quest.periodic_author` command asking the server to derive the same one. The
//     server never reads a quest off the wire — it re-generates and compares levels —
//     and its projection replaces the local board when it lands (identically, when
//     the level matched). Before this the board waited for the NEXT batch after the
//     level-up: the server rolled the sets forward before applying the commands, so
//     the batch that crossed level 5 saw level 4 and the star button arrived up to a
//     command and thirty seconds late, or on reload.

import type { GameState } from "../../GameState";
import { XP_THRESHOLDS } from "../../GameState";
import { QuestBus } from "../events";
import {
  applyPeriodicEvents, claimPeriodicQuest, claimablePeriodicCount, generatePeriodicSet,
  periodicViews, refreshPeriodicState, unlockLevel, xpToNextLevel,
} from "./generate";
import { periodEndsAt, periodIndex } from "./periods";
import {
  emptyPeriodicState, type PeriodicQuestState, type PeriodicScope, type PeriodicScopeState,
  type PeriodicScopeView,
} from "./types";

export interface PeriodicQuestHooks {
  /** True when a server owns the state (see the mode note above). */
  authoritative?: boolean;
  /** Online only: send the claim. The XP arrives with the server's next projection. */
  /** Return true only when the authoritative command entered the durable queue. */
  submitClaim?: (scope: PeriodicScope, questId: string, xp: number) => boolean;
  /** Online only: ask the server to derive the board this client just drew for
   *  itself (see the mode note). Return true only when the command entered the queue. */
  submitAuthor?: (scope: PeriodicScope, level: number) => boolean;
  /** Online only: a local event has just finished a quest in preview. Flush the
   *  command lane so the server's count (and the Claim) arrive without waiting out
   *  the batch window. */
  requestConfirmation?: () => void;
  /** Celebrate a paid-out claim. */
  claimed?: (text: string, xp: number) => void;
  /** Push the current panel state to the HUD. */
  render: (views: PeriodicScopeView[]) => void;
}

/** The account identity the roll is seeded with. Offline there is no account, so the
 *  local profile's own id stands in — it just has to be stable for one save. */
export type PeriodicIdentity = () => string;

/** A structural copy: the preview must never share a counts array with the adopted
 *  state, or applyPeriodicEvents on the copy would advance the claim gate too. */
function clonePeriodic(state: PeriodicQuestState): PeriodicQuestState {
  const copy = (set: PeriodicScopeState | null): PeriodicScopeState | null =>
    set ? { ...set, quests: [...set.quests], counts: [...set.counts], claimed: [...set.claimed] } : null;
  return { daily: copy(state.daily), weekly: copy(state.weekly) };
}

export class PeriodicQuestSystem {
  private state: PeriodicQuestState = emptyPeriodicState();
  /** Set once the online projection has been received, so an online client does not
   *  briefly draw a locally-generated board before the server's arrives. */
  private adopted = false;
  /** Online: the period each scope's author command was last SENT for, so a board is
   *  asked for once per period however many level-ups or refresh ticks follow. */
  private authored: Partial<Record<PeriodicScope, number>> = {};
  /** Online: the period the server REFUSED for a scope (below its unlock: the level
   *  this client crossed optimistically was not real). Not drawn again that period. */
  private refused: Partial<Record<PeriodicScope, number>> = {};
  /** Online: the adopted state plus this client's unconfirmed events, for display.
   *  Null until the first event after a projection; discarded by the next one. */
  private preview: PeriodicQuestState | null = null;

  constructor(
    private gameState: GameState,
    private identity: PeriodicIdentity,
    bus: QuestBus,
    private hooks: PeriodicQuestHooks
  ) {
    if (!this.hooks.authoritative) {
      bus.subscribe((nid, object, _n, aliases) => {
        // Roll the day over first: the event that arrives after midnight belongs to the
        // NEW day's board, not to the expired one it would otherwise be counted against.
        const rolled = this.refresh();
        // One event advances a quest by one, matching the server engine — `n` is
        // deliberately ignored so a bulk post cannot outpace the authoritative count.
        const advanced = applyPeriodicEvents(this.state, [{ type: nid, subject: object, aliases }]);
        if (rolled || advanced) this.hooks.render(this.views());
      });
      // A level-up can unlock a scope outright (daily at 5, weekly at 15).
      this.gameState.onChange(() => {
        if (this.refresh()) this.hooks.render(this.views());
      });
    } else {
      // Online the same level-up authors the board locally and asks the server for
      // the same one — the star button and Tim's notice land in the same frame.
      this.gameState.onChange(() => {
        if (this.authorDue()) this.hooks.render(this.views());
      });
      // And the same events the offline build counts move the display-only preview.
      bus.subscribe((nid, object, _n, aliases) => {
        if (this.previewEvent(nid, object, aliases)) this.hooks.render(this.views());
      });
    }
  }

  /** Online: count one local event against the preview copy. Returns true when the
   *  display changed. Nothing here touches the adopted state or the claim gate. */
  private previewEvent(nid: string, object: string, aliases: readonly string[]): boolean {
    if (!this.adopted) return false;
    this.preview ??= clonePeriodic(this.state);
    const claimableBefore = claimablePeriodicCount(this.preview);
    const advanced = applyPeriodicEvents(this.preview, [{ type: nid, subject: object, aliases }]);
    if (advanced && claimablePeriodicCount(this.preview) > claimableBefore) {
      this.hooks.requestConfirmation?.();
    }
    return advanced;
  }

  /** Roll the sets forward to now. Offline this generates; online it authors any
   *  scope that has become due (a level-up, a rollover) and asks the server for the
   *  same board — the counts and the claims stay the server's. */
  refresh(now = Date.now()): boolean {
    if (this.hooks.authoritative) return this.authorDue(now);
    const level = this.gameState.level;
    return refreshPeriodicState(this.state, {
      accountId: this.identity(),
      level,
      xpToNext: xpToNextLevel(level, XP_THRESHOLDS),
      now,
    });
  }

  /** Online: draw any scope that is due and this client has not drawn yet, and ask the
   *  server for the same one. Due means: the player's level (optimistic XP included —
   *  that is the level-up they just saw) reaches the scope's unlock, and the board on
   *  hand is not this period's. Only once the projection has been adopted, so a board
   *  is never drawn over a server one that has simply not arrived yet. Returns true
   *  when a board was drawn. */
  private authorDue(now = Date.now()): boolean {
    if (!this.adopted) return false;
    const level = this.gameState.level;
    let drawn = false;
    for (const scope of ["daily", "weekly"] as const) {
      if (level < unlockLevel(scope)) continue;
      const period = periodIndex(scope, now);
      if (this.state[scope]?.period === period || this.refused[scope] === period) continue;
      this.state[scope] = generatePeriodicSet({
        accountId: this.identity(), scope, period, level,
        xpToNext: xpToNextLevel(level, XP_THRESHOLDS),
      });
      this.preview = null; // a copy of the old state would be missing this board
      drawn = true;
      // Sent once per period. A send that could not be queued is retried on the next
      // level change or refresh tick, and the server's own post-batch roll-forward
      // produces the same board regardless — the command only makes it immediate.
      if (this.authored[scope] !== period && this.hooks.submitAuthor?.(scope, level)) {
        this.authored[scope] = period;
      }
    }
    return drawn;
  }

  /** Online: the server refused this client's author command. `already_authored`
   *  means its board for the period exists — the projection carrying it has either
   *  replaced the local one already or is identical — so there is nothing to do.
   *  Anything else (`below_unlock`: the level crossed optimistically was not real)
   *  means the board drawn here was never earned, and it comes down. */
  authorRefused(scope: PeriodicScope, error: string, now = Date.now()): void {
    if (!this.hooks.authoritative || error === "already_authored") return;
    const period = periodIndex(scope, now);
    this.refused[scope] = period;
    if (this.state[scope]?.period === period) {
      this.state[scope] = null;
      this.preview = null;
      this.hooks.render(this.views());
    }
  }

  /** Online: install the server's authoritative sets. */
  adoptAuthoritative(state: { daily: PeriodicScopeState | null; weekly: PeriodicScopeState | null } | null): void {
    if (!this.hooks.authoritative) return;
    this.adopted = true;
    this.state = state ? { daily: state.daily, weekly: state.weekly } : emptyPeriodicState();
    // The server's count supersedes whatever this client had previewed on top of the
    // previous projection: a refused command's events vanish with it.
    this.preview = null;
    this.hooks.render(this.views());
  }

  /** Collect a finished quest.
   *
   *  Offline this pays immediately. Online it only SENDS — the XP and the claimed flag
   *  both come back from the server, because a claim can legitimately be refused (the
   *  period rolled over between the panel rendering and the button being pressed). */
  claim(scope: PeriodicScope, questId: string): void {
    const set = this.state[scope];
    if (!set) return;
    const index = set.quests.findIndex((quest) => quest.id === questId);
    if (index < 0) return;
    const quest = set.quests[index];
    if ((set.counts[index] ?? 0) < quest.countTotal || set.claimed.includes(questId)) return;

    if (this.hooks.authoritative) {
      if (!this.hooks.submitClaim?.(scope, questId, quest.xp)) return;
      // Mark it locally so a double-tap cannot post the claim twice while the round
      // trip is in flight. Only do this after enqueue succeeds: otherwise there is no
      // future projection guaranteed to undo the local latch.
      set.claimed = [...set.claimed, questId];
      const previewSet = this.preview?.[scope];
      if (previewSet && !previewSet.claimed.includes(questId)) previewSet.claimed = [...previewSet.claimed, questId];
      this.hooks.render(this.views());
      return;
    }
    const result = claimPeriodicQuest(this.state, scope, questId);
    if (!result.ok) return;
    this.gameState.addXp(result.xp);
    this.hooks.claimed?.(result.quest.text, result.xp);
    this.hooks.render(this.views());
  }

  views(now = Date.now()): PeriodicScopeView[] {
    if (this.hooks.authoritative && !this.adopted) return [];
    if (!this.preview) return periodicViews(this.state, now);
    // Preview counts on the bar; the Claim only where the SERVER's count agrees.
    const confirmed = new Set<string>();
    for (const scope of periodicViews(this.state, now)) {
      for (const quest of scope.quests) if (quest.done) confirmed.add(`${scope.scope}:${quest.id}`);
    }
    return periodicViews(this.preview, now).map((scope) => ({
      ...scope,
      quests: scope.quests.map((quest) =>
        quest.done && !quest.claimed && !confirmed.has(`${scope.scope}:${quest.id}`)
          ? { ...quest, pending: true }
          : quest),
    }));
  }

  /** How many finished quests are waiting to be collected — the HUD's badge. Reads
   *  the preview online, so the badge lights with the chore rather than the batch. */
  get claimable(): number {
    return claimablePeriodicCount(this.preview ?? this.state);
  }

  /** When the soonest period rolls over, so the HUD knows when to redraw. */
  nextRolloverAt(now = Date.now()): number {
    const ends: number[] = [];
    if (this.state.daily) ends.push(periodEndsAt("daily", now));
    if (this.state.weekly) ends.push(periodEndsAt("weekly", now));
    return ends.length ? Math.min(...ends) : Number.POSITIVE_INFINITY;
  }

  // ---- persistence (offline only; online state is never saved, it is projected) ----

  serialize(): PeriodicQuestState | undefined {
    if (this.hooks.authoritative) return undefined;
    return this.state;
  }

  restore(save?: PeriodicQuestState | null): void {
    if (!this.hooks.authoritative && save) {
      this.state = { daily: save.daily ?? null, weekly: save.weekly ?? null };
    }
    this.refresh();
    this.hooks.render(this.views());
  }
}
