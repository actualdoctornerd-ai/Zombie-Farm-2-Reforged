import * as api from "./api";
import { crumb } from "../breadcrumbs";
import {
  COMMAND_BATCH_LIMIT,
  COMMAND_BATCH_WINDOW_MS,
  GAMEPLAY_PROTOCOL,
  type BootstrapResponse,
  type CommandBatchRequest,
  type CommandBatchResponse,
  type GameplayCommand,
  type SequencedCommand,
} from "./protocol";

interface StoredQueue {
  nextSequence: number;
  queuedAt: number;
  pending: SequencedCommand[];
  inFlight: CommandBatchRequest | null;
  accountVersion?: number;
  writerGeneration?: number;
  writerLost?: boolean;
}

interface QueueOptions {
  windowMs?: number;
  random?: () => number;
  now?: () => number;
}

const OUTBOX_PREFIX = "zf2r.online.outbox.v1";
const LEGACY_OUTBOX_PREFIX = "zf2r.v3.commands";
// The Worker accepts at most 120 semantic commands per rolling minute. Sending
// 60 per 30-second window leaves rapid optimistic purchases below that limit.
const COMMAND_SEND_LIMIT = Math.min(COMMAND_BATCH_LIMIT, 60);
const uuid = (): string => crypto.randomUUID();

/** One durable, ordered mutation lane for every non-raid gameplay command. */
export class CommandQueue {
  private nextSequence = 1;
  private queuedAt = 0;
  private pending: SequencedCommand[] = [];
  private inFlight: CommandBatchRequest | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private accountVersion = 0;
  private writerGeneration = 0;
  private takeWriter = false;
  private paused = false;
  private pausedReason = "";
  private writerLost = false;
  private readonly windowMs: number;
  private readonly random: () => number;
  private readonly now: () => number;

  onProjection: ((response: CommandBatchResponse) => void) | null = null;
  onUnavailable: ((reason: string) => void) | null = null;
  onWriterReplaced: (() => void) | null = null;
  onStateConflict: (() => void) | null = null;
  onSizeChange: ((size: number) => void) | null = null;

  constructor(private readonly accountId: string, options: QueueOptions = {}) {
    this.windowMs = options.windowMs ?? COMMAND_BATCH_WINDOW_MS;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.restore();
    if (typeof addEventListener === "function") {
      addEventListener("online", () => { if (this.paused) void this.retry(); });
      addEventListener("beforeunload", () => { void this.flush(); });
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void this.flush();
      });
    }
  }

  adoptBootstrap(value: BootstrapResponse): void {
    const localGeneration = this.writerGeneration;
    this.accountVersion = value.accountVersion;
    this.writerGeneration = value.writerGeneration;
    const mine = value.writer ? value.writer.status === "mine" :
      value.writerDeviceId === null || value.writerDeviceId === api.deviceId();
    if (value.writer && mine && this.size > 0 && localGeneration !== value.writerGeneration) this.discardPending();
    this.takeWriter = value.writer ? false : value.writerDeviceId === null || (!mine && !this.writerLost && localGeneration === 0);
    this.setPaused(this.bootstrapPauseReason(value, mine));
    if (value.writer && !mine) this.discardPending();
    if (mine) this.writerLost = false;
    this.persist();
    this.scheduleFromFirstCommand();
  }

  /** Why a bootstrap projection leaves the queue paused, or "" for playable. */
  private bootstrapPauseReason(value: BootstrapResponse, mine: boolean): string {
    if (!value.mutationsEnabled) return "mutations_disabled";
    if (value.minimumProtocolVersion > GAMEPLAY_PROTOCOL) return "update_required";
    return mine ? "" : "writer_elsewhere";
  }

  /** The single place `paused` is assigned, so no path can pause without saying why.
   *  The reason is diagnostic only — nothing branches on it. */
  private setPaused(reason: string): void {
    // Crumb the TRANSITION, not the state: this is called on every bootstrap, and a
    // healthy session would otherwise fill the ring with "still running". "Gameplay
    // paused — reconnect to continue" was reported twice on connections that were
    // demonstrably fine, and the paste could not say which of a dozen paths paused it,
    // whether anything resumed, or how long it had been stuck. Now it can.
    if (!!reason !== this.paused || reason !== this.pausedReason) {
      if (reason) crumb("queue:paused", reason);
      else if (this.paused) crumb("queue:resumed", `after ${this.pausedReason || "unknown"}`);
    }
    this.paused = !!reason;
    this.pausedReason = reason;
  }

  /** A 409 guarantees the submitted batch was not applied. After bootstrap has
   * replaced local projections, rebuild its envelope against the new version while
   * preserving the same ordered semantic commands. */
  rebaseAfterConflict(value: BootstrapResponse): void {
    const uncommitted = this.inFlight?.commands ?? [];
    this.inFlight = null;
    this.pending = [...uncommitted, ...this.pending];
    this.accountVersion = value.accountVersion;
    this.writerGeneration = value.writerGeneration;
    const mine = value.writer ? value.writer.status === "mine" :
      value.writerDeviceId === null || value.writerDeviceId === api.deviceId();
    this.takeWriter = value.writer ? false : value.writerDeviceId === null;
    this.setPaused(this.bootstrapPauseReason(value, mine));
    if (!mine) {
      this.writerLost = true;
      this.discardPending();
      this.onWriterReplaced?.();
    }
    this.queuedAt = this.pending.length ? this.now() - this.windowMs : 0;
    this.persist();
  }

  get available(): boolean { return !this.paused; }
  /** Why the queue is paused, or "" when it is running. Diagnostic only. */
  get pauseReason(): string { return this.paused ? (this.pausedReason || "unknown") : ""; }
  get size(): number { return this.pending.length + (this.inFlight?.commands.length ?? 0); }
  get needsWriterClaim(): boolean { return this.takeWriter; }

  /** Adopt the CAS version returned by a direct server mutation outside this queue.
   * Pending commands have not built their envelope yet and will use this boundary;
   * an already in-flight batch remains immutable and will conflict/rebase if needed. */
  adoptAccountVersion(value: number): void {
    if (!Number.isSafeInteger(value) || value < this.accountVersion) return;
    this.accountVersion = value;
    this.persist();
  }

  markWriterLost(): void {
    this.writerLost = true;
    this.setPaused("writer_lost");
    this.discardPending();
    this.persist();
  }

  enqueue(command: GameplayCommand): number {
    if (this.paused) throw new Error("gameplay_unavailable");
    const sequence = this.nextSequence++;
    if (!this.pending.length) this.queuedAt = this.now();
    this.pending.push({ sequence, command });
    this.persist();
    this.onSizeChange?.(this.size);
    // Keep rapid-fire market purchases fully optimistic. Reaching the wire batch
    // size must not force a request while the player is still clicking; the fixed
    // window drains the durable outbox in bounded batches after the interaction.
    this.scheduleFromFirstCommand();
    return sequence;
  }

  /** Fold a new mutation into the last command that has NOT yet been sent.
   *
   *  `merge` receives that command and returns its replacement, or null to decline —
   *  in which case the caller enqueues normally. Only the very last pending entry is
   *  offered, so merging can never reorder anything: whatever the caller folds in still
   *  lands after every command already ahead of it.
   *
   *  This exists for the drag-paint strokes, which produce one plow/plant per plot and
   *  can cover the entire board. The Worker's rolling-minute budget counts SEMANTIC
   *  commands, so unmerged they cannot fit through it; merged, a whole field is one.
   *
   *  Returns the sequence the command was folded into, or null if it was not merged. */
  coalesceLast(merge: (last: GameplayCommand) => GameplayCommand | null): number | null {
    // A paused queue declines rather than throwing: the caller falls through to
    // `enqueue`, which is the one place that reports `gameplay_unavailable`.
    if (this.paused) return null;
    const last = this.pending[this.pending.length - 1];
    if (!last) return null;
    const merged = merge(last.command);
    if (!merged) return null;
    last.command = merged;
    this.persist();
    // Deliberately no `scheduleFromFirstCommand`: the batch window belongs to the FIRST
    // command in the queue, and a stroke that keeps folding must not keep pushing its
    // own deadline back.
    return last.sequence;
  }

  disable(reason: string): void { this.pause(reason); }

  /** A causal boundary: callers await this before a raid or before spending an
   * unconfirmed result. */
  async settle(): Promise<void> {
    // A command may be enqueued while an older batch is already in flight. A
    // single flush() would only await that batch and leave the dependent command
    // parked in its next fixed window. Drain until both lanes are empty so callers
    // really do receive a causal boundary.
    while (!this.paused && this.size > 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (this.pending.length) this.queuedAt = this.now() - this.windowMs;
      await this.flush();
    }
    if (this.paused) throw new Error("gameplay_unavailable");
  }

  async retry(): Promise<void> {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    // A lost lease is not a transport failure, and this is the one caller that clears a
    // pause without consulting a projection. `reloadAfterConflict` retries straight
    // after a rebase that may have just discovered the writer moved; un-pausing there
    // fires a batch at a lease this document no longer owns, which answers 423, clears
    // the credential and drops the player behind the takeover gate — from what was only
    // ever a version conflict. Leave it paused and let a bootstrap decide.
    if (this.writerLost) return;
    this.setPaused("");
    await this.flush();
  }

  /** A player-initiated send: the sync indicator was pressed. Pending work goes on
   *  the wire immediately instead of waiting out its batch window.
   *
   *  Returns false, and does nothing, while a batch is already on the wire — so a
   *  mashed button costs exactly one request per round trip — and when there is
   *  nothing to send or the queue is paused (recovery, not sending, is the answer to a
   *  pause). Commands enqueued during the send land in `pending` behind the immutable
   *  in-flight envelope, exactly as they do for a timer-driven flush, so acting on the
   *  farm mid-send is safe: they ride the next batch, in order. */
  sendNow(): boolean {
    if (this.flushing || this.paused || (!this.inFlight && !this.pending.length)) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.flush();
    return true;
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.paused || (!this.inFlight && !this.pending.length)) return;
    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null;
      if (!this.paused && this.pending.length) this.scheduleFromFirstCommand();
    });
    return this.flushing;
  }

  private async flushLoop(): Promise<void> {
    while (!this.paused && (this.inFlight || this.pending.length)) {
      if (!this.inFlight) {
        const commands = this.pending.splice(0, COMMAND_SEND_LIMIT);
        this.inFlight = {
          protocolVersion: GAMEPLAY_PROTOCOL,
          deviceId: api.writerRequestClientId(),
          batchId: uuid(),
          firstSequence: commands[0].sequence,
          expectedAccountVersion: this.accountVersion,
          writerGeneration: this.writerGeneration,
          takeWriter: this.takeWriter || undefined,
          commands,
        };
        this.queuedAt = this.pending.length ? this.now() : 0;
        this.persist();
      }
      const response = await this.sendIdenticalWithRetry(this.inFlight);
      if (!response) return;
      if (this.paused && this.writerLost) {
        this.inFlight = null;
        this.persist();
        return;
      }
      crumb("queue:applied", `${this.inFlight.commands.length} commands`);
      this.accountVersion = response.accountVersion;
      this.writerGeneration = response.writerGeneration;
      this.writerLost = false;
      this.takeWriter = false;
      this.inFlight = null;
      this.persist();
      this.onSizeChange?.(this.size);
      this.onProjection?.(response);
      // Commands queued while the request was in flight wait in the next fixed
      // window unless their own deadline already elapsed.
      if (this.pending.length && this.now() - this.queuedAt < this.windowMs) return;
    }
  }

  private async sendIdenticalWithRetry(batch: CommandBatchRequest): Promise<CommandBatchResponse | null> {
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        // "Identical" is about the batchId that gives the send its idempotency, not
        // about the writer identity: re-stamp that on every attempt so a lease
        // acquired or rotated since the envelope was built is the one presented.
        // A restored envelope may carry an id this document can no longer
        // authenticate with, and the server fences the body against the header.
        batch.deviceId = api.writerRequestClientId();
        return await api.sendCommandBatch(batch);
      } catch (error) {
        if (!(error instanceof api.ApiError)) return this.pause("unexpected_error");
        if (error.status === 409) {
          this.setPaused("state_conflict");
          this.onStateConflict?.();
          return null;
        }
        if (error.status === 423 || error.code === "writer_replaced") {
          this.setPaused("writer_replaced");
          this.writerLost = true;
          this.persist();
          this.onWriterReplaced?.();
          return null;
        }
        const transient = error.status === 0 || error.status === 429 || [500, 502, 503, 504].includes(error.status);
        if (!transient) return this.dissolveAndPause(error.code);
        if (attempt === delays.length) return this.pause(error.code);
        // A transient failure that later succeeds never reaches `setPaused`, so without
        // this a session that spent two minutes retrying looks identical to one that
        // never faltered. Repeats collapse, so a long retry run costs one line.
        crumb("queue:retry", `${error.status} ${error.code}`);
        const retryAfter = Number((error.body as { retryAfterMs?: unknown } | undefined)?.retryAfterMs);
        const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : delays[attempt];
        await new Promise<void>((resolve) => setTimeout(resolve, Math.round(base * (0.8 + this.random() * 0.4))));
      }
    }
    return null;
  }

  private pause(reason: string): null {
    this.setPaused(reason || "unknown");
    this.onUnavailable?.(reason);
    return null;
  }

  /** Pause, but return the batch's commands to `pending` first so the next flush
   *  builds a FRESH envelope instead of replaying this one.
   *
   *  Only for statuses the server raises before `applyBatch` runs — a malformed or
   *  mis-fenced envelope (400), a rejected session (401), a retired route (410), a
   *  protocol floor (426). Those guarantee nothing was applied, so rebuilding cannot
   *  double-apply. A transient failure is deliberately NOT routed here: it may have
   *  committed with the response lost, and only replaying the same batchId collects
   *  the server's cached result.
   *
   *  Without this the envelope is frozen in localStorage and `flushLoop` re-sends it
   *  verbatim on every recovery tick, so one permanently-rejected batch pauses
   *  gameplay for good — across reloads, on a healthy connection, with the only
   *  symptom being "Gameplay paused — reconnect to continue" on every tap. */
  private dissolveAndPause(reason: string): null {
    if (this.inFlight) {
      this.pending = [...this.inFlight.commands, ...this.pending];
      this.inFlight = null;
      this.queuedAt = this.pending.length ? this.now() - this.windowMs : 0;
      this.persist();
    }
    return this.pause(reason);
  }

  private discardPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.inFlight = null;
    this.queuedAt = 0;
    this.onSizeChange?.(0);
  }

  private scheduleFromFirstCommand(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.paused || this.inFlight || !this.pending.length) return;
    const remaining = Math.max(0, this.windowMs - (this.now() - this.queuedAt));
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, remaining);
  }

  private storageKey(): string { return `${OUTBOX_PREFIX}::${this.accountId}`; }

  private persist(): void {
    try {
      const value: StoredQueue = {
        nextSequence: this.nextSequence,
        queuedAt: this.queuedAt,
        pending: this.pending,
        inFlight: this.inFlight,
        accountVersion: this.accountVersion,
        writerGeneration: this.writerGeneration,
        writerLost: this.writerLost,
      };
      localStorage.setItem(this.storageKey(), JSON.stringify(value));
    } catch {
      /* A live session still works; response-loss idempotency remains server-side. */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(this.storageKey()) ??
        localStorage.getItem(`${LEGACY_OUTBOX_PREFIX}::${this.accountId}`);
      const value = JSON.parse(raw ?? "null") as StoredQueue | null;
      if (!value || !Array.isArray(value.pending)) return;
      this.nextSequence = Number.isSafeInteger(value.nextSequence) ? value.nextSequence : 1;
      this.queuedAt = Number.isFinite(value.queuedAt) ? value.queuedAt : 0;
      this.pending = value.pending;
      this.inFlight = value.inFlight;
      this.accountVersion = Number.isSafeInteger(value.accountVersion) ? value.accountVersion! : 0;
      this.writerGeneration = Number.isSafeInteger(value.writerGeneration) ? value.writerGeneration! : 0;
      this.writerLost = value.writerLost === true;
      // Copy forward only after successful validation; keep the legacy value as
      // a recovery copy for one release.
      this.persist();
    } catch {
      try { localStorage.removeItem(this.storageKey()); } catch { /* storage unavailable */ }
    }
  }
}
