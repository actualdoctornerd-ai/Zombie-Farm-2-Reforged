// Online Farm auth gate. Local Farm never calls this module. Online Farm is locked
// behind Google sign-in so account data remains reachable across devices. requireAuth() renders a
// full-screen wall and resolves only once the player is signed in AND has chosen a
// username — main() awaits it before building the game.
//
// Two screens: the sign-in wall (Google button + why-note) and, for brand-new
// accounts, a one-time username picker. Sign-OUT is handled elsewhere (it reloads
// the page, which lands back here).
import * as auth from "./auth";
import * as api from "./api";
import {
  fetchServiceStatus, isExportOnly, OPEN_STATUS, peekServiceStatus, signInRefusalMessage,
  usernameRefusalMessage,
} from "./serviceStatus";

const STYLE = `
.zf-gate { position: fixed; inset: 0; z-index: 100000; display: flex;
  align-items: center; justify-content: center; padding: 24px;
  background: radial-gradient(120% 120% at 50% 0%, #234012 0%, #12220a 60%, #0a1406 100%);
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.zf-gate-card { width: min(420px, 94vw); text-align: center; color: #eaffd8;
  background: linear-gradient(#2a3f14, #1c2c0d); border: 2px solid #0c1505;
  border-radius: 18px; padding: 30px 26px; box-shadow: 0 18px 50px rgba(0,0,0,.5); }
.zf-gate-title { font-size: 30px; font-weight: 900; letter-spacing: .5px; margin: 0 0 4px;
  color: #b6f36a; text-shadow: 0 2px 0 #14240a; }
.zf-gate-sub { font-size: 14px; line-height: 1.5; color: #c9e6a8; margin: 0 0 22px; }
.zf-gate-gsi { display: flex; justify-content: center; min-height: 44px; }
.zf-gate-hint { margin-top: 16px; font-size: 12px; color: #90ad6e; }
.zf-gate-label { display: block; text-align: left; font-size: 13px; font-weight: 700;
  color: #c9e6a8; margin: 0 0 6px; }
.zf-gate-input { width: 100%; box-sizing: border-box; padding: 11px 13px; border-radius: 10px;
  border: 2px solid #0c1505; background: #16240b; color: #f0ffdc;
  font: 700 16px system-ui, sans-serif; }
.zf-gate-input:focus { outline: none; border-color: #79c247; }
.zf-gate-start { margin-top: 16px; width: 100%; padding: 12px; border-radius: 10px;
  border: 2px solid #14240a; cursor: pointer; color: #12240a;
  font: 800 16px system-ui, sans-serif; background: linear-gradient(#9be25a, #6fb030); }
.zf-gate-start:hover { filter: brightness(1.06); }
.zf-gate-start:disabled { opacity: .5; cursor: default; filter: none; }
.zf-gate-err { min-height: 16px; margin-top: 10px; font-size: 12px; color: #ffb0a0; }
.zf-gate-refusal { margin-top: 14px; font-size: 13px; line-height: 1.45; color: #ffd9a0; }
`;

let styled = false;
function injectStyle() {
  if (styled) return;
  const s = document.createElement("style");
  s.textContent = STYLE;
  document.head.appendChild(s);
  styled = true;
}

/**
 * Block until the player is fully authenticated (signed in + username chosen),
 * showing the gate meanwhile. Resolves immediately when:
 *   - no server is configured (offline build — nothing to lock), or
 *   - already signed in with a username.
 */
export function requireAuth(): Promise<void> {
  if (!auth.isOnlineAvailable()) return Promise.resolve(); // offline build: no lock
  if (auth.isSignedIn() && !auth.needsUsername()) return Promise.resolve();

  // main() probes before the farm chooser, so this is normally already memoised and
  // reads synchronously — no round trip and no second repaint of the Google button.
  let serviceStatus = peekServiceStatus() ?? OPEN_STATUS;
  injectStyle();
  const root = document.createElement("div");
  root.className = "zf-gate";
  document.body.appendChild(root);

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.remove();
      resolve();
    };

    const showSignIn = () => {
      // During the closedown the wall explains WHY you are signing in — the account is
      // no longer a place to play, it is where your farm is waiting to be collected.
      const exporting = isExportOnly(serviceStatus);
      const sub = exporting
        ? "Online Farm is closed while we prepare the full release. Sign in once to "
          + "download a copy of your farm, then play it in Local Farm."
        : "Sign in to save your farm and play across devices — your progress, "
          + "zombies, and friends live on your account.";
      const refusal = signInRefusalMessage(auth.lastSignInError());
      root.innerHTML =
        `<div class="zf-gate-card">` +
        `<h1 class="zf-gate-title">${exporting ? "Export Your Farm" : "Zombie Farm"}</h1>` +
        `<p class="zf-gate-sub">${sub}</p>` +
        `<div class="zf-gate-gsi"></div>` +
        (refusal ? `<p class="zf-gate-refusal"></p>` : "") +
        `<div class="zf-gate-hint">We only use your Google account for sign-in.</div>` +
        `</div>`;
      if (refusal) {
        (root.querySelector(".zf-gate-refusal") as HTMLElement).textContent = refusal;
      }
      void auth.renderSignInButton(root.querySelector(".zf-gate-gsi") as HTMLElement);
    };

    const showUsername = () => {
      root.innerHTML =
        `<div class="zf-gate-card">` +
        `<h1 class="zf-gate-title">Pick a name</h1>` +
        `<p class="zf-gate-sub">This is how friends will see you. You can use letters, ` +
        `numbers and spaces.</p>` +
        `<label class="zf-gate-label" for="zf-uname">Username</label>` +
        `<input class="zf-gate-input" id="zf-uname" maxlength="20" autocomplete="off" ` +
        `placeholder="e.g. CaptainZombie" />` +
        `<div class="zf-gate-err"></div>` +
        `<button class="zf-gate-start">Start playing</button>` +
        `</div>`;
      const input = root.querySelector(".zf-gate-input") as HTMLInputElement;
      const btn = root.querySelector(".zf-gate-start") as HTMLButtonElement;
      const err = root.querySelector(".zf-gate-err") as HTMLElement;
      input.focus();
      const submit = async () => {
        const v = input.value.trim();
        if (!v) return;
        btn.disabled = true;
        err.textContent = "";
        try {
          await api.setUsername(v);
          finish();
        } catch (e) {
          btn.disabled = false;
          // A CONTENT refusal has to be told apart from a network failure here more
          // than anywhere else in the game: this picker is the only way past the
          // gate, so "check your connection and try again" is advice that can never
          // work — the same name is refused every time, and the player has no way to
          // learn that the name is the problem. The server sends `reason` for exactly
          // this, and usernameRefusalMessage owns the wording for both surfaces.
          err.textContent = e instanceof api.ApiError
            ? usernameRefusalMessage({
                code: e.code,
                reason: (e.body as { reason?: string } | null)?.reason,
              })
            : "Couldn't save that — check your connection and try again.";
        }
      };
      btn.onclick = () => void submit();
      input.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
    };

    const render = () => {
      if (!auth.isSignedIn()) showSignIn();
      else if (auth.needsUsername()) showUsername();
      else finish();
    };

    // Google sign-in fires onAuthChange after storing the session → re-render into
    // the username picker (new account), the refusal copy, or finish.
    auth.onAuthChange(render);
    render();
    // Only when nothing had probed yet (a caller other than main()): fill in and repaint.
    if (!peekServiceStatus()) {
      void fetchServiceStatus().then((status) => {
        serviceStatus = status;
        if (!done && !auth.isSignedIn()) showSignIn();
      });
    }
  });
}
