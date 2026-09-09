import { describe, expect, it, vi } from "vitest";
import {
  activateWaitingWorker,
  checkRegistrationForUpdate,
  findWorkerToActivate,
  updateCheckMessage,
} from "./updateCheck";

// Minimal stand-ins for the bits of the service-worker API the poll touches.
function fakeWorker(state: ServiceWorker["state"]) {
  const listeners: (() => void)[] = [];
  return {
    state,
    addEventListener: (_: string, fn: () => void) => { listeners.push(fn); },
    removeEventListener: (_: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage: vi.fn(),
    /** Move the worker on and fire statechange, as the browser would. */
    settle(next: ServiceWorker["state"]) {
      this.state = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

function fakeServiceWorkers() {
  const listeners: (() => void)[] = [];
  return {
    addEventListener: (_: string, fn: () => void) => { listeners.push(fn); },
    removeEventListener: (_: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    controllerChanged() {
      for (const fn of [...listeners]) fn();
    },
  };
}

function fakeRegistration(over: Partial<Record<"waiting" | "installing", unknown>> & {
  update?: () => Promise<void>;
} = {}) {
  return {
    waiting: null,
    installing: null,
    update: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as ServiceWorkerRegistration & { update: ReturnType<typeof vi.fn> };
}

describe("manual update check", () => {
  it("reports no update when the poll finds nothing new", async () => {
    const registration = fakeRegistration();

    expect(await checkRegistrationForUpdate(async () => registration)).toBe("up-to-date");
    expect(registration.update).toHaveBeenCalledOnce();
  });

  it("reports a waiting worker without re-polling the network", async () => {
    const registration = fakeRegistration({ waiting: fakeWorker("installed") });

    expect(await checkRegistrationForUpdate(async () => registration)).toBe("update-ready");
    expect(registration.update).not.toHaveBeenCalled();
  });

  it("waits for a freshly downloaded worker to finish installing", async () => {
    const installing = fakeWorker("installing");
    const registration = fakeRegistration({ installing });
    registration.update = vi.fn().mockResolvedValue(undefined);

    const pending = checkRegistrationForUpdate(async () => registration);
    // Let update() resolve so the poll is parked on the statechange listener.
    await Promise.resolve();
    await Promise.resolve();

    (registration as { waiting: unknown }).waiting = installing;
    installing.settle("installed");

    expect(await pending).toBe("update-ready");
  });

  it("gives up rather than hanging when an install stalls", async () => {
    vi.useFakeTimers();
    try {
      const registration = fakeRegistration({ installing: fakeWorker("installing") });
      const pending = checkRegistrationForUpdate(async () => registration, 20_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toBe("up-to-date");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an error when the network poll fails", async () => {
    const registration = fakeRegistration({
      update: vi.fn().mockRejectedValue(new Error("offline")),
    });

    expect(await checkRegistrationForUpdate(async () => registration)).toBe("error");
  });

  it("reports unavailable with no service worker registered", async () => {
    expect(await checkRegistrationForUpdate(async () => null)).toBe("unavailable");
  });

  it("tells the player when nothing new was found", () => {
    expect(updateCheckMessage("up-to-date")).toBe("No new updates detected.");
  });
});

describe("update activation", () => {
  it("waits for confirmed activation before allowing a reload", async () => {
    const worker = fakeWorker("installed");
    const serviceWorkers = fakeServiceWorkers();
    const pending = activateWaitingWorker(
      worker as unknown as ServiceWorker,
      serviceWorkers as unknown as ServiceWorkerContainer,
    );

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    worker.settle("activated");
    await expect(pending).resolves.toBe(true);
  });

  it("does not permit an old-shell reload when activation times out", async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker("installed");
      const serviceWorkers = fakeServiceWorkers();
      const pending = activateWaitingWorker(
        worker as unknown as ServiceWorker,
        serviceWorkers as unknown as ServiceWorkerContainer,
        5_000,
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts controllerchange as activation confirmation", async () => {
    const worker = fakeWorker("installed");
    const serviceWorkers = fakeServiceWorkers();
    const pending = activateWaitingWorker(
      worker as unknown as ServiceWorker,
      serviceWorkers as unknown as ServiceWorkerContainer,
    );

    serviceWorkers.controllerChanged();
    await expect(pending).resolves.toBe(true);
  });
});

// The update-loop guard. A ruleset-skew prompt always arrives with nothing waiting, so
// this is the branch that decides between "look for a build" and "reload into the same
// precached shell and prompt again", which is a loop the player cannot break out of.
describe("findWorkerToActivate", () => {
  it("activates a worker that is already waiting without polling", async () => {
    const waiting = fakeWorker("installed") as unknown as ServiceWorker;
    const check = vi.fn();
    const found = await findWorkerToActivate(
      { waiting } as unknown as ServiceWorkerRegistration,
      check as never,
    );

    expect(found.worker).toBe(waiting);
    expect(check).not.toHaveBeenCalled();
  });

  it("looks for an update when nothing is waiting, rather than reloading", async () => {
    const waiting = fakeWorker("installed") as unknown as ServiceWorker;
    const registration = { waiting: null as ServiceWorker | null };
    // The poll is what installs the new build; the worker only appears afterwards.
    const check = vi.fn(async () => {
      registration.waiting = waiting;
      return "update-ready" as const;
    });

    const found = await findWorkerToActivate(
      registration as unknown as ServiceWorkerRegistration,
      check as never,
    );

    expect(check).toHaveBeenCalledTimes(1);
    expect(found.worker).toBe(waiting);
  });

  it("reports no worker when the poll finds nothing, so the caller cannot reload", async () => {
    const check = vi.fn(async () => "up-to-date" as const);

    const found = await findWorkerToActivate(
      { waiting: null } as unknown as ServiceWorkerRegistration,
      check as never,
    );

    expect(found.worker).toBeNull();
    expect(found).toMatchObject({ reason: "up-to-date" });
  });

  it("still activates a worker that finished installing after the poll gave up", async () => {
    const waiting = fakeWorker("installed") as unknown as ServiceWorker;
    const registration = { waiting: null as ServiceWorker | null };
    // "error" (or a timed-out install) must not lose a worker that landed anyway.
    const check = vi.fn(async () => {
      registration.waiting = waiting;
      return "error" as const;
    });

    const found = await findWorkerToActivate(
      registration as unknown as ServiceWorkerRegistration,
      check as never,
    );

    expect(found.worker).toBe(waiting);
  });
});
