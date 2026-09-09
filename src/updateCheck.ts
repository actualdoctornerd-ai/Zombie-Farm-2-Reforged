// Manual "check for updates" poll against the registered service worker.
//
// Kept apart from pwa.ts so it can be unit tested: pwa.ts imports the
// "virtual:pwa-register" module, which only exists inside a Vite build.
// The browser wiring (and the toast) lives there; the poll lives here.

export type UpdateCheckResult =
  /** A newer build is installed and waiting to take over. */
  | "update-ready"
  /** The service worker re-checked the network and found nothing new. */
  | "up-to-date"
  /** No service worker to ask — dev server, or a browser without SW support. */
  | "unavailable"
  /** The check itself failed (offline, server error, install stalled). */
  | "error";

/** How long to wait for a freshly downloaded worker to finish installing before
 *  giving up. A big precache on a slow phone connection can take a while; past
 *  this the player gets the update toast on their next visit instead. */
const INSTALL_TIMEOUT_MS = 20_000;

/** iOS can take several seconds to promote a waiting worker after SKIP_WAITING.
 *  Never reload on this timeout: doing so can load the old cached shell and present
 *  the same update again, which looks like an update loop. */
const ACTIVATION_TIMEOUT_MS = 30_000;

/** Ask the service worker to re-check the network for a new build.
 *
 *  `getRegistration` is injected so tests (and callers without a service worker)
 *  can supply their own. A worker that is already waiting counts as an update
 *  straight away — the player may have dismissed the automatic toast earlier. */
export async function checkRegistrationForUpdate(
  getRegistration: () => Promise<ServiceWorkerRegistration | null | undefined>,
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<UpdateCheckResult> {
  let registration: ServiceWorkerRegistration | null | undefined;
  try {
    registration = await getRegistration();
  } catch {
    return "error";
  }
  if (!registration) return "unavailable";
  if (registration.waiting) return "update-ready";

  try {
    await registration.update();
  } catch {
    // update() rejects when the SW script can't be fetched — almost always the
    // player being offline. Nothing is broken; there's just no answer.
    return "error";
  }

  // update() resolves as soon as the new script is fetched; the worker still has
  // to install (precaching every asset) before it moves to "waiting".
  const installing = registration.installing;
  if (installing) await workerSettled(installing, timeoutMs);

  return registration.waiting ? "update-ready" : "up-to-date";
}

/** Resolves once the worker leaves the "installing" state — or on timeout, so a
 *  stalled install can never leave the Settings button spinning forever. */
function workerSettled(worker: ServiceWorker, timeoutMs: number): Promise<void> {
  if (worker.state !== "installing") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (worker.state !== "installing") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    worker.addEventListener("statechange", onChange);
  });
}

/** Which worker, if any, a reload should activate first.
 *
 *  Split out of pwa.ts because getting it wrong is invisible and awful: a reload with
 *  nothing waiting is served straight out of the precache, so a ruleset-skew prompt
 *  reloads into the SAME stale bundle, skews against the same Worker and prompts again
 *  — an unbreakable loop for the player. A skew prompt arrives with nothing waiting by
 *  definition (the player never dismissed an update toast; the mismatch is what alerted
 *  them), so "nothing waiting" must mean LOOK, not RELOAD ANYWAY. */
export async function findWorkerToActivate(
  registration: ServiceWorkerRegistration,
  check: (
    getRegistration: () => Promise<ServiceWorkerRegistration | null | undefined>,
  ) => Promise<UpdateCheckResult> = checkRegistrationForUpdate,
): Promise<{ worker: ServiceWorker } | { worker: null; reason: UpdateCheckResult }> {
  if (registration.waiting) return { worker: registration.waiting };

  const reason = await check(async () => registration);
  // Re-read rather than trusting the verdict: the update may have installed a worker
  // that was still "installing" when the poll timed out.
  if (registration.waiting) return { worker: registration.waiting };
  return { worker: null, reason };
}

/** Ask a waiting worker to take control and resolve only after the browser confirms
 *  activation. A false result means the caller should leave the page in place and
 *  offer another try; reloading before activation can serve the old app shell. */
export function activateWaitingWorker(
  worker: ServiceWorker,
  serviceWorkers: Pick<ServiceWorkerContainer, "addEventListener" | "removeEventListener">,
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<boolean> {
  if (worker.state === "activated") return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (activated: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("statechange", onWorkerStateChange);
      serviceWorkers.removeEventListener("controllerchange", onControllerChange);
      resolve(activated);
    };
    const onControllerChange = () => finish(true);
    const onWorkerStateChange = () => {
      if (worker.state === "activated") finish(true);
      else if (worker.state === "redundant") finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    worker.addEventListener("statechange", onWorkerStateChange);
    serviceWorkers.addEventListener("controllerchange", onControllerChange);
    // Close the small race between the state check above and attaching listeners.
    if (worker.state === "activated") {
      finish(true);
      return;
    }
    if (worker.state === "redundant") {
      finish(false);
      return;
    }
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch {
      finish(false);
    }
  });
}

/** Player-facing line for the Settings row. The "update-ready" case also gets the
 *  bottom toast with the Reload button (see pwa.ts), so it stays short here. */
export function updateCheckMessage(result: UpdateCheckResult): string {
  switch (result) {
    case "update-ready":
      return "Update found — reload when you're ready.";
    case "up-to-date":
      return "No new updates detected.";
    case "unavailable":
      return "Update checks aren't available in this build.";
    case "error":
      return "Couldn't check for updates — check your connection.";
  }
}
