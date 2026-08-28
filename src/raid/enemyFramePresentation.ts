/** Zedzox's original frames belong against the black perch window. */
export function usesGroundEnemyFrames(state: string): boolean {
  return state !== "structure" && state !== "descending";
}
