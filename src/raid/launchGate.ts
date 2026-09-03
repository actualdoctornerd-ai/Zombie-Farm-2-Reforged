/** One battle launch at a time, decided synchronously.
 *
 *  A launch is a long async stretch — the server gate, Tim's tips awaiting a tap,
 *  the scene build — and `raidActive` is only set near its END, so for most of that
 *  time nothing in the session said "a launch is happening". The army screen's own
 *  disabled Fight button was the whole guard, and its `refresh()` re-derived that
 *  flag from the selection count on every card tap: deselect a zombie, reselect it,
 *  and the button was live again mid-launch. A second tap then ran the launch path
 *  a second time — dropping the fence on the live server session on its way in, and
 *  offline building a second RaidScene on top of the first, of which only the last
 *  one ticked. That was the "two battles, one unresponsive" report.
 *
 *  Two things here, both cheap:
 *
 *  - The TOKEN: `run` claims it before its first `await` and releases it in
 *    `finally`, so a second launch that arrives while the first is anywhere in that
 *    stretch is refused at the door without touching any state. It is refused, not
 *    queued — the player already has the launch they asked for.
 *  - The EPOCH: every scene build stamps itself, and a build that lands after a
 *    newer one was stamped is torn down instead of attached. `raidActive` alone
 *    cannot tell "this build's fight" from "a later fight that happens to be
 *    active", and a stale scene attached under a live one is exactly the ghost
 *    battle again, by another route (a fight that ended and a new one launched while
 *    the old build was still loading). */
export class LaunchGate {
  private inFlight = false;
  private epoch = 0;

  /** Whether a launch is between its first tap and its scene build starting. */
  get busy(): boolean {
    return this.inFlight;
  }

  /** Run `launch` if no launch is in flight; otherwise answer `refused` at once.
   *  The token is released whether `launch` returns or throws. */
  async run<T>(launch: () => Promise<T>, refused: T): Promise<T> {
    if (this.inFlight) return refused;
    this.inFlight = true;
    try {
      return await launch();
    } finally {
      this.inFlight = false;
    }
  }

  /** Mark the start of a scene build. Keep the number and ask `isCurrent` when the
   *  build lands. */
  stamp(): number {
    return ++this.epoch;
  }

  /** Whether no newer build has been stamped since `epoch`. */
  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }
}
