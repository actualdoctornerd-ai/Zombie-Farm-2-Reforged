import { html as trHtml, t as tr } from "./i18n";
import {
  canPlayOnline, canSignIn, isExportOnly, OPEN_STATUS, type ServiceStatus,
} from "./net/serviceStatus";

export type PlayMode = "local" | "online";

const MODE_KEY = "zf2r.play-mode.v1";

export function otherPlayMode(mode: PlayMode): PlayMode {
  return mode === "local" ? "online" : "local";
}

export function playModeDestinationLabel(mode: PlayMode): string {
  return mode === "local" ? tr("Go to Online Farm") : tr("Go to Local Farm");
}

/** The selected farm—not a retained auth session—owns the gameplay boundary. */
export function usesOnlineGameplay(mode: PlayMode): boolean {
  return mode === "online";
}

export function getPreferredPlayMode(): PlayMode | null {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === "local" || value === "online" ? value : null;
  } catch {
    return null;
  }
}

export function setPreferredPlayMode(mode: PlayMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* preference is optional */ }
}

export function clearPreferredPlayMode(): void {
  try { localStorage.removeItem(MODE_KEY); } catch { /* preference is optional */ }
}

/** Copy for the Online Farm tile, which changes shape while the service is closed
 *  down between the beta and the full release. Split out so it can be unit tested
 *  without a DOM. */
export function onlineFarmTile(status: ServiceStatus): {
  title: string; body: string; note: string; disabled: boolean;
} {
  if (!canSignIn(status)) {
    return {
      title: tr("Online Farm — Closed"),
      body: status.notice ?? tr("Online Farm is closed while we get ready for the full release. Local Farm is unaffected."),
      note: tr("Sign-in unavailable · Your online progress is kept"),
      disabled: true,
    };
  }
  if (isExportOnly(status)) {
    return {
      title: tr("Export My Online Farm"),
      body: status.notice ?? tr("The beta is over and Online Farm is closed for now. Sign in once to download a copy of your farm, then play it in Local Farm."),
      note: tr("Sign in to export · No online play until the full release"),
      disabled: false,
    };
  }
  if (!canPlayOnline(status)) {
    // Not currently reachable: every mode that forbids play also forbids sign-in or is
    // export_only. Kept so a future mode cannot silently present itself as playable.
    return {
      title: tr("Online Farm — Limited"),
      body: status.notice ?? tr("Online Farm is not accepting gameplay right now."),
      note: tr("Read-only"),
      disabled: false,
    };
  }
  return {
    title: tr("Play Online"),
    body: tr("Sign in to save across devices and use online features."),
    note: status.mode === "signups_closed" ? tr("Cloud saved · New accounts are paused — existing players can sign in") : tr("Cloud saved · Internet required for gameplay"),
    disabled: false,
  };
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

/**
 * Which farm to open without prompting, or null to show the chooser.
 *
 * The case that matters: a returning beta player whose browser remembers "online".
 * Honouring that against a closed service would drop them into a sign-in they cannot
 * use and never tell them their farm is waiting to be collected — so a restricted
 * service always re-shows the chooser. A stored "local" is never second-guessed.
 */
export function resolveStoredPlayMode(
  preferred: PlayMode | null,
  status: ServiceStatus,
): PlayMode | null {
  if (!preferred) return null;
  if (preferred === "local") return "local";
  return canPlayOnline(status) ? "online" : null;
}

/** Whether picking `mode` should be remembered for next launch. An export trip is a
 *  one-off errand, not a declaration that this browser plays online. */
export function shouldPersistChoice(mode: PlayMode, status: ServiceStatus): boolean {
  return mode === "local" || canPlayOnline(status);
}

export function choosePlayMode(
  onlineAvailable = true,
  status: ServiceStatus = OPEN_STATUS,
): Promise<PlayMode> {
  if (!onlineAvailable) {
    setPreferredPlayMode("local");
    return Promise.resolve("local");
  }
  const resolved = resolveStoredPlayMode(getPreferredPlayMode(), status);
  if (resolved) return Promise.resolve(resolved);

  const online = onlineFarmTile(status);
  const root = document.createElement("div");
  root.className = "zf-mode-gate";
  root.innerHTML = trHtml`
    <main class="zf-mode-card" aria-labelledby="zf-mode-title">
      <h1 id="zf-mode-title">Choose Your Farm</h1>
      <p class="zf-mode-intro">Local Farm and Online Farm have completely separate progress.</p>
      <button class="zf-mode-choice" data-mode="local">
        <strong>Play Local</strong>
        <span>Play entirely on this device. No account or internet required.</span>
        <small>Saved in this browser · Single-player features</small>
      </button>
      <button class="zf-mode-choice" data-mode="online"${online.disabled ? " disabled" : ""}>
        <strong>${escape(online.title)}</strong>
        <span>${escape(online.body)}</span>
        <small>${escape(online.note)}</small>
      </button>
    </main>`;
  document.body.appendChild(root);

  return new Promise((resolve) => {
    root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
      button.onclick = () => {
        if (button.disabled) return;
        const mode = button.dataset.mode as PlayMode;
        if (shouldPersistChoice(mode, status)) setPreferredPlayMode(mode);
        root.remove();
        resolve(mode);
      };
    });
  });
}

export function showOnlineUnavailable(
  retry: () => Promise<boolean>,
  openLocal: () => void,
): Promise<void> {
  const root = document.createElement("div");
  root.className = "zf-mode-gate";
  root.innerHTML = trHtml`
    <main class="zf-mode-card zf-online-unavailable" aria-labelledby="zf-online-title">
      <h1 id="zf-online-title">Can’t Reach Your Online Farm</h1>
      <p>Your cloud progress is safe, but Online Farm requires an internet connection.</p>
      <button class="zf-mode-action primary" data-action="retry">Try Again</button>
      <button class="zf-mode-action" data-action="local">Open Separate Local Farm</button>
      <small>Local Farm has separate progress and will not change your Online Farm.</small>
      <div class="zf-mode-error" role="status"></div>
    </main>`;
  document.body.appendChild(root);

  return new Promise((resolve) => {
    const retryButton = root.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
    const localButton = root.querySelector<HTMLButtonElement>('[data-action="local"]')!;
    const status = root.querySelector<HTMLElement>(".zf-mode-error")!;
    retryButton.onclick = async () => {
      retryButton.disabled = true;
      localButton.disabled = true;
      status.textContent = tr("Connecting…");
      if (await retry()) {
        root.remove();
        resolve();
        return;
      }
      status.textContent = tr("Still unable to connect. Your Online Farm remains safe.");
      retryButton.disabled = false;
      localButton.disabled = false;
    };
    localButton.onclick = openLocal;
  });
}

export function showLocalUnavailable(
  retry: () => Promise<boolean>,
  reset: () => void,
): Promise<void> {
  const root = document.createElement("div");
  root.className = "zf-mode-gate";
  root.innerHTML = trHtml`
    <main class="zf-mode-card zf-online-unavailable" aria-labelledby="zf-local-save-title">
      <h1 id="zf-local-save-title">Can’t Open Your Local Farm</h1>
      <p>Your saved farm has not been overwritten. Browser storage may be temporarily unavailable, or the latest save may be damaged.</p>
      <button class="zf-mode-action primary" data-action="retry">Try Again</button>
      <button class="zf-mode-action" data-action="reset">Start a New Local Farm</button>
      <small>Starting over permanently removes this Local Farm and its backup.</small>
      <div class="zf-mode-error" role="status"></div>
    </main>`;
  document.body.appendChild(root);

  return new Promise((resolve) => {
    const retryButton = root.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
    const resetButton = root.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
    const status = root.querySelector<HTMLElement>(".zf-mode-error")!;
    let resetArmed = false;
    retryButton.onclick = async () => {
      retryButton.disabled = true;
      resetButton.disabled = true;
      status.textContent = tr("Opening saved farm…");
      if (await retry()) {
        root.remove();
        resolve();
        return;
      }
      status.textContent = tr("The saved farm still could not be opened. It has not been changed.");
      retryButton.disabled = false;
      resetButton.disabled = false;
    };
    resetButton.onclick = () => {
      if (!resetArmed) {
        resetArmed = true;
        resetButton.textContent = tr("Confirm Start New Farm");
        status.textContent = tr("This permanently deletes the saved Local Farm and its backup.");
        return;
      }
      retryButton.disabled = true;
      resetButton.disabled = true;
      reset();
    };
  });
}
