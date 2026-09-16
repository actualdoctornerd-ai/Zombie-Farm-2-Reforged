// The damage wash on a zombie that has just been hit.
//
// Enemy melee was the least legible thing on the battlefield: a player watching the
// Lawyers invasion reported twice that "none of the enemies fought back, outside of
// tossing things", and both investigations found the blows landing exactly as they
// should. What was missing was any mark on the VICTIM. A landed hit produced a small
// dust puff at the ATTACKER, a sound that a simultaneous zombie swing could take
// (raid/combatPresentation.ts mixes one cue per tick), and a tick of the health bar —
// while the boss's thrown stapler, the one enemy impact with a guaranteed cue, read as
// the only thing an enemy ever did.
//
// So: when damage lands on a zombie, wash the rig red for a moment. Presentation only —
// it is driven off `SimUnit.damageFxTaken`, the running total the damage numbers already
// read, and feeds nothing back into the fight. The raid plays out tick-for-tick the same
// with or without it, which is what lets it ride a server-verified replay.

/** How long the wash lasts. Short on purpose: sixteen zombies trading blows through a
 *  boss fight must read as a battle, not a strobe. */
export const HIT_FLASH_SEC = 0.18;

/** The wash at full strength. Pixi tints MULTIPLY, so a tint can only pull channels
 *  DOWN — this takes green and blue off the rig and leaves red alone, which reads as a
 *  red bloom over the zombie's own colouring rather than replacing it. Kept pale
 *  (0x90 = 56 % green) because the zombies being washed are the ones the player is
 *  trying to read health bars and mutations off. */
export const HIT_FLASH_TINT = 0xff9084;

/** No tint at all. */
export const NO_TINT = 0xffffff;

/**
 * The tint for a wash `remaining` seconds from done — full strength at `HIT_FLASH_SEC`,
 * back to white at 0, blended per channel in between so the colour eases out rather
 * than snapping off.
 */
export function hitFlashTint(remaining: number): number {
  const k = Math.max(0, Math.min(1, remaining / HIT_FLASH_SEC));
  if (k <= 0) return NO_TINT;
  const channel = (shift: number) => {
    const to = (HIT_FLASH_TINT >> shift) & 0xff;
    return Math.round(0xff + (to - 0xff) * k) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}
