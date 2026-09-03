// The gate that turned "two battles, one unresponsive" into one battle.
//
// The report: Invade, then — before the battle screen appears — deselect and reselect
// a zombie and tap Fight again. The army screen's Fight button was the only guard and
// its refresh() re-enabled it from the selection count, so the launch path ran twice.
// The gate is the guard that does not live in the button.
import { describe, expect, it } from "vitest";
import { LaunchGate } from "./launchGate";

/** A launch that waits until the test lets it finish — the server gate, Tim's tip
 *  awaiting a tap, the scene build, all in one. */
function deferredLaunch<T>(result: T) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { finish, launch: async () => { await done; return result; } };
}

describe("LaunchGate — one launch at a time", () => {
  it("runs a launch and reports it in flight until it settles", async () => {
    const gate = new LaunchGate();
    const first = deferredLaunch(true);
    const running = gate.run(first.launch, false);
    expect(gate.busy).toBe(true);
    first.finish();
    expect(await running).toBe(true);
    expect(gate.busy).toBe(false);
  });

  // THE REPORT. The second tap arrives while the first launch is still awaiting
  // something; it must be refused without running anything.
  it("refuses a second launch while the first is in flight, and never runs it", async () => {
    const gate = new LaunchGate();
    const first = deferredLaunch(true);
    let secondRan = 0;
    const running = gate.run(first.launch, false);
    const refused = await gate.run(async () => { secondRan++; return true; }, false);
    expect(refused).toBe(false);
    expect(secondRan).toBe(0);
    first.finish();
    expect(await running).toBe(true);
  });

  it("accepts a launch again once the previous one has settled", async () => {
    const gate = new LaunchGate();
    const first = deferredLaunch(true);
    const running = gate.run(first.launch, false);
    first.finish();
    await running;
    expect(await gate.run(async () => "second", "refused")).toBe("second");
  });

  // A launch that throws (a network failure inside the server gate, say) must not
  // leave the token held, or the player could never invade again without a reload.
  it("releases the token when the launch throws", async () => {
    const gate = new LaunchGate();
    await expect(gate.run(async () => { throw new Error("gate exploded"); }, false)).rejects.toThrow("gate exploded");
    expect(gate.busy).toBe(false);
    expect(await gate.run(async () => true, false)).toBe(true);
  });

  // A launch that answers false (the server said cooldown; the army screen stays up)
  // has finished as far as the gate is concerned: the player may try again.
  it("does not confuse a declined launch with a held token", async () => {
    const gate = new LaunchGate();
    expect(await gate.run(async () => false, false)).toBe(false);
    expect(gate.busy).toBe(false);
  });
});

describe("LaunchGate — a scene build that lands late is stale", () => {
  it("treats the newest stamp as current and every earlier one as stale", () => {
    const gate = new LaunchGate();
    const first = gate.stamp();
    expect(gate.isCurrent(first)).toBe(true);
    const second = gate.stamp();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  // The ghost battle by the other route: a fight ends and a new one launches while
  // the old build is still loading. `raidActive` is true again, so only the stamp
  // can tell the old build it has been superseded.
  it("lets a build decide, when it lands, whether it is still the one wanted", async () => {
    const gate = new LaunchGate();
    const attached: string[] = [];
    const build = (name: string, epoch: number, ready: Promise<void>) =>
      ready.then(() => { if (gate.isCurrent(epoch)) attached.push(name); });

    let landOld!: () => void;
    const oldReady = new Promise<void>((resolve) => { landOld = resolve; });
    const oldBuild = build("old", gate.stamp(), oldReady);
    const newBuild = build("new", gate.stamp(), Promise.resolve());
    await newBuild;
    landOld();
    await oldBuild;

    expect(attached).toEqual(["new"]);
  });
});
