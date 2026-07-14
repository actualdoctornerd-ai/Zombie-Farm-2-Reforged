// Helpers for the integration suite. These drive the real `wrangler dev` Worker
// (booted by globalSetup) over HTTP. Tests isolate by using UNIQUE account ids —
// the database is shared across the run, so never reuse a devSub between tests.
const BASE = process.env.IT_BASE ?? "http://127.0.0.1:8799";

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
  body?: unknown
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
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

/** Dev sign-in (DEV_AUTH=1 in .dev.vars): a fresh isolated account. */
export async function signIn(devSub = uniqueSub()): Promise<Session> {
  const r = await call<Session>("POST", "/auth", undefined, { devSub });
  if (r.status !== 200) throw new Error(`auth failed: ${r.status}`);
  return r.body;
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
