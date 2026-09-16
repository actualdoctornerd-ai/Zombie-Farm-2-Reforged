// What the red dots on the Social surfaces mean, and when one is lit.
//
// The rule the whole feature rests on: a dot marks something WAITING FOR THE PLAYER
// that they have not dealt with yet. It is never a count of activity, never a nag,
// and it always has somewhere to go — every lit dot leads to a screen where the thing
// behind it can be opened, answered or watched, and clears itself once it has been.
//
// The three sources differ in how "dealt with" is decided, which is why they are
// modelled separately rather than as one counter:
//
//   • gifts    — server state. The inbox holds unclaimed gifts; opening them empties
//                it. Nothing device-local is remembered.
//   • requests — server state, same shape: accepting or ignoring removes the row.
//   • invaded  — NOT server state. Being invaded leaves nothing to action (the farm
//                already fought, and nothing was ever at stake), so "dealt with"
//                means "looked at". That is a per-device opinion, so it is a
//                high-water mark of the newest invasion the player has SEEN, kept in
//                local prefs and compared against the newest one the server reports.
//
// Deliberately a dot and not a number: the panels behind them already name the exact
// counts ("Friend requests (2)", the gift rows themselves), so a badge repeating them
// buys nothing, and the invaded dot has no honest number to show — bootstrap carries
// one timestamp, not a tally.

export interface SocialBadges {
  /** Unclaimed gifts sitting in the inbox. */
  gifts: number;
  /** Pending incoming friend requests. */
  requests: number;
  /** Whether an invasion has settled against this farm since the player last looked. */
  invaded: boolean;
}

export const NO_SOCIAL_BADGES: SocialBadges = { gifts: 0, requests: 0, invaded: false };

/** Everything the Friends panel answers for: gifts to open and requests to decide. */
export const friendsBadge = (b: SocialBadges): boolean => b.gifts > 0 || b.requests > 0;

/** Everything the Invasions panel answers for. */
export const invasionsBadge = (b: SocialBadges): boolean => b.invaded;

/** Whether the Social button in the menu dock wears a dot at all. */
export const socialBadge = (b: SocialBadges): boolean =>
  friendsBadge(b) || invasionsBadge(b);

/** Whether a newly-reported invasion is one the player has not seen yet.
 *  Both instants are on the SERVER clock (bootstrap reports one, and the mark stored
 *  locally is a value that came from the server), so they are directly comparable —
 *  a device whose own clock is wrong never lights or hides the dot by accident. */
export function invadedSinceSeen(lastInvadedAt: number | null, seenAt: number): boolean {
  if (lastInvadedAt == null) return false;
  return lastInvadedAt > seenAt;
}

/** What a lit dot is for, in words, for the host's tooltip and screen readers.
 *
 *  `scope` must match what the dot it labels actually leads to: the dock's dot opens
 *  the hub, so it speaks for everything, while the hub's Friends tile must not promise
 *  an invasion the Invasions tile beside it is the one holding. A dot that describes
 *  the wrong screen is worse than a silent one — it sends the player somewhere the
 *  thing they were told about isn't.
 *
 *  Empty when nothing in scope is waiting; the caller then removes the badge entirely
 *  rather than leaving an unlabelled one behind. */
export function badgeSummary(b: SocialBadges, scope: "all" | "friends" | "invasions" = "all"): string {
  const parts: string[] = [];
  if (scope !== "invasions") {
    if (b.gifts) parts.push(`${b.gifts} gift${b.gifts === 1 ? "" : "s"} waiting`);
    if (b.requests) parts.push(`${b.requests} friend request${b.requests === 1 ? "" : "s"}`);
  }
  if (scope !== "friends" && b.invaded) parts.push("your farm was invaded");
  return parts.join(", ");
}
