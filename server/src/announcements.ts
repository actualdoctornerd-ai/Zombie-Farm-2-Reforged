// In-game announcements: messages the operator wants every player to see once.
//
// Rows live in D1 (migration 0059) so one can be posted, scheduled or retired without a
// deploy — the same reason the closedown switch is a row (serviceState.ts). They are
// published, unauthenticated, by `GET /announcements`; the client shows each one once per
// device after it has loaded (src/net/announcements.ts).
//
// FAILS OPEN, like serviceState: a missing table (a Worker deployed ahead of migration 0059)
// or a D1 error serves an empty list. An announcement is never worth failing a request for.

/** One announcement as the client receives it. Times are ms since the epoch. */
export interface Announcement {
  id: number;
  title: string;
  body: string;
  publishedAt: number;
  /** Null = until retired. */
  expiresAt: number | null;
  /** Null = every client. Otherwise only clients whose raid ruleset is at least this are
   *  shown it, so a change can be announced only to players who have updated to it. */
  minRuleset: number | null;
}

/** Longest title and body served. Rows longer than this are trimmed, not refused: the text
 *  is operator-authored, and a modal that scrolls is better than a message nobody sees. */
export const TITLE_MAX = 80;
export const BODY_MAX = 2000;

/** At most this many are served, newest first. The client shows the ones the player has not
 *  seen, so this only bounds a long-lived backlog. */
export const ACTIVE_LIMIT = 10;

// One D1 read per isolate per window, not per request: every client asks at boot and then
// every half hour, and a posted announcement can wait a minute to appear.
const CACHE_TTL_MS = 60_000;
let cached: { at: number; list: Announcement[] } | null = null;

/** Drop the memo. Tests only — a live Worker relies on the TTL. */
export function resetAnnouncementsCache(): void {
  cached = null;
}

interface AnnouncementRow {
  id: number | null;
  title: string | null;
  body: string | null;
  published_at: number | null;
  expires_at: number | null;
  min_ruleset: number | null;
}

const asInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
};

/** One row as a servable announcement, or null if it is unusable (no id, no text). */
export function announcementFromRow(row: AnnouncementRow): Announcement | null {
  const id = asInt(row.id);
  const publishedAt = asInt(row.published_at);
  const title = typeof row.title === "string" ? row.title.trim().slice(0, TITLE_MAX) : "";
  const body = typeof row.body === "string" ? row.body.trim().slice(0, BODY_MAX) : "";
  if (id === null || publishedAt === null || !title || !body) return null;
  return {
    id,
    title,
    body,
    publishedAt,
    expiresAt: asInt(row.expires_at),
    minRuleset: asInt(row.min_ruleset),
  };
}

/** The announcements currently live, newest first. */
export async function readAnnouncements(
  db: D1Database,
  now: number = Date.now()
): Promise<Announcement[]> {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.list;
  let list: Announcement[] = [];
  try {
    const { results } = await db
      .prepare(
        "SELECT id, title, body, published_at, expires_at, min_ruleset FROM announcements " +
        "WHERE active = 1 AND published_at <= ?1 AND (expires_at IS NULL OR expires_at > ?1) " +
        "ORDER BY published_at DESC, id DESC LIMIT ?2"
      )
      .bind(now, ACTIVE_LIMIT)
      .all<AnnouncementRow>();
    list = (results ?? [])
      .map(announcementFromRow)
      .filter((item): item is Announcement => item !== null);
  } catch {
    // Pre-migration deploy or a D1 blip: nothing to announce (see the fail-open note above).
    list = [];
  }
  cached = { at: now, list };
  return list;
}
