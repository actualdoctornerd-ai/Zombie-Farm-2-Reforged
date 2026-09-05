// Helpers for the integration suite. These drive the real `wrangler dev` Worker
// (booted by globalSetup) over HTTP. Tests isolate by using UNIQUE account ids —
// the database is shared across the run, so never reuse a devSub between tests.
import { CLIENT_INTEGRITY_VERSION } from "../../../src/net/protocol";

const BASE = process.env.IT_BASE ?? "http://127.0.0.1:8799";
const writerByToken = new Map<string, { clientId: string; generation: number; token: string }>();
export const currentIntegrityHeaders = {
  "x-integrity-version": String(CLIENT_INTEGRITY_VERSION),
};

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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...currentIntegrityHeaders,
  };
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

/** Bury zombies so a scenario can exercise memorials without staging a raid that
 *  actually kills someone. */
export async function grantFallen(
  s: Session,
  units: { id: string; key: string; name?: string; mutation?: number; invasions?: number; diedAt?: number }[]
): Promise<void> {
  const r = await call<{ count: number }>("POST", "/dev/fixture/fallen", s.token, { units });
  if (r.status !== 200 || r.body.count < units.length) {
    throw new Error(`fallen fixture failed: ${r.status}`);
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

/** Put an account at `level` without touching its gold or brains — unlike
 *  `grantBalance`, which rewrites the whole balances row. Use this for a level FLOOR a
 *  feature enforces (the Black Market's, for one) so it survives later balance grants. */
export async function grantLevel(s: Session, level: number): Promise<void> {
  const r = await call("POST", "/dev/fixture/level", s.token, { level });
  if (r.status !== 200) throw new Error(`level fixture failed: ${r.status}`);
}

/** Make two accounts friends (request + accept). */
export async function befriend(a: Session, b: Session): Promise<void> {
  await call("POST", "/friends/add", a.token, { code: b.friendCode });
  await call("POST", "/friends/accept", b.token, { fromAccountId: a.accountId });
}

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

export const DEVICE_A = "device-aaaaaaaa";

/** A POST /commands envelope fenced against a bootstrap the caller just read.
 *
 *  Lives here rather than inside one spec because it is the v3 idiom every mutation
 *  goes through: a spec ported off the retired v2 action routes needs this and nothing
 *  else. Read a fresh /bootstrap first — the CAS is on `accountVersion`, so a stale one
 *  is refused rather than applied. */
export const commandBody = (
  bootstrap: { accountVersion: number; writerGeneration: number },
  batchId: string,
  firstSequence: number,
  commands: unknown[],
  deviceId = DEVICE_A,
  takeWriter = false
) => ({
  protocolVersion: 3,
  deviceId,
  batchId,
  firstSequence,
  expectedAccountVersion: bootstrap.accountVersion,
  writerGeneration: bootstrap.writerGeneration,
  takeWriter,
  commands: commands.map((command, index) => ({ sequence: firstSequence + index, command })),
});
