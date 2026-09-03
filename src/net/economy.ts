import type { GameState } from "../GameState";
import { crumb } from "../breadcrumbs";
import * as api from "./api";
import { CommandQueue } from "./commandQueue";
import {
  EPIC_BOSS_TOKEN_GRANT_LIMIT,
  FARM_BULK_LIMIT,
  type BootstrapResponse, type CommandBatchResponse, type GameplayCommand,
  type PeriodicQuestProjection,
} from "./protocol";
import type { RaidOutcome } from "../raid/types";
import { RAID_RULESET_VERSION } from "../raid/replay";
import { epicBossRunToClient, serverTimestampToClient } from "./clock";

export const OWNERSHIP_POLL_IDLE_MS = 3 * 60_000;

export interface InventoryInput {
  type: "buy" | "use" | "grant";
  key: string;
  qty?: number;
  unitId?: string;
  localZombieHarvests?: { id: string; oc: number; or: number }[];
  oc?: number;
  or?: number;
  target?: "zombie_pot";
}

export type RosterInput =
  | { type: "sell"; unitId: string }
  | { type: "grant"; unitId: string; key: string; mutation?: number; invasions?: number }
  | { type: "veteran"; unitIds: string[] }
  | { type: "casualty"; unitIds: string[] }
  | { type: "combineStart"; potId?: string; parentAId: string; parentBId: string; playerLevel?: number }
  | { type: "combineCollect"; potId?: string; unitId: string; key: string; mutation?: number;
      /** Collect the child straight into the Mausoleum instead of the farm. */
      stored?: boolean };

export interface FarmActionInput {
  type: "plant" | "harvest" | "plow" | "remove" | "move";
  oc: number;
  or: number;
  /** Destination origin, "move" only. */
  toOc?: number;
  toOr?: number;
  cropKey?: string;
  fertilized?: boolean;
  unitId?: string;
}

interface OptimisticDelta {
  gold: number;
  brains: number;
  xp: number;
  inventoryKey?: string;
  inventoryCount?: number;
  localUnitId?: string;
  localZombieHarvests?: { id: string; oc: number; or: number }[];
  localObjectId?: string;
  /** Boss Tokens this command reports, and the run they belong to. The client has
   *  already added them to the run it is showing, so every server projection that
   *  arrives before this command settles must be topped up by them or the counter
   *  visibly drops back and then climbs again. */
  bossTokens?: number;
  bossTokenRunId?: string;
}

interface PendingRaidFinish {
  sessionId: string;
  finalTick: number;
  inputs: api.RaidReplayInput[];
  outcome: RaidOutcome;
  savedAt: number;
}

const RAID_FINISH_PREFIX = "zf2r.v3.raid-finish";
const RAID_FINISH_RETRY_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

/** Compatibility facade used by the current gameplay code. Every non-raid method
 * feeds one protocol-v3 queue; none of these methods owns an HTTP stream anymore. */
export class EconomyClient {
  private readonly queue: CommandQueue;
  private base: api.Balance | null = null;
  private serverInv: Record<string, number> = {};
  private optimistic = new Map<number, OptimisticDelta>();
  private authoritativeUnitIds = new Map<string, string>();
  private deferredRosterAliases: Record<string, string> = {};
  private deferredObjectAliases: Record<string, string> = {};
  private deferredRejectedObjectIds = new Set<string>();
  private combineParents = new Map<string, {
    parentAId: string; parentBId: string; playerLevel?: number;
  }>();
  private commandsBySequence = new Map<number, GameplayCommand>();
  private ready = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempt = 0;
  private recoveryInFlight = false;
  /** The takeover gate is up: another live device holds the lease and the player has
   *  been asked what to do about it. Recovery deliberately stops there — retrying would
   *  fight a device that is legitimately writing — so this is the ONE state in which
   *  `ensureRecoveryArmed` may leave gameplay paused with nothing pending. */
  private writerGated = false;
  /** Consecutive conflict reloads with no batch applied in between. */
  private conflictReloads = 0;
  private conflictReloading = false;
  private ownershipTimer: ReturnType<typeof setTimeout> | null = null;
  private ownershipCheckInFlight = false;

  onShopState: ((size: number, climates: string[]) => void) | null = null;
  onFarmerState:
    ((headIds: number[], equippedHeadId: number, bonusHeadId: number | null | undefined) => void)
    | null = null;
  onPetState: ((ownedPets: string[], activePet: string | null, penPets: string[]) => void) | null = null;
  onQuestState: ((state: api.QuestStateResult) => void) | null = null;
  onQuestChanges: ((changes: api.QuestChange[]) => void) | null = null;
  /** Authoritative daily/weekly quest state. Null from a Worker that predates the
   *  feature, which the client reads as "no periodic quests" rather than as empty. */
  onPeriodicQuestState: ((state: PeriodicQuestProjection | null) => void) | null = null;
  onCropFertilized: ((oc: number, or: number) => void) | null = null;
  onFarmState: ((farm: api.FarmState) => void) | null = null;
  /** Resolving `false` means a newer reconcile superseded this pass before it consumed
   *  `aliases`, and this client must keep them for the next one. Any other result (or a
   *  synchronous handler) means they were applied and may be dropped. */
  onObjectState: ((
    objects: BootstrapResponse["gameplay"]["objects"]["objects"],
    aliases: Record<string, string>,
    baseZombieMax: number,
    rejectedLocalIds: string[],
  ) => void | Promise<boolean | void>) | null = null;
  /** `settled` means this client has NOTHING outstanding — no queued command, none in
   *  flight — so the roster it just received is the whole truth and may be used to
   *  retire local state the server contradicts (see ZombieField.reconcileServerPots).
   *  While work is outstanding the roster is merely a snapshot that predates it. */
  onRosterState: ((
    roster: BootstrapResponse["gameplay"]["roster"],
    aliases: Record<string, string>,
    settled: boolean,
  ) => void) | null = null;
  onRaidSettled: ((res: api.RaidFinishResult) => void) | null = null;
  onRaidRevival: ((offer: NonNullable<BootstrapResponse["gameplay"]["raidRevival"]>, brains: number) => void) | null = null;
  onEpicBossState: ((event: BootstrapResponse["gameplay"]["epicBoss"]) => void) | null = null;
  onTutorialState: ((rewarded: boolean) => void) | null = null;
  onGameplayUnavailable: ((reason: string) => void) | null = null;
  onWriterReplaced: (() => void) | null = null;
  /** Fired whenever a bootstrap confirms this tab owns the writer, including recovery. */
  onWriterOwned: (() => void) | null = null;
  onWriterAvailable: (() => void) | null = null;
  onCommandRejected: ((command: GameplayCommand | undefined, error: string) => void) | null = null;
  /** Some — not all — of a bulk plow/plant's plots were refused. */
  onBulkFarmPartial: ((plots: number, error: string) => void) | null = null;
  onAuthoritativeSettled: ((serverTime: number) => void) | null = null;
  onPendingChange: ((pending: number) => void) | null = null;
  /** Fired at boot when the Worker's raid ruleset differs from this bundle's. Every
   *  `/raid/start` would be refused with `426 stale_ruleset` until the tab reloads, so
   *  the UI surfaces a reload prompt rather than letting the player discover it by
   *  pressing Invade. */
  onRulesetSkew: ((serverVersion: number, clientVersion: number) => void) | null = null;
  /** The session id of the invasion THIS document is playing right now (set from
   *  /raid/start, cleared once its finish is submitted or the launch is abandoned).
   *  Read only by recoverResumableRaid, which must never settle a live fight. */
  private liveRaidSessionId: string | null = null;

  constructor(
    private state: GameState,
    private readonly accountId: string,
    private readonly options: { requireReady?: boolean } = {},
  ) {
    this.queue = new CommandQueue(accountId);
    this.queue.onProjection = (response) => this.adoptCommandResponse(response);
    this.queue.onUnavailable = (reason) => {
      this.onGameplayUnavailable?.(reason);
      this.scheduleRecovery();
    };
    this.queue.onWriterReplaced = () => this.gateOnWriterReplaced();
    // Arm the backoff BEFORE dispatching. A 409 pauses the queue through `setPaused`,
    // which emits no `onUnavailable` and so schedules nothing — this handler was the
    // only thing standing between that pause and a permanent stall, and it is one
    // failed bootstrap away from doing nothing at all.
    this.queue.onStateConflict = () => {
      this.ensureRecoveryArmed();
      void this.reloadAfterConflict();
    };
    this.queue.onSizeChange = (size) => this.onPendingChange?.(size);
    api.setWriterRejectedHandler(() => this.handleWriterLost());
    api.setWriterConfirmedHandler(() => this.scheduleOwnershipCheck());
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void this.resumeFromBackground();
        else this.clearOwnershipCheck();
      });
      // A different device cannot push a takeover notification into this page.
      // Successful writer-protected requests already prove ownership and postpone
      // the next check. Only an idle visible tab needs a dedicated status request;
      // focus remains immediate so a resumed tab never waits three minutes.
    }
  }

  async start(): Promise<void> {
    try {
      let bootstrap = await api.bootstrap();
      // A missing token can be recovered without a takeover when this document
      // owns the browser-local lock and the server lease belongs to the same
      // session/client. A genuinely different browser still receives writer_active.
      if (bootstrap.writer.status !== "mine" && api.hasLocalWriterLock()) {
        try { await api.acquireWriter(bootstrap.writer.generation, false); }
        catch { /* another client may have acquired it between bootstrap and claim */ }
        bootstrap = await api.bootstrap(true);
      }
      // The ONLY bootstrap allowed to abandon a live session: this one runs once, at
      // boot, so a raid the server still holds open belongs to a previous page load and
      // has no scene left to finish it.
      bootstrap = await this.recoverResumableRaid(bootstrap, true);
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
      // Feature capability: whether this Worker accepts friend invasions. Read at
      // boot only — the client's Invasions surfaces follow the Worker's PVP_ENABLED
      // flag, so launching (or parking) PvP never needs a client redeploy.
      this.serverPvpEnabled = bootstrap.pvpEnabled === true;
      if (bootstrap.raidRulesetVersion !== RAID_RULESET_VERSION) {
        this.onRulesetSkew?.(bootstrap.raidRulesetVersion, RAID_RULESET_VERSION);
      }
      if (this.queue.size === 0) this.onAuthoritativeSettled?.(bootstrap.serverTime);
      this.syncOwnershipPolling(bootstrap.writer.status);
      if (bootstrap.writer.status === "mine") this.onWriterAvailable?.();
      else this.gateOnWriterReplaced();
      // A bootstrap that succeeds but lands paused (mutations halted, protocol floor)
      // arms nothing on its own: `disable` is never called, so `onUnavailable` never
      // fires. Boot is as able to strand a client as a mid-session failure is.
      this.ensureRecoveryArmed();
    } catch {
      this.ready = false;
      this.queue.disable("bootstrap_failed");
      this.scheduleRecovery();
    }
  }

  get available(): boolean { return this.ready && this.queue.available; }

  /** Whether the deployed Worker accepts friend invasions (bootstrap `pvpEnabled`).
   *  False until the first successful bootstrap. */
  serverPvpEnabled = false;

  /** A compact description of WHY gameplay is unavailable, read live at the moment
   *  it's shown rather than remembered from a callback — several paths pause the
   *  queue without emitting one (a 409 rebase, a lost writer, a bootstrap projection
   *  that says mutations are off). Diagnostic only; nothing branches on it.
   *  Shape: `reason` or `reason+detail`, e.g. `bootstrap_failed`,
   *  `state_conflict/q3`, `writer_elsewhere/nocred`. */
  get unavailableReason(): string {
    if (this.available) return "";
    const parts: string[] = [];
    if (!this.ready) parts.push("not_ready");
    if (!this.queue.available) parts.push(this.queue.pauseReason);
    if (this.queue.size) parts.push(`q${this.queue.size}`);
    // Distinguishes "the lease moved" from "this document never had a credential",
    // which look identical from the outside but have different fixes.
    if (!api.getSession()) parts.push("nosession");
    else if (!api.hasLocalWriterLock()) parts.push("nolock");
    else if (!api.hasWriterCredential()) parts.push("nocred");
    return parts.filter(Boolean).join("/");
  }

  async takeOver(): Promise<boolean> {
    try {
      const current = await api.bootstrap(true);
      await api.acquireWriter(current.writer.generation, true);
      this.scheduleOwnershipCheck();
      return true;
    } catch {
      return false;
    }
  }

  private handleWriterLost(): void {
    this.clearOwnershipCheck();
    api.clearWriterCredential();
    this.queue.markWriterLost();
    this.optimistic.clear();
    this.commandsBySequence.clear();
    this.gateOnWriterReplaced();
    void this.refreshReadOnly();
  }

  /** Re-take a lease the server reports as unheld. A free lease is NOT a conflict:
   *  no other document owns it, so claiming it needs no takeover and must never raise
   *  the "Farm active elsewhere" gate. The path that makes this load-bearing is mobile
   *  resume — `pagehide` releases the lease when the OS suspends the app, but a
   *  suspended document is often resumed rather than destroyed, so it wakes up holding
   *  a credential the server has already forgotten. Without a silent re-claim that
   *  document is paused forever: every tap answers "Gameplay paused — reconnect to
   *  continue" and only a manual reload clears it.
   *  Returns true once this document is writing again. */
  private async reclaimFreeWriter(observedGeneration: number): Promise<boolean> {
    if (!api.hasLocalWriterLock() || !api.getSession()) return false;
    try {
      await api.acquireWriter(observedGeneration, false);
      let bootstrap = await api.bootstrap(true);
      if (bootstrap.writer.status !== "mine") return false;
      // Only now does the raid recovery in the caller's bootstrap become reachable: it
      // no-ops while the lease is unowned. Resend-only — this path exists BECAUSE the
      // document was suspended mid-session, which is precisely when the fight is still
      // on screen and must not be abandoned.
      bootstrap = await this.recoverResumableRaid(bootstrap);
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
      this.syncOwnershipPolling(bootstrap.writer.status);
      if (this.queue.size === 0) this.onAuthoritativeSettled?.(bootstrap.serverTime);
      this.recoveryAttempt = 0;
      this.onWriterAvailable?.();
      await this.queue.retry();
      return true;
    } catch {
      // A real second device answers 423 writer_active here; fall back to the gate.
      return false;
    }
  }

  private async refreshReadOnly(): Promise<void> {
    try {
      const bootstrap = await api.bootstrap(true);
      if (bootstrap.writer.status === "free" &&
          await this.reclaimFreeWriter(bootstrap.writer.generation)) return;
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
      this.syncOwnershipPolling(bootstrap.writer.status);
      if (this.queue.size === 0) this.onAuthoritativeSettled?.(bootstrap.serverTime);
    } catch { /* the blocking state remains until a later focus/reconnect */ }
    finally { this.ensureRecoveryArmed(); }
  }

  private clearOwnershipCheck(): void {
    if (this.ownershipTimer) clearTimeout(this.ownershipTimer);
    this.ownershipTimer = null;
  }

  private scheduleOwnershipCheck(): void {
    this.clearOwnershipCheck();
    if (typeof window === "undefined" || typeof document === "undefined" ||
        document.visibilityState !== "visible" || !this.ready ||
        !api.getSession() || !api.hasWriterCredential()) return;
    this.ownershipTimer = setTimeout(() => {
      this.ownershipTimer = null;
      void this.checkOwnership();
    }, OWNERSHIP_POLL_IDLE_MS);
  }

  private syncOwnershipPolling(status: "free" | "mine" | "other"): void {
    if (status === "mine") {
      this.writerGated = false;
      this.scheduleOwnershipCheck();
      this.onWriterOwned?.();
    } else this.clearOwnershipCheck();
  }

  /** Foregrounding the app. Confirm the lease first, then — if gameplay is still
   *  paused — retry immediately instead of waiting out a backoff that was scheduled
   *  before the OS suspended us and may be a minute away. A document already behind
   *  the takeover gate (its credential cleared) is left alone: that state is the
   *  player's to resolve, and re-running recovery would reopen the dialog they
   *  dismissed with "View only". */
  private async resumeFromBackground(): Promise<void> {
    await this.checkOwnership();
    if (this.available || !api.hasWriterCredential()) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryAttempt = 0;
    await this.recover();
  }

  private async checkOwnership(): Promise<void> {
    if (this.ownershipCheckInFlight) return;
    this.clearOwnershipCheck();
    if (!this.ready || !api.getSession() || !api.hasWriterCredential()) return;
    this.ownershipCheckInFlight = true;
    try {
      const writer = await api.writerStatus();
      // Resolve "free" before treating the lease as lost. This check runs on every
      // visibility change, so a mobile resume after `pagehide` released the lease lands
      // here first — re-claim it instead of gating a farm no other device is holding.
      if (writer.status === "free" && await this.reclaimFreeWriter(writer.generation)) return;
      if (writer.status !== "mine") this.handleWriterLost();
    } catch { /* ordinary recovery owns network failure handling */ }
    finally {
      this.ownershipCheckInFlight = false;
      this.scheduleOwnershipCheck();
      // The supervisor. This poll re-arms itself for as long as the tab is visible and
      // holds a credential, which is precisely the state a stalled client sits in — so
      // hanging the invariant off it costs no new timer and bounds ANY stall, including
      // one arriving down a path that does not exist yet, at one poll interval.
      this.ensureRecoveryArmed();
    }
  }

  /** Raise the takeover gate and tell the UI. Every `onWriterReplaced` this class
   *  emits goes through here, so the gate and the callback can never disagree. */
  private gateOnWriterReplaced(): void {
    this.writerGated = true;
    this.onWriterReplaced?.();
  }

  /** THE invariant: while gameplay is unavailable, a recovery attempt is always
   *  pending.
   *
   *  Every pause path used to be responsible for arming its own retry, and several of
   *  them didn't — a 409 whose reload bootstrap threw, a recovery that lost the race to
   *  `recoveryInFlight`, a `retry()` that returned early under `navigator.onLine`
   *  false. Each left the queue paused with no timer, no dialog and a perfectly healthy
   *  connection: the farm answers every tap with "Gameplay paused — reconnect to
   *  continue" until the player reloads by hand, while the lease stays live (other
   *  writer-protected routes keep renewing it) and the account version never moves.
   *  That is the reported signature exactly. Enforcing the invariant in one place
   *  retires the whole class rather than the three instances of it I could find.
   *
   *  Two states are deliberately excluded, because retrying fixes neither and both are
   *  the player's to resolve: signed out, and the takeover gate. */
  private ensureRecoveryArmed(): void {
    if (this.available || this.writerGated || !api.getSession()) return;
    this.scheduleRecovery();
  }

  /** Whether the invariant above is holding RIGHT NOW, for the diagnostics report. The
   *  reported signature — a paused farm, a live lease, an account version that has not
   *  moved in an hour — is indistinguishable from a healthy pause without this. */
  get recoveryState(): string {
    if (this.available) return "running";
    if (this.writerGated) return "gated on another device (no retry by design)";
    if (!api.getSession()) return "signed out (no retry by design)";
    if (this.recoveryInFlight) return "recovering now";
    return this.recoveryTimer ? `retry armed (attempt ${this.recoveryAttempt + 1})` : "STALLED: nothing pending";
  }

  /** A tap on a paused farm. The player pressing a dead board is the most reliable
   *  signal that a stall is happening, and the least tolerable moment to keep waiting
   *  out a backoff, so a refused interaction pulls the next attempt forward instead of
   *  merely reporting the pause. */
  nudgeRecovery(): void {
    if (this.available || this.writerGated || this.recoveryInFlight) return;
    if (!api.getSession()) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    void this.recover();
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer || typeof window === "undefined") return;
    const delays = [2_000, 5_000, 10_000, 30_000, 60_000];
    const delay = delays[Math.min(this.recoveryAttempt, delays.length - 1)];
    crumb("queue:retry-armed", `in ${Math.round(delay / 1000)}s (attempt ${this.recoveryAttempt + 1})`);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.recover();
    }, delay);
  }

  private async recover(): Promise<void> {
    // A resume can race the backoff timer; one recovery attempt at a time. Bailing
    // here is safe only because the attempt already running re-arms in its own
    // `finally` — the timer that fired to get here has already cleared itself, so
    // while the re-arm lived on the exit paths below, losing this race quietly ended
    // the loop.
    if (this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    crumb("queue:recovering");
    try {
      let bootstrap = await api.bootstrap(true);
      bootstrap = await this.recoverResumableRaid(bootstrap);
      this.queue.adoptBootstrap(bootstrap);
      this.ready = true;
      this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
      this.syncOwnershipPolling(bootstrap.writer.status);
      if (this.queue.size === 0) this.onAuthoritativeSettled?.(bootstrap.serverTime);
      if (!this.queue.available) {
        // Another live device owns the lease: the takeover gate owns this state, so
        // stop retrying and let the player decide.
        if (bootstrap.writer.status === "other") { this.gateOnWriterReplaced(); return; }
        if (bootstrap.writer.status === "free" &&
            await this.reclaimFreeWriter(bootstrap.writer.generation)) return;
        // Still paused (mutations disabled server-side, protocol skew, or a lost claim
        // race). Widen the backoff; the `finally` keeps it armed.
        this.recoveryAttempt++;
        return;
      }
      await this.queue.retry();
      // Reset the ladder on GAMEPLAY coming back, not on the bootstrap succeeding.
      // `retry()` can decline (offline, a lost lease) or re-pause inside the flush it
      // starts, and a condition that answers every bootstrap cheerfully and every batch
      // with a conflict then resets the counter on each pass — pinning recovery at its
      // shortest delay and turning the backoff into a poll.
      if (this.available) this.recoveryAttempt = 0;
      else this.recoveryAttempt++;
    } catch {
      this.recoveryAttempt++;
    } finally {
      this.recoveryInFlight = false;
      // The invariant, enforced on EVERY exit — including the early returns above and
      // any added later. Nothing in this method may leave gameplay paused with no
      // attempt pending.
      this.ensureRecoveryArmed();
    }
  }

  /** A CAS race resolves in ONE reload: bootstrap replaces the projection, the rebase
   *  rebuilds the envelope against the new version, and the retry lands. So a conflict
   *  that keeps coming back is not a race that can be won by trying harder — it is a
   *  standing condition (an operation marker the server has not expired yet, another
   *  writer mid-handoff), and retrying it immediately is a hot loop: each turn spends a
   *  bootstrap and a batch, applies nothing, and renews the lease on the way past, so
   *  the account looks alive from the outside while its version never moves. Past this
   *  burst the conflict is handed to the ordinary recovery backoff. */
  private static readonly CONFLICT_RELOAD_BURST = 3;

  private async reloadAfterConflict(): Promise<void> {
    if (this.conflictReloading) return;
    this.conflictReloading = true;
    try {
      let bootstrap = await api.bootstrap(true);
      bootstrap = await this.recoverResumableRaid(bootstrap);
      this.queue.rebaseAfterConflict(bootstrap);
      this.ready = true;
      this.optimistic.clear();
      this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
      this.syncOwnershipPolling(bootstrap.writer.status);
      if (++this.conflictReloads > EconomyClient.CONFLICT_RELOAD_BURST) {
        this.recoveryAttempt++;
        this.queue.disable("state_conflict_loop");
        return;
      }
      await this.queue.retry();
    } catch {
      // This bootstrap failing is ordinary — it runs over the same network the batch
      // just failed on. What was not ordinary is that reporting it used to be ALL that
      // happened: the 409 had already paused the queue without emitting
      // `onUnavailable`, so nothing was ever scheduled and the farm stayed dead until
      // the player reloaded by hand. The `finally` now guarantees the retry.
      this.recoveryAttempt++;
      this.onGameplayUnavailable?.("state_conflict");
    } finally {
      this.conflictReloading = false;
      this.ensureRecoveryArmed();
    }
  }

  private enqueue(command: GameplayCommand, delta: Partial<OptimisticDelta> = {}): number | null {
    if (this.options.requireReady && !this.available) {
      this.onGameplayUnavailable?.("gameplay_unavailable");
      this.nudgeRecovery();
      return null;
    }
    try {
      const sequence = this.queue.enqueue(command);
      this.commandsBySequence.set(sequence, command);
      this.optimistic.set(sequence, {
        gold: delta.gold ?? 0,
        brains: delta.brains ?? 0,
        xp: delta.xp ?? 0,
        inventoryKey: delta.inventoryKey,
        inventoryCount: delta.inventoryCount,
        localUnitId: delta.localUnitId,
        localZombieHarvests: delta.localZombieHarvests,
        localObjectId: delta.localObjectId,
        bossTokens: delta.bossTokens,
        bossTokenRunId: delta.bossTokenRunId,
      });
      this.reconcile();
      return sequence;
    } catch {
      this.onGameplayUnavailable?.("gameplay_unavailable");
      this.nudgeRecovery();
      return null;
    }
  }

  /** Raw client-authored balance changes are intentionally not representable in v3.
   * Callers must use a semantic command or a server-derived quest/raid reward. */
  record(_currency: api.Currency, _delta: number, _reason: string): void {}

  /** Fold a plow/plant into the command already waiting at the back of the outbox.
   *
   *  The farmer emits one of these per plot as it works down the queue, and a drag-paint
   *  stroke can cover the whole board. Unmerged, that is hundreds of semantic commands,
   *  which the Worker's rolling-minute budget cannot pass — so the outbox spends minutes
   *  draining behind 429s, `settle()` holds the next invasion launch behind it, and any
   *  pause along the way strands the rest of the queue. Merged, one stroke is one
   *  command and the whole field clears in a single request.
   *
   *  Only the LAST pending command is a candidate, so a fold can never jump a plot
   *  ahead of a harvest, a purchase, or anything else queued between the two.
   *
   *  Returns the sequence it merged into, or null when it must be enqueued on its own. */
  private coalesceFarmPlot(input: FarmActionInput): number | null {
    let folded: GameplayCommand | null = null;
    const sequence = this.queue.coalesceLast((last) => {
      if (input.type === "plow") {
        if (last.type !== "farm.plow_many" || last.plots.length >= FARM_BULK_LIMIT) return null;
        folded = { ...last, plots: [...last.plots, { oc: input.oc, or: input.or }] };
      } else if (input.type === "plant") {
        // One crop per command: a stroke plants one thing, and a player who switches
        // seed mid-queue simply starts a new command.
        if (last.type !== "farm.plant_many" || last.cropKey !== (input.cropKey ?? "")) return null;
        if (last.plots.length >= FARM_BULK_LIMIT) return null;
        folded = {
          ...last,
          plots: [...last.plots, { oc: input.oc, or: input.or, fertilized: !!input.fertilized }],
        };
      }
      return folded;
    });
    // Keep the rejection-reporting map pointed at what was actually sent, so a refusal
    // names the merged command rather than the one-plot version it started as.
    if (sequence !== null && folded) this.commandsBySequence.set(sequence, folded);
    return sequence;
  }

  submitFarm(input: FarmActionInput, optimistic: { gold?: number; brains?: number; xp?: number }): void {
    // Plow and plant always go out in their BULK form, even for a single plot, so the
    // next plot the farmer finishes has something to fold into.
    if (input.type === "plow" || input.type === "plant") {
      const merged = this.coalesceFarmPlot(input);
      if (merged !== null) {
        // The fold carries the plot's own cost and XP onto the command it joined, so the
        // optimistic balance still moves per plot and still unwinds as one unit.
        const pending = this.optimistic.get(merged);
        if (pending) {
          pending.gold += optimistic.gold ?? 0;
          pending.brains += optimistic.brains ?? 0;
          pending.xp += optimistic.xp ?? 0;
        }
        this.reconcile();
        return;
      }
    }
    const command: GameplayCommand = input.type === "plant"
      ? {
          type: "farm.plant_many",
          cropKey: input.cropKey ?? "",
          plots: [{ oc: input.oc, or: input.or, fertilized: !!input.fertilized }],
        }
      : input.type === "harvest"
        ? { type: "farm.harvest", oc: input.oc, or: input.or }
        : input.type === "remove"
          ? { type: "farm.remove", oc: input.oc, or: input.or }
          : input.type === "move"
            ? { type: "farm.move", oc: input.oc, or: input.or,
                toOc: input.toOc ?? input.oc, toOr: input.toOr ?? input.or }
            : { type: "farm.plow_many", plots: [{ oc: input.oc, or: input.or }] };
    const sequence = this.enqueue(command, { ...optimistic, localUnitId: input.unitId });
    // A harvested zombie is rendered immediately, but its crop-adjacency mutation
    // is server-owned. Do not leave that visible result sitting in the ordinary
    // batching window: reconcile it as soon as network latency allows.
    if (sequence !== null && input.type === "harvest" && input.unitId) void this.queue.flush();
  }

  submitInventory(
    input: InventoryInput,
    optimistic: { count: number; gold?: number; brains?: number; xp?: number }
  ): void {
    if (input.type === "grant") return; // grants are emitted only by server subsystems
    const command: GameplayCommand = input.type === "buy"
      ? { type: "power.buy", key: input.key }
      : { type: "power.use", key: input.key, oc: input.oc, or: input.or, target: input.target };
    const sequence = this.enqueue(command, {
      gold: optimistic.gold,
      brains: optimistic.brains,
      // A farm-wide power (Insta-Harvest / Insta-Plow) pays out gold + XP across
      // every plot it hits; the server owns the real numbers and reconciles.
      xp: optimistic.xp,
      inventoryKey: input.key,
      inventoryCount: optimistic.count,
      localUnitId: input.unitId,
      localZombieHarvests: input.localZombieHarvests,
    });
    // Insta-Harvest can create several zombies whose mutations are all resolved by
    // the server. Flush the single semantic power command immediately for the same
    // reason as an ordinary zombie harvest.
    if (sequence !== null && input.localZombieHarvests?.length) void this.queue.flush();
  }

  submitPower(key: "insta_harvest" | "insta_plow"): void {
    this.enqueue({ type: "power.use", key }, { inventoryKey: key, inventoryCount: -1 });
  }

  /** Returns false ONLY when a combine collection could not be submitted because this
   *  client no longer knows the job's parents (its in-memory record was cleared, or the
   *  pot id moved). That case used to fall through silently: the caller had already
   *  destroyed its pot job and granted an optimistic child, so no command, no rejection
   *  and no rollback meant both parents were simply gone. The caller must undo its
   *  optimistic collection when this returns false. */
  submitRoster(input: RosterInput, optimistic: { gold?: number } = {}): boolean {
    if (input.type === "combineStart") {
      const potId = input.potId ?? "legacy";
      this.combineParents.set(potId, {
        parentAId: input.parentAId,
        parentBId: input.parentBId,
        playerLevel: input.playerLevel,
      });
      this.enqueue({
        type: "roster.combine_start",
        potId,
        parentAId: this.authoritativeUnitId(input.parentAId),
        parentBId: this.authoritativeUnitId(input.parentBId),
        ...(input.playerLevel === undefined ? {} : { playerLevel: input.playerLevel }),
      });
      return true;
    }
    if (input.type === "combineCollect") {
      const potId = input.potId ?? "legacy";
      const parents = this.combineParents.get(potId);
      if (!parents) return false;
      this.enqueue({
        type: "roster.combine",
        potId,
        parentAId: this.authoritativeUnitId(parents.parentAId),
        parentBId: this.authoritativeUnitId(parents.parentBId),
        ...(parents.playerLevel === undefined ? {} : { playerLevel: parents.playerLevel }),
        ...(input.stored ? { stored: true } : {}),
      }, { localUnitId: input.unitId });
      return true;
    }
    if (input.type === "sell") this.enqueue({ type: "roster.sell", unitId: this.authoritativeUnitId(input.unitId) }, optimistic);
    // Grants, casualties, and veterancy come from farm/raid results in v3.
    return true;
  }
  submitRosterStatus(unitId: string, stored: boolean): void {
    this.enqueue({ type: "roster.status", unitId: this.authoritativeUnitId(unitId), stored });
  }

  restoreCombineParents(parentAId: string, parentBId: string): void;
  restoreCombineParents(potId: string, parentAId: string, parentBId: string, playerLevel?: number): void;
  restoreCombineParents(a: string, b: string, c?: string, playerLevel?: number): void {
    const [potId, parentAId, parentBId] = c === undefined ? ["legacy", a, b] : [a, b, c];
    this.combineParents.set(potId, { parentAId, parentBId, playerLevel });
  }

  async settleUnitIds(ids: string[]): Promise<string[]> {
    await this.settleBeforeDependency();
    return ids.map((id) => this.authoritativeUnitId(id));
  }

  submitObject(
    input: { type: "buy" | "refund"; key: string; instanceId?: string } |
      { type: "upgrade"; fromKey: string; toKey: string; instanceId?: string },
    optimistic: { gold?: number; brains?: number; xp?: number }
  ): void {
    if (input.type === "buy") this.enqueue(
      { type: "object.buy", catalogKey: input.key, clientInstanceId: input.instanceId },
      { ...optimistic, localObjectId: input.instanceId }
    );
    else if (input.type === "refund" && input.instanceId) this.enqueue({ type: "object.refund", instanceId: input.instanceId }, optimistic);
    else if (input.type === "upgrade") {
      if (input.instanceId) this.enqueue({ type: "object.upgrade", instanceId: input.instanceId, catalogKey: input.toKey }, optimistic);
    }
  }

  submitObjectStatus(instanceId: string, status: "placed" | "stored"): void {
    this.enqueue({ type: "object.status", instanceId, status });
  }

  /** Move a fallen zombie on or off a Memorial Statue. Server-owned so a visitor
   *  sees the same statue the owner does — the visit projection reads the
   *  authoritative graveyard, never this client's presentation blob. Costs nothing,
   *  so there is no optimistic balance to apply. */
  submitMemorial(command:
    | { type: "memorial.enshrine"; instanceId: string; unitId: string; name?: string }
    | { type: "memorial.clear"; instanceId: string }
  ): void {
    this.enqueue(command);
  }

  submitTreeHarvest(instanceIds: string[], optimisticGold = 0): void {
    if (instanceIds.length) this.enqueue(
      { type: "object.harvest_trees", instanceIds },
      { gold: optimisticGold }
    );
  }

  submitStorageClaim(
    itemName: string,
    optimistic: { inventoryKey?: string; localObjectId?: string }
  ): boolean {
    return this.enqueue(
      { type: "storage.claim", itemName, clientInstanceId: optimistic.localObjectId },
      {
        inventoryKey: optimistic.inventoryKey,
        inventoryCount: optimistic.inventoryKey ? 1 : undefined,
        localObjectId: optimistic.localObjectId,
      }
    ) !== null;
  }

  submitShopSize(size: number, currency: "gold" | "brains", cost: number): boolean {
    return this.enqueue(
      { type: "shop.size", size, currency }, currency === "gold" ? { gold: -cost } : { brains: -cost }
    ) !== null;
  }

  submitFarmerBuy(headId: number, currency: "gold" | "brains", cost: number, xp: number): boolean {
    return this.enqueue(
      { type: "farmer.buy", headId },
      currency === "gold" ? { gold: -cost, xp } : { brains: -cost, xp }
    ) !== null;
  }

  submitFarmerEquip(headId: number): boolean {
    return this.enqueue({ type: "farmer.equip", headId }) !== null;
  }

  submitFarmerBonus(headId: number | null): boolean {
    return this.enqueue({ type: "farmer.bonus", headId }) !== null;
  }

  submitPetBuy(petKey: string, cost: number, xp: number): boolean {
    return this.enqueue({ type: "pet.buy", petKey }, { brains: -cost, xp }) !== null;
  }

  submitPetEquip(petKey: string | null): boolean {
    return this.enqueue({ type: "pet.equip", petKey }) !== null;
  }

  submitPenPets(petKeys: string[]): boolean {
    return this.enqueue({ type: "pet.pen", petKeys }) !== null;
  }

  submitShopClimate(terrain: string, cost: number): boolean {
    return this.enqueue({ type: "shop.climate", terrain }, { gold: -cost }) !== null;
  }

  submitTutorialCompletion(): void {
    this.enqueue({ type: "tutorial.complete" }, { gold: 200 });
  }

  /** Report a Boss Token the client rolled on a harvest. The token is already showing
   *  on the farm; this only records it, and the server does not second-guess the roll.
   *
   *  Folded into a pending grant for the same run exactly like a drag-paint stroke:
   *  an Insta-Harvest over a full field can turn up a dozen tokens in one frame, and
   *  the Worker's budget counts SEMANTIC commands. */
  submitEpicBossToken(runId: string, count = 1): void {
    if (!runId || count < 1) return;
    let folded: GameplayCommand | null = null;
    const merged = this.queue.coalesceLast((last) => {
      if (last.type !== "epicBoss.token" || last.runId !== runId) return null;
      if ((last.count ?? 1) + count > EPIC_BOSS_TOKEN_GRANT_LIMIT) return null;
      folded = { ...last, count: (last.count ?? 1) + count };
      return folded;
    });
    if (merged !== null && folded) {
      const pending = this.optimistic.get(merged);
      if (pending) pending.bossTokens = (pending.bossTokens ?? 0) + count;
      this.commandsBySequence.set(merged, folded);
      return;
    }
    this.enqueue({ type: "epicBoss.token", runId, count }, { bossTokens: count, bossTokenRunId: runId });
  }

  submitQuest(_questId: string): void {
    // Completion and reward happen inside the accepted command/raid transaction.
  }

  /** Collect a finished daily/weekly quest. Unlike the catalog quests above this IS a
   *  real command, because a periodic reward is only paid when the player asks for it.
   *
   *  Flushed immediately rather than batched: the player pressed a button expecting XP,
   *  and the reward is refused outright once the period rolls over — so a claim sitting
   *  in a 30s window near midnight would be silently worth nothing. */
  submitPeriodicQuestClaim(scope: "daily" | "weekly", questId: string, xp: number): boolean {
    const sequence = this.enqueue({ type: "quest.periodic_claim", scope, questId }, { xp });
    if (sequence === null) return false;
    void this.queue.flush();
    return true;
  }

  /** Ask the server to derive the daily/weekly board this client just generated for
   *  itself (PeriodicQuestSystem.authorDue). Flushed immediately, like the claim: the
   *  board is already on screen, and its counts only start moving once the server has
   *  installed the same one. */
  submitPeriodicQuestAuthor(scope: "daily" | "weekly", level: number): boolean {
    const sequence = this.enqueue({ type: "quest.periodic_author", scope, level });
    if (sequence === null) return false;
    void this.queue.flush();
    return true;
  }

  async submitRaid(
    sessionId: string,
    finalTick: number,
    inputs: api.RaidReplayInput[],
    outcome: RaidOutcome,
    _optimistic: { gold?: number; xp?: number }
  ): Promise<api.RaidFinishResult> {
    const pending: PendingRaidFinish = { sessionId, finalTick, inputs, outcome, savedAt: Date.now() };
    this.persistPendingRaid(pending);
    let result: api.RaidFinishResult;
    try {
      result = await this.sendRaidFinish(pending);
      this.clearPendingRaid(sessionId);
    } catch (error) {
      // Transport/writer contention leaves the server session resumable. Preserve the
      // exact transcript and let reconnect/bootstrap retry it instead of turning a
      // completed invasion into a retreat.
      if (this.raidFinishRetryable(error) || (error instanceof api.ApiError && error.status === 423)) {
        this.scheduleRecovery();
      } else {
        this.clearPendingRaid(sessionId);
      }
      throw error;
    }
    // An EXPIRED session settles with a body carrying none of these — no balance, no
    // lastRaidAt, no outcome — because the server zeroes it without replaying the
    // fight. Adopting them unconditionally set `base` to undefined (silently skipping
    // every later reconcile) and pushed NaN through the cooldown clock. Guard them the
    // way the other two settlement call sites already do.
    if (result.balance) this.base = result.balance;
    if (result.inventory) this.serverInv = { ...result.inventory };
    if (result.storage) this.state.syncStorage(result.storage.received, result.storage.stored);
    if (result.raidProgress) this.state.syncRaidProgress(result.raidProgress);
    if (result.lastRaidAt != null) this.state.syncRaidCooldown(serverTimestampToClient(
      result.lastRaidAt,
      result.serverTime ?? Date.now(),
    ));
    this.onQuestChanges?.(result.questChanges ?? []);
    // An invasion win is the only thing that can advance an invasion daily, and it
    // never crosses the command lane — so this settlement is the sole place the
    // periodic panel learns about it.
    if (result.periodicQuests !== undefined) this.onPeriodicQuestState?.(result.periodicQuests);
    this.reconcile();
    this.onRaidSettled?.(result);
    return result;
  }

  async resolveRaidRevival(sessionId: string, reviveIds: string[]): Promise<api.RaidReviveResult> {
    const result = await api.raidRevive(sessionId, reviveIds);
    this.base = result.balance;
    this.reconcile();
    return result;
  }

  async flush(): Promise<void> { await this.queue.flush(); }
  /** The sync indicator was pressed. Sends whatever is waiting right now; while a
   *  batch is already on the wire the press does nothing ("busy"). A paused farm gets
   *  its next recovery attempt pulled forward instead, which is itself one-at-a-time. */
  syncNow(): "sent" | "busy" | "idle" | "paused" {
    if (!this.available) {
      this.nudgeRecovery();
      return "paused";
    }
    if (this.queue.sendNow()) return "sent";
    return this.queue.size > 0 ? "busy" : "idle";
  }
  async settleBeforeDependency(): Promise<void> {
    try {
      await this.queue.settle();
      return;
    } catch (error) {
      // A bootstrap/network failure can leave an otherwise empty durable queue paused.
      // Out-of-band mutations (gift claims, raids, Epic Boss actions) used to remain
      // blocked behind that stale flag even after connectivity returned. With no local
      // commands to preserve, a fresh bootstrap is a safe immediate recovery boundary.
      if (this.queue.size > 0) throw error;
    }

    const bootstrap = await api.bootstrap(true);
    this.queue.adoptBootstrap(bootstrap);
    this.ready = true;
    this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
    this.syncOwnershipPolling(bootstrap.writer.status);
    if (bootstrap.writer.status !== "mine") {
      this.gateOnWriterReplaced();
      throw new Error("writer_replaced");
    }
    // Re-check the queue state so maintenance mode, a protocol gate, or ownership
    // loss still blocks the external mutation instead of bypassing server authority.
    await this.queue.settle();
  }

  /** Establish a fresh CAS boundary for a direct cross-account mutation. Market
   * actions deliberately do not auto-replay after this version is observed. */
  async prepareExternalMutation(): Promise<number> {
    await this.queue.settle();
    const bootstrap = await api.bootstrap(true);
    this.queue.adoptBootstrap(bootstrap);
    this.ready = true;
    this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
    this.syncOwnershipPolling(bootstrap.writer.status);
    if (bootstrap.writer.status !== "mine") throw new Error("writer_replaced");
    return bootstrap.accountVersion;
  }

  adoptRaidStartInventory(inventory: Record<string, number>): void {
    this.serverInv = { ...inventory };
    this.reconcile();
  }

  adoptEpicBossResult(result: api.EpicBossFinishResult): void {
    this.base = result.balance;
    this.serverInv = { ...result.inventory };
    this.state.syncStorage(result.storage.received, result.storage.stored);
    this.onPetState?.(result.ownedPets, this.state.activePet, this.state.penPets);
    // Changes BEFORE the wholesale adopt. restoreAuthoritative installs the server's
    // `completed` set, and applyAuthoritativeChanges only celebrates a quest it did not
    // already consider complete — so the old order silently swallowed the completion
    // popup for every epic-boss quest, including the one handing over the event's
    // signature zombie. The raid lane (submitRaid) posts changes alone for this reason.
    this.onQuestChanges?.(result.questChanges);
    this.onQuestState?.({ completed: result.quests.completed, progress: result.quests.progress, questChanges: result.questChanges });
    const serverTime = result.serverTime ?? Date.now();
    this.onEpicBossState?.(this.withPendingBossTokens(epicBossRunToClient(result.event, serverTime)));
    if (result.lastRaidAt != null) this.state.syncRaidCooldown(serverTimestampToClient(
      result.lastRaidAt,
      serverTime,
    ));
    this.reconcile();
  }

  adoptEpicBossActivation(
    event: NonNullable<BootstrapResponse["gameplay"]["epicBoss"]>,
    balance: api.Balance,
    serverTime = Date.now(),
    /** Sent when the activation re-opened this boss's finished quests. */
    quests?: import("./protocol").QuestProjection,
  ): void {
    this.base = balance;
    this.onEpicBossState?.(this.withPendingBossTokens(epicBossRunToClient(event, serverTime)));
    // After onEpicBossState, never before: that call is what marks the event active,
    // and a reopened epic quest is only eligible for the rail while it is.
    if (quests) this.onQuestState?.({ completed: quests.completed, progress: quests.progress, questChanges: [] });
    this.reconcile();
  }

  /** Translate an optimistic harvest id after its command has settled. */
  authoritativeUnitId(id: string): string {
    return this.authoritativeUnitIds.get(id) ?? id;
  }

  async refreshInventory(): Promise<void> {
    let bootstrap = await api.bootstrap(true);
    bootstrap = await this.recoverResumableRaid(bootstrap);
    this.queue.adoptBootstrap(bootstrap);
    this.ready = true;
    this.adoptGameplay(bootstrap.gameplay, {}, {}, [], bootstrap.serverTime);
    this.syncOwnershipPolling(bootstrap.writer.status);
  }
  async refreshAuthoritative(): Promise<void> { await this.refreshInventory(); }

  private pendingRaidKey(): string { return `${RAID_FINISH_PREFIX}::${this.accountId}`; }

  private persistPendingRaid(value: PendingRaidFinish): void {
    try { localStorage.setItem(this.pendingRaidKey(), JSON.stringify(value)); }
    catch { /* the live retry path still works when storage is unavailable */ }
  }

  private readPendingRaid(): PendingRaidFinish | null {
    try {
      const value = JSON.parse(localStorage.getItem(this.pendingRaidKey()) ?? "null") as PendingRaidFinish | null;
      if (!value || typeof value.sessionId !== "string" || !Number.isInteger(value.finalTick) ||
          !Array.isArray(value.inputs) || !value.outcome || typeof value.outcome.win !== "boolean") return null;
      return value;
    } catch {
      return null;
    }
  }

  private clearPendingRaid(sessionId?: string): void {
    const current = this.readPendingRaid();
    if (sessionId && current && current.sessionId !== sessionId) return;
    try { localStorage.removeItem(this.pendingRaidKey()); } catch { /* unavailable */ }
  }

  private raidFinishRetryable(error: unknown): boolean {
    if (!(error instanceof api.ApiError)) return false;
    return error.status === 0 || error.status === 408 || error.status === 425 || error.status === 429 ||
      error.status >= 500 || error.code === "operation_in_progress" ||
      error.code === "state_conflict" || error.code === "future_finish";
  }

  private async sendRaidFinish(pending: PendingRaidFinish): Promise<api.RaidFinishResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.raidFinish(pending.sessionId, pending.finalTick, pending.inputs, pending.outcome);
      } catch (error) {
        if (!this.raidFinishRetryable(error) || attempt === RAID_FINISH_RETRY_MS.length) throw error;
        const retryAfterMs = Number((error as api.ApiError).body &&
          ((error as api.ApiError).body as { retryAfterMs?: unknown }).retryAfterMs);
        const delay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? retryAfterMs + 250
          : RAID_FINISH_RETRY_MS[attempt];
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** Mark the invasion this document is currently playing, so a mid-fight bootstrap
   * cannot mistake it for an abandoned session. Cleared when its finish is submitted
   * (from then on the persisted pending transcript is what recovery resends) or when a
   * launch is aborted before the battle scene comes up. */
  setLiveRaid(sessionId: string | null): void {
    this.liveRaidSessionId = sessionId;
  }

  /** Resolve a server session discovered by bootstrap. A durable completed transcript
   * wins over the old crash fallback; only a genuinely abandoned session retreats.
   *
   * `mayAbandon` is the whole safety property here, so it is OFF by default and passed
   * only by start(). Abandoning means posting a tick-0 retreat, which settles the fight
   * at zero — correct for a session orphaned by a previous page load, catastrophic for
   * one that is being played right now. Every other caller (the recovery backoff, the
   * iOS writer re-claim, the CAS reload, refreshAuthoritative) runs MID-SESSION and used
   * to do exactly that: the player then won, /raid/finish replayed the stored zero
   * result, and the victory panel patched itself to 0 gold / 0 brains / no loot with no
   * error shown. Those callers keep the half that is always safe — resending a completed
   * transcript whose POST failed. */
  private async recoverResumableRaid(
    bootstrap: BootstrapResponse,
    mayAbandon = false
  ): Promise<BootstrapResponse> {
    if (bootstrap.writer.status !== "mine") return bootstrap;
    const pending = this.readPendingRaid();
    const resumable = bootstrap.resumableRaid;
    if (!resumable) {
      if (pending) this.clearPendingRaid(pending.sessionId);
      return bootstrap;
    }
    if (pending?.sessionId === resumable.sessionId) {
      // Every one of these throws used to propagate, and this runs inside EVERY
      // bootstrap — boot, the recovery backoff, the CAS reload, the writer re-claim,
      // refreshAuthoritative. A finish the server will never accept (400
      // `bad_roster_partition`, or a persisted outcome a newer bundle validates
      // differently) therefore failed the whole bootstrap, and because the throw jumped
      // over `clearPendingRaid` the same transcript was still there to fail the next
      // one. Nothing else settles the session either, so the account could not load at
      // all until the server's own 15-minute session TTL expired it — a quarter of an
      // hour of "reconnecting" for a fight the player had already finished.
      try {
        await this.sendRaidFinish(pending);
        this.clearPendingRaid(pending.sessionId);
      } catch (error) {
        // Retryable means the transcript is still good and only the wire failed: keep
        // it and let the backoff bring us back. Anything else will be refused for as
        // long as it exists, so it is dropped — the fight's rewards are lost either
        // way, and keeping it only spreads that loss over everything else.
        if (this.raidFinishRetryable(error)) this.scheduleRecovery();
        else this.clearPendingRaid(pending.sessionId);
        return bootstrap;
      }
    } else {
      // Second gate, independent of the caller: a session this document is fighting is
      // never abandonable, even from a boot-time bootstrap.
      if (!mayAbandon || this.liveRaidSessionId === resumable.sessionId) return bootstrap;
      if (pending) this.clearPendingRaid(pending.sessionId);
      // Same rule for the abandon: settling someone else's orphaned session is a
      // courtesy, and it must not be able to stop this document from booting.
      try {
        await api.raidFinish(resumable.sessionId, 0, [{ seq: 1, tick: 0, type: "retreat" }]);
      } catch {
        return bootstrap;
      }
    }
    return api.bootstrap(true);
  }

  /** Claiming a social gift is an independent, server-fenced mutation. It must not
   * wait on the gameplay writer queue: another tab may own that queue, and a paused
   * durable command must not prevent this account from receiving its gift. */
  async claimGift(giftId: string) {
    let result: Awaited<ReturnType<typeof api.claimGift>> | undefined;
    let lastError: unknown;
    // A command batch owns the account fence only briefly. Claims are idempotent,
    // so retry a transient collision instead of making the player click again.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await api.claimGift(giftId);
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof api.ApiError) || error.code !== "operation_in_progress" || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    if (!result) throw lastError ?? new Error("gift_claim_failed");
    this.adoptExternalBalance(result.balance, result.accountVersion);
    return result;
  }

  /** Adopt a balance returned by a trusted server-side mutation such as claiming a
   * social gift. Pending optimistic gameplay deltas remain layered on top. */
  adoptExternalBalance(balance: api.Balance, accountVersion?: number): void {
    this.base = { ...balance };
    if (accountVersion !== undefined) this.queue.adoptAccountVersion(accountVersion);
    this.reconcile();
  }

  // Reset means there is no client seed/import path. These remain as no-ops until
  // their call sites are removed from the presentation hydration code.
  async syncRoster(_units: api.RosterSeedUnit[]): Promise<void> {}
  async syncObjects(_counts: Record<string, number>): Promise<void> {}
  async syncFarm(_plowed: { oc: number; or: number }[]): Promise<void> {}
  async syncShop(_size: number, _climates: string[]): Promise<void> {}

  private adoptCommandResponse(response: CommandBatchResponse): void {
    // An applied batch is the only proof the conflict cleared, so it is the only thing
    // allowed to re-open the reload burst.
    this.conflictReloads = 0;
    const aliases: Record<string, string> = {};
    const objectAliases: Record<string, string> = {};
    const rejectedObjectIds: string[] = [];
    for (const result of response.results) {
      const pending = this.optimistic.get(result.sequence);
      const command = this.commandsBySequence.get(result.sequence);
      if ((result.status === "rejected" || result.status === "dependency_failed") && result.error) {
        if (command?.type === "roster.combine_start") this.combineParents.delete(command.potId);
        this.onCommandRejected?.(command, result.error);
      }
      // A bulk farm command that mostly worked. Report it once with the plot count, so
      // "you ran out of gold twelve plots into the field" reaches the player without
      // twelve separate toasts — and without the silence a per-plot-only path would give.
      if (result.status === "applied" && result.rejectedPlots) {
        this.onBulkFarmPartial?.(result.rejectedPlots, result.rejectedPlotError ?? "no_effect");
      }
      if (result.status === "applied" && command?.type === "roster.combine") {
        this.combineParents.delete(command.potId ?? "legacy");
      }
      if (pending?.localUnitId && result.status === "applied" && result.createdIds?.[0]) {
        aliases[result.createdIds[0]] = pending.localUnitId;
        this.authoritativeUnitIds.set(pending.localUnitId, result.createdIds[0]);
      }
      if (pending?.localZombieHarvests?.length && result.createdZombieSources?.length) {
        const localByPlot = new Map(pending.localZombieHarvests.map((item) => [`${item.oc}:${item.or}`, item.id]));
        for (const created of result.createdZombieSources) {
          const local = localByPlot.get(`${created.oc}:${created.or}`);
          if (!local) continue;
          aliases[created.id] = local;
          this.authoritativeUnitIds.set(local, created.id);
        }
      }
      if (pending?.localObjectId && result.status === "applied" && result.createdIds?.[0] &&
          result.createdIds[0] !== pending.localObjectId) {
        objectAliases[result.createdIds[0]] = pending.localObjectId;
      }
      if (pending?.localObjectId && (result.status === "rejected" || result.status === "dependency_failed")) {
        rejectedObjectIds.push(pending.localObjectId);
      }
      this.optimistic.delete(result.sequence);
      this.commandsBySequence.delete(result.sequence);
    }
    Object.assign(this.deferredRosterAliases, aliases);
    Object.assign(this.deferredObjectAliases, objectAliases);
    rejectedObjectIds.forEach((id) => this.deferredRejectedObjectIds.add(id));
    this.onQuestChanges?.(response.questChanges);
    this.adoptGameplay(response.gameplay, aliases, objectAliases, rejectedObjectIds, response.serverTime);
    if (this.queue.size === 0) this.onAuthoritativeSettled?.(response.serverTime);
  }

  private adoptGameplay(
    gameplay: BootstrapResponse["gameplay"],
    aliases: Record<string, string> = {},
    objectAliases: Record<string, string> = {},
    rejectedObjectIds: string[] = [],
    serverTime = Date.now(),
  ): void {
    this.base = gameplay.balance;
    this.serverInv = gameplay.inventory;
    this.state.zombiePotBought = gameplay.zombiePotBought ?? false;
    this.state.syncRaidProgress(gameplay.raids.progress);
    this.state.syncRaidCooldown(serverTimestampToClient(gameplay.raids.lastRaidAt, serverTime));
    // Outside the deferStructural gate below: periodic quests are pure display state
    // with no dependency on the farm reconcile, so holding them back would leave the
    // panel stale for the whole time a structural pass is in flight.
    this.onPeriodicQuestState?.(gameplay.periodicQuests ?? null);
    const deferStructural = this.commandsBySequence.size > 0;
    const plowed: api.FarmState["plowed"] = [];
    const spent: NonNullable<api.FarmState["spent"]> = [];
    const crops: api.FarmState["crops"] = [];
    // Farm growth uses the local wall clock. Translate server-authored timestamps
    // into that clock domain so clock skew cannot make an acknowledged Insta-Grow
    // briefly appear unripe (or skew every ordinary crop countdown).
    const clientTime = Date.now();
    for (const [key, plot] of Object.entries(gameplay.farm.plots)) {
      const [oc, pr] = key.split(":").map(Number);
      if (plot.state === "plowed") plowed.push({ oc, pr });
      else if (plot.state === "spent") spent.push({ oc, pr, zombie: !!plot.zombie });
      else if (plot.state === "planted") {
        crops.push({
          oc,
          pr,
          crop_key: plot.cropKey,
          planted_at: serverTimestampToClient(plot.plantedAt, serverTime, clientTime),
          grow_ms: plot.growMs,
          fertilized: plot.fertilized ? 1 : 0,
        });
      }
    }
    if (!deferStructural) {
      this.onShopState?.(gameplay.farmSize, gameplay.climates);
      this.onFarmerState?.(gameplay.farmerHeads, gameplay.farmerHeadId, gameplay.farmerBonusHeadId);
      this.onPetState?.(gameplay.ownedPets, gameplay.activePet, gameplay.penPets);
      this.onQuestState?.({
        completed: gameplay.quests.completed,
        progress: gameplay.quests.progress,
        questChanges: [],
      });
      this.state.syncStorage(gameplay.storage.received, gameplay.storage.stored);
      for (const crop of crops) if (crop.fertilized) this.onCropFertilized?.(crop.oc, crop.pr);
      this.onFarmState?.({ plowed, spent, crops });
      const objectAliasesForPass = { ...this.deferredObjectAliases, ...objectAliases };
      const objectPass = this.onObjectState?.(
        gameplay.objects.objects.map((object) => object.readyAt === undefined ? object : ({
          ...object,
          readyAt: serverTimestampToClient(object.readyAt, serverTime, clientTime),
        })),
        objectAliasesForPass,
        gameplay.zombieMax,
        [...new Set([...this.deferredRejectedObjectIds, ...rejectedObjectIds])]
      );
      // The reconcile is async. Clearing the alias map here — as this used to — discarded
      // it the moment that reconcile awaited a texture, so a pass superseded mid-flight
      // lost the only mapping from a server-minted instance id to the local object holding
      // its position. Positions live nowhere else, so the object could never be drawn
      // again: the player had paid for something permanently invisible. Retain each alias
      // until a pass reports it consumed them, and drop only the keys actually delivered
      // so an alias learned since this pass started survives.
      void Promise.resolve(objectPass)
        .then((consumed) => {
          if (consumed === false) return;
          for (const id of Object.keys(objectAliasesForPass)) delete this.deferredObjectAliases[id];
        })
        .catch(() => {});
      // Rejections are applied before the reconcile's first await, so they are always
      // consumed. Re-delivering one could delete a later object that reused the freed id.
      this.deferredRejectedObjectIds.clear();
      // Capture/display a pending revival before roster reconciliation removes the
      // casualties from the local presentation cache. The offer remains server-owned.
      if (gameplay.raidRevival) this.onRaidRevival?.(gameplay.raidRevival, gameplay.balance.brains);
      this.onRosterState?.(
        gameplay.roster,
        { ...this.deferredRosterAliases, ...aliases },
        this.queue.size === 0,
      );
      this.deferredRosterAliases = {};
      this.onEpicBossState?.(this.withPendingBossTokens(
        epicBossRunToClient(gameplay.epicBoss, serverTime, clientTime)
      ));
      this.onTutorialState?.(gameplay.tutorialRewarded);
    }
    this.reconcile();
  }

  /** Layer still-unsent Boss Tokens back onto an authoritative run.
   *
   *  The client mints these itself (submitEpicBossToken) and shows them immediately, so
   *  a projection built before the grant reached the server legitimately does not know
   *  about them; adopting it raw would drop the counter back and then re-climb it.
   *  adoptGameplay's structural defer gate hides most of those, but the direct epic-boss
   *  adopts (activation, fight result) have no such gate. Grants naming a different run
   *  are dropped — that event is over, and its tokens with it. */
  private withPendingBossTokens(
    run: ReturnType<typeof epicBossRunToClient>
  ): ReturnType<typeof epicBossRunToClient> {
    if (!run || run.completedAt || Date.now() >= run.expiresAt) return run;
    let pending = 0;
    for (const delta of this.optimistic.values()) {
      if (delta.bossTokens && delta.bossTokenRunId === run.runId) pending += delta.bossTokens;
    }
    return pending ? { ...run, tokenCount: run.tokenCount + pending } : run;
  }

  private reconcile(): void {
    if (!this.base) return;
    const balance = { ...this.base };
    const inventory = { ...this.serverInv };
    for (const delta of this.optimistic.values()) {
      balance.gold += delta.gold;
      balance.brains += delta.brains;
      balance.xp += delta.xp;
      if (delta.inventoryKey) inventory[delta.inventoryKey] = (inventory[delta.inventoryKey] ?? 0) + (delta.inventoryCount ?? 0);
    }
    this.state.syncBalance(balance.gold, balance.brains, balance.xp);
    this.state.syncInventory(inventory);
  }
}
