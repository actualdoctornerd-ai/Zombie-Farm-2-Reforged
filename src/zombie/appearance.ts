/** White multiplication preserves the eye sprite's authored light-yellow color. */
export const DEFAULT_ZOMBIE_EYE_TINT = 0xffffff;

export function zombiePartTint(file: string, bodyTint: number): number {
  return /^defaultEye[LR](?:\.png)?$/i.test(file)
    ? DEFAULT_ZOMBIE_EYE_TINT
    : bodyTint;
}
