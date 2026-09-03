// Daily / weekly quests ("periodic quests"). These are a SEPARATE system from the
// catalog quests in quests.json: those are a one-time authored progression chain,
// these are generated per period, reset on a clock, and pay XP only.
//
// The two systems deliberately share the requirement vocabulary — a periodic quest
// carries the same `notificationID` / `notificationObject` / `countTotal` triple as a
// QuestRequirement — so the same game events and the same questSubjectMatches() drive
// both. What differs is the lifecycle: a periodic quest expires, and its reward is
// CLAIMED rather than auto-granted (see PeriodicScopeState.claimed).

export type PeriodicScope = "daily" | "weekly";

/** One generated objective. */
export interface PeriodicQuest {
  /** Unique within its set. Stable for the life of the period, and the id a claim
   *  names. Built from the template key so a set never holds two of a kind. */
  id: string;
  /** Which template produced this quest (also the claim's audit label). */
  template: string;
  /** Player-facing objective line, e.g. "Harvest 20 Spineapple". */
  text: string;
  /** Filename under assets/ui. */
  icon: string;
  /** The game event this counts, mirroring QuestRequirement.notificationID. */
  notificationID: string;
  /** Subject to match; "" is the wildcard, exactly as in the catalog quests. */
  notificationObject: string;
  countTotal: number;
  /** XP paid on claim. FROZEN at generation time — see generatePeriodicSet. */
  xp: number;
}

/** The durable state of one scope (daily or weekly). */
export interface PeriodicScopeState {
  /** UTC day index, or Monday-aligned week index (see periods.ts). */
  period: number;
  /** The level this set was generated for. Recorded because the rewards were sized
   *  against it and must not be re-derived later at a higher level. */
  level: number;
  quests: PeriodicQuest[];
  /** Progress per quest, parallel to `quests`. */
  counts: number[];
  /** Ids already paid out. A quest is claimable iff complete and absent here. */
  claimed: string[];
}

/** Everything the periodic system persists. Either scope is null before it unlocks
 *  (daily at level 5, weekly at level 15) or before its first period is generated. */
export interface PeriodicQuestState {
  daily: PeriodicScopeState | null;
  weekly: PeriodicScopeState | null;
}

export function emptyPeriodicState(): PeriodicQuestState {
  return { daily: null, weekly: null };
}

/** A single quest as the HUD draws it. */
export interface PeriodicQuestView {
  scope: PeriodicScope;
  id: string;
  text: string;
  icon: string;
  count: number;
  total: number;
  done: boolean;
  claimed: boolean;
  xp: number;
  /** Online only: `done` by this client's own events, not yet by the server's count.
   *  The bar is full and the badge lit, but the Claim waits for confirmation — a
   *  claim the server would refuse must not be offered (see PeriodicQuestSystem). */
  pending?: boolean;
}

/** One scope's panel: its quests plus when the period rolls over. */
export interface PeriodicScopeView {
  scope: PeriodicScope;
  /** Epoch ms this period ends and the set is replaced. */
  endsAt: number;
  quests: PeriodicQuestView[];
}
