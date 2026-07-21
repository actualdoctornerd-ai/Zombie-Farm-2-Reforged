// Helpers for the integration suite. These drive the real `wrangler dev` Worker
// (booted by globalSetup) over HTTP. Tests isolate by using UNIQUE account ids —
// the database is shared across the run, so never reuse a devSub between tests.
const BASE = process.env.IT_BASE ?? "http://127.0.0.1:8799";
const writerByToken = new Map<string, { clientId: string; generation: number; token: string }>();

let counter = 0;
/** A unique devSub so each signed-in account is isolated from other tests. */
export function uniqueSub(prefix = "u"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.floor(Math.random() * 1e9)}`;
}

export interface Session {
  token: string;
  accountId: string;
  friendCode: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-integrity-version": "4" };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
    const writer = writerByToken.get(token);
    if (writer) {
      headers["x-writer-client"] = writer.clientId;
      headers["x-writer-generation"] = String(writer.generation);
      headers["x-writer-token"] = writer.token;
    }
  }
  Object.assign(headers, extraHeaders);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

/** Dev sign-in (DEV_AUTH=1 in the integration harness): a fresh isolated account. */
export async function signIn(devSub = uniqueSub(), acquireWriter = true): Promise<Session> {
  const r = await call<Session>("POST", "/auth", undefined, { devSub });
  if (r.status !== 200) throw new Error(`auth failed: ${r.status} ${JSON.stringify(r.body)}`);
  if (acquireWriter) {
    const boot = await call<any>("POST", "/bootstrap", r.body.token, {});
    const clientId = "device-aaaaaaaa";
    const token = `${uniqueSub("writer")}-${"x".repeat(40)}`;
    const acquired = await call<any>("POST", "/writer/acquire", r.body.token, {
      clientId, token, observedGeneration: boot.body.writer.generation, takeover: false,
    });
    if (acquired.status !== 200) throw new Error(`writer acquire failed: ${acquired.status}`);
    writerByToken.set(r.body.token, { clientId, token, generation: acquired.body.writerGeneration });
  }
  return r.body;
}

/** Establish trusted roster state through the DEV_AUTH-only fixture route. */
export async function grantRoster(
  s: Session,
  units: { id: string; key: string; mutation?: number; invasions?: number; stored?: boolean }[]
): Promise<void> {
  const r = await call<{ count: number }>("POST", "/dev/fixture/roster", s.token, { units });
  if (r.status !== 200 || r.body.count < units.length) {
    throw new Error(`roster fixture failed: ${r.status}`);
  }
}

/** Establish an explicit economy balance for a scenario that tests paid actions. */
export async function grantBalance(
  s: Session,
  balance: { gold?: number; brains?: number; xp?: number }
): Promise<void> {
  const r = await call("POST", "/dev/fixture/balance", s.token, balance);
  if (r.status !== 200) throw new Error(`balance fixture failed: ${r.status}`);
}

/** A minimal valid save blob (passes validateSave) with the given currency. */
export function makeSave(gold = 200, brains = 15, xp = 0) {
  return {
    version: 1,
    savedAt: 1_700_000_000_000,
    player: { name: "IT", gold, brains, xp, zombieMax: 16, zombieCount: 1 },
    farm: { fieldId: "default", w: 20, h: 20, plots: [] },
  };
}

/** Make two accounts friends (request + accept). */
export async function befriend(a: Session, b: Session): Promise<void> {
  await call("POST", "/friends/add", a.token, { code: b.friendCode });
  await call("POST", "/friends/accept", b.token, { fromAccountId: a.accountId });
}

/** Gold a single plow costs (mirrors farm.ts PLOW_COST) — the tests' balance math. */
export const PLOW = 10;

/** XP that puts an account at `level`, for seeding past Phase E's level gates. Mirrors
 *  levels.ts XP_THRESHOLDS; level 45 is the cap. Seeding xp at account creation does NOT
 *  pay level-up brains: getOrSeedBalance stamps claimed_level from the seeded xp, which is
 *  the sentinel that stops a migrating account collecting a retroactive windfall. */
export function xpForLevel(level: number): number {
  const T = [
    0, 25, 75, 150, 250, 375, 550, 800, 1300, 1800, 2300, 2800, 3300, 3900, 4500,
    5500, 6500, 7500, 8500, 9500, 11500, 13500, 15500, 17500, 20500, 25000, 30000,
    35000, 40000, 46000, 53000, 61000, 69000, 78000, 87000, 97000, 107000, 117000,
    127000, 137000, 151000, 165000, 179000, 193000, 218000,
  ];
  return T[Math.min(Math.max(level, 1), T.length) - 1];
}

/** Import plots as already-PLOWED via the one-time /farm/sync migration path, so a test
 *  can plant without paying (and doing the bookkeeping for) a plow first. This is the
 *  seed-from-save door, so it only works ONCE per account and only pre-cutoff — which is
 *  exactly what the integration env is. Use `plowPaid` when the plow itself is under test. */
export async function seedPlowed(s: Session, plots: { oc: number; or: number }[]): Promise<void> {
  await call("POST", "/farm/sync", s.token, { plowed: plots });
}

/** Plow a plot for real, through the server (costs PLOW gold, grants 1 xp). */
export async function plowPaid(s: Session, oc: number, or: number): Promise<void> {
  await call("POST", "/farm/actions", s.token, {
    actions: [{ id: `plow-${uniqueSub()}`, type: "plow", oc, or }],
  });
}
