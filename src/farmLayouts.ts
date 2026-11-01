// Saved farm layouts: snapshots of where every placed OBJECT stands, so a farm can
// keep a seasonal look (or several) and swap between them. Plots are not part of a
// layout — they stay exactly where they are.
//
// Loading a layout is built entirely from the shed's own moves: objects that are not
// where the layout wants them go into the shed, and the layout's objects come out of
// it. Nothing is bought, sold or created, so a layout can only ever place things the
// farm still owns; an entry for something that has since been sold is skipped and
// the rest of the layout still loads.
//
// Online, layouts live on the server (GET/PUT /farm-layouts) so every device sees
// the same list; this device keeps a copy as a fallback. An offline farm keeps them in
// local storage only, like the rest of its save.

export interface LayoutItem {
  key: string;
  oc: number;
  or: number;
  /** Orientation, as Field.objectTurnOf reports it. */
  turn: number;
  /** The exact object that stood here, preferred when it is in the shed, so a Pet
   *  Pen comes back as the same pen (pens hold their pets by order of id). */
  id?: string;
}

export interface SavedLayout {
  id: string;
  name: string;
  savedAt: number;
  items: LayoutItem[];
}

/** An object standing on the farm now, as the planner sees it. */
export interface PlacedNow extends LayoutItem {
  id: string;
  /** Cannot go in the shed (the shed itself, the Mausoleum, a Pot mid-combine). It
   *  stays where it is whatever the layout says. */
  fixed: boolean;
}

export interface LayoutPlan {
  /** Objects already standing where the layout wants them. */
  keep: string[];
  /** Objects to put in the shed. */
  store: string[];
  /** Layout entries to place from the shed, in layout order. */
  place: LayoutItem[];
  /** Layout entries the farm no longer owns a copy of (sold since it was saved). */
  missing: LayoutItem[];
  /** Layout entries for an object that cannot move (it is fixed elsewhere). */
  stuck: LayoutItem[];
  /** Shed count once the swap is done. */
  shedAfter: number;
}

export const MAX_LAYOUTS = 6;
export const LAYOUT_NAME_MAX = 24;

const sameSpot = (a: LayoutItem, b: LayoutItem) =>
  a.key === b.key && a.oc === b.oc && a.or === b.or && a.turn === b.turn;

/** Snapshot the farm's objects as a layout's items. */
export function captureLayout(placed: readonly LayoutItem[]): LayoutItem[] {
  return placed.map(({ key, oc, or, turn, id }) => ({ key, oc, or, turn, ...(id ? { id } : {}) }));
}

/** Work out what loading `layout` would do to the farm.
 *
 *  `stored` is the shed's count per key now; `shedUsed` its total. An entry is only
 *  placeable while a copy is available — one already in the shed, or one coming off
 *  the farm in this same swap — so a layout can never place more of something than
 *  the farm owns. */
export function planLayout(
  layout: readonly LayoutItem[],
  placed: readonly PlacedNow[],
  stored: Readonly<Record<string, number>>,
  shedUsed: number,
  isFixedKey: (key: string) => boolean,
): LayoutPlan {
  const matched = new Set<string>();
  const keep: string[] = [];
  const unmatched: LayoutItem[] = [];
  for (const item of layout) {
    const hit = placed.find((p) => !matched.has(p.id) && sameSpot(p, item));
    if (hit) { matched.add(hit.id); keep.push(hit.id); }
    else unmatched.push(item);
  }
  const store = placed.filter((p) => !matched.has(p.id) && !p.fixed).map((p) => p.id);
  const available: Record<string, number> = { ...stored };
  for (const p of placed) {
    if (!matched.has(p.id) && !p.fixed) available[p.key] = (available[p.key] ?? 0) + 1;
  }
  const place: LayoutItem[] = [];
  const missing: LayoutItem[] = [];
  const stuck: LayoutItem[] = [];
  for (const item of unmatched) {
    if (isFixedKey(item.key)) { stuck.push(item); continue; }
    if ((available[item.key] ?? 0) > 0) {
      available[item.key]--;
      place.push(item);
    } else missing.push(item);
  }
  return { keep, store, place, missing, stuck, shedAfter: shedUsed + store.length - place.length };
}

// ---- persistence ----

const KEY_PREFIX = "zf2r.farmLayouts.";

function isItem(v: unknown): v is LayoutItem {
  const o = v as LayoutItem;
  return !!o && typeof o.key === "string" && Number.isInteger(o.oc) &&
    Number.isInteger(o.or) && Number.isInteger(o.turn) &&
    (o.id === undefined || typeof o.id === "string");
}

export function isLayout(v: unknown): v is SavedLayout {
  const o = v as SavedLayout;
  return !!o && typeof o.id === "string" && typeof o.name === "string" &&
    typeof o.savedAt === "number" && Array.isArray(o.items) && o.items.every(isItem);
}

export function loadLayouts(farmId: string): SavedLayout[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + farmId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isLayout) : [];
  } catch {
    return [];
  }
}

/** False when this device refused the write (private mode, storage full). */
export function saveLayouts(farmId: string, layouts: readonly SavedLayout[]): boolean {
  try {
    localStorage.setItem(KEY_PREFIX + farmId, JSON.stringify(layouts));
    return true;
  } catch {
    return false;
  }
}

const SYNCED_PREFIX = "zf2r.farmLayouts.synced.";

/** Whether this device's copy has been handed to the server once. Until then a
 *  device's own layouts (saved before they synced) are uploaded on first contact;
 *  after it, the server's list wins, so a layout deleted elsewhere stays deleted. */
export function layoutsSynced(farmId: string): boolean {
  try { return localStorage.getItem(SYNCED_PREFIX + farmId) === "1"; } catch { return false; }
}

export function markLayoutsSynced(farmId: string): void {
  try { localStorage.setItem(SYNCED_PREFIX + farmId, "1"); } catch { /* retried next open */ }
}

export function cleanLayoutName(name: string): string {
  return name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, LAYOUT_NAME_MAX);
}
