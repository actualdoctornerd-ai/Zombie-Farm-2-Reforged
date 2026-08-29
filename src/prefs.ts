// Player-facing preferences persisted in local storage.
// These are persisted to localStorage and read at the points that care about them.
//
// The sprite toggle is surfaced in Settings:
//
//   • Sprite set — "zf1" (original Zombie Farm art) vs "zf2" (the sequel's art
//     this reimplementation is built from). This is a PLACEHOLDER: the value is
//     persisted and exposed, but nothing swaps art on it yet. Wiring the ZF1 art
//     pack in is future work (see README "Current Gaps").

import { DEFAULT_FRIEND_SORT, isFriendSort, type FriendSort } from "./social/friendSort";
import { DEFAULT_ZOMBIE_SORT, isZombieSort, type ZombieSort } from "./zombie/rosterSort";

export type SpriteSet = "zf1" | "zf2";
// How lush the decorative foliage ringing the farm is. All three fill the whole
// camera view out to the max zoom-out edge; they differ only in tree density.
export type FarmBackground = "deep-forest" | "woodland" | "light-meadow";
export type DayNightMode = "auto" | "day" | "night";
export const DEFAULT_FARM_BACKGROUND: FarmBackground = "woodland";

export function isFarmBackground(value: unknown): value is FarmBackground {
  return value === "deep-forest" || value === "woodland" || value === "light-meadow";
}

/** How an owned zombie's body is tinted.
 *  • "inherited" — a Zombie Pot child keeps the mixed tint it was born with.
 *  • "species"   — every zombie wears its own species' colour, so a silver made
 *                  from two greens looks silver. */
export type ZombieBodyColorMode = "inherited" | "species";
export const DEFAULT_BODY_COLOR_MODE: ZombieBodyColorMode = "inherited";

/** One device's zombie-appearance choices, read wherever a zombie is drawn. */
export interface ZombieAppearancePrefs {
  bodyColor: ZombieBodyColorMode;
  showMutations: boolean;
}

const SPRITE_KEY = "zf2r.spriteSet";
const FARM_BG_KEY = "zf2r.farmBackground";
const DAY_NIGHT_KEY = "zf2r.dayNight";
const FRIEND_SORT_KEY = "zf2r.friendSort";
const ZOMBIE_SORT_KEY = "zf2r.zombieSort";
const HAZARD_TIP_KEY = "zf2r.seenHazardTip";
const RAID_TIP_KEY = "zf2r.seenRaidTip."; // + raid id
const PVP_TIP_KEY = "zf2r.seenPvpTip";
const BODY_COLOR_KEY = "zf2r.zombieBodyColor";
const SHOW_MUTATIONS_KEY = "zf2r.showZombieMutations";
const HEALTH_NUMBERS_KEY = "zf2r.showHealthNumbers";
const DAMAGE_NUMBERS_KEY = "zf2r.showDamageNumbers";
const LANTERN_KEY = "zf2r.farmerLantern";
const LANTERN_TAP_KEY = "zf2r.farmerLanternTap";
const RIGHT_CLICK_KEY = "zf2r.rightClick";

/** Raised the first time this device refuses to KEEP a preference, so a player whose
 *  settings quietly reset is told why instead of re-making the same change every
 *  launch. Wired to a HUD toast in main, exactly like SaveManager.onStorageError and
 *  AudioManager.onStorageError — a refused write is invisible from inside the game
 *  (the toggle moves, the setting applies, and it is gone at the next start), which is
 *  precisely the report this exists to answer. */
let onPrefStorageError: ((message: string) => void) | null = null;
let storageWarned = false;

export function setPrefStorageErrorHandler(fn: ((message: string) => void) | null): void {
  onPrefStorageError = fn;
}

/** localStorage.getItem that survives a browser with storage denied (private mode,
 *  blocked third-party context). Appearance prefs are read while DRAWING, so a throw
 *  here would take the frame with it — and `getFarmBackground` is read at module scope
 *  during boot, where a throw takes the whole launch. EVERY read in this file goes
 *  through here for that reason; none may touch `localStorage` directly. */
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The write half of the same rule. A failure is reported once rather than swallowed:
 *  a full quota and a blocked storage both look identical to the player otherwise. */
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn("[prefs] write failed", key, error);
    if (storageWarned) return;
    storageWarned = true;
    onPrefStorageError?.(
      "Settings can't be saved in this browser, so they'll reset when you come back. " +
      "Private browsing or a full storage quota is the usual cause.",
    );
  }
}

/** Which body tint a combined zombie shows. Defaults to the inherited mix (what the
 *  Zombie Pot has always produced); "species" makes every unit wear its own type's
 *  colour instead. */
export function getZombieBodyColorMode(): ZombieBodyColorMode {
  return readPref(BODY_COLOR_KEY) === "species" ? "species" : DEFAULT_BODY_COLOR_MODE;
}

export function setZombieBodyColorMode(mode: ZombieBodyColorMode): void {
  writePref(BODY_COLOR_KEY, mode);
}

/** Whether crop mutations are drawn on zombies at all. Defaults to on. */
export function getShowZombieMutations(): boolean {
  return readPref(SHOW_MUTATIONS_KEY) !== "0";
}

export function setShowZombieMutations(on: boolean): void {
  writePref(SHOW_MUTATIONS_KEY, on ? "1" : "0");
}

/** Whether an invasion prints the numbers behind its bars: the exact HP left on a
 *  health bar, and a floating figure for each hit as it lands.
 *
 *  BOTH DEFAULT OFF, deliberately. ZF2 never showed either — the battlefield reads as
 *  a fight, not a spreadsheet, and a screen of rising numbers is the sort of thing a
 *  player either wants badly or does not want at all. The bars themselves are unchanged
 *  either way, and neither switch touches the simulation: the numbers are read off the
 *  same HP the bar is drawn from, so a raid plays out identically with them on. */
export function getShowHealthNumbers(): boolean {
  return readPref(HEALTH_NUMBERS_KEY) === "1";
}

export function setShowHealthNumbers(on: boolean): void {
  writePref(HEALTH_NUMBERS_KEY, on ? "1" : "0");
}

export function getShowDamageNumbers(): boolean {
  return readPref(DAMAGE_NUMBERS_KEY) === "1";
}

export function setShowDamageNumbers(on: boolean): void {
  writePref(DAMAGE_NUMBERS_KEY, on ? "1" : "0");
}

/** Whether the farmer carries a lit lantern at night. Defaults to on — that is what
 *  ZF2 does, and it is how you see anything after dark.
 *
 *  Off puts the farm back under the full darkness mask with only the placed objects'
 *  own glows carved out of it, which is the look some players actually want. It also
 *  takes the lamp out of the farmer's hand, so the two agree. */
export function getFarmerLantern(): boolean {
  return readPref(LANTERN_KEY) !== "0";
}

export function setFarmerLantern(on: boolean): void {
  writePref(LANTERN_KEY, on ? "1" : "0");
}

/** Whether tapping the farmer after dark toggles his lantern. Defaults to on.
 *
 *  Off makes the lantern a Settings-only switch: the tap falls through to whatever
 *  is under him, so a farmer standing on a ripe plot can never eat the harvest and
 *  the lantern can't be flipped by a stray tap. The Settings row above still works
 *  either way, so turning this off can't strand the lantern in a state you can't
 *  change. */
export function getFarmerLanternTap(): boolean {
  return readPref(LANTERN_TAP_KEY) !== "0";
}

export function setFarmerLanternTap(on: boolean): void {
  writePref(LANTERN_TAP_KEY, on ? "1" : "0");
}

/** What right-clicking the farm does.
 *  • "menu"   — opens the quick-switch tool menu (the default).
 *  • "select" — equips the Select tool, the pre-menu reflex some players kept.
 *  Either way the browser's own context menu stays suppressed. */
export type RightClickMode = "menu" | "select";

export function getRightClickMode(): RightClickMode {
  return readPref(RIGHT_CLICK_KEY) === "select" ? "select" : "menu";
}

export function setRightClickMode(mode: RightClickMode): void {
  writePref(RIGHT_CLICK_KEY, mode);
}

/** Both appearance choices at once, for the render sites that apply them. */
export function zombieAppearancePrefs(): ZombieAppearancePrefs {
  return { bodyColor: getZombieBodyColorMode(), showMutations: getShowZombieMutations() };
}

/** Which sprite pack to render with. Defaults to ZF2 (the only pack wired today).
 *
 *  NOTHING READS THIS RIGHT NOW. The Settings switch that used to set it was pulled
 *  (see ui/panels/settings.ts) because it changed no pixels; the accessors stay because
 *  the stored value on a device that flipped it is still valid, and the ZF1 art pack that
 *  gives the choice meaning is being extracted by tools/extract_zf1_ipa.py. Wire the
 *  runtime swap to this, then put the switch back — not the other way round. */
export function getSpriteSet(): SpriteSet {
  return readPref(SPRITE_KEY) === "zf1" ? "zf1" : "zf2";
}

export function setSpriteSet(set: SpriteSet): void {
  writePref(SPRITE_KEY, set);
}

// Foliage density per background, as a fraction of the base (Deep Forest) tree
// count. Light Meadow is ~1/10 as dense. Because the three share the same seeded
// layout, the sets nest (meadow ⊂ woodland ⊂ deep forest) — switching thins or
// thickens the same forest rather than reshuffling it.
export const FARM_BG_DENSITY: Record<FarmBackground, number> = {
  "deep-forest": 1,
  woodland: 0.45,
  "light-meadow": 0.1,
};

// Ordered options + display labels for the Settings picker.
export const FARM_BACKGROUNDS: { id: FarmBackground; label: string }[] = [
  { id: "deep-forest", label: "Deep Forest" },
  { id: "woodland", label: "Woodland" },
  { id: "light-meadow", label: "Light Meadow" },
];

/** How lush the farm's foliage ring is. Defaults to Woodland (the medium density). */
export function getFarmBackground(): FarmBackground {
  const v = readPref(FARM_BG_KEY);
  return isFarmBackground(v) ? v : DEFAULT_FARM_BACKGROUND;
}

export function setFarmBackground(bg: FarmBackground): void {
  writePref(FARM_BG_KEY, bg);
}

/** Player lighting preference. Auto follows the browser/device's local clock. */
export function getDayNightMode(): DayNightMode {
  const value = readPref(DAY_NIGHT_KEY);
  return value === "day" || value === "night" ? value : "auto";
}

export function setDayNightMode(mode: DayNightMode): void {
  writePref(DAY_NIGHT_KEY, mode);
}

/** How the friends list is ordered. Purely a display choice, so it lives here with
 *  the other view preferences rather than in the save. */
export function getFriendSort(): FriendSort {
  const value = readPref(FRIEND_SORT_KEY);
  return isFriendSort(value) ? value : DEFAULT_FRIEND_SORT;
}

export function setFriendSort(sort: FriendSort): void {
  writePref(FRIEND_SORT_KEY, sort);
}

/** How the "My Zombies" roster is ordered. Like the friends sort this is a view
 *  preference, not progression, so it stays device-local instead of in the save. */
export function getZombieSort(): ZombieSort {
  const value = readPref(ZOMBIE_SORT_KEY);
  return isZombieSort(value) ? value : DEFAULT_ZOMBIE_SORT;
}

export function setZombieSort(sort: ZombieSort): void {
  writePref(ZOMBIE_SORT_KEY, sort);
}

/** Whether the player has been shown the "tap/click hazards to damage them" tip,
 *  raised once before their first invasion that actually fields a hazard (the
 *  Circus trapeze, the beach crab, the Ninja/Robot wall). Kept device-local rather
 *  than in the save blob: hazards themselves are client-only, so this is a control
 *  hint about THIS device's input, not account progression. A browser that can't
 *  write storage simply sees the tip again — cheaper than failing the launch. */
export function hasSeenHazardTip(): boolean {
  return readPref(HAZARD_TIP_KEY) === "1";
}

export function markHazardTipSeen(): void {
  writePref(HAZARD_TIP_KEY, "1");
}

/** Whether Tim's one-off briefing for a particular invasion has been given yet. Some
 *  raids run on a rule the battlefield never states — the Pirates' Scallywag mirrors
 *  whatever attack speed you bring, so a fast army is answered by a fast enemy — and
 *  the game only ever admitted it in the DEFEAT text, after the lesson had already
 *  cost a fight. Stored per raid id, and device-local for the same reason as the
 *  hazard tip: it is a hint about how to play, not account progression, so a browser
 *  that cannot write storage simply hears Tim out again. */
export function hasSeenRaidTip(raidId: number): boolean {
  return readPref(RAID_TIP_KEY + raidId) === "1";
}

export function markRaidTipSeen(raidId: number): void {
  writePref(RAID_TIP_KEY + raidId, "1");
}

/** Whether Tim has explained how DEFENDING works, given once when the Invasions panel
 *  is first opened. Defending is the one part of the game the player never plays: the
 *  farm fights on its own, one zombie per class, and nothing is lost either way — so
 *  the panel would otherwise be the first screen with rules nobody stated. Device-local
 *  for the same reason as the other tips: it is a hint about how to read a screen, not
 *  account progression, so a browser that cannot write storage just hears it again. */
export function hasSeenPvpTip(): boolean {
  return readPref(PVP_TIP_KEY) === "1";
}

export function markPvpTipSeen(): void {
  writePref(PVP_TIP_KEY, "1");
}

/** When the local-clock night window opens and closes, in the device's own
 *  timezone. Whole hours, and deliberately not derived from real sunset: that
 *  would need precise location permission. */
export const NIGHT_START_HOUR = 19;
export const NIGHT_END_HOUR = 7;
/** How far either side of nightfall counts as dusk. */
export const DUSK_HOURS = 2;

/** Local-clock night window: 7pm through 6:59am. */
export function isLocalNight(at = new Date()): boolean {
  const hour = at.getHours();
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** The hours either side of nightfall — 5pm to 8:59pm by default.
 *
 *  Derived from NIGHT_START_HOUR rather than written out, so the two can never
 *  drift apart: a dusk window that no longer straddles the moment the lights go
 *  down is worse than none, because the sunset backdrop would show while the sky
 *  is plainly still day. Half of this window is also night, which is intended —
 *  the sunset art carries on under the darkness for the first couple of hours. */
export function isLocalDusk(at = new Date()): boolean {
  const hour = at.getHours();
  return hour >= NIGHT_START_HOUR - DUSK_HOURS && hour < NIGHT_START_HOUR + DUSK_HOURS;
}
