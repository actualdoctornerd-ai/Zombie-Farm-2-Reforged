// Minimal local game state (no server). Levels/XP curve is build-verified from
// PlayerLevels.plist. Filler starting values for now.
import { Friend, canGiftBrain, nextFriendId } from "./social/friends";

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
  brains = 5;
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
  // DEPRECATED: ability unlocking is now derived per-tier from raidsCompleted (see
  // abilityTierUnlocked). Kept as an optional persisted field for save compatibility.
  unlockedAbilities: string[] = [];
  // ---- raids: lifetime win count per raid id (drives "first clear" + stats) ----
  raidsCompleted: Record<string, number> = {};
  // Epoch ms of the last completed invasion (drives the between-raids cooldown).
  lastRaidAt = 0;
  // The player's chosen attack order (deployed zombie ids, first attacks first).
  // Persisted so the Army screen reopens with the same ordering after a raid.
  raidAttackOrder: string[] = [];
  // ---- friends (offline stub; the seam for a future online friend system) ----
  // A local list of "friends"; gifting a brain is recorded here. See social/friends.ts.
  friends: Friend[] = [];
  private listeners: Listener[] = [];

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
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

  addGold(n: number) {
    this.gold += n;
    this.emit();
  }
  spendGold(n: number): boolean {
    if (this.gold < n) return false;
    this.gold -= n;
    this.emit();
    return true;
  }
  spendBrains(n: number): boolean {
    if (this.brains < n) return false;
    this.brains -= n;
    this.emit();
    return true;
  }
  /** Fired once per addXp that crosses a level threshold, with the old + new
   *  level. Wired in main.ts to show the "level up" popup. */
  onLevelUpCb: ((from: number, to: number) => void) | null = null;

  addXp(n: number) {
    const before = this.level;
    this.xp += n;
    const after = this.level;
    if (after > before) this.onLevelUp(before, after);
    this.emit();
  }

  /** Effects granted when the player levels up. Grants a brain per level, resets
   *  the between-invasions timer so a fresh raid is ready, and notifies the HUD to
   *  show the unlock popup. The real game also refills zombie hunger — that belongs
   *  with the (later) hunger phase; wire the reset in here when it lands. */
  private onLevelUp(from: number, to: number) {
    this.brains += to - from; // +1 brain per level gained
    this.lastRaidAt = 0; // raid timer resets on level up
    this.onLevelUpCb?.(from, to);
  }
  addBrains(n: number) {
    this.brains += n;
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
  /** Whether the player has ever cleared a raid (drives first-clear rewards). */
  hasClearedRaid(id: string): boolean {
    return (this.raidsCompleted[id] ?? 0) > 0;
  }

  // ---- zombie abilities ----
  // Abilities unlock by TIER: beating a tier's invasion boss (winning raid id 1..4
  // for tiers 1..4 — McDonnell/Lawyers/Pirates/Ninjas) unlocks that whole tier for
  // every zombie whose colour class reaches it. Which ability a unit gets is fixed
  // by its group (see traits.GROUP_ABILITIES), not random.
  abilityTierUnlocked(tier: number): boolean {
    return this.hasClearedRaid(String(tier));
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
   *  This is where a future online build POSTs the gift to credit the friend.
   *  Returns false if the friend is unknown or (later) already gifted today. */
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
