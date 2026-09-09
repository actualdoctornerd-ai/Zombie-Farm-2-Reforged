// Evicting art that shipped WRONG under a filename that never changed.
//
// The service worker runtime-caches /assets/**.png CacheFirst into `zf-art` for 60
// days (see vite.config.ts). That is right for game art — stable filenames, ~88MB of
// it, and a CacheFirst hit is what makes a second launch instant. It has one failure
// mode: correcting an asset IN PLACE never reaches anyone who already loaded the bad
// one. The URL is identical, so CacheFirst never asks the network, and the fix waits
// out the expiry — up to two months, per player.
//
// That is not hypothetical. Worm Hole A and B shipped as the fully transparent 111x142
// placeholder frame the extractor picked (`wormhole*_00`; the drawn art is in the
// _01.._04 animation frames). The generator was fixed and the real portal art has been
// live since 2026-08-03, but players who had opened the game before that kept the blank
// 140-byte PNGs pinned and still saw two decor items with no icon.
//
// So: an explicit, versioned eviction list. Bumping ART_EPOCH re-runs the sweep once
// per browser; only the named files are dropped, so nothing else in the 88MB cache is
// re-downloaded. Do NOT reach for this when the art merely changed — a redraw is fine
// arriving late. It is for art that was BROKEN, where "late" means "never".
//
// Cheap by construction: one localStorage read on the common path, and the sweep only
// touches the listed entries.
//
// Not the tool for a sprite ATLAS whose frame table moved on (a new zombie packed onto
// ZombieSheet / SpecialZombieSheet): those are versioned by content instead, so the
// stale copy is never asked for again — see src/atlasVersion.ts. This list is for art
// whose filename AND table are unchanged but whose pixels were wrong.

/** Bump when adding to STALE_ART. Each new value re-runs the sweep once per browser. */
const ART_EPOCH = "3";
const EPOCH_KEY = "zf.artEpoch";

/** Paths (relative to the deploy root) whose cached copy is known to be wrong. */
const STALE_ART: readonly string[] = [
  "assets/objects/spaceWormHoleA.png", // shipped as a transparent placeholder until 2026-08-03
  "assets/objects/spaceWormHoleB.png",

  // Epoch 2 — every flat tile in the game (the complete `flatTile` set in
  // placeables.json, all fifteen of them). These shipped with colour still
  // premultiplied by alpha, which PixiJS then premultiplies a second time on upload, so
  // each piece's antialiased edge composited at `rgb*a²`. Flat art is laid edge to edge
  // and overlaps by design, so that darkened fringe fell across the neighbour's opaque
  // pixels and drew a dark line along every join — a grid of seams across a pond, a
  // ladder of them down a road. They ship straight-alpha now (`unpremultiply` in
  // tools/prep_placeables.py). The seven pond pieces ALSO moved anchor in the same
  // change, so their cached copies are doubly wrong.
  "assets/objects/pond1.png",
  "assets/objects/pond2.png",
  "assets/objects/pond3.png",
  "assets/objects/pond4.png",
  "assets/objects/pond5.png",
  "assets/objects/pond6.png",
  "assets/objects/pond7.png",
  "assets/objects/roadStraight.png",
  "assets/objects/roadBend_01.png",
  "assets/objects/roadIntersection.png",
  "assets/objects/cobblestoneRoadStraight_01.png",
  "assets/objects/cobblestoneRoadBend_01.png",
  "assets/objects/cobblestoneRoadIntersection.png",
  "assets/objects/rocks.png",
  "assets/objects/soil_zombiePatch.png",

  // Epoch 3 — the Pixel Campfire, the same failure as the Worm Holes above: its
  // `frameName` (pixel_campfire_base.png) is the crossed logs alone and all three flame
  // frames live in the animation, so the raid reward shipped as an unlit fire pit while
  // lighting.ts carved a warm glow out of the night above it. The generator bakes the
  // first flame frame on now (ANIMATION_OVER_BASE in tools/prep_placeables.py).
  "assets/objects/pixelCampfire.png",
];

/** Drop the known-bad art from every runtime art cache, once per ART_EPOCH.
 *
 *  Deliberately silent and never awaited by the caller: a browser with no Cache API,
 *  no storage, or a locked-down profile just keeps whatever it has, exactly as before.
 *  The epoch is recorded even on failure paths that cannot retry usefully, so this can
 *  never become a sweep that runs on every boot. */
export async function repairStaleArtCache(): Promise<void> {
  let store: Storage | undefined;
  try {
    store = window.localStorage;
    if (store.getItem(EPOCH_KEY) === ART_EPOCH) return;
  } catch {
    return; // no storage: no way to run this once, so don't run it at all
  }
  if (typeof caches === "undefined") {
    try { store.setItem(EPOCH_KEY, ART_EPOCH); } catch { /* full or blocked */ }
    return;
  }
  try {
    const names = (await caches.keys()).filter((name) => name.startsWith("zf-art"));
    for (const name of names) {
      const cache = await caches.open(name);
      // Match on the PATH, not the whole URL: the same deploy is reachable under a
      // bare domain and a GitHub Pages subpath, and an installed shell may hold either.
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        if (STALE_ART.some((file) => path.endsWith(`/${file}`))) await cache.delete(request);
      }
    }
  } catch {
    // A quota error or an evicted cache mid-sweep: the art is no worse off than it was.
  }
  try { store.setItem(EPOCH_KEY, ART_EPOCH); } catch { /* full or blocked */ }
}
