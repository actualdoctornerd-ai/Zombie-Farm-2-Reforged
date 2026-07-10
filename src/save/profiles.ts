// Multiple independent save profiles. Each profile is a full, separate game: its
// own SaveGame blob under its own localStorage key. A small index tracks the set
// of profiles and which one is active; SaveManager reads/writes the ACTIVE
// profile's key, so switching a profile is just "point the index elsewhere and
// reload". Entirely local — no server.
import { SAVE_KEY } from "./schema";

const INDEX_KEY = "zf2r.profiles.v1";

export interface ProfileMeta {
  id: string;
  name: string;
  createdAt: number;
  lastPlayedAt: number;
}
export interface ProfileIndex {
  activeId: string;
  profiles: ProfileMeta[];
}

/** The localStorage save key holding a given profile's game. */
export function profileSaveKey(id: string): string {
  return `${SAVE_KEY}::${id}`;
}

function read(): ProfileIndex | null {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as ProfileIndex) : null;
  } catch {
    return null;
  }
}
function write(idx: ProfileIndex) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch (e) {
    console.warn("[profiles] write failed", e);
  }
}
function nextId(existing: Set<string>): string {
  let n = 1;
  while (existing.has(`p${n}`)) n++;
  return `p${n}`;
}

/** Read the index, creating it on first run. A pre-profiles single-slot save
 *  (legacy `zf2r.save.v1`) is adopted as "Profile 1" by copying it into that
 *  profile's key — the legacy blob is left untouched as a backup. Idempotent. */
export function ensureIndex(): ProfileIndex {
  const existing = read();
  if (existing && existing.profiles.length) return existing;
  const now = Date.now();
  const p1: ProfileMeta = { id: "p1", name: "Profile 1", createdAt: now, lastPlayedAt: now };
  try {
    const legacy = localStorage.getItem(SAVE_KEY);
    const key = profileSaveKey("p1");
    // Copy the legacy save into p1 only if p1 has no save yet (don't clobber).
    if (legacy && localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
  } catch {
    /* ignore */
  }
  const idx: ProfileIndex = { activeId: "p1", profiles: [p1] };
  write(idx);
  return idx;
}

/** The full index (creating it if needed). */
export function listProfiles(): ProfileIndex {
  return ensureIndex();
}

/** Save key for the currently-active profile. */
export function activeSaveKey(): string {
  return profileSaveKey(ensureIndex().activeId);
}

/** Create a new (empty — i.e. fresh-game) profile. Does NOT switch to it. */
export function createProfile(name: string): string {
  const idx = ensureIndex();
  const id = nextId(new Set(idx.profiles.map((p) => p.id)));
  const now = Date.now();
  idx.profiles.push({
    id,
    name: name.trim() || `Profile ${idx.profiles.length + 1}`,
    createdAt: now,
    lastPlayedAt: now,
  });
  write(idx);
  return id;
}

/** Make `id` the active profile (bumps its last-played stamp). */
export function setActive(id: string) {
  const idx = ensureIndex();
  const p = idx.profiles.find((x) => x.id === id);
  if (!p) return;
  idx.activeId = id;
  p.lastPlayedAt = Date.now();
  write(idx);
}

export function renameProfile(id: string, name: string) {
  const idx = ensureIndex();
  const p = idx.profiles.find((x) => x.id === id);
  if (!p) return;
  const trimmed = name.trim();
  if (trimmed) p.name = trimmed;
  write(idx);
}

/** Delete a profile and its save. Refuses to delete the last remaining profile;
 *  callers should not delete the ACTIVE profile (the UI disables that). */
export function deleteProfile(id: string) {
  const idx = ensureIndex();
  if (idx.profiles.length <= 1) return;
  idx.profiles = idx.profiles.filter((p) => p.id !== id);
  try {
    localStorage.removeItem(profileSaveKey(id));
  } catch {
    /* ignore */
  }
  if (idx.activeId === id) idx.activeId = idx.profiles[0].id;
  write(idx);
}
