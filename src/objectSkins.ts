// Alternate appearances for a placed object — "skins".
//
// Upgrading the storage shed swaps the object's def in place (Field.replaceObjectDef)
// and is one-way: the Shabby Shed's look is gone the moment you buy the Fine Shed,
// and some players liked it better. A skin is the cosmetic half of that swap made
// reversible. The object keeps its REAL def — which stays the only thing capacity,
// sell value and the Market's next-tier offer are ever allowed to read — and simply
// wears another def's art.
//
// Which skins are unlocked needs no saved state at all. The Market offers exactly
// one shed at a time, the next tier above the placed one (see the Functional branch
// of the market menu in hud.ts), so the ladder is strictly monotonic: "sheds this
// farm has owned" is precisely "every shed whose capacity is at or below the one
// standing on the farm right now".
import type { PlaceableDef } from "./assets";

/** Whether `skin`'s art can stand in for `def`'s without moving, resizing or
 *  re-animating anything.
 *
 *  A skin is a texture swap and nothing more: the object keeps its own footprint,
 *  blocked tiles, orientation and state machine. So the two defs must agree on
 *  everything the renderer reads besides the picture, and neither may be one of the
 *  kinds of object whose art is not a single still — flat ground tiles (which hang
 *  off authored anchors), flipbook decor, two-layer art, working-state art, or a
 *  piece with per-corner turn states. Sheds are none of those, which is why they are
 *  the ladder this ships for; the guard is what keeps a tampered save (or a friend's
 *  presentation blob, which a visitor renders) from dressing a 3x3 shed up as
 *  something that draws outside its own tiles. */
export function skinCompatible(def: PlaceableDef, skin: PlaceableDef): boolean {
  const plain = (d: PlaceableDef) =>
    !d.flatTile && !d.anim && !d.backSprite && !d.busySprite && !d.readySprite &&
    !d.growingSprite && !d.turns && !d.memorial;
  return plain(def) && plain(skin) &&
    def.tileW === skin.tileW && def.tileH === skin.tileH &&
    (def.collideExtend?.length ?? 0) === (skin.collideExtend?.length ?? 0) &&
    !!def.noMirror === !!skin.noMirror;
}

/** Every appearance the object `def` may wear, cheapest tier first, including its
 *  own. An object with no ladder behind it (anything that is not a shed) gets an
 *  empty list, which is what hides the picker.
 *
 *  `catalog` is the whole placeable catalog; only the shed rows are considered. */
export function objectSkinOptions(
  def: PlaceableDef, catalog: Iterable<PlaceableDef>,
): PlaceableDef[] {
  const slots = def.storageSlots ?? 0;
  if (!slots) return [];
  const ladder = [...catalog]
    .filter((c) => (c.storageSlots ?? 0) > 0 && (c.storageSlots ?? 0) <= slots &&
      (c.key === def.key || skinCompatible(def, c)))
    .sort((a, b) => (a.storageSlots ?? 0) - (b.storageSlots ?? 0));
  // Two tiers can share one piece of art — the Zombie Warehouse redraws nothing and
  // reuses McDonnell's Barn's sprite. Offer that look once, under the HIGHEST tier
  // that wears it, so a farm standing on the top tier finds its OWN shed in the list
  // rather than an identical-looking card it does not own.
  const bySprite = new Map<string, PlaceableDef>();
  for (const c of ladder) bySprite.set(c.sprite, c);
  return [...bySprite.values()].sort((a, b) => (a.storageSlots ?? 0) - (b.storageSlots ?? 0));
}

/** The def behind a saved skin key, or null when the object should wear its own art.
 *
 *  Null for an unknown key, for a key the object has not unlocked, and for the
 *  object's own key — "no skin" and "skinned as myself" must be the same state, or
 *  an upgrade would leave a stale override pinning the shed to art it has outgrown. */
export function resolveObjectSkin(
  def: PlaceableDef, skinKey: string | undefined, catalog: Iterable<PlaceableDef>,
): PlaceableDef | null {
  if (!skinKey || skinKey === def.key) return null;
  return objectSkinOptions(def, catalog).find((c) => c.key === skinKey) ?? null;
}
