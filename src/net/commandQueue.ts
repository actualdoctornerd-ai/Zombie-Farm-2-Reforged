import * as api from "./api";
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

const OUTBOX_PREFIX = "zf2r.v3.commands";
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
  private writerLost = false;
  private readonly windowMs: number;
  private readonly random: () => number;
  private readonly now: () => number;

  onProjection: ((response: CommandBatchResponse) => void) | null = null;
  onUnavailable: ((reason: string) => void) | null = null;
  onWriterReplaced: (() => void) | null = null;
  onStateConflict: (() => void) | null = null;

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
    const mine = value.writerDeviceId === api.deviceId();
    this.takeWriter = value.writerDeviceId === null || (!mine && !this.writerLost && localGeneration === 0);
    this.paused = !value.mutationsEnabled || value.minimumProtocolVersion > GAMEPLAY_PROTOCOL ||
      (!!value.writerDeviceId && !mine && !this.takeWriter);
    this.persist();
    this.scheduleFromFirstCommand();
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
    const mine = value.writerDeviceId === api.deviceId();
    this.takeWriter = value.writerDeviceId === null;
    this.paused = !value.mutationsEnabled || value.minimumProtocolVersion > GAMEPLAY_PROTOCOL ||
      (!!value.writerDeviceId && !mine);
    if (value.writerDeviceId && !mine) {
      this.writerLost = true;
      this.onWriterReplaced?.();
    }
    this.queuedAt = this.pending.length ? this.now() - this.windowMs : 0;
    this.persist();
  }

  get available(): boolean { return !this.paused; }
  get size(): number { return this.pending.length + (this.inFlight?.commands.length ?? 0); }

  enqueue(command: GameplayCommand): number {
    if (this.paused) throw new Error("gameplay_unavailable");
    const sequence = this.nextSequence++;
    if (!this.pending.length) this.queuedAt = this.now();
    this.pending.push({ sequence, command });
    this.persist();
    if (this.pending.length >= COMMAND_BATCH_LIMIT) void this.flush();
    else this.scheduleFromFirstCommand();
    return sequence;
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
    this.paused = false;
    await this.flush();
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
        const commands = this.pending.splice(0, COMMAND_BATCH_LIMIT);
        this.inFlight = {
          protocolVersion: GAMEPLAY_PROTOCOL,
          deviceId: api.deviceId(),
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
      this.accountVersion = response.accountVersion;
      this.writerGeneration = response.writerGeneration;
      this.writerLost = false;
      this.takeWriter = false;
      this.inFlight = null;
      this.persist();
      this.onProjection?.(response);
      // Commands queued while the request was in flight wait in the next fixed
      // window unless their own deadline already elapsed.
      if (this.pending.length && this.now() - this.queuedAt < this.windowMs && this.pending.length < COMMAND_BATCH_LIMIT) return;
    }
  }

  private async sendIdenticalWithRetry(batch: CommandBatchRequest): Promise<CommandBatchResponse | null> {
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await api.sendCommandBatch(batch);
      } catch (error) {
        if (!(error instanceof api.ApiError)) return this.pause("unexpected_error");
        if (error.status === 409) {
          this.paused = true;
          this.onStateConflict?.();
          return null;
        }
        if (error.status === 423 || error.code === "writer_replaced") {
          this.paused = true;
          this.writerLost = true;
          this.persist();
          this.onWriterReplaced?.();
          return null;
        }
        const transient = error.status === 0 || error.status === 429 || [500, 502, 503, 504].includes(error.status);
        if (!transient) return this.pause(error.code);
        if (attempt === delays.length) return this.pause(error.code);
        const retryAfter = Number((error.body as { retryAfterMs?: unknown } | undefined)?.retryAfterMs);
        const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : delays[attempt];
        await new Promise<void>((resolve) => setTimeout(resolve, Math.round(base * (0.8 + this.random() * 0.4))));
      }
    }
    return null;
  }

  private pause(reason: string): null {
    this.paused = true;
    this.onUnavailable?.(reason);
    return null;
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
      const value = JSON.parse(localStorage.getItem(this.storageKey()) ?? "null") as StoredQueue | null;
      if (!value || !Array.isArray(value.pending)) return;
      this.nextSequence = Number.isSafeInteger(value.nextSequence) ? value.nextSequence : 1;
      this.queuedAt = Number.isFinite(value.queuedAt) ? value.queuedAt : 0;
      this.pending = value.pending;
      this.inFlight = value.inFlight;
      this.accountVersion = Number.isSafeInteger(value.accountVersion) ? value.accountVersion! : 0;
      this.writerGeneration = Number.isSafeInteger(value.writerGeneration) ? value.writerGeneration! : 0;
      this.writerLost = value.writerLost === true;
    } catch {
      try { localStorage.removeItem(this.storageKey()); } catch { /* storage unavailable */ }
    }
  }
}
