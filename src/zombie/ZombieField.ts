// Manages the owned zombies living on the farm: spawning them from harvested
// zombie crops, wandering/rendering them, click-selection, and save/restore.
// Owned units share Field.entityLayer with the farmer + objects so they depth-
// sort correctly. The live roster count is mirrored into GameState.zombieCount.
import { GameAssets, ZombieDef } from "../assets";
import { Field } from "../Field";
import { GameState } from "../GameState";
import { OwnedZombieSave, ZombiePotSave } from "../save/schema";
import { addMutation } from "./mutations";
import { makeOwned, OwnedZombie, RosterEntry } from "./types";
import { ZombieUnit } from "./ZombieUnit";
import { ZombiePot } from "./ZombiePot";

/** Mausoleum storage-slot capacity (default; upgradeable later). */
export const MAUSOLEUM_CAP = 15;

/** Per-combat-tier fertilize chance for Garden zombies. GROUND TRUTH: the exact
 *  `fertilizeChance` values in UnitStats.json map 1:1 to a Garden unit's tier
 *  (t1 .04, t2 .06, t3/t4 .08, t5 .12), so we key off the tier the catalog already
 *  carries instead of re-baking the stat. Non-garden / tier-0 units never fertilize. */
const FERTILIZE_BY_TIER: Record<number, number> = { 1: 0.04, 2: 0.06, 3: 0.08, 4: 0.08, 5: 0.12 };

export class ZombieField {
  private units: ZombieUnit[] = []; // deployed: wandering on the farm
  private stored: OwnedZombie[] = []; // stored: off the farm, still owned
  private selected: ZombieUnit | null = null;
  private nextId = 1;
  private pot = new ZombiePot(); // the single Zombie Pot combine job (if any)

  // ---- server-owned roster hooks (P12) ----
  // ONLINE only. Fire when a unit is CREATED (onGrant) or REMOVED as a casualty /
  // combined parent (onCasualty), so the server roster shadow stays accurate. Gated by
  // `rosterLive` so restoring the save (which re-spawns every unit) doesn't re-emit —
  // those are seeded via /roster/sync instead. A SELL is reported at its own call site
  // (it credits gold), so it deliberately does NOT go through onCasualty.
  onGrant: ((u: { id: string; key: string; mutation: number; invasions: number }) => void) | null = null;
  onCasualty: ((ids: string[]) => void) | null = null;
  // Combine goes through its own server ops so the result can be validated against the
  // two parents: onCombineStart consumes the parents; onCombineCollect grants the
  // result (server checks its key is one of the parents'). Fall back to casualty/grant
  // if these aren't wired.
  onCombineStart: ((parentAId: string, parentBId: string) => void) | null = null;
  onCombineCollect: ((unitId: string, key: string, mutation: number) => void) | null = null;
  private rosterLive = false;
  private combining = false; // suppresses addUnit's generic onGrant during a collect
  private harvesting = false; // suppresses onGrant while spawning a server-harvested crop

  /** Start emitting roster hooks (call once the save is restored + the server roster
   *  seeded, so only genuine post-load changes are reported). */
  setRosterLive() {
    this.rosterLive = true;
  }

  /** All owned units (deployed + stored) as server roster seed records. */
  seedData(): { id: string; key: string; mutation: number; invasions: number }[] {
    const of = (d: OwnedZombie) => ({ id: d.id, key: d.key, mutation: d.mutation, invasions: d.invasions });
    return [...this.units.map((u) => of(u.getData())), ...this.stored.map(of)];
  }

  constructor(
    private assets: GameAssets,
    private field: Field,
    private state: GameState,
    // Resolve a zombie type key -> its catalog def (stats/taxonomy).
    private resolve: (key: string) => ZombieDef | undefined
  ) {}

  /** Deployed (on-farm) unit count — what the army cap limits. */
  get count(): number {
    return this.units.length;
  }
  /** Stored (in the Mausoleum) unit count. */
  get storedCount(): number {
    return this.stored.length;
  }
  /** Mausoleum storage-slot capacity. */
  get mausoleumCap(): number {
    return MAUSOLEUM_CAP;
  }
  /** Are all Mausoleum slots full? */
  get mausoleumFull(): boolean {
    return this.stored.length >= MAUSOLEUM_CAP;
  }
  /** Total owned units (deployed + stored). */
  get total(): number {
    return this.units.length + this.stored.length;
  }
  /** Is there a free on-farm slot to grow/deploy another zombie? The army cap
   *  limits DEPLOYED units only; stored zombies (Mausoleum) are uncapped. */
  canAdd(): boolean {
    return this.units.length < this.state.zombieMax;
  }

  /** A crop was just planted at plot (oc,or): each DEPLOYED Garden zombie rolls its
   *  tier's `fertilizeChance` (first success wins), matching the source's per-actor
   *  roll. On success the crop is flagged for a 2x harvest, the winning zombie
   *  teleports to the plot (with its leaf FX starting on the crop), and its name is
   *  returned for the "Fertilized by <name>!" toast. Null = not fertilized. */
  tryFertilize(oc: number, or: number): string | null {
    const gardens = this.units.filter((u) => u.group === "Garden");
    if (!gardens.length) return null;
    let winner: (typeof gardens)[number] | null = null;
    for (const u of gardens) {
      const chance = FERTILIZE_BY_TIER[this.resolve(u.typeKey)?.tier ?? 0] ?? 0;
      if (Math.random() < chance) { winner = u; break; }
    }
    if (!winner || !this.field.markFertilized(oc, or)) return null;
    const spot = this.field.plotFrontSpot(oc, or);
    winner.teleportTo(spot.x, spot.y);
    return winner.displayName;
  }

  private syncCount() {
    this.state.setZombieCount(this.units.length);
  }

  private addUnit(data: OwnedZombie) {
    const unit = new ZombieUnit(this.assets, this.field, data);
    this.field.entityLayer.addChild(unit.container);
    this.units.push(unit);
    if (this.rosterLive && !this.combining && !this.harvesting) {
      this.onGrant?.({ id: data.id, key: data.key, mutation: data.mutation, invasions: data.invasions });
    }
    return unit;
  }

  private colorOf(data: OwnedZombie): [number, number, number] | undefined {
    return data.color ?? this.assets.zombieModels[data.key]?.color;
  }

  // Grow a new owned zombie of `key` at farm tile (col,row). Returns the unit, or
  // null if the key isn't a known zombie type or the army is at capacity.
  spawn(key: string, col: number, row: number, mutation?: number): ZombieUnit | null {
    if (!this.canAdd()) return null;
    const def = this.resolve(key);
    if (!def) return null;
    // mutation overrides the species default (used for combine results / testing);
    // omitted, a market mutant grows in with its guaranteed bit.
    const data = makeOwned(`z${this.nextId++}`, def, col, row, 0, mutation);
    const unit = this.addUnit(data);
    this.syncCount();
    return unit;
  }

  /** Spawn an owned zombie whose provenance the SERVER records as part of some other
   *  action — a harvested zombie crop, or a redeemed gift voucher — suppressing the
   *  generic onGrant. That action carries this exact unit id, so firing onGrant too would
   *  be a redundant, rejected roster grant. Returns the new unit (whose `.id` the caller
   *  sends to the server), or null if the army is at capacity / the key is unknown. */
  spawnVerified(key: string, col: number, row: number, mutation?: number): ZombieUnit | null {
    this.harvesting = true;
    try {
      return this.spawn(key, col, row, mutation);
    } finally {
      this.harvesting = false;
    }
  }

  // ---- roster / storage ----
  /** All owned units (deployed first, then stored), for the Zombies menu. */
  roster(): RosterEntry[] {
    const live: RosterEntry[] = this.units.map((u) => ({ ...u.getData(), stored: false }));
    const kept: RosterEntry[] = this.stored.map((d) => ({ ...d, stored: true }));
    return [...live, ...kept];
  }

  // Store a deployed unit in the Mausoleum: take it off the farm (keeps it owned,
  // frees an army slot). No-op if not found / already stored.
  store(id: string): boolean {
    if (this.stored.length >= MAUSOLEUM_CAP) return false; // Mausoleum full
    const i = this.units.findIndex((u) => u.id === id);
    if (i < 0) return false;
    const u = this.units[i];
    if (this.selected === u) this.selected = null;
    this.stored.push({ ...u.getData() });
    u.destroy();
    this.units.splice(i, 1);
    this.syncCount();
    return true;
  }

  // Deploy a stored unit back onto the farm at its saved tile. Refused if the
  // farm is already at the army cap.
  deploy(id: string): boolean {
    if (!this.canAdd()) return false;
    const i = this.stored.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const data = this.stored[i];
    this.stored.splice(i, 1);
    this.addUnit(data);
    this.syncCount();
    return true;
  }

  // Permanently sell an owned zombie (deployed or stored) by id, returning its
  // data (or null if not found). The caller credits the gold; the unit leaves the
  // roster for good. Reuses takeOwned, so it also clears the selection/frees the
  // army slot when a deployed unit is sold.
  sell(id: string): OwnedZombie | null {
    return this.takeOwned(id);
  }

  /** Permanently remove raid casualties (dead units, by id) from the roster.
   *  GROUND TRUTH: a downed zombie is a permanent loss — raids cull the fallen
   *  (IMPLEMENTATION_RAIDS_PLAN Phase 6). Called by RaidManager.finishRaid with
   *  outcome.losses. Reuses takeOwned, so each deployed casualty's sprite is
   *  destroyed, its army slot freed, and the selection cleared. Returns the
   *  removed unit data. */
  removeCasualties(ids: string[]): OwnedZombie[] {
    const removed: OwnedZombie[] = [];
    for (const id of ids) {
      const data = this.takeOwned(id);
      if (data) removed.push(data);
    }
    // Drop the dead from the server shadow too, so they can't be sold after dying.
    if (this.rosterLive && removed.length) this.onCasualty?.(removed.map((r) => r.id));
    return removed;
  }

  // ---- Zombie Pot: combine two owned zombies into one ----
  /** The combine job (busy/ready/remainingMs), for the HUD. */
  get combinePot(): ZombiePot {
    return this.pot;
  }
  /** Can a new combine be started right now? Needs a placed Zombie Pot, no combine
   *  already running, and two DISTINCT owned zombies to feed it. */
  canCombine(): boolean {
    return this.field.hasZombiePot() && !this.pot.busy && this.total >= 2;
  }

  // Remove an owned zombie (deployed or stored) by id and return its data, or
  // null. Used to feed parents into the pot (they leave the roster on combine).
  private takeOwned(id: string): OwnedZombie | null {
    const i = this.units.findIndex((u) => u.id === id);
    if (i >= 0) {
      const u = this.units[i];
      if (this.selected === u) this.selected = null;
      const data = { ...u.getData() };
      u.destroy();
      this.units.splice(i, 1);
      this.syncCount();
      return data;
    }
    const j = this.stored.findIndex((d) => d.id === id);
    if (j >= 0) {
      const [data] = this.stored.splice(j, 1);
      return data;
    }
    return null;
  }

  /**
   * Start combining zombies `idA` and `idB` in the Zombie Pot. Both parents are
   * consumed immediately (removed from the roster). The Mutant Monolith, if
   * placed, halves the timer. Returns false (consuming nothing) if the pot isn't
   * available, a combine is already running, the ids are the same, or either id
   * isn't owned.
   */
  combine(idA: string, idB: string, baseDurationMs?: number): boolean {
    if (idA === idB) return false;
    if (!this.field.hasZombiePot() || this.pot.busy) return false;
    // Both must exist BEFORE we remove anything (no partial consumption).
    const hasA = this.units.some((u) => u.id === idA) || this.stored.some((d) => d.id === idA);
    const hasB = this.units.some((u) => u.id === idB) || this.stored.some((d) => d.id === idB);
    if (!hasA || !hasB) return false;
    const a = this.takeOwned(idA)!;
    const b = this.takeOwned(idB)!;
    // Both parents are consumed. ONLINE: the server records them as a combine job
    // (onCombineStart) so it can validate the result at collect; fall back to a plain
    // casualty removal if the combine hooks aren't wired.
    if (this.rosterLive) {
      if (this.onCombineStart) this.onCombineStart(idA, idB);
      else this.onCasualty?.([idA, idB]);
    }
    return this.pot.start(
      { key: a.key, mutation: a.mutation, color: this.colorOf(a), ...this.speciesTraits(a) },
      { key: b.key, mutation: b.mutation, color: this.colorOf(b), ...this.speciesTraits(b) },
      this.field.hasCombineMonolith(), // Clay Monolith → 15-min combine
      baseDurationMs
    );
  }

  /** Species-selection traits for a parent fed to the pot: its combat tier and
   *  whether it's a veggie/mutant-tier "mutation base class" (category "mutant").
   *  See ZombiePot.pickSpecies (determineBaseClass). Falls back gracefully when
   *  the catalog lacks the unit (tier 0, non-veggie). */
  private speciesTraits(z: OwnedZombie): { tier: number; isBaseClass: boolean } {
    const def = this.resolve(z.key);
    return { tier: def?.tier ?? 0, isBaseClass: def?.category === "mutant" };
  }

  /** Is the running combine finished and ready to collect? */
  get combineReady(): boolean {
    return this.pot.ready;
  }

  /**
   * Collect a finished combine: builds the result zombie (species via
   * determineBaseClass, mutations inherited per-slot deterministically) and adds
   * it to the farm at (col,row), or to storage if the army is at capacity.
   * Returns the new unit's data, or null if nothing is ready. Result species is
   * re-derived from the catalog by key; an unknown key aborts and returns null
   * (job already cleared).
   */
  collectCombine(col: number, row: number): OwnedZombie | null {
    const result = this.pot.collect();
    if (!result) return null;
    const def = this.resolve(result.key);
    if (!def) return null;
    const mutation = def.mutation ? addMutation(result.mutation, def.mutation) : result.mutation;
    const data = makeOwned(`z${this.nextId++}`, def, col, row, 0, mutation, result.color);
    // A combine result is granted via onCombineCollect (server validates it against the
    // two parents), NOT the generic onGrant — so suppress the latter while adding.
    this.combining = true;
    if (this.canAdd()) {
      this.addUnit(data);
      this.syncCount();
    } else {
      this.stored.push(data); // no free army slot -> goes to the Mausoleum
    }
    this.combining = false;
    if (this.rosterLive) {
      if (this.onCombineCollect) this.onCombineCollect(data.id, data.key, data.mutation);
      else this.onGrant?.({ id: data.id, key: data.key, mutation: data.mutation, invasions: data.invasions });
    }
    return data;
  }

  /** Credit a fought invasion to each unit in `ids` (drives veterancy). Applies
   *  to deployed and stored units alike; persists via serialize(). */
  recordInvasion(ids: string[]) {
    const set = new Set(ids);
    for (const u of this.units) if (set.has(u.id)) u.getData().invasions++;
    for (const d of this.stored) if (set.has(d.id)) d.invasions++;
  }

  /** Mirror a server-verified raid result without re-submitting roster mutations. */
  applyServerRaidOutcome(survivors: string[], losses: string[]): void {
    const live = this.rosterLive;
    this.rosterLive = false;
    try {
      this.recordInvasion(survivors);
      this.removeCasualties(losses);
    } finally {
      this.rosterLive = live;
    }
  }

  // Select a deployed unit by id (from the roster) and report where it is on the
  // farm so the caller can center the camera on it. Null if not deployed.
  selectById(id: string): { x: number; y: number } | null {
    const u = this.units.find((x) => x.id === id);
    if (!u) return null;
    this.select(u);
    return u.worldPos;
  }

  // Front-most owned zombie whose sprite contains the world point, or null.
  pick(wx: number, wy: number): ZombieUnit | null {
    let best: ZombieUnit | null = null;
    for (const u of this.units) {
      if (!u.containsPoint(wx, wy)) continue;
      if (!best || u.sortDepth > best.sortDepth) best = u;
    }
    return best;
  }

  select(unit: ZombieUnit | null) {
    if (this.selected === unit) return;
    this.selected?.setSelected(false);
    this.selected = unit;
    this.selected?.setSelected(true);
  }

  clearSelection() {
    this.select(null);
  }

  update(dt: number) {
    for (const u of this.units) u.update(dt);
  }

  // ---- Zombie Patch: gather units to nap / wake them ----
  private gathered = false;
  get isGathered(): boolean {
    return this.gathered;
  }
  // Call every deployed unit to nap on the patch (distribute across its tiles).
  gatherTo(tiles: { col: number; row: number }[]) {
    if (!tiles.length) return;
    this.units.forEach((u, i) => {
      const t = tiles[i % tiles.length];
      u.sleepAt(t.col, t.row);
    });
    this.gathered = true;
  }
  // Wake every unit so they resume wandering.
  wakeAll() {
    for (const u of this.units) u.wake();
    this.gathered = false;
  }
  // Tap the patch: gather if awake, wake if napping. Returns the new state.
  toggleGather(tiles: { col: number; row: number }[] | null): boolean {
    if (this.gathered) { this.wakeAll(); return false; }
    if (tiles) this.gatherTo(tiles);
    return this.gathered;
  }

  serialize(): OwnedZombieSave[] {
    const live = this.units.map((u) => {
      const d = u.getData();
      return { id: d.id, key: d.key, invasions: d.invasions, mutation: d.mutation, color: d.color, pos: { col: d.col, row: d.row } };
    });
    const kept = this.stored.map((d) => ({
      id: d.id, key: d.key, invasions: d.invasions, mutation: d.mutation, color: d.color, pos: { col: d.col, row: d.row }, stored: true,
    }));
    return [...live, ...kept];
  }

  /** The pending combine job to persist (undefined when the pot is idle). */
  serializePot(): ZombiePotSave | undefined {
    return this.pot.serialize();
  }
  /** Restore a persisted combine job (offline-safe: it finishes on its epoch). */
  restorePot(save?: ZombiePotSave) {
    this.pot.restore(save);
  }

  // Rebuild the roster from a save. Stats/taxonomy are re-derived from the key +
  // saved mutation mask; units flagged `stored` are kept off the farm.
  restore(saves: OwnedZombieSave[]) {
    for (const u of this.units) u.destroy();
    this.units = [];
    this.stored = [];
    this.selected = null;
    let maxN = 0;
    for (const s of saves) {
      const def = this.resolve(s.key);
      if (!def) continue;
      const col = s.pos?.col ?? 0;
      const row = s.pos?.row ?? 0;
      // Pass s.mutation (may be undefined) so an old save without the field falls
      // back to the species' default bit; an explicit 0 stays unmutated.
      const data = makeOwned(s.id, def, col, row, s.invasions ?? 0, s.mutation, s.color);
      if (s.stored) this.stored.push(data);
      else this.addUnit(data);
      const m = /^z(\d+)$/.exec(s.id);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    this.nextId = maxN + 1;
    this.syncCount();
  }
}
