// Client bridge to the server-authoritative economy (server/src/economy.ts + farm.ts).
//
// The server owns gold/brains/xp. Gameplay stays SYNCHRONOUS via an optimistic
// mirror + reconcile: a change is applied to GameState immediately (instant UI) and
// enqueued; a debounced flush POSTs it and adopts the server's authoritative
// balance. Two kinds of change share one balance + one reconcile:
//   • ECONOMY EVENTS (record) — a raw currency delta the server bounds-validates.
//     For sells, quest/raid rewards, purchases, plow — anything without exact
//     server-side modelling.
//   • FARM ACTIONS (submitFarm) — a plant/harvest the server prices EXACTLY from
//     its own catalog + crop plot records, gating harvest by server time. The
//     client sends an optimistic estimate; the server's exact result reconciles it.
//
// Both are idempotent (uuid ids) and persisted to localStorage OUTBOXes so a crash
// mid-flush doesn't lose progress. The displayed balance is always
//   base (server truth) + pending economy deltas + pending farm optimistic effects,
// so the two overlays never fight. Offline / signed-out: never constructed;
// GameState behaves as the original local-only game (see main.ts wiring).
import type { GameState } from "../GameState";
import * as api from "./api";

const ECON_OUTBOX_KEY = "zf2r.econ.outbox.v1";
const FARM_OUTBOX_KEY = "zf2r.farm.outbox.v1";
const RAID_OUTBOX_KEY = "zf2r.raid.outbox.v1";
const INV_OUTBOX_KEY = "zf2r.inv.outbox.v1";
const ROSTER_OUTBOX_KEY = "zf2r.roster.outbox.v1";
const SHOP_OUTBOX_KEY = "zf2r.shop.outbox.v1";

/** A pending farm action plus the optimistic effect it applied locally (so a
 *  rejected harvest can fall back to the bounds path without losing the reward). */
interface PendingFarm {
  action: api.FarmAction;
  gold: number;
  xp: number;
}

/** A finished raid awaiting its server-authoritative reward. Carries the finish
 *  inputs (so a crash-interrupted finish can be retried — the server is idempotent)
 *  plus the optimistic reward shown meanwhile. */
interface PendingRaid {
  sessionId: string;
  win: boolean;
  survivalFrac: number;
  gold: number;
  xp: number;
}

/** A pending inventory action plus the optimistic effect it applied (a boost count
 *  delta on `key`, and — for a buy — the currency it debits). */
interface PendingInv {
  action: api.InventoryAction;
  key: string;
  count: number;
  gold: number;
  brains: number;
}

/** What GameState.onInventory hands us — a buy/use/grant minus its client id. */
export interface InventoryInput {
  type: "buy" | "use" | "grant";
  key: string;
  qty?: number;
}

/** A pending roster action plus its optimistic currency effect (a sell credits gold;
 *  grant/veteran/casualty are pure server bookkeeping with no display effect). */
interface PendingRoster {
  action: api.RosterAction;
  gold: number;
}

/** A pending shop purchase (farm-size tier or climate skin) + its optimistic currency
 *  debit. The server owns the resulting size/climate set; flushShop adopts it. */
interface PendingShop {
  buy: { kind: "size"; size: number; currency: "gold" | "brains" } | { kind: "climate"; terrain: string };
  gold: number;
  brains: number;
}

/** A roster action minus its (client-assigned) id, as submitRoster receives it. */
export type RosterInput =
  | { type: "sell"; unitId: string }
  | { type: "grant"; unitId: string; key: string; mutation?: number; invasions?: number }
  | { type: "veteran"; unitIds: string[] }
  | { type: "casualty"; unitIds: string[] }
  | { type: "combineStart"; parentAId: string; parentBId: string }
  | { type: "combineCollect"; unitId: string; key: string; mutation?: number };

/** What GameState.onFarm hands us — the action minus its (client-assigned) id. */
export interface FarmActionInput {
  type: "plant" | "harvest";
  oc: number;
  or: number;
  cropKey?: string;
  fertilized?: boolean;
}

function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

export class EconomyClient {
  /** Unsent + in-flight economy events (idempotent by id). */
  private pending: api.EconomyEvent[] = [];
  /** Unsent + in-flight farm actions with their optimistic effects. */
  private farmPending: PendingFarm[] = [];
  /** Finished raids awaiting their server-authoritative reward. */
  private raidPending: PendingRaid[] = [];
  /** Unsent + in-flight inventory actions with their optimistic effects. */
  private invPending: PendingInv[] = [];
  /** Unsent + in-flight roster actions (sell/grant/casualty) with sell gold. */
  private rosterPending: PendingRoster[] = [];
  /** Unsent + in-flight shop purchases (farm-size / climate) with their optimistic debit. */
  private shopPending: PendingShop[] = [];
  /** Called after a shop flush with the server's authoritative farm size + climate set,
   *  so the client adopts them (reverting a rejected optimistic change). Wired in main.ts. */
  onShopState: ((size: number, climates: string[]) => void) | null = null;
  /** Last server-confirmed balance; display = base + pending overlays. */
  private base: api.Balance | null = null;
  /** Last server-confirmed boost inventory; display = serverInv + pending count deltas. */
  private serverInv: Record<string, number> | null = null;
  private flushing = false;
  private timer = 0;
  private dirtySince = 0;
  /** Called when the server reports a freshly-planted crop was fertilized, so the
   *  client can apply the 2x visual (leaf FX). Wired in main.ts. */
  onCropFertilized: ((oc: number, or: number) => void) | null = null;

  constructor(
    private state: GameState,
    private accountId: string,
    private delayMs = 5000,
    private maxDirtyMs = 30000
  ) {
    this.pending = this.readOutbox(ECON_OUTBOX_KEY) as api.EconomyEvent[];
    this.farmPending = this.readOutbox(FARM_OUTBOX_KEY) as PendingFarm[];
    this.raidPending = this.readOutbox(RAID_OUTBOX_KEY) as PendingRaid[];
    this.invPending = this.readOutbox(INV_OUTBOX_KEY) as PendingInv[];
    this.rosterPending = this.readOutbox(ROSTER_OUTBOX_KEY) as PendingRoster[];
    this.shopPending = this.readOutbox(SHOP_OUTBOX_KEY) as PendingShop[];
  }

  private key(base: string): string {
    return `${base}::${this.accountId}`;
  }
  private readOutbox(base: string): unknown[] {
    try {
      const raw = localStorage.getItem(this.key(base));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  private writeEconOutbox(): void {
    try {
      localStorage.setItem(this.key(ECON_OUTBOX_KEY), JSON.stringify(this.pending));
    } catch {
      /* ignore quota/serialization errors */
    }
  }
  private writeFarmOutbox(): void {
    try {
      localStorage.setItem(this.key(FARM_OUTBOX_KEY), JSON.stringify(this.farmPending));
    } catch {
      /* ignore */
    }
  }
  private writeRaidOutbox(): void {
    try {
      localStorage.setItem(this.key(RAID_OUTBOX_KEY), JSON.stringify(this.raidPending));
    } catch {
      /* ignore */
    }
  }
  private writeInvOutbox(): void {
    try {
      localStorage.setItem(this.key(INV_OUTBOX_KEY), JSON.stringify(this.invPending));
    } catch {
      /* ignore */
    }
  }
  private writeRosterOutbox(): void {
    try {
      localStorage.setItem(this.key(ROSTER_OUTBOX_KEY), JSON.stringify(this.rosterPending));
    } catch {
      /* ignore */
    }
  }
  private writeShopOutbox(): void {
    try {
      localStorage.setItem(this.key(SHOP_OUTBOX_KEY), JSON.stringify(this.shopPending));
    } catch {
      /* ignore */
    }
  }

  /** Adopt the server's authoritative balance (seeding it from the current local
   *  currency if the server has none yet — e.g. a brand-new account), then flush any
   *  outbox left from a previous session. Call once after the save has loaded so the
   *  server balance wins over the blob. Safe to call again as a refresh. */
  async start(): Promise<void> {
    try {
      this.base = await api.syncEconomy({
        gold: this.state.gold,
        brains: this.state.brains,
        xp: this.state.xp,
      });
      // Seed + adopt the server's boost inventory from the save's boost list (one-time
      // INSERT OR IGNORE server-side; thereafter the server counts win).
      const seed: Record<string, number> = {};
      for (const b of this.state.boostInv) seed[b.key] = b.count;
      const inv = await api.syncInventory(seed);
      this.serverInv = inv.inventory;
      this.reconcile();
    } catch {
      /* offline — keep showing the blob values until the server is reachable */
    }
    if (
      this.pending.length ||
      this.farmPending.length ||
      this.raidPending.length ||
      this.invPending.length ||
      this.rosterPending.length ||
      this.shopPending.length
    ) {
      void this.flush();
    }
  }

  /** Re-read the authoritative boost inventory from the server (e.g. after the server
   *  consumed a voucher on /raid/start). No-op offline. */
  async refreshInventory(): Promise<void> {
    try {
      const inv = await api.syncInventory({});
      this.serverInv = inv.inventory;
      this.reconcile();
    } catch {
      /* offline — keep the current optimistic view */
    }
  }

  /** Record a raw currency change (already applied optimistically to GameState by
   *  the caller). Server bounds-validates it. */
  record(currency: api.Currency, delta: number, reason: string): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.pending.push({ id: uuid(), currency, delta: Math.trunc(delta), reason });
    this.writeEconOutbox();
    this.schedule();
  }

  /** Submit a plant/harvest to the server's exact-economics engine. `optimistic` is
   *  the client's estimate of the effect (plant: {gold:-cost}, harvest:{gold,xp});
   *  it shows immediately and is corrected to the server's exact result on flush. */
  submitFarm(input: FarmActionInput, optimistic: { gold?: number; xp?: number }): void {
    const id = uuid();
    const action: api.FarmAction =
      input.type === "plant"
        ? { id, type: "plant", oc: input.oc, or: input.or, cropKey: input.cropKey ?? "", fertilized: input.fertilized }
        : { id, type: "harvest", oc: input.oc, or: input.or };
    this.farmPending.push({ action, gold: optimistic.gold ?? 0, xp: optimistic.xp ?? 0 });
    this.writeFarmOutbox();
    this.reconcile();
    this.schedule();
  }

  /** Submit a finished raid for its server-authoritative reward. The server owns the
   *  base win gold + first-clear XP for the session's pinned raid; `optimistic` is the
   *  client's estimate (shown instantly and reconciled to the server's exact credit).
   *  Flushes right away — a raid just ended, so the player wants the reward + the
   *  server cooldown now, not on the next debounce. */
  submitRaid(
    sessionId: string,
    win: boolean,
    survivalFrac: number,
    optimistic: { gold?: number; xp?: number }
  ): void {
    this.raidPending.push({
      sessionId,
      win,
      survivalFrac,
      gold: optimistic.gold ?? 0,
      xp: optimistic.xp ?? 0,
    });
    this.writeRaidOutbox();
    this.reconcile();
    void this.flush();
  }

  /** Submit a boost buy/use/grant to the server's owned inventory. `optimistic` is the
   *  effect shown instantly — a boost count delta on the item and, for a buy, the
   *  currency it debits (buys go through here, NOT the economy record path, so the
   *  currency isn't double-debited). Reconciled to the server's authoritative counts
   *  + balance on flush. Flushes right away so a purchase lands promptly. */
  submitInventory(input: InventoryInput, optimistic: { count: number; gold?: number; brains?: number }): void {
    const id = uuid();
    const action: api.InventoryAction =
      input.type === "buy"
        ? { id, type: "buy", key: input.key }
        : { id, type: input.type, key: input.key, qty: input.qty };
    this.invPending.push({
      action,
      key: input.key,
      count: optimistic.count,
      gold: optimistic.gold ?? 0,
      brains: optimistic.brains ?? 0,
    });
    this.writeInvOutbox();
    this.reconcile();
    void this.flush();
  }

  /** Seed the server roster shadow from the current local units (one-time on load).
   *  Fire-and-forget; the server INSERT OR IGNOREs so it never clobbers. */
  async syncRoster(units: api.RosterSeedUnit[]): Promise<void> {
    try {
      await api.syncRoster(units);
    } catch {
      /* offline — the outbox / next start() retries */
    }
  }

  /** Submit a roster sell/grant/casualty to the server. A `sell` credits gold
   *  (optimistic {gold} shown + reconciled); grant/casualty are pure server
   *  bookkeeping. Flushes right away so a sell lands promptly. */
  submitRoster(input: RosterInput, optimistic: { gold?: number } = {}): void {
    const action = { id: uuid(), ...input } as api.RosterAction;
    this.rosterPending.push({ action, gold: optimistic.gold ?? 0 });
    this.writeRosterOutbox();
    this.reconcile();
    void this.flush();
  }

  /** Seed + adopt the server-owned farm size + climate set from the save (once on
   *  load). Fires onShopState with the authoritative values. No-op offline. */
  async syncShop(size: number, climates: string[]): Promise<void> {
    try {
      const s = await api.shopState(size, climates);
      this.onShopState?.(s.size, s.climates);
    } catch {
      /* offline — retried indirectly via a later purchase flush / next start() */
    }
  }

  /** Buy the next farm-size tier. `cost` is the optimistic debit (shown instantly); the
   *  server prices it exactly and returns the authoritative size, adopted on flush. */
  submitShopSize(size: number, currency: "gold" | "brains", cost: number): void {
    this.shopPending.push({
      buy: { kind: "size", size, currency },
      gold: currency === "gold" ? -cost : 0,
      brains: currency === "brains" ? -cost : 0,
    });
    this.writeShopOutbox();
    this.reconcile();
    void this.flush();
  }

  /** Buy a climate skin (gold). Optimistic `cost` shown; server is authoritative. */
  submitShopClimate(terrain: string, cost: number): void {
    this.shopPending.push({ buy: { kind: "climate", terrain }, gold: -cost, brains: 0 });
    this.writeShopOutbox();
    this.reconcile();
    void this.flush();
  }

  private schedule(): void {
    const now = Date.now();
    if (!this.dirtySince) this.dirtySince = now;
    const untilMax = Math.max(0, this.maxDirtyMs - (now - this.dirtySince));
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), Math.min(this.delayMs, untilMax));
  }

  /** Max items per POST — stays under the server's per-request cap so a long offline
   *  session drains instead of being rejected wholesale and stranded. */
  private static readonly CHUNK = 200;

  /** Send pending economy events + farm actions and adopt the server balance. Safe
   *  to call anytime (single in-flight); a boundary (raid finish, sign-out) forces
   *  it. On a transient failure the outboxes are kept and retried later. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.dirtySince = 0;
    if (
      this.flushing ||
      (!this.pending.length &&
        !this.farmPending.length &&
        !this.raidPending.length &&
        !this.invPending.length &&
        !this.rosterPending.length &&
        !this.shopPending.length)
    ) {
      return;
    }
    this.flushing = true;
    try {
      await this.flushEconomy();
      await this.flushFarm();
      await this.flushRaid();
      await this.flushInv();
      await this.flushRoster();
      await this.flushShop();
      this.reconcile();
    } catch {
      /* offline / transient — keep the outboxes and retry on the next change/start() */
    } finally {
      this.flushing = false;
      if (
        this.pending.length ||
        this.farmPending.length ||
        this.raidPending.length ||
        this.invPending.length ||
        this.rosterPending.length ||
        this.shopPending.length
      ) {
        this.schedule();
      }
    }
  }

  private async flushEconomy(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.slice(0, EconomyClient.CHUNK);
      const { balance } = await api.applyEconomy(batch);
      const sent = new Set(batch.map((e) => e.id));
      this.pending = this.pending.filter((e) => !sent.has(e.id));
      this.writeEconOutbox();
      this.base = balance;
    }
  }

  private async flushFarm(): Promise<void> {
    while (this.farmPending.length) {
      const batch = this.farmPending.slice(0, EconomyClient.CHUNK);
      const { balance, results } = await api.applyFarm(batch.map((f) => f.action));
      const byId = new Map(batch.map((f) => [f.action.id, f]));
      for (const res of results) {
        // A plant the server rolled fertilized: apply the 2x visual to that crop.
        if (res.status === "applied" && res.fertilized) {
          const f = byId.get(res.id);
          if (f && f.action.type === "plant") this.onCropFertilized?.(f.action.oc, f.action.or);
        }
        if (res.status !== "rejected") continue;
        const f = byId.get(res.id);
        // ONLY grandfather a harvest the server has NO record of (a crop planted
        // before this feature): fall back to the bounds path so the reward isn't
        // lost. Any OTHER rejection (not_grown, bad_coord, …) must NOT credit —
        // e.g. `not_grown` is the anti-insta-harvest gate and dropping the optimistic
        // effect on reconcile correctly reverts it. A rejected PLANT likewise needs
        // no fallback: dropping its optimistic -cost just refunds it.
        if (f && f.action.type === "harvest" && res.error === "nothing_planted") {
          if (f.gold) this.record("gold", f.gold, "harvest");
          if (f.xp) this.record("xp", f.xp, "harvest");
        }
      }
      const sent = new Set(batch.map((f) => f.action.id));
      this.farmPending = this.farmPending.filter((f) => !sent.has(f.action.id));
      this.writeFarmOutbox();
      this.base = balance;
    }
  }

  private async flushRaid(): Promise<void> {
    // One at a time: each finish also advances the (idempotent) server cooldown, and
    // there's realistically at most one pending. A failure throws so flush() keeps the
    // outbox for retry; the server is idempotent, so re-sending a finish is safe.
    while (this.raidPending.length) {
      const r = this.raidPending[0];
      const res = await api.raidFinish(r.sessionId, r.win, r.survivalFrac);
      this.state.lastRaidAt = res.lastRaidAt; // adopt the authoritative cooldown clock
      this.raidPending.shift();
      this.writeRaidOutbox();
      this.base = res.balance; // server truth already includes this raid's credit
    }
  }

  private async flushInv(): Promise<void> {
    while (this.invPending.length) {
      const batch = this.invPending.slice(0, EconomyClient.CHUNK);
      const { balance, inventory } = await api.applyInventory(batch.map((f) => f.action));
      // A rejected action (e.g. can't afford, none owned) simply has its optimistic
      // effect dropped on reconcile — the server's balance + inventory are truth.
      const sent = new Set(batch.map((f) => f.action.id));
      this.invPending = this.invPending.filter((f) => !sent.has(f.action.id));
      this.writeInvOutbox();
      this.base = balance;
      this.serverInv = inventory;
    }
  }

  private async flushRoster(): Promise<void> {
    while (this.rosterPending.length) {
      const batch = this.rosterPending.slice(0, EconomyClient.CHUNK);
      const { balance } = await api.applyRoster(batch.map((f) => f.action));
      // A rejected sell (unit the server doesn't own) just drops its optimistic gold
      // on reconcile — no credit, which is the anti-fabrication behaviour.
      const sent = new Set(batch.map((f) => f.action.id));
      this.rosterPending = this.rosterPending.filter((f) => !sent.has(f.action.id));
      this.writeRosterOutbox();
      this.base = balance;
    }
  }

  private async flushShop(): Promise<void> {
    // One at a time (purchases are infrequent + sequential for size). Each returns the
    // authoritative balance + farm size + climate set; adopting them auto-corrects a
    // rejected optimistic change (e.g. reverts a resize the server declined).
    while (this.shopPending.length) {
      const p = this.shopPending[0];
      const res =
        p.buy.kind === "size"
          ? await api.shopSize(p.buy.size, p.buy.currency)
          : await api.shopClimate(p.buy.terrain);
      this.shopPending.shift();
      this.writeShopOutbox();
      this.base = res.balance;
      this.onShopState?.(res.size, res.climates);
    }
  }

  /** Set GameState currency to server truth plus every still-pending optimistic
   *  effect (economy deltas + farm effects), so in-flight changes still show while
   *  converging to the authoritative balance. */
  private reconcile(): void {
    if (!this.base) return;
    const b: api.Balance = { ...this.base };
    for (const e of this.pending) b[e.currency] += e.delta;
    for (const f of this.farmPending) {
      b.gold += f.gold;
      b.xp += f.xp;
    }
    for (const r of this.raidPending) {
      b.gold += r.gold;
      b.xp += r.xp;
    }
    for (const iv of this.invPending) {
      b.gold += iv.gold;
      b.brains += iv.brains;
    }
    for (const rp of this.rosterPending) b.gold += rp.gold;
    for (const sp of this.shopPending) {
      b.gold += sp.gold;
      b.brains += sp.brains;
    }
    this.state.syncBalance(b.gold, b.brains, b.xp);

    // Inventory: server truth + pending count deltas → the displayed boost counts.
    if (this.serverInv) {
      const counts: Record<string, number> = { ...this.serverInv };
      for (const iv of this.invPending) counts[iv.key] = (counts[iv.key] ?? 0) + iv.count;
      this.state.syncInventory(counts);
    }
  }
}
