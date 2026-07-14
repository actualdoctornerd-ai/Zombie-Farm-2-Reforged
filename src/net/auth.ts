// Google Sign-In (GIS) on top of api.ts. Loads the Google library on demand,
// renders the sign-in button, exchanges the returned Google ID token for our own
// session via api.authenticate(), and exposes a tiny sign-in/out surface.
//
// Everything degrades: with no VITE_API_URL (api.isConfigured() === false) or no
// VITE_GOOGLE_CLIENT_ID, sign-in is simply unavailable and the game stays offline.
import * as api from "./api";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const GIS_SRC = "https://accounts.google.com/gsi/client";

// Minimal shape of the GIS globals we use (no @types dependency).
interface GoogleId {
  accounts: {
    id: {
      initialize(cfg: {
        client_id: string;
        callback: (r: { credential: string }) => void;
      }): void;
      renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
      disableAutoSelect(): void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleId;
    /** Dev-only sign-in bypass (see below), attached when VITE_API_URL is set. */
    zfDevSignIn?: (sub: string, name?: string) => Promise<void>;
  }
}

type Listener = () => void;
const listeners: Listener[] = [];
export function onAuthChange(fn: Listener) {
  listeners.push(fn);
}
function emit() {
  for (const fn of listeners) fn();
}

/** Whether online play is even possible (a server URL is configured). */
export const isOnlineAvailable = () => api.isConfigured();
/** Whether Google sign-in can be offered (server + client id present). */
export const canSignIn = () => api.isConfigured() && !!CLIENT_ID;
export const isSignedIn = () => !!api.getSession();
export const session = () => api.getSession();
/** Signed in, but hasn't chosen a username yet (new account → show the picker). */
export const needsUsername = () => {
  const s = api.getSession();
  return !!s && s.username == null;
};

// Load the GIS script once.
let gisPromise: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load Google Sign-In"));
    document.head.appendChild(s);
  });
  return gisPromise;
}

// GIS must be initialized exactly once per page; renderButton can then run as many
// times as needed. Calling initialize() on every render triggers a GSI warning and
// only the last instance would be used.
let gisInitialized = false;
function ensureGisInitialized(g: GoogleId) {
  if (gisInitialized) return;
  g.accounts.id.initialize({
    client_id: CLIENT_ID!,
    callback: async (resp) => {
      try {
        await api.authenticate({ idToken: resp.credential });
        emit();
      } catch (e) {
        console.warn("[auth] sign-in failed", e);
      }
    },
  });
  gisInitialized = true;
}

/** Render Google's sign-in button into `container`. No-op if sign-in isn't
 *  available. On success, stores our session and notifies listeners. */
export async function renderSignInButton(container: HTMLElement): Promise<void> {
  if (!canSignIn()) return;
  await loadGis();
  const g = window.google!;
  ensureGisInitialized(g);
  g.accounts.id.renderButton(container, {
    theme: "filled_blue",
    size: "large",
    text: "signin_with",
    shape: "pill",
  });
}

export function signOut() {
  try {
    window.google?.accounts.id.disableAutoSelect();
  } catch {
    /* ignore */
  }
  // Revoke the session server-side (best-effort), not just locally — a stolen copy
  // of the token stops working once the session row is revoked. clearSession()
  // still runs inside api.logout() so the UI signs out immediately regardless.
  void api.logout();
  emit();
}

/** Renew our access token if we're signed in (fresh token for a long-lived tab).
 *  Best-effort: a revoked/expired session surfaces as 401 and clears the session,
 *  which the caller's re-render turns into the sign-in gate. */
export async function refreshIfSignedIn(): Promise<void> {
  if (!api.getSession()) return;
  try {
    await api.refreshSession();
  } catch {
    /* 401 already cleared the session; onAuthChange listeners re-render the gate */
    emit();
  }
}

// Dev-only sign-in: bypasses the Google popup so the flow can be automated
// locally. Only works when the SERVER has DEV_AUTH=1 (it rejects otherwise), and
// is only exposed when a server URL is configured. Never a security risk in prod
// because the server gates it.
if (api.isConfigured()) {
  window.zfDevSignIn = async (sub: string, name?: string) => {
    await api.authenticate({ devSub: sub, devName: name });
    emit();
  };
}
