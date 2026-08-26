/** Which way a player zombie's rig should point this frame, as a horizontal delta for
 *  `RaidActor.setFacingFromDelta` (+1 = toward the enemy line, -1 = toward home).
 *  Returns null to leave the facing exactly as it is.
 *
 *  Facing used to be read straight off `vx`: face the way you are walking. That is right
 *  for the crowd milling behind the charge slot, and wrong for everyone on the field. A
 *  zombie sent to a REAR formation slot — knocked back, displaced by a boss special, or
 *  re-formed behind a row that filled ahead of it — walks there leftward and turns to
 *  face that way. It then attacks from the back row (every zombie inside the combat zone
 *  attacks, not just the front one), but `vx` is zero the moment it arrives, so nothing
 *  ever turned it around again: it traded blows with its back to the enemy for the rest
 *  of the fight. Which way the player's side FIGHTS is not a movement question.
 *
 *  Presentation only — nothing here touches the simulation. */
export function zombieFacingDelta(u: {
  state: string;
  vx: number;
  windupKey: string | null;
  alive: boolean;
  knockBackSpeed?: number;
}, opts: { exitMarch: boolean; retreating: boolean }): number | null {
  // The end-of-fight march overrides everything: home on a retreat, onward on a win.
  if (opts.exitMarch) return opts.retreating ? -1 : 1;
  if (!u.alive) return null;
  // Being SHOVED is the other case where travel is not intent. A knockback slides the
  // zombie backward fast, so the `vx` branch below turned it around to face the way it
  // was flying — and a zombie that turns its back and strides away reads as retreating
  // under its own steam rather than as one that just took a hit. It is still fighting
  // the enemy in front of it; it just isn't standing where it was.
  if ((u.knockBackSpeed ?? 0) > 0) return 1;
  // Fighting (or charging an activated move) always squares up to the enemy, even on
  // the tick a zombie is still closing the last few pixels to its slot.
  if (u.state === "fight" || u.windupKey) return 1;
  // Actually walking somewhere: face the walk. This is what makes the zombies waiting
  // behind the charge slot pace back and forth.
  if (Math.abs(u.vx) > 6) return u.vx;
  // Deployed and standing still — between one enemy dying and the next walking on.
  // Square back up rather than keeping whichever way the last leg of the walk pointed.
  if (u.state === "advance") return 1;
  return null;
}
