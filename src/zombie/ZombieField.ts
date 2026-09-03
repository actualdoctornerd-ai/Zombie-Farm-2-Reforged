// Manages the owned zombies living on the farm: spawning them from harvested
// zombie crops, wandering/rendering them, click-selection, and save/restore.
// Owned units share Field.entityLayer with the farmer + objects so they depth-
// sort correctly. The live roster count is mirrored into GameState.zombieCount.
import type { Container } from "pixi.js";
import { GameAssets, ZombieDef } from "../assets";
import { Field } from "../Field";
import { GameState } from "../GameState";
import { OwnedZombieSave, ZombiePotSave } from "../save/schema";
import { findEscape } from "../pathfind";
import { addMutation } from "./mutations";
import { newMutationBits } from "./mutationMask";
import { makeOwned, normalizeZombieName, OwnedZombie, RosterEntry } from "./types";
import { ZombieUnit } from "./ZombieUnit";
import { ZombiePot } from "./ZombiePot";

/** Mausoleum storage-slot capacity of the BASE building. Every tier above it is
 *  authored in placeables.json (`zombieSlots`), so the live cap comes from the
 *  placed building's def; this is only the fallback for a def that predates the
 *  field. See the Mausoleum upgrade ladder in tools/prep_placeables.py. */
export const MAUSOLEUM_CAP = 15;

export function joiningPatchTile(
  gathered: boolean,
  tiles: { col: number; row: number }[] | null,
  unitIndex: number,
): { col: number; row: number } | null {
  return gathered && tiles?.length ? tiles[unitIndex % tiles.length] : null;
}

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
  private pots = new Map<string, ZombiePot>(); // one independent job per placed pot
  /** Jobs optimistically collected locally but not yet accepted by the server. */
  private collectedPots = new Map<string, ZombiePotSave>();

  // ---- server-owned roster hooks (P12) ----
  // ONLINE only. Fire when a unit is CREATED (onGrant) or REMOVED as a casualty /
  // combined parent (onCasualty), so the server roster shadow stays accurate. Gated by
  // `rosterLive` so restoring the save (which re-spawns every unit) doesn't re-emit —
  // those are seeded via /roster/sync instead. A SELL is reported at its own call site
  // (it credits gold), so it deliberately does NOT go through onCasualty.
  onGrant: ((u: { id: string; key: string; mutation: number; invasions: number }) => void) | null = null;
  onCasualty: ((ids: string[]) => void) | null = null;
  // ---- the graveyard (Memorial Statues) ----
  // Fired for every unit lost to a raid, and again for any of them the player then
  // buys back at the revival offer. Both live here rather than at the call sites
  // because removeCasualties/reviveCasualties are the ONLY doors a zombie dies or
  // un-dies through, and the offline and server-verified raid paths use both.
  // Unlike the hooks above these are NOT gated by `rosterLive`: an offline farm has
  // no server shadow but still buries its dead.
  onFallen: ((units: OwnedZombie[]) => void) | null = null;
  onRevived: ((ids: string[]) => void) | null = null;
  // Combine goes through its own server ops so the result can be validated against the
  // two parents: onCombineStart consumes the parents; onCombineCollect grants the
  // result (the v3 server derives its species from the authoritative parents). Fall
  // back to casualty/grant if these aren't wired.
  onCombineStart: ((potId: string, parentAId: string, parentBId: string) => void) | null = null;
  /** Must return false if the collection could NOT be handed to the server, so this
   *  field can put the job back instead of destroying it (and its two parents) for a
   *  result that will never be granted. */
  onCombineCollect:
    ((potId: string, unitId: string, key: string, mutation: number, stored: boolean) => boolean)
    | null = null;
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
    private resolve: (key: string) => ZombieDef | undefined,
    private playFertilizeSfx: () => void = () => {},
    /** The farmer's current tile — where a unit with no remembered spot of its
     *  own turns up. See arrivalTile(). */
    private farmerTile: () => { col: number; row: number } = () => ({ col: 0, row: 0 })
  ) {}

  /** Where to put a zombie that has no position to restore: on the farmer, so the
   *  player sees it arrive, snapped to the nearest walkable tile if he happens to
   *  be standing in a doorway or under an object. The old fallback was (0,0) —
   *  the field's top corner, usually buried under whatever is built there. */
  private arrivalTile(): { col: number; row: number } {
    const at = this.farmerTile();
    return this.openTileNear(at.col, at.row);
  }

  /** (col,row) itself when a zombie can stand there, else the nearest tile it can.
   *  "Walkable" is not enough: a hedge tile is crossable but is no place to put a
   *  zombie down, so the search walks out to real open ground. */
  private openTileNear(atCol: number, atRow: number): { col: number; row: number } {
    const col = Math.round(atCol);
    const row = Math.round(atRow);
    const open = (c: number, r: number) => this.field.isOpenGround(c, r);
    if (open(col, row)) return { col, row };
    const out = findEscape({ col, row }, open, {
      inBounds: (c, r) => this.field.inBounds(c, r),
    });
    return out.length ? out[out.length - 1] : { col, row };
  }

  /** Where a zombie collected from a placed object turns up: beside THAT OBJECT,
   *  not wherever the farmer happens to be standing when the panel's button is
   *  pressed. Collecting a Zombie Pot from across the farm used to drop the child
   *  at the player's feet, which reads as the farmer having grown it.
   *
   *  The object's own tiles are built on, so this steps out to the open ground
   *  beside it. Falls back to the farmer if the object is gone (sold or reconciled
   *  away between the panel opening and the collection landing). */
  objectArrivalTile(instanceId: string | null | undefined): { col: number; row: number } {
    const at = instanceId ? this.field.objectAnchorTile(instanceId) : null;
    return at ? this.openTileNear(at.col, at.row) : this.arrivalTile();
  }

  /** Deployed (on-farm) unit count — what the army cap limits. */
  get count(): number {
    return this.units.length;
  }
  /** Stored (in the Mausoleum) unit count. */
  get storedCount(): number {
    return this.stored.length;
  }
  /** Mausoleum storage-slot capacity: the placed building's tier decides it, so
   *  upgrading the Mausoleum raises this immediately. Zero with none placed. */
  get mausoleumCap(): number {
    const id = this.field.mausoleumId();
    if (!id) return 0;
    return this.field.objectDefOf(id)?.zombieSlots ?? MAUSOLEUM_CAP;
  }
  /** Are all Mausoleum slots full? */
  get mausoleumFull(): boolean {
    return this.stored.length >= this.mausoleumCap;
  }
  /** Total owned units (deployed + stored). */
  get total(): number {
    return this.units.length + this.stored.length;
  }
  /** Is there a free on-farm slot to grow/deploy another zombie? The army cap
   *  limits DEPLOYED units only. Callers granting an earned zombie use this to
   *  decide between the farm and Received (see main.ts grantEarnedZombie). */
  canAdd(): boolean {
    return this.units.length < this.state.zombieMax;
  }

  /** How many more grown zombies have somewhere to go: free army slots plus free
   *  Mausoleum slots. Zero means a ripe zombie crop must stay in the ground — the
   *  farm cap is never exceeded, and the crop is never spent on a unit with no home.
   *  Callers queueing several harvests at once must debit their own pending ones. */
  zombieHarvestRoom(): number {
    const army = Math.max(0, this.state.zombieMax - this.units.length);
    const crypt = this.field.mausoleumId()
      ? Math.max(0, this.mausoleumCap - this.stored.length)
      : 0;
    return army + crypt;
  }

  /** Can a grown zombie be collected into either the active army or Mausoleum? */
  canHarvestZombie(): boolean {
    return this.zombieHarvestRoom() > 0;
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
    winner.teleportTo(spot.x, spot.y, this.patchRestSpot(winner));
    this.playFertilizeSfx();
    return winner.displayName;
  }

  /** The Zombie Patch tile a fertilizing unit should return to, or null when the
   *  farm isn't gathered (it goes back to wandering like everyone else). The tile
   *  is the same one gatherTo would have given it, so it lies back down in its own
   *  spot rather than doubling up on someone else's. */
  private patchRestSpot(unit: ZombieUnit): { col: number; row: number } | null {
    const index = this.units.indexOf(unit);
    if (index < 0) return null;
    return joiningPatchTile(this.gathered, this.field.patchRestTiles(), index);
  }

  /** Live on-farm character containers used by Pet Pen silhouette occlusion. */
  characterContainers(): Container[] {
    return this.units.map((unit) => unit.container);
  }

  /** Source `farmThink:` assigns the ready thought independently to every actor. */
  setInvasionReady(ready: boolean) {
    this.units.forEach((unit) => unit.setInvasionReady(ready));
  }

  /** A deployed, voiced zombie for occasional farm ambience. */
  randomBrainBark(): { group: string; key: string } | null {
    const voiced = this.units.filter((unit) => unit.group !== "Headless" && !unit.isSleeping);
    if (!voiced.length) return null;
    const unit = voiced[Math.floor(Math.random() * voiced.length)];
    return { group: unit.group, key: unit.typeKey };
  }

  /** Play fertilization adopted from a restored/remote server projection. That
   *  projection does not name the actor, so an eligible Garden zombie performs it. */
  animateFertilize(oc: number, or: number): string | null {
    const gardens = this.units.filter((u) => u.group === "Garden");
    if (!gardens.length) return null;
    const winner = gardens[Math.floor(Math.random() * gardens.length)];
    const spot = this.field.plotFrontSpot(oc, or);
    winner.teleportTo(spot.x, spot.y, this.patchRestSpot(winner));
    this.playFertilizeSfx();
    return winner.displayName;
  }

  private syncCount() {
    this.state.setZombieCount(this.units.length);
  }

  /** Redraw every deployed zombie after a display preference changed (mutations
   *  hidden, species body colour). Stored units carry no sprite, so they pick the new
   *  look up whenever they are deployed. */
  refreshAppearance() {
    for (const unit of this.units) unit.rebuildAppearance(this.assets);
  }

  private addUnit(data: OwnedZombie) {
    const unit = new ZombieUnit(this.assets, this.field, data);
    this.field.entityLayer.addChild(unit.container);
    this.units.push(unit);
    // Gathering at the Zombie Patch is farm-wide state. A zombie that arrives
    // after the patch was tapped should join the existing nap immediately.
    const tile = joiningPatchTile(this.gathered, this.field.patchRestTiles(), this.units.length - 1);
    if (tile) unit.sleepAt(tile.col, tile.row);
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
    this.state.recordZombieDiscovered(data.key, data.mutation);
    this.syncCount();
    return unit;
  }

  /** Spawn an owned zombie whose provenance the SERVER records as part of a harvest,
   *  suppressing the generic onGrant. The action carries this exact unit id, so firing
   *  onGrant too would be redundant. Returns null only if both destinations are full
   *  or the key is unknown. */
  spawnVerified(
    key: string, col: number, row: number, mutation?: number
  ): ZombieUnit | OwnedZombie | null {
    this.harvesting = true;
    try {
      if (this.canAdd()) return this.spawn(key, col, row, mutation);
      if (!this.field.mausoleumId() || this.mausoleumFull) return null;
      const def = this.resolve(key);
      if (!def) return null;
      const data = makeOwned(`z${this.nextId++}`, def, col, row, 0, mutation);
      this.stored.push(data);
      this.state.recordZombieDiscovered(data.key, data.mutation);
      return data;
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
    if (this.mausoleumFull) return false; // no Mausoleum, or every slot taken
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

  /** Rename an owned deployed or stored zombie. Returns the normalized saved name. */
  rename(id: string, requested: string): string | null {
    const name = normalizeZombieName(requested);
    if (!name) return null;
    const live = this.units.find((unit) => unit.id === id);
    if (live) {
      live.getData().name = name;
      return name;
    }
    const kept = this.stored.find((unit) => unit.id === id);
    if (!kept) return null;
    kept.name = name;
    return name;
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
    if (removed.length) this.onFallen?.(removed);
    return removed;
  }

  // ---- Zombie Pot: combine two owned zombies into one ----
  /** The combine job (busy/ready/remainingMs), for the HUD. */
  get combinePot(): ZombiePot {
    const firstBusy = [...this.pots.values()].find((pot) => pot.busy);
    return firstBusy ?? this.potFor(this.field.zombiePotId() ?? "legacy");
  }

  potFor(potId: string): ZombiePot {
    let pot = this.pots.get(potId);
    if (!pot) {
      // The pot resolves the child's body type through the catalog so its inherited
      // mask matches what the server computes for the same combine, and reads the
      // farm's coloured graves so a matched pair only breeds up to a class this farm
      // has actually unlocked (the server checks its own placed graves the same way).
      pot = new ZombiePot(
        undefined, undefined,
        (key) => this.resolve(key)?.group === "Headless",
        (color) => this.field.hasGrave(color)
      );
      this.pots.set(potId, pot);
    }
    return pot;
  }
  /** Can a new combine be started right now? Needs a placed Zombie Pot, no combine
   *  already running, and two DISTINCT owned zombies to feed it. */
  canCombine(potId?: string): boolean {
    const id = potId ?? this.field.zombiePotId();
    return !!id && !!this.field.objectDefOf(id)?.zombiePot && !this.potFor(id).busy && this.total >= 2;
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
  combine(idA: string, idB: string, baseDurationMs?: number, potId?: string): boolean {
    const targetPotId = potId ?? this.field.zombiePotId();
    if (!targetPotId || !this.field.objectDefOf(targetPotId)?.zombiePot) return false;
    const pot = this.potFor(targetPotId);
    if (idA === idB) return false;
    if (pot.busy) return false;
    // Both must exist BEFORE we remove anything (no partial consumption).
    const hasA = this.units.some((u) => u.id === idA) || this.stored.some((d) => d.id === idA);
    const hasB = this.units.some((u) => u.id === idB) || this.stored.some((d) => d.id === idB);
    if (!hasA || !hasB) return false;
    const peekA = this.roster().find((zombie) => zombie.id === idA)!;
    const peekB = this.roster().find((zombie) => zombie.id === idB)!;
    const defA = this.resolve(peekA.key);
    const defB = this.resolve(peekB.key);
    if (defA?.rewardOnly || defB?.rewardOnly) return false;
    // Named specials are permanent output species, so they may only occupy the
    // first (output-species) slot.
    if (defB?.category === "special") return false;
    const a = this.takeOwned(idA)!;
    const b = this.takeOwned(idB)!;
    // Both parents are consumed. ONLINE: the server records them as a combine job
    // (onCombineStart) so it can validate the result at collect; fall back to a plain
    // casualty removal if the combine hooks aren't wired.
    const reserved = this.rosterLive && !!this.onCombineStart;
    if (this.rosterLive) {
      if (this.onCombineStart) this.onCombineStart(targetPotId, idA, idB);
      else this.onCasualty?.([idA, idB]);
    }
    return pot.start(
      // Slot 1's NAME rides along with its species: the child is the zombie the player
      // put in the first slot, so it keeps that zombie's name (see ZombiePotSave.nameA).
      { id: a.id, key: a.key, name: a.name, mutation: a.mutation, color: this.colorOf(a), ...this.speciesTraits(a) },
      { id: b.id, key: b.key, mutation: b.mutation, color: this.colorOf(b), ...this.speciesTraits(b) },
      this.field.hasCombineMonolith(), // Clay Monolith → 15-min combine
      baseDurationMs,
      this.state.level,
      reserved
    );
  }

  /** Traits recorded for a parent fed to the pot. `group`, `className` and `isSpecial`
   *  drive selection (see selectCombineSpecies); `tier` and `isBaseClass` no longer do —
   *  they are persisted so a job started by an older client still round-trips.
   *  Falls back gracefully when the catalog lacks the unit. */
  private speciesTraits(z: OwnedZombie): {
    tier: number; isBaseClass: boolean; group?: string; className?: string; isSpecial: boolean;
  } {
    const def = this.resolve(z.key);
    return {
      tier: def?.tier ?? 0,
      isBaseClass: def?.category === "mutant",
      group: def?.group,
      className: def?.className,
      isSpecial: def?.category === "special",
    };
  }

  /** Is the running combine finished and ready to collect? */
  get combineReady(): boolean {
    return this.combinePot.ready;
  }

  combineReadyFor(potId: string): boolean {
    return this.potFor(potId).ready;
  }

  /** The finished zombie waiting in a ready pot, resolved through the catalog the
   *  same way collectCombine does (species mutation folded in) so the panel can
   *  show exactly what is about to be collected. Null while the pot is running,
   *  empty, or holding a species this catalog no longer knows. */
  combinePreview(potId?: string): {
    key: string; name: string; mutation: number; color?: [number, number, number];
  } | null {
    // Same pot the HUD's status reads: the tapped one, else the running job.
    const result = (potId ? this.potFor(potId) : this.combinePot).preview();
    if (!result) return null;
    const def = this.resolve(result.key);
    if (!def) return null;
    // Built through makeOwned exactly as collectCombine does, so the preview can
    // never advertise a mutation the collected unit won't have — a headless child
    // has its head/hair-eye bits stripped there (no carrot-eyed Party Zombie).
    const child = makeOwned(
      "preview", def, 0, 0, 0,
      def.mutation ? addMutation(result.mutation, def.mutation) : result.mutation,
      result.color
    );
    return { key: child.key, name: def.name, mutation: child.mutation, color: child.color };
  }

  /** Quest/server reward. `serverStored` is the authoritative placement online —
   *  including a Received zombie being claimed, which the caller has already checked
   *  against the Mausoleum cap. Offline the caller decides between the farm and
   *  Received first, so the local fallback here is only reached for a legacy grant.
   *
   *  `recordDiscovery: false` is for CLAIMING a reward already sitting in Received:
   *  the Almanac counted it when it was earned (the collection does not care which
   *  bucket a unit is in), so counting it again on the move would inflate the tally. */
  grantReward(
    key: string, col: number, row: number, serverId?: string, serverStored?: boolean,
    opts: { recordDiscovery?: boolean } = {}
  ): OwnedZombie | null {
    const def = this.resolve(key);
    if (!def) return null;
    const data = makeOwned(serverId ?? `z${this.nextId++}`, def, col, row, 0, def.mutation);
    this.harvesting = true;
    try {
      // Online, the Worker decides the location from the authoritative roster. An
      // undefined location is the offline path: use the farm while it has room, then
      // preserve the earned zombie in the Mausoleum instead of dropping the reward.
      if (serverStored !== true && this.canAdd()) { this.addUnit(data); this.syncCount(); }
      else this.stored.push(data);
      if (opts.recordDiscovery !== false) this.state.recordZombieDiscovered(data.key, data.mutation);
    } finally { this.harvesting = false; }
    return data;
  }

  /** Apply Insta-Grow to the running Zombie Pot job. */
  finishCombineNow(potId?: string): boolean {
    const id = potId ?? this.field.zombiePotId();
    return id ? this.potFor(id).finishNow() : false;
  }

  /** Can a finished combine be sent straight to the Mausoleum? Needs the building
   *  placed with a free slot — an empty crypt is never a destination. */
  canStoreCombine(): boolean {
    return !!this.field.mausoleumId() && !this.mausoleumFull;
  }

  /**
   * Collect a finished combine: builds the result zombie (species from slot 1,
   * mutations inherited per-slot deterministically) and adds
   * it to the farm at (col,row) — or, with `stored`, straight into the Mausoleum,
   * so a full farm is no longer a reason the Pot cannot be emptied. Like any zombie
   * crop, collection to the farm waits when the active army is full. Returns the new
   * unit's data, or null if nothing is ready or the chosen destination has no room.
   * Result species is re-derived from the catalog by key; an unknown key aborts and
   * returns null (job already cleared).
   */
  collectCombine(
    col: number, row: number, potId?: string, opts: { stored?: boolean } = {}
  ): OwnedZombie | null {
    const targetPotId = potId ?? this.field.zombiePotId();
    if (!targetPotId) return null;
    const toCrypt = !!opts.stored;
    // Like a ripe zombie crop, a ready Pot waits until its destination has room.
    if (toCrypt ? !this.canStoreCombine() : !this.canAdd()) return null;
    const pot = this.potFor(targetPotId);
    const pending = pot.pending ? { ...pot.pending } : null;
    const result = pot.collect();
    if (!result) return null;
    // From here the job is CLEARED. Both parents were consumed when the combine
    // started, so every remaining failure path must put the job back — abandoning it
    // destroys two zombies and yields nothing.
    const abandon = (): null => {
      if (pending) pot.restore(pending);
      this.collectedPots.delete(targetPotId);
      return null;
    };
    if (pending) this.collectedPots.set(targetPotId, pending);
    const def = this.resolve(result.key);
    if (!def) return abandon();
    const mutation = def.mutation ? addMutation(result.mutation, def.mutation) : result.mutation;
    // `result.name` is slot 1's name (see ZombiePot.preview). A job started before the
    // pot recorded it passes undefined, which is the old id-derived random name.
    const data = makeOwned(
      `z${this.nextId++}`, def, col, row, 0, mutation, result.color, result.name
    );
    // A combine result is granted via onCombineCollect (server validates it against the
    // two parents), NOT the generic onGrant — so suppress the latter while adding.
    this.combining = true;
    if (toCrypt) this.stored.push(data);
    else this.addUnit(data);
    this.state.recordZombieDiscovered(data.key, data.mutation);
    this.syncCount();
    this.combining = false;
    if (this.rosterLive) {
      if (this.onCombineCollect) {
        // A refused hand-off means the server will never grant this child. Take the
        // optimistic unit back out and restore the job so the player can collect it
        // again once the client has re-learned the job's parents.
        if (!this.onCombineCollect(targetPotId, data.id, data.key, data.mutation, toCrypt)) {
          this.takeOwned(data.id);
          this.syncCount();
          return abandon();
        }
      } else {
        this.onGrant?.({ id: data.id, key: data.key, mutation: data.mutation, invasions: data.invasions });
      }
    }
    // Lifetime tally, counted LAST: every failure path above either returns null or
    // goes through abandon(), so reaching here is the one place a Pot child is
    // certainly the player's — a refused hand-off puts the job back in the Pot.
    this.state.recordZombieCombined();
    return data;
  }

  /** Restore an optimistically collected job after authoritative rejection. */
  rollbackCombineCollection(potId: string): boolean {
    const pending = this.collectedPots.get(potId);
    if (!pending) return false;
    this.potFor(potId).restore(pending);
    this.collectedPots.delete(potId);
    return true;
  }

  /** Forget the rollback snapshot once the authoritative collection has settled. */
  confirmCombineCollection(potId: string): void {
    this.collectedPots.delete(potId);
  }

  /** Roll back a rejected authoritative combine start. Server reconciliation then
   * restores the two parents because they are no longer hidden by a pending job. */
  cancelCombine(potId: string): void {
    this.potFor(potId).cancel();
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

  /** Restore the Zombie Patch's nap state after its object and roster exist. */
  restoreGathered(gathered: boolean | undefined, tiles: { col: number; row: number }[] | null) {
    if (gathered && tiles?.length) this.gatherTo(tiles);
    else this.wakeAll();
  }

  serialize(): OwnedZombieSave[] {
    const live = this.units.map((u) => {
      const d = u.getData();
      return { id: d.id, key: d.key, name: d.name, invasions: d.invasions, mutation: d.mutation, color: d.color, pos: { col: d.col, row: d.row } };
    });
    const kept = this.stored.map((d) => ({
      id: d.id, key: d.key, name: d.name, invasions: d.invasions, mutation: d.mutation, color: d.color, pos: { col: d.col, row: d.row }, stored: true,
    }));
    return [...live, ...kept];
  }

  /** The pending combine job to persist (undefined when the pot is idle). */
  serializePot(): ZombiePotSave | undefined {
    return this.combinePot.serialize();
  }
  serializePots(): Record<string, ZombiePotSave> | undefined {
    const entries = [...this.pots.entries()].flatMap(([id, pot]) => {
      const save = pot.serialize();
      return save ? [[id, save] as const] : [];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  /** Restore a persisted combine job (offline-safe: it finishes on its epoch). */
  restorePot(save?: ZombiePotSave) {
    this.pots.clear();
    if (save) this.potFor(this.field.zombiePotId() ?? "legacy").restore(this.hydratePotSave(save));
  }
  restorePots(saves?: Record<string, ZombiePotSave>, legacy?: ZombiePotSave) {
    this.pots.clear();
    this.collectedPots.clear();
    const entries = Object.entries(saves ?? {});
    for (const [id, save] of entries) this.potFor(id).restore(this.hydratePotSave(save));
    if (!entries.length && legacy) {
      this.potFor(this.field.zombiePotId() ?? "legacy").restore(this.hydratePotSave(legacy));
    }
  }

  /** Reconcile local Pot jobs against the authoritative roster, in both directions.
   *
   * RECOVER — a surviving parent reservation (`lockedByRaid = "pot:<id>"`) proves a
   * combine started, so rebuild the job even if the local presentation lost it.
   * Recovered jobs are immediately ready: the reservation does not own the timer.
   *
   * RETIRE — the inverse, and the one whose absence used to destroy zombies. A job
   * this client believes in but the server has no reservation for can never be
   * collected, yet its two parent ids stay hidden from the presentation for as long as
   * it exists (see the callers of `pendingPotParents`). The result was two zombies
   * that were neither in the Pot nor anywhere else. Retiring the job releases them.
   *
   * `settled` must be true — with a command queued or in flight the roster predates
   * this client's own work, and a start that has not been sent yet would look exactly
   * like a job the server never got. Only jobs flagged `reserved` are retired, because
   * an older job legitimately has no reservation and the server still honours it
   * through its unreserved fallback. */
  reconcileServerPots(
    roster: { id: string; key: string; mutation: number; lockedByRaid?: string }[],
    settled = false
  ): {
    live: { potId: string; parentAId: string; parentBId: string; playerLevel: number }[];
    retired: string[];
  } {
    const reserved = new Map<string, typeof roster>();
    for (const unit of roster) {
      if (!unit.lockedByRaid?.startsWith("pot:")) continue;
      const potId = unit.lockedByRaid.slice(4);
      if (!potId) continue;
      const group = reserved.get(potId) ?? [];
      group.push(unit);
      reserved.set(potId, group);
    }

    const live: { potId: string; parentAId: string; parentBId: string; playerLevel: number }[] = [];
    for (const [potId, parents] of reserved) {
      if (parents.length !== 2) continue;
      const current = this.potFor(potId).pending;
      const sameParents = current?.parentAId && current.parentBId &&
        new Set([current.parentAId, current.parentBId]).size === 2 &&
        [current.parentAId, current.parentBId].every((id) => parents.some((u) => u.id === id));
      // SLOT ORDER IS NOT IN THE ROSTER. It arrives in CREATION order, so reading slot 1
      // off it swaps the Pot's two slots whenever the player fed in the NEWER zombie
      // first — and slot 1 is what decides the result species (see selectCombineSpecies).
      // Keep the order this client recorded when the job started; only a job this client
      // no longer holds falls back to roster order, and the server no longer takes the
      // collecting client's word for it either (engine.ts `potSlots`).
      const bySlot = sameParents
        ? [
            parents.find((unit) => unit.id === current.parentAId),
            parents.find((unit) => unit.id === current.parentBId),
          ]
        : [];
      const [a, b] = bySlot[0] && bySlot[1] ? [bySlot[0], bySlot[1]] : parents;
      if (!sameParents) {
        this.potFor(potId).restore(this.hydratePotSave({
          parentAId: a.id,
          parentBId: b.id,
          keyA: a.key,
          keyB: b.key,
          maskA: a.mutation,
          maskB: b.mutation,
          playerLevel: this.state.level,
          reserved: true,
          startedAt: 0,
          finishAt: 0,
        }));
      }
      live.push({
        potId,
        parentAId: a.id,
        parentBId: b.id,
        playerLevel: sameParents ? current.playerLevel ?? this.state.level : this.state.level,
      });
    }

    const retired: string[] = [];
    if (!settled) return { live, retired };
    for (const [potId, pot] of this.pots) {
      const job = pot.pending;
      if (!job?.reserved || reserved.has(potId)) continue;
      // Optimistically collected jobs are held in `collectedPots` for rollback and are
      // legitimately absent from the roster while their command is in flight; `settled`
      // already excludes that, but skip them explicitly rather than rely on timing.
      if (this.collectedPots.has(potId)) continue;
      pot.cancel();
      retired.push(potId);
    }
    return { live, retired };
  }
  /** Fill fields absent from pre-special-rule saves from the authoritative catalog.
   * The current level is safe as the legacy start-level fallback because levels do
   * not decrease, and the server caps it at its authoritative current level. */
  private hydratePotSave(save: ZombiePotSave): ZombiePotSave {
    const a = this.resolve(save.keyA);
    const b = this.resolve(save.keyB);
    return {
      ...save,
      tierA: save.tierA ?? a?.tier ?? 0,
      tierB: save.tierB ?? b?.tier ?? 0,
      baseA: save.baseA ?? (a?.category === "mutant"),
      baseB: save.baseB ?? (b?.category === "mutant"),
      groupA: save.groupA ?? a?.group,
      groupB: save.groupB ?? b?.group,
      specialA: save.specialA ?? (a?.category === "special"),
      specialB: save.specialB ?? (b?.category === "special"),
      playerLevel: save.playerLevel ?? this.state.level,
    };
  }
  pendingPotParents(): {
    potId: string; parentAId: string; parentBId: string; playerLevel?: number;
  }[] {
    return [...this.pots.entries()].flatMap(([potId, pot]) => {
      const p = pot.pending;
      return p?.parentAId && p.parentBId
        ? [{ potId, parentAId: p.parentAId, parentBId: p.parentBId, playerLevel: p.playerLevel }]
        : [];
    });
  }

  // Rebuild the roster from a save. Stats/taxonomy are re-derived from the key +
  // saved mutation mask; units flagged `stored` are kept off the farm.
  restore(saves: OwnedZombieSave[]) {
    for (const u of this.units) u.destroy();
    this.units = [];
    this.stored = [];
    this.selected = null;
    this.gathered = false;
    let maxN = 0;
    for (const s of saves) {
      const def = this.resolve(s.key);
      if (!def) continue;
      // A save that predates stored positions has none to restore: start the unit
      // by the farmer rather than in the top corner.
      const home = s.pos ?? this.arrivalTile();
      const col = home.col;
      const row = home.row;
      // Pass s.mutation (may be undefined) so an old save without the field falls
      // back to the species' default bit; an explicit 0 stays unmutated.
      const data = makeOwned(s.id, def, col, row, s.invasions ?? 0, s.mutation, s.color, s.name);
      if (s.stored) this.stored.push(data);
      else this.addUnit(data);
      const m = /^z(\d+)$/.exec(s.id);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    this.nextId = maxN + 1;
    this.syncCount();
  }

  /** Restore selected casualties after the one-time post-raid brain purchase. The
   * caller supplies the pre-battle snapshots, so names, mutations, veterancy and
   * farm positions survive exactly. Server hooks are suppressed because online
   * revival has already been committed authoritatively. */
  reviveCasualties(casualties: OwnedZombie[]): void {
    const owned = new Set(this.roster().map((z) => z.id));
    const live = this.rosterLive;
    this.rosterLive = false;
    try {
      for (const zombie of casualties) {
        if (owned.has(zombie.id)) continue;
        if (this.canAdd()) this.addUnit({ ...zombie });
        else this.stored.push({ ...zombie });
        owned.add(zombie.id);
      }
      this.syncCount();
    } finally {
      this.rosterLive = live;
    }
    // Anyone bought back is not dead after all, so they leave the graveyard. This
    // runs for every id offered, not just the ones re-added: a unit already in the
    // roster (`owned` above) was revived by another path and must not stay buried.
    if (casualties.length) this.onRevived?.(casualties.map((zombie) => zombie.id));
  }

  /** Reconcile a server roster without rebuilding unchanged actors. `aliases` maps
   * a new server id to the optimistic local id spawned at harvest time, preserving
   * its position while replacing its identity. */
  reconcileServerRoster(
    saves: { id: string; key: string; mutation: number; invasions: number; stored: boolean;
      restored?: boolean; color?: [number, number, number] }[],
    aliases: Record<string, string> = {}
  ) {
    const desiredIds = new Set(saves.map((save) => save.id));
    const aliasIds = new Set(Object.values(aliases));
    const current = new Map(this.roster().map((unit) => [unit.id, unit]));
    this.harvesting = true;
    try {
      for (const unit of current.values()) {
        if (!desiredIds.has(unit.id) && !aliasIds.has(unit.id)) this.takeOwned(unit.id);
      }
      for (const save of saves) {
        const direct = current.get(save.id);
        const hinted = current.get(aliases[save.id] ?? "");
        const source = direct ?? hinted;
        if (direct && direct.key === save.key && direct.mutation === save.mutation &&
            direct.invasions === save.invasions && direct.stored === save.stored) continue;
        if (source) this.takeOwned(source.id);
        const def = this.resolve(save.key);
        if (!def) continue;
        // No local counterpart means the server is handing us a unit this client
        // never placed — a Black Market purchase, most often. It has no position
        // of its own, so it joins the player at the farmer instead of the corner.
        const home = source ?? this.arrivalTile();
        // Prefer the server's tint. A unit with no local counterpart is exactly the
        // case the old code could not colour — a Black Market purchase or a cancelled
        // listing coming home under a new id — and it used to fall back to the
        // species' catalog colour, permanently, once the next save was written.
        const data = makeOwned(save.id, def, home.col, home.row, save.invasions, save.mutation,
          save.color ?? source?.color, source?.name);
        if (save.stored) this.stored.push(data);
        else this.addUnit(data);
        // A server unit with no local counterpart arriving AFTER go-live is a real
        // acquisition this client never created itself (e.g. a Black Market
        // purchase reconciled from the authoritative roster) — count it for the
        // Almanac. Pre-live reconciles are the initial bootstrap, not new grants.
        // `restored` units are the exception: the server is handing back a zombie
        // this player escrowed on a Black Market listing they then cancelled. It
        // carries a fresh unit id but it is the same zombie they already own, so
        // crediting it would let list/cancel cycles farm the lifetime count.
        if (this.rosterLive && !source && !save.restored) this.state.recordZombieDiscovered(data.key, data.mutation);
        // A unit this client DID spawn, coming back wearing mutations it did not have:
        // the online harvest. It grew optimistically with no mask (the server rolls
        // crop mutations), counted its species then, and this is the first the client
        // hears what it is wearing — so credit the new bits, and only the new bits.
        // Not gated on rosterLive: a mask that landed after the app closed is still
        // news on the next load, and it cannot inflate the count because the local
        // mask only ever catches up once.
        else if (source) {
          const gained = newMutationBits(source.mutation, save.mutation);
          if (gained) this.state.recordMutationsDiscovered(gained);
        }
      }
    } finally {
      this.harvesting = false;
    }
    this.syncCount();
  }
}
