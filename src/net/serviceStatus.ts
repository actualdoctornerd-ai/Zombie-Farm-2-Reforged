// What the Online Farm service currently permits, read from the Worker's
// unauthenticated `GET /` probe BEFORE anything else happens at boot.
//
// The point is the start screen: when the beta is closed down between the beta and
// the full release, players must learn that from the farm chooser — not by picking
// Online Farm, waiting through Google sign-in, and getting an error. It also drives
// the export-only flow, which is the only way a beta player gets their farm out.
//
// Everything here fails OPEN. A flaky connection must never present a working service
// as closed, so any error, timeout, or malformed reply is treated as "open" and the
// player takes the ordinary path (which has its own, better, failure UX).
import * as api from "./api";

export type ServiceMode = "open" | "signups_closed" | "export_only" | "closed";

export interface ServiceStatus {
  mode: ServiceMode;
  /** Operator-authored line to show instead of the built-in copy for the mode. */
  notice: string | null;
  /** False when the probe never answered — we are ASSUMING open, not reporting it. */
  reached: boolean;
}

export const OPEN_STATUS: ServiceStatus = { mode: "open", notice: null, reached: false };

const MODES: readonly string[] = ["open", "signups_closed", "export_only", "closed"];
const PROBE_TIMEOUT_MS = 6000;

const isMode = (value: unknown): value is ServiceMode =>
  typeof value === "string" && MODES.includes(value);

/** Existing accounts can sign in at all. */
export const canSignIn = (status: ServiceStatus): boolean => status.mode !== "closed";

/** A player without an account can still get one. */
export const canCreateAccount = (status: ServiceStatus): boolean => status.mode === "open";

/** Online Farm is playable, rather than readable-so-you-can-leave. */
export const canPlayOnline = (status: ServiceStatus): boolean =>
  status.mode === "open" || status.mode === "signups_closed";

/** Sign-in exists solely so the player can take their farm to Local Farm. */
export const isExportOnly = (status: ServiceStatus): boolean => status.mode === "export_only";

/** Player-facing line for a sign-in the server refused. The closedown codes are the
 *  ones that need real copy — everything else is a generic retry. Lives here rather
 *  than in gate.ts so it can be tested without importing the Google Sign-In module,
 *  which touches `window` as soon as it loads. */
export function signInRefusalMessage(code: string | null): string | null {
  switch (code) {
    case "signups_closed":
      return "New accounts are paused while we prepare the full release. "
        + "If you played the beta, sign in with the same Google account.";
    case "service_closed":
      return "Online Farm is closed while we prepare the full release. "
        + "Local Farm still works, and your online progress is kept.";
    case null:
      return null;
    default:
      return "Sign-in didn't complete. Check your connection and try again.";
  }
}

/** A username refusal, as the two name-picking surfaces receive it: the server's
 *  error code plus, for a content refusal, which KIND of problem it was. */
export interface UsernameRefusal {
  code: string;
  reason?: string;
}

/** Player-facing line for a username the server refused.
 *
 *  There are two refusals and they need opposite advice. `bad_username` is the SHAPE
 *  rule — length and legal characters — so restating that rule is exactly right.
 *  `blocked_username` is the CONTENT filter, where restating it is actively
 *  misleading: the name WAS 2-20 legal characters and was still not allowed, so a
 *  player told to use letters and numbers will retype the same name and be refused
 *  again. That dead end is the reason this function exists.
 *
 *  The copy stays coarse on purpose. It names the category and never the word that
 *  matched, because `nameFilter.ts`'s lists are not something to hand back to
 *  somebody probing them at ten tries a minute. Impersonation is the one case worth
 *  splitting out: that player wrote nothing offensive, and "reserved" tells them why
 *  their perfectly ordinary name bounced.
 *
 *  Lives here rather than in gate.ts for the same reason `signInRefusalMessage` does
 *  — gate.ts cannot be imported by a test without pulling in Google Sign-In, which
 *  touches `window` the moment it loads. */
export function usernameRefusalMessage(refusal: UsernameRefusal): string {
  if (refusal.code === "bad_username") return "Use 2–20 letters, numbers, spaces or _ - . '";
  if (refusal.code !== "blocked_username")
    return "Couldn't save that. Check your connection and try again.";
  return refusal.reason === "impersonation"
    ? "That name is reserved — it looks like a staff or game account. Please pick another."
    : "That name isn't allowed here. Please pick another.";
}

let cached: ServiceStatus | null = null;

/** The memoised status, or null if nothing has probed yet. Lets a caller that runs
 *  after main()'s boot probe render synchronously instead of resolving a promise and
 *  repainting a second time. */
export function peekServiceStatus(): ServiceStatus | null {
  return cached;
}

/** Test seam — clears the per-load memo. */
export function resetServiceStatus(): void {
  cached = null;
}

export async function fetchServiceStatus(
  fetcher: typeof fetch = fetch
): Promise<ServiceStatus> {
  if (cached) return cached;
  const base = api.baseUrl();
  if (!base) {
    // Offline build: there is no service to be closed.
    cached = OPEN_STATUS;
    return cached;
  }
  let status = OPEN_STATUS;
  try {
    const response = await fetcher(`${base}/`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json()) as { serviceMode?: unknown; serviceNotice?: unknown };
      // An older Worker (before the closedown switch) simply omits these.
      status = {
        mode: isMode(body.serviceMode) ? body.serviceMode : "open",
        notice: typeof body.serviceNotice === "string" && body.serviceNotice.trim()
          ? body.serviceNotice
          : null,
        reached: true,
      };
    }
  } catch {
    status = OPEN_STATUS;
  }
  cached = status;
  return status;
}
