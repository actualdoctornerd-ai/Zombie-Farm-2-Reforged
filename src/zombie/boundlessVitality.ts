// Boundless Vitality (Green Flower Zombie, owner 2026-11-11, ruleset 90): a fallen zombie
// with it is back on its feet once the fight is over, so it is never a casualty. Read by
// BattleSim.outcome() (every invasion, elite, dual, Halloween night and Epic Boss
// settlement), Endless's between-floor carry (finishEndlessFight) and its run-end burial
// (endlessLosses). It is settled AFTER the fight: in battle it falls like anyone else.
export const BOUNDLESS_VITALITY = "boundlessVitality";

/** Does a unit carrying these (unlocked, active) abilities get back up after a fight? */
export const getsBackUp = (abilities: readonly string[]): boolean => abilities.includes(BOUNDLESS_VITALITY);
