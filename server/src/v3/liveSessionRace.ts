// The one-live-fight rule, when two starts tie.
//
// Every fight start reads "is there a live session already?" and then inserts one.
// The read and the insert are separate round trips, so two starts that arrive
// together both see "none" and both insert — and the partial unique indexes
// (idx_raid_v3_live, idx_epic_boss_session_live_v3, idx_pvp_live) refuse the second.
// That refusal is correct; what was wrong was its SHAPE: the batch threw, nothing
// caught it, and the client got a raw 500 for a situation every start route already
// has a proper answer for (409 raid_in_progress / battle_in_progress). The double-tap
// that produces the tie is a client bug with its own fix; this is the server saying
// the right thing when it happens anyway.

/** Whether a failed batch failed because a live-session unique index refused a
 *  second open fight. Matched on SQLite's message: the only signal D1 gives. */
export function isLiveSessionCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message)
    && /raid_sessions_v3|epic_boss_sessions_v3|pvp_sessions_v3|idx_raid_v3_live|idx_epic_boss_session_live_v3|idx_pvp_live/.test(message);
}
