// Tim Buckwheat's one-off explanations for the level-ups that open a SYSTEM
// rather than just more catalog entries. The LEVEL UP popup lists what appeared;
// these say what it means — shown by main.ts after that popup is dismissed, via
// the Tim notice modal (ui/TimNotice.ts).
//
// No persisted "seen" flag is needed: level is derived from monotonic XP, so a
// given threshold can only ever be crossed once per farm.

export interface UnlockNotice {
  level: number;
  message: string;
  /** The feature lives behind Social / the server — skip it on offline farms. */
  onlineOnly?: boolean;
}

export const TIM_UNLOCK_NOTICES: readonly UnlockNotice[] = [
  {
    level: 3,
    message:
      "See that Zombie Pot in the Market? Place one, stick two zombies inside, " +
      "and they'll brew down into a brand-new zombie with the mutations of both!",
  },
  {
    level: 5,
    message:
      "Daily Quests are open! That star on yer quest list has fresh chores " +
      "every day, and they pay real rewards.\nSwing by each mornin'.",
  },
  {
    level: 10,
    message:
      "Big news — the Black Market's open! You'll find it under Social.\n" +
      "Post yer zombies for sale, or put up a request and let yer fellow farmers " +
      "fill it.",
    onlineOnly: true,
  },
  {
    level: 20,
    message:
      "Brain Tickets are up for sale in the Market! One ticket starts " +
      "an invasion right away, with way better brain luck.\nFair warnin' — the " +
      "fight turns ELITE, so bring yer toughest army.",
  },
];

/** The Tim messages to show after a level-up popup spanning (from, to], in
 *  ascending level order. A multi-level jump (a big quest turn-in) can cross
 *  several at once; each still gets its own say. */
export function timUnlockNoticesFor(from: number, to: number, online: boolean): string[] {
  return TIM_UNLOCK_NOTICES
    .filter((n) => n.level > from && n.level <= to && (online || !n.onlineOnly))
    .map((n) => n.message);
}
