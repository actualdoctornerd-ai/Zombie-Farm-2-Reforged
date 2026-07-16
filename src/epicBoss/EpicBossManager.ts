import { epicBossHp, epicBossRetrySkipCost } from "./catalog";
import type { EpicBossAttemptResult, EpicBossDef, EpicBossRun } from "./types";

export type EpicBossGate =
  | { ok: true; run: EpicBossRun }
  | { ok: false; error: "inactive" | "expired" | "completed" | "cooldown"; remainingMs?: number };

const copy = (run: EpicBossRun): EpicBossRun => ({ ...run, attackOrder: [...run.attackOrder] });

export class EpicBossManager {
  constructor(readonly def: EpicBossDef, private now: () => number = () => Date.now()) {}

  activate(runId: string, attackOrder: string[] = []): EpicBossRun {
    const now = this.now();
    const maxHp = epicBossHp(this.def, 1);
    return {
      runId, bossId: this.def.id, activatedAt: now, expiresAt: now + this.def.durationMs,
      level: 1, maxHp, currentHp: maxHp, encounterStartedAt: 0, retryReadyAt: 0,
      completedAt: 0, attackOrder: [...attackOrder],
    };
  }

  /** Apply wall-clock expiry/reset rules without mutating the stored object. */
  normalize(value: EpicBossRun | null | undefined): EpicBossRun | null {
    if (!value || value.bossId !== this.def.id) return null;
    const run = copy(value);
    if (run.completedAt || this.now() >= run.expiresAt) return run;
    if (run.encounterStartedAt && this.now() >= run.encounterStartedAt + this.def.encounterMs) {
      run.maxHp = epicBossHp(this.def, run.level);
      run.currentHp = run.maxHp;
      run.encounterStartedAt = 0;
      run.retryReadyAt = 0;
    }
    return run;
  }

  isActive(value: EpicBossRun | null | undefined): boolean {
    const run = this.normalize(value);
    return !!run && !run.completedAt && this.now() < run.expiresAt;
  }

  retrySkipCost(value: EpicBossRun | null | undefined): number {
    const run = this.normalize(value);
    return run ? epicBossRetrySkipCost(run.retryReadyAt - this.now()) : 0;
  }

  /** Clear a live retry cooldown without touching currency; the caller owns payment. */
  skipRetry(value: EpicBossRun | null | undefined): EpicBossRun | null {
    const run = this.normalize(value);
    if (!run || run.completedAt || this.now() >= run.expiresAt || this.retrySkipCost(run) <= 0) return null;
    run.retryReadyAt = 0;
    return run;
  }

  /** End an active event early without treating it as a completed run. */
  end(value: EpicBossRun | null | undefined): EpicBossRun | null {
    const run = this.normalize(value);
    if (!run || run.completedAt || this.now() >= run.expiresAt) return null;
    run.expiresAt = this.now();
    run.encounterStartedAt = 0;
    run.retryReadyAt = 0;
    return run;
  }

  start(value: EpicBossRun | null | undefined, attackOrder: string[]): EpicBossGate {
    const run = this.normalize(value);
    if (!run) return { ok: false, error: "inactive" };
    if (run.completedAt) return { ok: false, error: "completed" };
    if (this.now() >= run.expiresAt) return { ok: false, error: "expired" };
    if (this.now() < run.retryReadyAt) {
      return { ok: false, error: "cooldown", remainingMs: run.retryReadyAt - this.now() };
    }
    if (!run.encounterStartedAt) run.encounterStartedAt = this.now();
    run.attackOrder = [...attackOrder];
    return { ok: true, run };
  }

  finish(value: EpicBossRun, playerDamage: number, bossDefeated: boolean): EpicBossAttemptResult {
    const run = copy(value);
    const defeatedLevel = bossDefeated || playerDamage >= run.currentHp ? run.level : null;
    if (defeatedLevel !== null) {
      run.currentHp = 0;
      run.retryReadyAt = 0;
      run.encounterStartedAt = 0;
      if (run.level >= this.def.maxLevel) {
        run.completedAt = this.now();
        return { run, defeatedLevel, completed: true, escaped: false };
      }
      run.level++;
      run.maxHp = epicBossHp(this.def, run.level);
      run.currentHp = run.maxHp;
      return { run, defeatedLevel, completed: false, escaped: false };
    }
    run.currentHp = Math.max(1, run.currentHp - Math.max(0, Math.round(playerDamage)));
    run.retryReadyAt = this.now() + this.def.retryMs;
    return { run, defeatedLevel: null, completed: false, escaped: true };
  }
}
