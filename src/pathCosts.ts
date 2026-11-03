// What placed terrain costs a walker, in tiles-worth-of-effort per tile entered.
//
// The pathfinder used to be a pure yes/no: a placed object blocked the tile, bare
// ground did not, and everything else was identical. That made a hedge an absolute
// wall (a zombie fenced in by one could only ever be teleported out) and it made a
// road no more attractive to walk on than the grass beside it — in fact roads were
// BLOCKING, because they are placed objects like any other.
//
// So terrain now has a price instead. Nothing here is impassable except genuinely
// solid objects (a barn, a tree, a Mausoleum); a hedge is merely so ruinously
// expensive that a route only crosses one when there is no other way round at all,
// which is the behaviour a fence is supposed to have without the "permanently
// stuck" failure mode. The ordering between the barrier numbers is the design:
//
//   path 0.75  <  ground/open gate 1  <  pond 3  <<  closed gate 9000  <  hedge 10000
//
// A closed gate undercutting the fence run it sits in is what makes a penned-in
// walker leave through the DOOR rather than straight through the hedge.
import type { PlaceableDef } from "./assets";

/** Bare grass, a plot, a zombie patch — the baseline a step is measured against. */
export const COST_GROUND = 1;
/** Roads and cobbles. Cheaper than grass, so a route drifts onto a path that runs
 *  roughly its way — but only just, or walkers would take absurd detours to reach
 *  one and the farm would look like everybody was allergic to the lawn. */
export const COST_PATH = 0.75;
/** Water. Crossable — a small ornamental pond is not a cliff — but three times the
 *  price of dry ground, so anything but a long way round goes around it. */
export const COST_POND = 3;
/** An open gate is a doorway: it costs exactly what walking through the gap would. */
export const COST_GATE_OPEN = 1;
/** A shut gate. Below COST_BARRIER on purpose — see the file header. */
export const COST_GATE_CLOSED = 9000;
/** Hedges, fences, dividers: the thing you are not supposed to walk through. */
export const COST_BARRIER = 10000;
/** A SOLID object (a tree, a statue, a flower bed), for the one walker allowed to
 *  climb over one: a zombie called to the Zombie Patch from a field the player has
 *  walled in with decor. Far above COST_BARRIER, so that walk goes round anything it
 *  can, through a gate or a fence before anything solid, and over solid decor only
 *  where nothing else gets out — at the thinnest point. No other walker uses it. */
export const COST_CLIMB = 100000;
/** At or above this a tile reads as a wall to everything except the pathfinder
 *  itself: straight-line walks re-route around it, and nothing picks it as a
 *  destination or a spawn point. The pathfinder alone may still cross one, as a
 *  last resort, which is the whole point of pricing barriers instead of blocking. */
export const COST_AVOID = 100;

// Terrain is recognised from the placeable key. The catalog is generated
// (tools/prep_placeables.py), so flags authored into placeables.json alone get
// reverted by the next asset regen — the same reason assets.ts derives zombiePatch
// and friends by key. pathCosts.spec asserts the classification of every catalog
// row, so a new item cannot quietly land in the wrong bucket.
const GATE_OPEN = /gate.*open/i;
const GATE_CLOSED = /gate.*closed/i;
const BARRIER = /fence|hedge|^pen_01/i;
const PATH = /road/i;
const POND = /pond/i;
const WORMHOLE = /^spaceWormHole([AB])$/;
const ZOMBIE_PATCH = "soil_zombiePatch"; // walkable soil zombies nap on

/** Which half of a wormhole pair this is, or null for everything else. */
export function wormholeSide(def: Pick<PlaceableDef, "key">): "A" | "B" | null {
  const m = WORMHOLE.exec(def.key);
  return m ? (m[1] as "A" | "B") : null;
}

/** Is this a gate — the deliberate hole in a fence run? Gates ignore the fence
 *  panels that overhang them; see Field.tileCost. */
export function isGate(def: Pick<PlaceableDef, "key">): boolean {
  return GATE_OPEN.test(def.key) || GATE_CLOSED.test(def.key);
}

/** Is this a one-tile fence PANEL — a barrier whose footprint is a single tile?
 *
 *  Those are the only barriers that need the overhang assets.ts hangs on them. A
 *  panel's rail is about two tiles wide and bridges into the next tile, so a run laid
 *  every OTHER tile reads as one unbroken fence; without the overhang the collision
 *  under it has a hole at every gap and walkers stroll through a wall. The multi-tile
 *  barriers need nothing — a 1x5 hedge already owns the five tiles it is drawn across.
 *
 *  Derived rather than listed. The set used to be four hard-coded keys, which is one
 *  per fence FAMILY — so every colour variant the catalog ships (Pink Fence, Blue,
 *  Red, Black, Pink Iron, Christmas Fence) had identical art to a sealing panel and
 *  leaked. Anything the price list calls a barrier and the catalog calls one tile is
 *  a panel, whatever it is named. */
export function isFencePanel(
  def: Pick<PlaceableDef, "key" | "tileW" | "tileH">
): boolean {
  return objectWalkCost(def) === COST_BARRIER
    && Math.floor(def.tileW) === 1 && Math.floor(def.tileH) === 1;
}

// A* asks for the price of a tile once per neighbour per expansion, which is tens of
// thousands of calls for one route across a fenced farm — far too many to be running
// half a dozen regexes each time. Every rule reads the key and nothing else, so one
// answer per key is the whole story and it can be memoised.
const cache = new Map<string, number>();

/** What one step onto a tile this object covers costs. `Infinity` for a solid
 *  object — the default, and still what most of the catalog is. */
export function objectWalkCost(def: Pick<PlaceableDef, "key">): number {
  const hit = cache.get(def.key);
  if (hit !== undefined) return hit;
  const cost = classify(def.key);
  cache.set(def.key, cost);
  return cost;
}

function classify(key: string): number {
  // Gates first: their keys carry "fence" too, and a gate is not a fence.
  if (GATE_OPEN.test(key)) return COST_GATE_OPEN;
  if (GATE_CLOSED.test(key)) return COST_GATE_CLOSED;
  if (BARRIER.test(key)) return COST_BARRIER;
  if (PATH.test(key)) return COST_PATH;
  if (POND.test(key)) return COST_POND;
  // A wormhole is a pad you step onto to be somewhere else — walkable ground with
  // an exit attached (Field.portalExit).
  if (WORMHOLE.test(key)) return COST_GROUND;
  if (key === ZOMBIE_PATCH) return COST_GROUND;
  return Infinity;
}
