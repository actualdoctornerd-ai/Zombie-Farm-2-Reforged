// In-game announcements: messages the operator wants every player to read once.
//
// The Worker publishes them, unauthenticated, at `GET /announcements`
// (server/src/announcements.ts); this module fetches them, decides which this device has
// not seen, and drives a watcher that shows them one at a time when the player is free.
//
// Everything here FAILS QUIET. An unreachable Worker, a malformed reply or blocked storage
// means "nothing to announce", never an error the player has to deal with. An offline build
// (no VITE_API_URL) has no service to ask and never shows anything.
//
// Which announcements a player has read is remembered on THIS DEVICE (localStorage), not in
// their save: it needs no migration, works for Local Farm players too, and the worst case is
// a second device showing the same message once more.
import * as api from "./api";
import { RAID_RULESET_VERSION } from "../raid/replay";

export interface Announcement {
  id: number;
  title: string;
  body: string;
  publishedAt: number;
  expiresAt: number | null;
  /** Only clients whose raid ruleset is at least this show it. Null = every client. */
  minRuleset: number | null;
}

/** Mirrors server/src/announcements.ts. The Worker already trims; this is defence in depth
 *  for a modal that must never be swamped by one runaway message. */
export const TITLE_MAX = 80;
export const BODY_MAX = 2000;

const FETCH_TIMEOUT_MS = 6000;
const SEEN_KEY = "zf2r.announcements.seen.v1";
const SEEN_KEEP = 200;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;

/** The Worker's reply as a clean list, OLDEST first (the order a player should read them in).
 *  Anything that is not a well-formed announcement is dropped. */
export function parseAnnouncements(json: unknown): Announcement[] {
  const raw = (json as { announcements?: unknown } | null)?.announcements;
  if (!Array.isArray(raw)) return [];
  const out: Announcement[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const rec = item as Record<string, unknown> | null;
    if (!rec || typeof rec !== "object") continue;
    const id = num(rec.id);
    const publishedAt = num(rec.publishedAt);
    const title = typeof rec.title === "string" ? rec.title.trim().slice(0, TITLE_MAX) : "";
    const body = typeof rec.body === "string" ? rec.body.trim().slice(0, BODY_MAX) : "";
    if (id === null || publishedAt === null || !title || !body || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title, body, publishedAt, expiresAt: num(rec.expiresAt), minRuleset: num(rec.minRuleset) });
  }
  return out.sort((a, b) => a.publishedAt - b.publishedAt || a.id - b.id);
}

/** Ask the Worker for the live announcements. Empty on any failure or in an offline build. */
export async function fetchAnnouncements(fetcher: typeof fetch = fetch): Promise<Announcement[]> {
  const base = api.baseUrl();
  if (!base) return [];
  try {
    const response = await fetcher(`${base}/announcements`, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    return parseAnnouncements(await response.json());
  } catch {
    return [];
  }
}

/** The ids this device has already shown, or an empty set if storage is unavailable. */
export function loadSeen(storage: Pick<Storage, "getItem"> | null = safeStorage()): Set<number> {
  try {
    const parsed = JSON.parse(storage?.getItem(SEEN_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : []);
  } catch {
    return new Set();
  }
}

/** Remember that this device has shown an announcement. Keeps only the newest ids. */
export function markSeen(id: number, storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): void {
  try {
    const ids = [...loadSeen(storage).add(id)];
    storage?.setItem(SEEN_KEY, JSON.stringify(ids.slice(-SEEN_KEEP)));
  } catch {
    // Blocked or full storage: the worst case is seeing it once more next load.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The announcements this client should show now, oldest first: not yet seen, and not
 *  addressed to a newer client than this one. */
export function pendingAnnouncements(
  list: readonly Announcement[],
  seen: ReadonlySet<number>,
  rulesetVersion: number = RAID_RULESET_VERSION,
): Announcement[] {
  return list.filter((a) => !seen.has(a.id) && (a.minRuleset === null || a.minRuleset <= rulesetVersion));
}

export interface AnnouncementWatcherOptions {
  /** Show one announcement; resolves when the player has dismissed it. `index`/`total` count
   *  the ones queued in this sitting, so the dialog can say "1 of 3". */
  show: (announcement: Announcement, index: number, total: number) => Promise<void>;
  /** True while something else owns the player's attention (a raid, the tutorial, a dialog). */
  isBusy: () => boolean;
  fetcher?: typeof fetch;
  storage?: (Pick<Storage, "getItem" | "setItem">) | null;
  rulesetVersion?: number;
  /** Wait before the first check, so the farm finishes loading first. */
  initialDelayMs?: number;
  /** Re-check this often — a PWA can stay open for days. */
  intervalMs?: number;
  /** How often to look again while busy. */
  busyRetryMs?: number;
}

export interface AnnouncementWatcher {
  /** Everything the Worker last published, oldest first (read or not), for a history view. */
  latest(): readonly Announcement[];
  /** Fetch the list afresh WITHOUT showing anything (the Settings history view). */
  refresh(): Promise<readonly Announcement[]>;
  /** Fetch and show whatever is pending. Exposed for tests. */
  check(): Promise<void>;
  stop(): void;
}

/** Start checking for announcements: once shortly after boot, then on an interval. */
export function startAnnouncementWatcher(opts: AnnouncementWatcherOptions): AnnouncementWatcher {
  const {
    show, isBusy, fetcher = fetch, rulesetVersion = RAID_RULESET_VERSION,
    initialDelayMs = 4000, intervalMs = 30 * 60_000, busyRetryMs = 10_000,
  } = opts;
  const storage = opts.storage === undefined ? safeStorage() : opts.storage;
  let latest: Announcement[] = [];
  let showing = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void check(); }, ms);
  };

  async function check(): Promise<void> {
    if (stopped || showing) return;
    latest = await fetchAnnouncements(fetcher);
    const queue = pendingAnnouncements(latest, loadSeen(storage), rulesetVersion);
    if (!queue.length) return schedule(intervalMs);
    showing = true;
    try {
      for (let i = 0; i < queue.length; i++) {
        // Wait out a raid, the tutorial or an open dialog rather than covering it.
        while (!stopped && isBusy()) await new Promise<void>((r) => setTimeout(r, busyRetryMs));
        if (stopped) return;
        await show(queue[i], i, queue.length);
        markSeen(queue[i].id, storage);
      }
    } finally {
      showing = false;
    }
    schedule(intervalMs);
  }

  schedule(initialDelayMs);
  return {
    latest: () => latest,
    async refresh() {
      latest = await fetchAnnouncements(fetcher);
      return latest;
    },
    check,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
