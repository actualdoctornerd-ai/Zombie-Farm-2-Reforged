// ---------------------------------------------------------------------------
// Friend leaderboard (Social → Leaderboard) — the ranking, kept pure.
// ---------------------------------------------------------------------------
// The server (GET /leaderboard/friends) returns you + your accepted friends with
// a fixed projection of each farm's lifetime tally, deliberately UNORDERED: rank
// depends on which stat is being ranked by, so ordering is decided here and the
// panel (ui/panels/leaderboard.ts) only renders rows it is handed.
//
// Fun-only by design: every column except Level is the client-authored tally
// behind the Statistics panel — display data nobody's rewards or gates read —
// shown only to people who accepted the friendship. See src/stats.ts.

import type { FriendLeaderboardEntry } from "../net/api";

export interface LeaderboardCategory {
  key: string;
  /** Chip label (also the ranked column's name). */
  label: string;
  /** The ranked number, or null when this farmer has no data for it — a friend
   *  whose client has never published a tally must sit at the bottom as "no
   *  stats yet", never be scored as a farm that has done nothing. */
  value: (entry: FriendLeaderboardEntry) => number | null;
}

/** Every board the panel offers, in chip order. Level leads: it is the one
 *  server-derived column, and the number players already scan the friends list
 *  by. The rest mirror the Statistics panel's headline counters. */
export const LEADERBOARD_CATEGORIES: readonly LeaderboardCategory[] = [
  { key: "level", label: "Level", value: (e) => e.level },
  { key: "harvested", label: "Crops harvested", value: (e) => e.stats?.harvested ?? null },
  { key: "goldEarned", label: "Gold earned", value: (e) => e.stats?.goldEarned ?? null },
  { key: "brainsEarned", label: "Brains earned", value: (e) => e.stats?.brainsEarned ?? null },
  { key: "zombiesGrown", label: "Zombies grown", value: (e) => e.stats?.zombiesGrown ?? null },
  { key: "raidsWon", label: "Invasions won", value: (e) => e.stats?.raidsWon ?? null },
];

export interface RankedRow {
  entry: FriendLeaderboardEntry;
  /** The ranked number, or null when this farmer has no data for the category. */
  value: number | null;
  /** Competition ("1224") rank; equal values share a rank. Null = unranked (no data). */
  rank: number | null;
}

/** Stable display tiebreak so two openings of the panel agree: name (folded),
 *  then account id — the id never collides, so the order is total. */
const displayOrder = (a: FriendLeaderboardEntry, b: FriendLeaderboardEntry): number => {
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return byName !== 0 ? byName : a.accountId < b.accountId ? -1 : 1;
};

/** Order `entries` for one category: ranked rows first, best value at the top,
 *  ties sharing a rank (1, 2, 2, 4); farmers with no data for the category last,
 *  unranked, in name order. */
export function rankLeaderboard(
  entries: readonly FriendLeaderboardEntry[],
  category: LeaderboardCategory
): RankedRow[] {
  const rows = entries
    .map((entry) => ({ entry, value: category.value(entry), rank: null as number | null }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === null && b.value === null
          ? displayOrder(a.entry, b.entry)
          : a.value === null ? 1 : -1;
      }
      return b.value - a.value || displayOrder(a.entry, b.entry);
    });
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].value === null) break;
    rows[i].rank = i > 0 && rows[i].value === rows[i - 1].value ? rows[i - 1].rank : i + 1;
  }
  return rows;
}
