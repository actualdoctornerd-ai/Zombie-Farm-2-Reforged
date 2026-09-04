// Client-side live game state. Persistence may be local-only (localStorage) or
// synchronized through the online save service (see save/SaveManager). Levels/XP
// curve is build-verified from PlayerLevels.plist.
import { Friend, canGiftBrain, nextFriendId } from "./social/friends";
import { ABILITY_TIER, abilityTierOf } from "./zombie/traits";
import { TutorialSave } from "./save/schema";
import type { FarmerCatalog } from "./assets";
import {
  activeBonusHeadId, farmerCooldownMs, farmerGold, farmerHeadHasEffect, farmerMultiplier,
  farmerSpeedPx,
  farmerZombieGrowMs,
} from "./farmer";
import type { EpicBossRun } from "./epicBoss/types";
import { parseReceivedZombie } from "./zombie/receivedReward";
import { mutationsOf } from "./zombie/mutations";
import { releasedToGraveyard, trimFallen, type FallenZombie } from "./zombie/memorial";
import type { ZombieTeam } from "./zombie/teams";
import { mergeFarmStats, newFarmStats, type FarmStats } from "./stats";

export const XP_THRESHOLDS = [
  0, 25, 75, 150, 250, 375, 550, 800, 1300, 1800, 2300, 2800, 3300, 3900, 4500,
  5500, 6500, 7500, 8500, 9500, 11500, 13500, 15500, 17500, 20500, 25000, 30000,
  35000, 40000, 46000, 53000, 61000, 69000, 78000, 87000, 97000, 107000, 117000,
  127000, 137000, 151000, 165000, 179000, 193000, 218000,
];

type Listener = () => void;

export class GameState {
  name = "Zombie Farmer";
  gold = 400;
  // The tutorial spends the fresh player's one brain on Insta-Grow.
  brains = 1;
  xp = 0;
  zombieCount = 1;
  zombieMax = 16;
  // ---- storage (the tool shed) ----
  storageItemCap = 8; // Shabby Shed default; a bigger shed raises it (+8/tier)
  storedItems: { key: string; count: number }[] = [];
  received: string[] = []; // raid loot, unlimited
  // ---- Zombie Almanac: lifetime obtained count per species key ----
  // Cosmetic collection data. Incremented by ZombieField at every unit-creation
  // path (grow, Pot, reward, Black Market, gift); never decremented — selling or
  // losing a zombie does not un-discover its species.
  zombieDiscovered: Record<string, number> = {};
  // ---- Mutation Almanac: lifetime count per mutation key ----
  // The same collection, one level down: a zombie arriving with a mask counts every
  // mutation on it, so one Tomatohead Zyborg discovers Tomatohead. Kept beside the
  // species map and written by the same call, because every path that creates a unit
  // already reports that unit — and a mutation has no creation path of its own.
  mutationDiscovered: Record<string, number> = {};
  // ---- the graveyard: zombies lost in an invasion and not revived ----
  // Purely a memento list — a Memorial Statue is the only thing that can consume
  // one, and enshrining moves the snapshot onto the statue. Nothing here can ever
  // return a zombie to the roster (see src/zombie/memorial.ts).
  fallenZombies: FallenZombie[] = [];
  // ---- ground/climate skins owned (Market Upgrade → Ground) ----
  // "grass" is the free default; buying a skin adds its terrain key here so it can
  // be re-applied for free later. The current applied skin lives on Field.climate.
  ownedClimates: string[] = ["grass"];
  // ---- modular farmer appearance ----
  ownedFarmerHeads: number[] = [];
  ownedFarmerBodies: number[] = [];
  /** The head the farmer WEARS. Purely how the player looks — on their own farm,
   *  and as the face beside their name in a friend's list. */
  farmerHeadId = 1;
  farmerBodyId = 0;
  /** The head whose BONUS is live, when the player has pinned one. `null` means
   *  "whatever I'm wearing supplies it", which is how the single-slot version
   *  behaved, so an untouched save keeps its bonus exactly as before. */
  farmerBonusHeadId: number | null = null;
  // ---- cosmetic pets (server authoritative while signed in) ----
  ownedPets: string[] = [];
  activePet: string | null = null;
  penPets: string[] = [];
  // ---- consumable boosts (bought from the Market Boosts tab) ----
  boostInv: { key: string; count: number }[] = [];
  // ---- zombie abilities ----
  // DEPRECATED: ability unlocking is now derived from raidsCompleted (see
  // abilityUnlocked). Kept as an optional persisted field for save compatibility.
  unlockedAbilities: string[] = [];
  // ---- Zombie Pot pricing ----
  // The Zombie Pot's first acquisition costs 500 GOLD; every one after that costs
  // a flat 3 BRAINS, permanently. This is sticky: once the player has ever owned a
  // pot (bought OR gifted by the tutorial), it stays at 3 brains even if they sell
  // it, so it must persist rather than be derived from whether a pot is on the farm.
  zombiePotBought = false;
  // ---- raids: lifetime win count per raid id (drives "first clear" + stats) ----
  raidsCompleted: Record<string, number> = {};
  // Epoch ms of the last completed invasion (drives the between-raids cooldown).
  lastRaidAt = 0;
  // OFFLINE brain pity: brain-eligible invasions (boss wins) settled since the last brain
  // drop. The offline roll floors a zero once this reaches BRAIN_PITY_INVASIONS. ONLINE the
  // server owns the equivalent counter (raid_state_v3.brain_dry_streak) and never sends it
  // down, so this stays 0 while signed in. Nothing in the UI reads it — by design.
  brainDryStreak = 0;
  // OFFLINE rare-zombie pity, keyed by raid id: wins of that raid since it last dropped its
  // rare zombie. At RAID_ZOMBIE_PITY_WINS the next win hands it over outright. Server-owned
  // online (raid_state_v3.zombie_dry_json) and, like the above, deliberately unread by any UI.
  zombieDryWins: Record<string, number> = {};
  // The player's chosen attack order (deployed zombie ids, first attacks first).
  // Persisted so the Army screen reopens with the same ordering after a raid.
  raidAttackOrder: string[] = [];
  // ---- saved farm line-ups ("teams") ----
  // A name plus owned zombie ids (see zombie/teams.ts). Assembling one is nothing
  // but a batch of the store/deploy moves the Mausoleum already offers, so this
  // list is presentation data: it confers no zombie, slot or bonus of its own.
  zombieTeams: ZombieTeam[] = [];
  // ---- limited Epic Boss run ----
  epicBossRun: EpicBossRun | null = null;
  // ---- friends (local offline-fallback list) ----
  // The online friend system is server-backed (net/api.ts + HUD): friend codes,
  // server friend lists, and daily brain gifting live on the Worker. This local
  // list is the offline-build fallback; gifting a brain is recorded here. See
  // social/friends.ts.
  friends: Friend[] = [];
  // ---- lifetime statistics (the Account menu's Statistics panel) ----
  // A kept tally: nothing here can be recovered from the save after the fact (see
  // stats.ts). Purely cosmetic — no price, gate, reward or unlock reads it.
  stats: FarmStats = newFarmStats(Date.now());
  // Balances as of the last time the tally was reconciled. Gold and brains move
  // through half a dozen paths — locally through addGold, online through the
  // economy's optimistic apply and the server reconcile that follows it — and the
  // ONE thing they all agree on is where the balance ends up. So earned/spent is
  // read off the balance itself rather than hooked onto each path, which is also
  // what keeps an online harvest from being counted twice.
  private tallyGold = this.gold;
  private tallyBrains = this.brains;

  // ---- first-run guided tutorial (Tim Buckwheat) ----
  // Progress {done, step, target}; undefined = never started. The
  // TutorialController reads/writes this via setTutorial() so autosave (which
  // listens to onChange) captures every step advance. The target is stored so
  // reloads keep the arrow and input gate on the same server-owned plot.
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
        action: { type: "plant" | "harvest" | "plow" | "remove" | "move"; oc: number; or: number;
                  toOc?: number; toOr?: number; cropKey?: string; fertilized?: boolean; unitId?: string },
        optimistic: { gold?: number; brains?: number; xp?: number }
      ) => void)
    | null = null;
  /** Re-check online writer availability when a delayed farm job actually executes.
   * A job may have spent several seconds queued after the original pointer tap. */
  canMutateOnline: (() => boolean) | null = null;

  /** Adopt the server's authoritative balance (economy reconcile). Sets the values
   *  and re-renders WITHOUT emitting an onMoney event — this is server truth being
   *  mirrored down, not a player action to report back up. */
  syncBalance(gold: number, brains: number, xp: number) {
    const before = this.level;
    this.gold = gold;
    this.brains = brains;
    this.xp = xp;
    const after = this.level;
    this.accrueCurrencyStats();
    // Reconciliation still needs to restore a missed level-up presentation notification.
    if (after > before) this.onLevelUpCb?.(before, after);
    this.emit();
  }

  /** ONLINE: submit a boost buy/use/grant to the server's owned inventory instead of
   *  mutating boostInv locally. The balance client applies the optimistic effect and
   *  reconciles to server truth (see syncInventory). Null offline, where boosts stay
   *  purely local. */
  onInventory:
    | ((
        action: { type: "buy" | "use" | "grant"; key: string; qty?: number; unitId?: string; localZombieHarvests?: { id: string; oc: number; or: number }[]; oc?: number; or?: number; target?: "zombie_pot" },
        optimistic: { count: number; gold?: number; brains?: number; xp?: number }
      ) => void)
    | null = null;

  /** ONLINE: sell a zombie through the server-owned roster — the server prices +
   *  credits it (and rejects a unit it doesn't own, so a fabricated zombie can't be
   *  cashed out). `value` is the client's optimistic estimate, reconciled to server
   *  truth. Null offline, where the sell credits gold locally. */
  onRosterSell: ((unitId: string, value: number) => void) | null = null;
  /** ONLINE fruit-tree harvests are semantic object commands; the local animation
   * remains immediate while the server validates ownership/readiness. */
  onTreeHarvest: ((instanceId: string, optimisticGold: number) => void) | null = null;

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
   *  the pot's price is a flat 3 brains forever (see zombiePotBought). */
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

  /** XP earned within this level and the amount required to reach the next one. */
  get levelXp(): { current: number; required: number } | null {
    const l = this.level;
    if (l >= XP_THRESHOLDS.length) return null;
    const cur = XP_THRESHOLDS[l - 1];
    const next = XP_THRESHOLDS[l];
    return { current: this.xp - cur, required: next - cur };
  }

  addGold(n: number, reason = "misc") {
    this.gold += n;
    this.onMoney?.("gold", n, reason);
    this.accrueCurrencyStats();
    this.emit();
  }
  spendGold(n: number, reason = "purchase"): boolean {
    if (this.gold < n) return false;
    this.gold -= n;
    this.onMoney?.("gold", -n, reason);
    this.accrueCurrencyStats();
    this.emit();
    return true;
  }
  spendBrains(n: number, reason = "purchase"): boolean {
    if (this.brains < n) return false;
    this.brains -= n;
    this.onMoney?.("brains", -n, reason);
    this.accrueCurrencyStats();
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

  /** Effects granted when the player levels up. Resets the between-invasions timer so a
   *  fresh raid is ready, and notifies the HUD to show the unlock popup. The real game
   *  also refills zombie hunger — that belongs with the (later) hunger phase; wire the
   *  reset in here when it lands.
   *
   *  NOTE: leveling up no longer grants brains (post-brainflation revert). A single brain
   *  is now ~10x more valuable, so the old +1-brain-per-level drip was removed; brains come
   *  from raids, epic bosses, gifts, and the market economy instead. */
  private onLevelUp(from: number, to: number) {
    this.lastRaidAt = 0; // raid timer resets on level up
    this.onLevelUpCb?.(from, to);
  }
  addBrains(n: number, reason = "misc") {
    this.brains += n;
    this.onMoney?.("brains", n, reason);
    this.accrueCurrencyStats();
    this.emit();
  }

  /** Fold the movement since the last check into the lifetime earned/spent totals.
   *  Called from every writer of gold/brains, INCLUDING the server reconcile: a
   *  correction that takes gold back reads as spending, which is the honest answer
   *  when the optimistic credit that preceded it was already counted as earnings. */
  private accrueCurrencyStats() {
    const gold = this.gold - this.tallyGold;
    if (gold > 0) this.stats.goldEarned += gold;
    else if (gold < 0) this.stats.goldSpent -= gold;
    const brains = this.brains - this.tallyBrains;
    if (brains > 0) this.stats.brainsEarned += brains;
    else if (brains < 0) this.stats.brainsSpent -= brains;
    this.tallyGold = this.gold;
    this.tallyBrains = this.brains;
  }

  /** Give back the booking of an optimistic movement that never happened.
   *
   *  The tally is read off the balance (accrueCurrencyStats), which counts an online
   *  action exactly once — but it also counts a balance that DIPS AND RECOVERS twice,
   *  once on each side: a spend the server then refuses springs back as "income"; an
   *  outbox cleared when the writer moved or a conflict rebased springs its spends
   *  back the same way, and they book as spending AGAIN when the server's own figure
   *  lands; a Black Market post's escrow books as spending going up and income coming
   *  home. That is how one player's lifetime brains read 141 earned / 127 spent
   *  against a real 62 — both sides inflated by the same wobble.
   *
   *  `gold` / `brains` are the SIGNED deltas that were booked (a spend is negative).
   *  The stats hand the booking back, and the tally baseline shifts by the same
   *  amount, so the balance correction that follows — the delta vanishing from the
   *  optimistic overlay, or the server's figure arriving — books nothing. Whatever
   *  really happened is then counted exactly once, when the server's balance carries
   *  it. Callers pair this with the correction in the same synchronous run: a tally
   *  shifted ahead of its balance would book the gap on the next unrelated accrual. */
  unbookCurrency(gold: number, brains: number) {
    if (gold > 0) this.stats.goldEarned = Math.max(0, this.stats.goldEarned - gold);
    else if (gold < 0) this.stats.goldSpent = Math.max(0, this.stats.goldSpent + gold);
    if (brains > 0) this.stats.brainsEarned = Math.max(0, this.stats.brainsEarned - brains);
    else if (brains < 0) this.stats.brainsSpent = Math.max(0, this.stats.brainsSpent + brains);
    this.tallyGold -= gold;
    this.tallyBrains -= brains;
  }

  /** Adopt a balance WITHOUT counting it as earned or spent. Loading a save, or
   *  importing one, is not a windfall — without this an account with 50,000 gold
   *  would book that much in earnings every time it signed in. */
  private rebaseCurrencyStats() {
    this.tallyGold = this.gold;
    this.tallyBrains = this.brains;
  }

  // ---- lifetime statistics ----
  /** Restore a persisted tally (save load). Rebases the currency baseline with it,
   *  because the balance arrives in the same breath. */
  restoreStats(stats: FarmStats) {
    this.stats = stats;
    this.rebaseCurrencyStats();
  }

  /** Fold another copy of THIS farm's tally into the live one, keeping the higher of
   *  each counter (see mergeFarmStats). Used when the server turns out to hold counts
   *  this client has never seen — another device wrote while this one was away — so
   *  that the write about to go out cannot roll the account back. Returns the merged
   *  tally, which is what should be sent. */
  mergeStats(incoming: FarmStats): FarmStats {
    this.stats = mergeFarmStats(this.stats, incoming);
    return this.stats;
  }

  /** One harvested plot. `zombieCrop` also credits the zombie it produced — the two
   *  are the same act, and a zombie crop is still a crop for the favourite. */
  recordHarvest(cropKey: string, zombieCrop: boolean) {
    if (cropKey) this.stats.harvested[cropKey] = (this.stats.harvested[cropKey] ?? 0) + 1;
    if (zombieCrop) this.stats.zombiesGrown++;
  }
  recordPlanted() { this.stats.planted++; }
  recordPlowed() { this.stats.plowed++; }
  recordTreeHarvest() { this.stats.treesHarvested++; }
  recordZombieCombined() { this.stats.zombiesCombined++; }
  recordZombieSold() { this.stats.zombiesSold++; }
  /** One settled invasion. Retreats count as losses — the army came home beaten. */
  recordRaidSettled(won: boolean) {
    if (won) this.stats.raidsWon++;
    else this.stats.raidsLost++;
  }
  /** Adopt a freshly DERIVED army cap (base + placed objects). The cap is never
   *  accumulated — see armyCapacity.ts for why a running total could not hold. */
  syncArmyCapacity(zombieMax: number) {
    const next = Math.max(1, zombieMax);
    if (next === this.zombieMax) return;
    this.zombieMax = next;
    this.emit();
  }
  /** Adopt server base capacity plus authoritative placed-object effects. */
  syncCapacities(zombieMax: number, itemCap: number) {
    this.zombieMax = Math.max(1, zombieMax);
    this.storageItemCap = Math.max(0, itemCap);
    this.emit();
  }
  // Set the live owned-zombie count (driven by the ZombieField roster).
  setZombieCount(n: number) {
    this.zombieCount = Math.max(0, n);
    this.emit();
  }
  /** Adopt a freshly DERIVED shed capacity (the placed shed's tier). Like the army
   *  cap this is never nudged in place — see shedCapacity.ts for the saves that
   *  disagreed with the farm when it was. */
  syncShedCapacity(itemCap: number) {
    const next = Math.max(0, itemCap);
    if (next === this.storageItemCap) return;
    this.storageItemCap = next;
    this.emit();
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

  /** Remember zombies that just died, so a Memorial Statue can enshrine one. Does
   *  NOT resurrect anything: a fallen zombie is out of the roster for good, and the
   *  only undo was the revival offer shown when the raid settled. */
  recordFallen(fallen: FallenZombie[]) {
    if (!fallen.length) return;
    const known = new Set(this.fallenZombies.map((z) => z.id));
    const added = fallen.filter((z) => !known.has(z.id));
    if (!added.length) return;
    this.fallenZombies = trimFallen([...this.fallenZombies, ...added]);
    this.stats.zombiesLost += added.length;
    this.emit();
  }

  /** Un-bury zombies the player bought back at the post-raid revival offer. They
   *  are alive again, so a memorial must not be able to remember them. */
  forgetFallen(ids: string[]) {
    if (!ids.length) return;
    const revived = new Set(ids);
    const kept = this.fallenZombies.filter((z) => !revived.has(z.id));
    if (kept.length === this.fallenZombies.length) return;
    // Bought back at the post-raid offer, so they were never lost after all.
    this.stats.zombiesLost = Math.max(0, this.stats.zombiesLost -
      (this.fallenZombies.length - kept.length));
    this.fallenZombies = kept;
    this.emit();
  }

  /** Take one fallen zombie out of the graveyard — it is moving onto a statue,
   *  which then owns the snapshot. Returns null if it is already gone (a second
   *  statue cannot enshrine the same zombie). */
  claimFallen(id: string): FallenZombie | null {
    const index = this.fallenZombies.findIndex((z) => z.id === id);
    if (index < 0) return null;
    const [claimed] = this.fallenZombies.splice(index, 1);
    this.emit();
    return claimed;
  }

  /** Put an enshrined zombie back in the graveyard — the statue holding it was
   *  removed, or the player took them off it. They rejoin at the TOP of the list
   *  rather than at their date of death (see graveyardRank): a farm that has lost
   *  sixty zombies since would otherwise evict them the instant the statue is sold,
   *  which is the opposite of what the sell confirmation promises. They still age
   *  out — just behind the next sixty losses instead of immediately. */
  releaseFallen(fallen: FallenZombie, at = Date.now()) {
    if (this.fallenZombies.some((z) => z.id === fallen.id)) return;
    this.fallenZombies = trimFallen([...this.fallenZombies, releasedToGraveyard(fallen, at)]);
    this.emit();
  }

  /** Record one obtained zombie of `key` in the Almanac's lifetime counter, along with
   *  every mutation it arrived wearing.
   *
   *  `mutation` is REQUIRED. It used to default to 0, and that default is how the
   *  Mutation Almanac stopped recording crop mutations earned online: the optimistic
   *  harvest spawned with no mask, counted the species, and the real mask the server
   *  rolled arrived later on a path that had already decided the unit was known. A
   *  caller that genuinely has no mask says so with an explicit 0 (a species counts
   *  even bare) — but it has to say it, so the next such gap fails to compile. */
  recordZombieDiscovered(key: string, mutation: number) {
    this.zombieDiscovered[key] = (this.zombieDiscovered[key] ?? 0) + 1;
    this.recordMutationsDiscovered(mutation, { emit: false });
    this.emit();
  }

  /** Credit every mutation in `mask` without touching the species count. For a
   *  zombie whose species was counted when it was spawned and whose mask only became
   *  known afterwards — an online harvest, where the server rolls the crop mutations
   *  and hands them back with the reconciled roster. Pass the NEW bits only (see
   *  newMutationBits in zombie/mutationMask.ts); a mask of 0 records nothing. */
  recordMutationsDiscovered(mask: number, opts: { emit?: boolean } = {}) {
    for (const def of mutationsOf(mask)) {
      this.mutationDiscovered[def.key] = (this.mutationDiscovered[def.key] ?? 0) + 1;
    }
    if (opts.emit !== false) this.emit();
  }

  /** The Almanac counts what the player OWNS, not where they keep it, so a reward
   *  zombie parked in Received is discovered exactly like one standing on the farm.
   *  Every grant path now counts at the moment the unit is earned; this floor is
   *  the repair for markers earned BEFORE that was true, which would otherwise stay
   *  silhouetted until claimed (and, once claiming stopped double-counting, forever).
   *  A floor rather than an increment, so it is idempotent across reloads and never
   *  fights the earn-time count. */
  countUnclaimedZombieRewards() {
    const pending: Record<string, number> = {};
    for (const entry of this.received) {
      const zombie = parseReceivedZombie(entry);
      if (zombie) pending[zombie.key] = (pending[zombie.key] ?? 0) + 1;
    }
    for (const [key, count] of Object.entries(pending)) {
      this.zombieDiscovered[key] = Math.max(this.zombieDiscovered[key] ?? 0, count);
    }
  }

  /** Add a looted/rewarded item to the Received bucket (unlimited). */
  receiveItem(key: string) {
    this.received.push(key);
    this.countUnclaimedZombieRewards();
    this.emit();
  }

  /** Adopt the server's authoritative item storage (Received bucket + shed). ONLINE the
   *  server owns both: raid loot is rolled and granted there, and the roll reads them to
   *  decide whether a unique may still drop — so an edited save must not decide them.
   *  Counts are expanded back into the client's list shapes.
   *
   *  The SHED is a special case. A packed decoration is a server OBJECT carrying
   *  status "stored", so the shed's real contents arrive through syncObjectStorage;
   *  `stored` here is the legacy item bucket, which is empty for every account that
   *  packs things away the modern way. Adopting an empty bucket verbatim blanked the
   *  shed on EVERY authoritative response and left it blank whenever the object
   *  projection that restores it was superseded mid-flight (it bails on a newer
   *  reconcile) — the shed looked wiped after actions that swap an object in place,
   *  such as a storage-shed upgrade. Only a non-empty legacy bucket replaces it. */
  syncStorage(received: Record<string, number>, stored: Record<string, number>) {
    this.received = [];
    for (const [key, n] of Object.entries(received)) {
      for (let i = 0; i < n; i++) this.received.push(key);
    }
    const legacy = Object.entries(stored).filter(([, count]) => count > 0);
    if (legacy.length) this.storedItems = legacy.map(([key, count]) => ({ key, count }));
    this.countUnclaimedZombieRewards();
    this.emit();
  }

  /** Add all source entries with no positive price to a player's wardrobe. */
  seedFarmerCatalog(catalog: FarmerCatalog) {
    const heads = catalog.heads.filter((part) => !part.cost).map((part) => part.id);
    const bodies = catalog.bodies.filter((part) => !part.cost).map((part) => part.id);
    this.ownedFarmerHeads = [...new Set([...this.ownedFarmerHeads, ...heads])];
    this.ownedFarmerBodies = [...new Set([...this.ownedFarmerBodies, ...bodies])];
    if (!this.ownedFarmerHeads.includes(this.farmerHeadId)) this.farmerHeadId = this.ownedFarmerHeads[0] ?? 1;
    if (!this.ownedFarmerBodies.includes(this.farmerBodyId)) this.farmerBodyId = this.ownedFarmerBodies[0] ?? 0;
  }

  /** Adopt authoritative online head ownership while retaining source-free parts. */
  syncFarmerOwnership(
    headIds: number[],
    catalog: FarmerCatalog,
    equippedHeadId?: number,
    bonusHeadId?: number | null
  ) {
    this.ownedFarmerHeads = [...new Set(headIds.filter(Number.isInteger))];
    this.ownedFarmerBodies = [];
    this.seedFarmerCatalog(catalog);
    for (const head of catalog.heads) {
      if (this.ownedFarmerHeads.includes(head.id) && !this.ownedFarmerBodies.includes(head.bodyId)) {
        this.ownedFarmerBodies.push(head.bodyId);
      }
    }
    if (equippedHeadId !== undefined && this.ownedFarmerHeads.includes(equippedHeadId)) {
      this.farmerHeadId = equippedHeadId;
    }
    // A Worker that predates the slot split sends no bonus field at all; leaving the
    // local value alone there keeps "follow the worn head" rather than blanking a
    // pin the player set on a newer one.
    if (bonusHeadId !== undefined) {
      this.farmerBonusHeadId =
        bonusHeadId !== null && this.ownedFarmerHeads.includes(bonusHeadId) ? bonusHeadId : null;
    }
    this.emit();
  }

  unlockFarmerHead(id: number, bodyId: number) {
    if (!this.ownedFarmerHeads.includes(id)) this.ownedFarmerHeads.push(id);
    if (!this.ownedFarmerBodies.includes(bodyId)) this.ownedFarmerBodies.push(bodyId);
    this.emit();
  }

  equipFarmerHead(id: number): boolean {
    if (!this.ownedFarmerHeads.includes(id)) return false;
    this.farmerHeadId = id;
    this.emit();
    return true;
  }

  /** Pin (or, with null, un-pin) the head supplying bonuses. Only an owned head
   *  that actually HAS a bonus can be pinned — pinning a cosmetic would silently
   *  mean "no bonus", which is what un-pinning already reads as. */
  equipFarmerBonusHead(id: number | null): boolean {
    if (id !== null && (!this.ownedFarmerHeads.includes(id) || !farmerHeadHasEffect(id))) return false;
    this.farmerBonusHeadId = id;
    this.emit();
    return true;
  }

  equipFarmerBody(id: number): boolean {
    if (!this.ownedFarmerBodies.includes(id)) return false;
    this.farmerBodyId = id;
    this.emit();
    return true;
  }

  syncPetOwnership(keys: string[], active: string | null, pen: string[] = this.penPets) {
    this.ownedPets = [...new Set(keys.filter((key) => typeof key === "string" && key.length > 0))];
    this.activePet = active !== null && this.ownedPets.includes(active) ? active : null;
    this.penPets = [...new Set(pen)].filter((key) =>
      this.ownedPets.includes(key) && key !== this.activePet
    ).slice(0, 4);
    this.emit();
  }

  unlockPet(key: string) {
    if (!this.ownedPets.includes(key)) this.ownedPets.push(key);
    this.activePet = key;
    this.emit();
  }

  equipPet(key: string | null): boolean {
    if (key !== null && !this.ownedPets.includes(key)) return false;
    this.activePet = key;
    if (key !== null) this.penPets = this.penPets.filter((pet) => pet !== key);
    this.emit();
    return true;
  }

  setPenPets(keys: string[]): boolean {
    const pets = [...new Set(keys)];
    if (pets.length > 4 || pets.some((key) => !this.ownedPets.includes(key))) return false;
    this.penPets = pets;
    if (this.activePet && pets.includes(this.activePet)) this.activePet = null;
    this.emit();
    return true;
  }

  /** The head supplying bonuses right now — the pinned one, else the worn one. */
  bonusHeadId(): number { return activeBonusHeadId(this.farmerHeadId, this.farmerBonusHeadId); }
  /** Whether the player owns any head with a bonus at all. Until they do, the
   *  function slot is meaningless and stays out of the Market entirely. */
  hasBonusHead(): boolean { return this.ownedFarmerHeads.some(farmerHeadHasEffect); }
  farmerHarvestGold(value: number): number { return farmerGold(value, this.bonusHeadId()); }
  farmerZombieGrowMs(value: number): number { return farmerZombieGrowMs(value, this.bonusHeadId()); }
  farmerZombieStrengthMult(): number { return farmerMultiplier(this.bonusHeadId(), "zombieStrength"); }
  farmerZombieLifeMult(): number { return farmerMultiplier(this.bonusHeadId(), "zombieLife"); }
  farmerInvasionCooldownMs(value: number): number { return farmerCooldownMs(value, this.bonusHeadId()); }
  farmerWalkSpeedPx(value: number): number { return farmerSpeedPx(value, this.bonusHeadId()); }
  syncObjectStorage(stored: Record<string, number>) {
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
  /** Adopt the server's authoritative start time as soon as an invasion is accepted. */
  syncRaidCooldown(lastRaidAt: number) {
    this.lastRaidAt = Math.max(0, lastRaidAt);
    this.emit();
  }

  setEpicBossRun(run: EpicBossRun | null) {
    this.epicBossRun = run ? { ...run, attackOrder: [...run.attackOrder] } : null;
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
  /** Whether a brain can be gifted to this friend right now. */
  canGiftBrain(id: string): boolean {
    const f = this.friends.find((x) => x.id === id);
    return !!f && canGiftBrain(f, Date.now());
  }
  /** Gift one brain to a friend. Free to the player (a social faucet) — offline
   *  there is no recipient account, so the gift is only recorded on the friend.
   *  The online build credits the recipient's account server-side instead
   *  (net/api.ts → POST /gifts). Returns false if the friend is unknown or was
   *  already gifted during the current cooldown. */
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
    // A loaded balance is not income. See rebaseCurrencyStats.
    this.rebaseCurrencyStats();
    this.emit();
  }
}
