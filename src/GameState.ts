// Client-side live game state. Persistence may be local-only (localStorage) or
// synchronized through the online save service (see save/SaveManager). Levels/XP
// curve is build-verified from PlayerLevels.plist. Filler starting values for now.
import { Friend, canGiftBrain, nextFriendId } from "./social/friends";
import { ABILITY_TIER, abilityTierOf } from "./zombie/traits";
import { TutorialSave } from "./save/schema";

export const XP_THRESHOLDS = [
  0, 25, 75, 150, 250, 375, 550, 800, 1300, 1800, 2300, 2800, 3300, 3900, 4500,
  5500, 6500, 7500, 8500, 9500, 11500, 13500, 15500, 17500, 20500, 25000, 30000,
  35000, 40000, 46000, 53000, 61000, 69000, 78000, 87000, 97000, 107000, 117000,
  127000, 137000, 151000, 165000, 179000, 193000, 218000,
];

type Listener = () => void;

export class GameState {
  name = "Zombie Farmer";
  gold = 200;
  brains = 15; // enough to buy the tutorial's Insta-Grow (10 brains) with headroom
  xp = 0;
  zombieCount = 1;
  zombieMax = 16;
  // ---- storage (the tool shed) ----
  storageItemCap = 8; // Shabby Shed default; a bigger shed raises it (+8/tier)
  storedItems: { key: string; count: number }[] = [];
  received: string[] = []; // raid loot, unlimited
  // ---- ground/climate skins owned (Market Upgrade → Ground) ----
  // "grass" is the free default; buying a skin adds its terrain key here so it can
  // be re-applied for free later. The current applied skin lives on Field.climate.
  ownedClimates: string[] = ["grass"];
  // ---- consumable boosts (bought from the Market Boosts tab) ----
  boostInv: { key: string; count: number }[] = [];
  // ---- zombie abilities ----
  // DEPRECATED: ability unlocking is now derived from raidsCompleted (see
  // abilityUnlocked). Kept as an optional persisted field for save compatibility.
  unlockedAbilities: string[] = [];
  // ---- Zombie Pot pricing ----
  // The Zombie Pot's first acquisition costs 500 GOLD; every one after that costs
  // a flat 30 BRAINS, permanently. This is sticky: once the player has ever owned a
  // pot (bought OR gifted by the tutorial), it stays at 30 brains even if they sell
  // it, so it must persist rather than be derived from whether a pot is on the farm.
  zombiePotBought = false;
  // ---- raids: lifetime win count per raid id (drives "first clear" + stats) ----
  raidsCompleted: Record<string, number> = {};
  // Epoch ms of the last completed invasion (drives the between-raids cooldown).
  lastRaidAt = 0;
  // The player's chosen attack order (deployed zombie ids, first attacks first).
  // Persisted so the Army screen reopens with the same ordering after a raid.
  raidAttackOrder: string[] = [];
  // ---- friends (local offline-fallback list) ----
  // The online friend system is server-backed (net/api.ts + HUD): friend codes,
  // server friend lists, and daily brain gifting live on the Worker. This local
  // list is the offline-build fallback; gifting a brain is recorded here. See
  // social/friends.ts.
  friends: Friend[] = [];
  // ---- first-run guided tutorial (Tim Buckwheat) ----
  // Coarse progress {done, step, skipped}; undefined = never started. The
  // TutorialController reads/writes this via setTutorial() so autosave (which
  // listens to onChange) captures every step advance. Transient targeting
  // (which plot/arrow) is not stored — it's re-derived on restore.
  tutorial: TutorialSave | undefined = undefined;
  private listeners: Listener[] = [];

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** ONLINE: notified of every gold/brains/xp change so the EconomyClient can mirror
   *  it to the server's authoritative ledger (net/economy.ts). Null offline, where
   *  currency stays purely local (original behaviour). Set by main.ts after load. */
  onMoney: ((currency: "gold" | "brains" | "xp", delta: number, reason: string) => void) | null = null;

  /** ONLINE: submit a plant/harvest to the server's EXACT economics engine
   *  (/farm/actions) instead of mutating currency locally. Covers veggie crops (cost +
   *  sell in gold) AND zombie crops (cost in gold OR brains; harvest yields a verified
   *  unit named by `unitId`, no gold). The balance client applies the optimistic effect
   *  and reconciles to server truth. Null offline, where the crop loop stays local. */
  onFarm:
    | ((
        action: { type: "plant" | "harvest" | "plow"; oc: number; or: number; cropKey?: string; fertilized?: boolean; unitId?: string },
        optimistic: { gold?: number; brains?: number; xp?: number }
      ) => void)
    | null = null;

  /** Adopt the server's authoritative balance (economy reconcile). Sets the values
   *  and re-renders WITHOUT emitting an onMoney event — this is server truth being
   *  mirrored down, not a player action to report back up. */
  syncBalance(gold: number, brains: number, xp: number) {
    this.gold = gold;
    this.brains = brains;
    this.xp = xp;
    this.emit();
  }

  /** ONLINE: submit a boost buy/use/grant to the server's owned inventory instead of
   *  mutating boostInv locally. The balance client applies the optimistic effect and
   *  reconciles to server truth (see syncInventory). Null offline, where boosts stay
   *  purely local. */
  onInventory:
    | ((
        action: { type: "buy" | "use" | "grant"; key: string; qty?: number; unitId?: string },
        optimistic: { count: number; gold?: number; brains?: number }
      ) => void)
    | null = null;

  /** ONLINE: sell a zombie through the server-owned roster — the server prices +
   *  credits it (and rejects a unit it doesn't own, so a fabricated zombie can't be
   *  cashed out). `value` is the client's optimistic estimate, reconciled to server
   *  truth. Null offline, where the sell credits gold locally. */
  onRosterSell: ((unitId: string, value: number) => void) | null = null;

  /** Adopt the server's authoritative boost counts (inventory reconcile). Replaces the
   *  local boost list wholesale — the server owns the counts, so the blob's list is an
   *  ignored cache. Emits WITHOUT firing onInventory (server truth mirrored down). */
  syncInventory(counts: Record<string, number>) {
    this.boostInv = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([key, count]) => ({ key, count }));
    this.emit();
  }

  /** Persist tutorial progress and notify listeners (triggers autosave). */
  setTutorial(t: TutorialSave | undefined) {
    this.tutorial = t;
    this.emit();
  }

  /** Record that the player has acquired a Zombie Pot (bought or gifted). Once set,
   *  the pot's price is a flat 30 brains forever (see zombiePotBought). */
  markZombiePotBought() {
    if (!this.zombiePotBought) {
      this.zombiePotBought = true;
      this.emit();
    }
  }

  // ---- ground/climate skins ----
  ownsClimate(terrain: string): boolean {
    return this.ownedClimates.includes(terrain);
  }
  addOwnedClimate(terrain: string) {
    if (!this.ownedClimates.includes(terrain)) {
      this.ownedClimates.push(terrain);
      this.emit();
    }
  }

  get level(): number {
    let lvl = 1;
    for (let i = 0; i < XP_THRESHOLDS.length; i++) {
      if (this.xp >= XP_THRESHOLDS[i]) lvl = i + 1;
    }
    return lvl;
  }
  // Progress [0,1] through the current level toward the next threshold.
  get levelProgress(): number {
    const l = this.level;
    if (l >= XP_THRESHOLDS.length) return 1;
    const cur = XP_THRESHOLDS[l - 1];
    const next = XP_THRESHOLDS[l];
    return (this.xp - cur) / (next - cur);
  }

  addGold(n: number, reason = "misc") {
    this.gold += n;
    this.onMoney?.("gold", n, reason);
    this.emit();
  }
  spendGold(n: number, reason = "purchase"): boolean {
    if (this.gold < n) return false;
    this.gold -= n;
    this.onMoney?.("gold", -n, reason);
    this.emit();
    return true;
  }
  spendBrains(n: number, reason = "purchase"): boolean {
    if (this.brains < n) return false;
    this.brains -= n;
    this.onMoney?.("brains", -n, reason);
    this.emit();
    return true;
  }
  /** Fired once per addXp that crosses a level threshold, with the old + new
   *  level. Wired in main.ts to show the "level up" popup. */
  onLevelUpCb: ((from: number, to: number) => void) | null = null;

  addXp(n: number, reason = "quest") {
    const before = this.level;
    this.xp += n;
    this.onMoney?.("xp", n, reason);
    const after = this.level;
    if (after > before) this.onLevelUp(before, after);
    this.emit();
  }

  /** Effects granted when the player levels up. Grants a brain per level, resets
   *  the between-invasions timer so a fresh raid is ready, and notifies the HUD to
   *  show the unlock popup. The real game also refills zombie hunger — that belongs
   *  with the (later) hunger phase; wire the reset in here when it lands. */
  private onLevelUp(from: number, to: number) {
    const grant = to - from; // +1 brain per level gained
    this.brains += grant;
    this.onMoney?.("brains", grant, "levelup");
    this.lastRaidAt = 0; // raid timer resets on level up
    this.onLevelUpCb?.(from, to);
  }
  addBrains(n: number, reason = "misc") {
    this.brains += n;
    this.onMoney?.("brains", n, reason);
    this.emit();
  }
  addZombieMax(n: number) {
    this.zombieMax = Math.max(1, this.zombieMax + n);
    this.emit();
  }
  // Set the live owned-zombie count (driven by the ZombieField roster).
  setZombieCount(n: number) {
    this.zombieCount = Math.max(0, n);
    this.emit();
  }
  // Placing a storage shed raises the item capacity to its tier (never lowers it).
  upgradeStorage(cap: number) {
    if (cap > this.storageItemCap) {
      this.storageItemCap = cap;
      this.emit();
    }
  }

  // ---- item storage (the shed's Items tab) ----
  /** Total items currently in the shed (sum of stacked counts). */
  storedItemTotal(): number {
    return this.storedItems.reduce((a, i) => a + i.count, 0);
  }
  /** Store one placeable of `key` in the shed. Fails if the shed is full. */
  storeItem(key: string): boolean {
    if (this.storedItemTotal() >= this.storageItemCap) return false;
    const e = this.storedItems.find((i) => i.key === key);
    if (e) e.count++;
    else this.storedItems.push({ key, count: 1 });
    this.emit();
    return true;
  }
  /** Take one placeable of `key` back out of the shed. Fails if none stored. */
  retrieveItem(key: string): boolean {
    const idx = this.storedItems.findIndex((i) => i.key === key);
    if (idx < 0) return false;
    const e = this.storedItems[idx];
    e.count--;
    if (e.count <= 0) this.storedItems.splice(idx, 1);
    this.emit();
    return true;
  }

  /** Add a looted/rewarded item to the Received bucket (unlimited). */
  receiveItem(key: string) {
    this.received.push(key);
    this.emit();
  }

  /** Adopt the server's authoritative item storage (Received bucket + shed). ONLINE the
   *  server owns both: raid loot is rolled and granted there, and the roll reads them to
   *  decide whether a unique may still drop — so an edited save must not decide them.
   *  Counts are expanded back into the client's list shapes. */
  syncStorage(received: Record<string, number>, stored: Record<string, number>) {
    this.received = [];
    for (const [key, n] of Object.entries(received)) {
      for (let i = 0; i < n; i++) this.received.push(key);
    }
    this.storedItems = Object.entries(stored).map(([key, count]) => ({ key, count }));
    this.emit();
  }

  /** Remove and return the Received entry at `index` (claimed or placed). Returns
   *  null if the index is out of range. Index-based so duplicate names are safe. */
  takeReceivedAt(index: number): string | null {
    if (index < 0 || index >= this.received.length) return null;
    const [entry] = this.received.splice(index, 1);
    this.emit();
    return entry ?? null;
  }

  // ---- consumable boosts ----
  boostCount(key: string): number {
    return this.boostInv.find((b) => b.key === key)?.count ?? 0;
  }
  addBoost(key: string, n = 1) {
    const e = this.boostInv.find((b) => b.key === key);
    if (e) e.count += n;
    else this.boostInv.push({ key, count: n });
    this.emit();
  }
  /** Consume one boost of `key`. Returns false if none are owned. */
  useBoost(key: string): boolean {
    const idx = this.boostInv.findIndex((b) => b.key === key);
    if (idx < 0 || this.boostInv[idx].count <= 0) return false;
    this.boostInv[idx].count--;
    if (this.boostInv[idx].count <= 0) this.boostInv.splice(idx, 1);
    this.emit();
    return true;
  }

  // ---- raids ----
  /** Record a raid win. Returns the new lifetime win count for that raid. */
  completeRaid(id: string): number {
    const n = (this.raidsCompleted[id] ?? 0) + 1;
    this.raidsCompleted[id] = n;
    this.emit();
    return n;
  }

  /** Adopt the server's authoritative raid progress (lifetime wins per raid). ONLINE the
   *  server owns wins — they drive ability unlocks, so an edited save must not decide
   *  them. Server truth mirrored down, like syncBalance. */
  syncRaidProgress(progress: Record<string, number>) {
    this.raidsCompleted = { ...progress };
    this.emit();
  }
  /** Whether the player has ever cleared a raid (drives first-clear rewards). */
  hasClearedRaid(id: string): boolean {
    return (this.raidsCompleted[id] ?? 0) > 0;
  }
  /** Lifetime win count for a raid (drives the eased first-clear army minimums). */
  raidWins(id: string): number {
    return this.raidsCompleted[id] ?? 0;
  }

  // ---- zombie abilities ----
  // Abilities unlock ONE AT A TIME by beating a tier's invasion boss. Each win of a
  // tier's boss (raid id 1..4 for tiers 1..4 — McDonnell/Lawyers/Pirates/Ninjas)
  // unlocks the next still-locked ability of that tier, in canonical ABILITY_TIER
  // order, across every zombie whose colour class reaches that tier. So `w` wins of
  // tier T's boss unlock the first `w` of that tier's abilities; the rest stay
  // padlocked until the boss is beaten again. Which ability a unit gets at a tier is
  // fixed by its group (see traits.GROUP_ABILITIES), not random.

  /** How many of tier `t`'s abilities are unlocked — one per win of that tier's
   *  invasion boss, capped at the tier's pool size. */
  tierAbilitiesUnlocked(tier: number): number {
    const pool = ABILITY_TIER[tier];
    if (!pool) return 0;
    return Math.min(pool.length, this.raidWins(String(tier)));
  }

  /** Whether a specific ability KEY is unlocked yet. An ability unlocks once its
   *  tier's boss has been beaten enough times to reach it — i.e. it sits within the
   *  first `tierAbilitiesUnlocked(tier)` entries of its tier's canonical pool. */
  abilityUnlocked(key: string): boolean {
    const tier = abilityTierOf(key);
    if (tier <= 0) return false;
    const idx = ABILITY_TIER[tier].indexOf(key);
    return idx >= 0 && idx < this.tierAbilitiesUnlocked(tier);
  }

  // ---- friends (offline stub) ----
  /** Add a local friend by name. Returns the new Friend, or null if the name is
   *  blank. No dedupe: two people can share a display name (ids differ). */
  addFriend(name: string): Friend | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const f: Friend = {
      id: nextFriendId(this.friends.map((x) => x.id)),
      name: trimmed,
      addedAt: Date.now(),
      giftsSent: 0,
    };
    this.friends.push(f);
    this.emit();
    return f;
  }
  /** Remove a friend by id. */
  removeFriend(id: string): boolean {
    const idx = this.friends.findIndex((f) => f.id === id);
    if (idx < 0) return false;
    this.friends.splice(idx, 1);
    this.emit();
    return true;
  }
  /** Whether a brain can be gifted to this friend right now. The once-per-day
   *  limit is deferred (see social/friends.ts), so this is currently always true
   *  for a real friend. */
  canGiftBrain(id: string): boolean {
    const f = this.friends.find((x) => x.id === id);
    return !!f && canGiftBrain(f, Date.now());
  }
  /** Gift one brain to a friend. Free to the player (a social faucet) — offline
   *  there is no recipient account, so the gift is only recorded on the friend.
   *  The online build credits the recipient's account server-side instead
   *  (net/api.ts → POST /gifts). Returns false if the friend is unknown or
   *  (later) already gifted today. */
  giftBrain(id: string): boolean {
    const f = this.friends.find((x) => x.id === id);
    if (!f || !canGiftBrain(f, Date.now())) return false;
    f.lastGiftAt = Date.now();
    f.giftsSent = (f.giftsSent ?? 0) + 1;
    this.emit();
    return true;
  }

  // ---- developer overrides (Settings dev tools) ----
  setGold(n: number) {
    this.gold = Math.max(0, Math.floor(n));
    this.emit();
  }
  setBrains(n: number) {
    this.brains = Math.max(0, Math.floor(n));
    this.emit();
  }
  // Set the player level by snapping XP to that level's threshold.
  setLevel(n: number) {
    const lvl = Math.max(1, Math.min(XP_THRESHOLDS.length, Math.floor(n)));
    this.xp = XP_THRESHOLDS[lvl - 1];
    this.emit();
  }

  // Overwrite the persisted progression fields (used when loading a save) and
  // notify listeners once.
  apply(p: {
    name: string;
    gold: number;
    brains: number;
    xp: number;
    zombieCount: number;
    zombieMax: number;
  }) {
    this.name = p.name;
    this.gold = p.gold;
    this.brains = p.brains;
    this.xp = p.xp;
    this.zombieCount = p.zombieCount;
    this.zombieMax = p.zombieMax;
    this.emit();
  }
}
