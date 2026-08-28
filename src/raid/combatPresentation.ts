/** One audible/visible combat impact presented by RaidScene. */
export interface RaidStrikePresentation {
  team: "player" | "enemy";
  attackName?: string;
  impact?: "projectile";
  sfxFile?: string;
}

/**
 * Reduce one fixed simulation tick to the single cue RaidScene is allowed to mix.
 * Projectiles retain their authored collision cue. Otherwise a zombie attack wins a
 * simultaneous exchange so it cannot be masked by an enemy hit.
 *
 * RaidScene appends this result for every fixed tick it processes. That history is
 * what prevents an empty final catch-up tick from erasing an earlier impact.
 */
export function selectTickPresentation(
  strikes: readonly RaidStrikePresentation[],
  projectile: RaidStrikePresentation | null
): RaidStrikePresentation | null {
  if (projectile) return projectile;
  return strikes.find((strike) => strike.team === "player") ?? strikes[0] ?? null;
}
