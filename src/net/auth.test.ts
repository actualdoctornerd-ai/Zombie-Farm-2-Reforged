import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import * as auth from "./auth";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sign out", () => {
  it("does not complete until the API has cleared the session", async () => {
    let finishLogout!: () => void;
    vi.spyOn(api, "logout").mockReturnValue(new Promise<void>((resolve) => {
      finishLogout = resolve;
    }));
    vi.stubGlobal("window", {});
    let emitted = false;
    auth.onAuthChange(() => { emitted = true; });

    const signingOut = auth.signOut();
    await Promise.resolve();
    expect(emitted).toBe(false);

    finishLogout();
    await signingOut;
    expect(emitted).toBe(true);

  });
});
