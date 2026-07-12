// "Visit a friend's farm" — a READ-ONLY view of another player's farm.
//
// Implemented as a reload into visit mode rather than a second live world: main()
// already builds the entire farm from a save, so visiting just hydrates the
// friend's (server-projected, read-only) save into freshly-built singletons and
// NEVER enables autosave. Because the player's own save is never loaded in this
// mode, a visit structurally cannot write to — or even touch — their farm.
//
// The target is stashed in sessionStorage (survives the reload, dies with the
// tab) so no game state has to be threaded through the reload.

const VISIT_KEY = "zf2r.visit.v1";

export interface VisitTarget {
  /** The friend's account id (Friend.id when online) — the key GET /friends/:id/save wants. */
  id: string;
  /** Display name, for the "Visiting X's farm" banner. */
  name: string;
}

/** The farm we're currently visiting, or null for the normal (own-farm) session. */
export function getVisitTarget(): VisitTarget | null {
  try {
    const raw = sessionStorage.getItem(VISIT_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as VisitTarget;
    return t && typeof t.id === "string" ? t : null;
  } catch {
    return null;
  }
}

/** Begin visiting `target`: stash it and reload so main() rebuilds in visit mode. */
export function enterVisit(target: VisitTarget): void {
  try {
    sessionStorage.setItem(VISIT_KEY, JSON.stringify(target));
  } catch {
    /* ignore — if we can't stash the target we simply won't enter visit mode */
  }
  location.reload();
}

/** Clear the visit target. Call before reloading back to the player's own farm,
 *  or when a visit fetch fails so the next load is a normal one. */
export function clearVisitTarget(): void {
  try {
    sessionStorage.removeItem(VISIT_KEY);
  } catch {
    /* ignore */
  }
}

/** Stop visiting: back to the player's own farm (a normal reload). */
export function exitVisit(): void {
  clearVisitTarget();
  location.reload();
}
