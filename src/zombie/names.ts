// Random individual zombie names, sourced from the game's ZombieNames.json
// (buckets: female / large / male / small). Each owned zombie gets a fixed name
// derived deterministically from its instance id, so the same zombie always
// shows the same name across reloads without needing to persist it.
let NAMES: Record<string, string[]> = {};

export function setZombieNames(data: Record<string, string[]>) {
  NAMES = data ?? {};
}

/** Which name bucket a group draws from. */
function bucketFor(group: string): string {
  if (group === "Girl" || group === "Female") return "female";
  if (group === "Large") return "large";
  if (group === "Small") return "small";
  return "male"; // Regular / Headless / Garden and anything else
}

/** A stable, deterministic name for a zombie (same id → same name). */
export function randomZombieName(group: string, seed: string): string {
  const list = NAMES[bucketFor(group)] ?? NAMES.male ?? [];
  if (!list.length) return "";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return list[Math.abs(h) % list.length];
}
