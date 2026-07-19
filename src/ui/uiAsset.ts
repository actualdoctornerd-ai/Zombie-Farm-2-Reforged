// Resolve a HUD UI image name to its BASE-prefixed asset URL. Shared by hud.ts,
// the Modal primitive and the panel modules so the "assets/ui/…" path prefix lives
// in exactly one place (must stay BASE-prefixed for the GitHub Pages build).
import { BASE } from "../base";

export const UI = (n: string) => `${BASE}assets/ui/${n}`;
