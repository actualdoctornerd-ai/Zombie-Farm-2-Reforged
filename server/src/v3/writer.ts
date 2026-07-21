export interface WriterCredential {
  clientId: string;
  generation: number;
  token: string;
}

export interface WriterProjection {
  status: "free" | "mine" | "other";
  generation: number;
  lastActivityAt: number;
}

interface RuntimeWriterRow {
  account_version: number;
  writer_device_id: string | null;
  writer_session_id: string | null;
  writer_token_hash: string | null;
  writer_generation: number;
  writer_last_activity_at: number;
  active_batch_id: string | null;
  active_batch_expires_at: number;
}

const OPERATION_TTL_MS = 120_000;

/** How long a lease survives with no live document behind it. This is NOT "time
 *  since the player last acted": a visible tab refreshes the lease every few
 *  seconds via GET /writer/status, so an AFK player keeps their lease indefinitely.
 *  It elapses only when the tab is closed, crashed, force-quit, or backgrounded --
 *  and even then the lease is merely CLAIMABLE, never revoked. A holder whose lease
 *  nobody took keeps writing without interruption. */
export const WRITER_IDLE_MS = 600_000;

/** The ownership poll runs every 5s while visible; persisting that would be ~720
 *  writes per player-hour for no benefit. One write per minute keeps a lease far
 *  from the idle threshold at a twelfth of the cost. */
const HEARTBEAT_MIN_INTERVAL_MS = 60_000;

const isHeld = (row: RuntimeWriterRow): boolean =>
  !!row.writer_device_id && !!row.writer_token_hash && !!row.writer_session_id;

/** Evaluated lazily at read time rather than swept by a cron: D1 has no TTL, and a
 *  sweeper would be more moving parts for an identical result. */
const isIdle = (row: RuntimeWriterRow, now: number): boolean =>
  now - (row.writer_last_activity_at ?? 0) > WRITER_IDLE_MS;

/** Refresh the holder's lease from its ownership poll. The WHERE clause repeats the
 *  full ownership fence so a takeover landing between the read and this write can
 *  never be papered over by a heartbeat. Returns the effective activity timestamp. */
const heartbeat = async (
  db: D1Database,
  accountId: string,
  sessionId: string,
  row: RuntimeWriterRow,
  credential: WriterCredential,
  now: number
): Promise<number> => {
  const last = row.writer_last_activity_at ?? 0;
  if (now - last < HEARTBEAT_MIN_INTERVAL_MS) return last;
  const result = await db.prepare(`UPDATE account_runtime_v3 SET writer_last_activity_at=?,updated_at=?
    WHERE account_id=? AND writer_device_id=? AND writer_session_id=? AND writer_generation=?`)
    .bind(now, now, accountId, credential.clientId, sessionId, credential.generation).run();
  return (result.meta.changes ?? 0) === 1 ? now : last;
};

const tokenHash = async (token: string): Promise<string> => {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
};

const ensureRuntime = async (db: D1Database, accountId: string, now: number): Promise<void> => {
  await db.prepare(`INSERT OR IGNORE INTO account_runtime_v3
    (account_id,command_window_start,command_window_count,updated_at) VALUES(?,0,0,?)`)
    .bind(accountId, now).run();
};

const readRuntime = async (db: D1Database, accountId: string, now: number): Promise<RuntimeWriterRow> => {
  await ensureRuntime(db, accountId, now);
  return (await db.prepare("SELECT * FROM account_runtime_v3 WHERE account_id=?")
    .bind(accountId).first<RuntimeWriterRow>())!;
};

const matches = async (
  row: RuntimeWriterRow,
  sessionId: string,
  credential: WriterCredential | null
): Promise<boolean> => !!credential && row.writer_device_id === credential.clientId &&
  row.writer_session_id === sessionId && row.writer_generation === credential.generation &&
  row.writer_token_hash === await tokenHash(credential.token);

export async function projection(
  db: D1Database,
  accountId: string,
  sessionId: string,
  credential: WriterCredential | null,
  now: number
): Promise<WriterProjection> {
  const row = await readRuntime(db, accountId, now);
  // Ownership is resolved BEFORE staleness, and deliberately so. Reporting a stale
  // but unclaimed lease as "free" to its own holder would make the client's 5s
  // ownership poll see status !== "mine", trip handleWriterLost, and raise the very
  // takeover gate idle expiry exists to prevent. Staleness is a statement about what
  // OTHER clients may claim; it never invalidates the holder.
  if (isHeld(row) && await matches(row, sessionId, credential)) {
    return {
      status: "mine",
      generation: row.writer_generation,
      lastActivityAt: await heartbeat(db, accountId, sessionId, row, credential!, now),
    };
  }
  return {
    status: !isHeld(row) || isIdle(row, now) ? "free" : "other",
    generation: row.writer_generation,
    lastActivityAt: row.writer_last_activity_at,
  };
}

export async function acquire(
  db: D1Database,
  accountId: string,
  sessionId: string,
  body: { clientId: string; token: string; observedGeneration: number; takeover: boolean },
  now: number
): Promise<{ status: 200; generation: number; accountVersion: number } |
  { status: 409 | 423; error: string; generation: number }> {
  const row = await readRuntime(db, accountId, now);
  const hash = await tokenHash(body.token);
  if (row.writer_device_id === body.clientId && row.writer_session_id === sessionId &&
      row.writer_token_hash === hash) {
    return { status: 200, generation: row.writer_generation, accountVersion: row.account_version };
  }
  // Recovery after a reload may present the same session/client with a freshly
  // generated token. Rotate it without a takeover or generation bump. The CAS and
  // active-operation guard prevent recovery from cutting through an in-flight write.
  if (row.writer_device_id === body.clientId && row.writer_session_id === sessionId) {
    if (body.observedGeneration !== row.writer_generation) {
      return { status: 409, error: "writer_changed", generation: row.writer_generation };
    }
    if (row.active_batch_id && row.active_batch_expires_at > now) {
      return { status: 409, error: "operation_in_progress", generation: row.writer_generation };
    }
    const recovered = await db.prepare(`UPDATE account_runtime_v3 SET
        writer_token_hash=?,writer_last_activity_at=?,updated_at=?
      WHERE account_id=? AND writer_device_id=? AND writer_session_id=?
        AND writer_generation=? AND writer_token_hash=?
        AND (active_batch_id IS NULL OR active_batch_expires_at<=?)`)
      .bind(hash, now, now, accountId, body.clientId, sessionId,
        row.writer_generation, row.writer_token_hash, now).run();
    if ((recovered.meta.changes ?? 0) !== 1) {
      const current = await readRuntime(db, accountId, now);
      return { status: 409, error: "writer_changed", generation: current.writer_generation };
    }
    return { status: 200, generation: row.writer_generation, accountVersion: row.account_version };
  }
  // An idle lease has no live document behind it, so a new client may claim it
  // without the takeover gate. This is the only path that recovers a lease stranded
  // by a crash or force-quit on a DIFFERENT browser or device; the same browser is
  // already covered by its stable clientId hitting the recovery branch above.
  const held = isHeld(row);
  const claimable = !held || isIdle(row, now);
  if (!claimable && !body.takeover) return { status: 423, error: "writer_active", generation: row.writer_generation };
  if (body.observedGeneration !== row.writer_generation) {
    return { status: 409, error: "writer_changed", generation: row.writer_generation };
  }
  if (row.active_batch_id && row.active_batch_expires_at > now) {
    return { status: 409, error: "operation_in_progress", generation: row.writer_generation };
  }
  const updateWriter = db.prepare(`UPDATE account_runtime_v3 SET
      writer_device_id=?,writer_session_id=?,writer_token_hash=?,
      writer_generation=writer_generation+1,writer_last_activity_at=?,
      account_version=account_version+1,active_batch_id=NULL,active_batch_expires_at=0,updated_at=?
    WHERE account_id=? AND writer_generation=? AND account_version=?
      AND (active_batch_id IS NULL OR active_batch_expires_at<=?)`)
    .bind(body.clientId, sessionId, hash, now, now, accountId, row.writer_generation,
      row.account_version, now);
  const replacedSessionId = held && body.takeover && row.writer_session_id !== sessionId
    ? row.writer_session_id
    : null;
  // A takeover is also a session handoff: revoke the displaced login in the same
  // transaction as the writer CAS. The EXISTS guard means a failed/stale CAS can
  // never sign out the old session by itself.
  //
  // Gated on body.takeover, never on `claimable`: an idle claim is automatic, so
  // signing the other device out for it would kick a player who merely backgrounded
  // a tab. An idle claim still bumps the generation, so the displaced holder learns
  // it lost the lease via writer_replaced and can take it back -- while staying
  // signed in. Only the deliberate "Take over here" button revokes a session.
  const statements = [updateWriter];
  if (replacedSessionId) {
    statements.push(db.prepare(`UPDATE sessions SET revoked_at=?
      WHERE id=? AND account_id=? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM account_runtime_v3
          WHERE account_id=? AND writer_session_id=? AND writer_generation=?)`)
      .bind(now, replacedSessionId, accountId, accountId, sessionId, row.writer_generation + 1));
  }
  const [updated] = await db.batch(statements);
  if ((updated.meta.changes ?? 0) !== 1) {
    const current = await readRuntime(db, accountId, now);
    return { status: 409, error: "writer_changed", generation: current.writer_generation };
  }
  return { status: 200, generation: row.writer_generation + 1, accountVersion: row.account_version + 1 };
}

export async function validate(
  db: D1Database,
  accountId: string,
  sessionId: string,
  credential: WriterCredential | null,
  now: number
): Promise<boolean> {
  if (!credential) return false;
  const hash = await tokenHash(credential.token);
  const result = await db.prepare(`UPDATE account_runtime_v3 SET writer_last_activity_at=?,updated_at=?
    WHERE account_id=? AND writer_device_id=? AND writer_session_id=?
      AND writer_generation=? AND writer_token_hash=?`)
    .bind(now, now, accountId, credential.clientId, sessionId, credential.generation, hash).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function beginOperation(
  db: D1Database,
  accountId: string,
  sessionId: string,
  credential: WriterCredential | null,
  operationId: string,
  now: number
): Promise<"ok" | "writer_replaced" | "operation_in_progress"> {
  if (!credential) return "writer_replaced";
  const hash = await tokenHash(credential.token);
  const result = await db.prepare(`UPDATE account_runtime_v3 SET
      active_batch_id=?,active_batch_expires_at=?,writer_last_activity_at=?,updated_at=?
    WHERE account_id=? AND writer_device_id=? AND writer_session_id=?
      AND writer_generation=? AND writer_token_hash=?
      AND (active_batch_id IS NULL OR active_batch_expires_at<=?)`)
    .bind(operationId, now + OPERATION_TTL_MS, now, now, accountId, credential.clientId,
      sessionId, credential.generation, hash, now).run();
  if ((result.meta.changes ?? 0) === 1) return "ok";
  return await projection(db, accountId, sessionId, credential, now).then((value) =>
    value.status === "mine" ? "operation_in_progress" : "writer_replaced");
}

export async function endOperation(
  db: D1Database,
  accountId: string,
  operationId: string,
  now: number
): Promise<void> {
  await db.prepare(`UPDATE account_runtime_v3 SET active_batch_id=NULL,active_batch_expires_at=0,updated_at=?
    WHERE account_id=? AND active_batch_id=?`).bind(now, accountId, operationId).run();
}

export async function release(
  db: D1Database,
  accountId: string,
  sessionId: string,
  credential: WriterCredential | null,
  now: number
): Promise<boolean> {
  if (!credential) return false;
  const hash = await tokenHash(credential.token);
  const result = await db.prepare(`UPDATE account_runtime_v3 SET
      writer_device_id=NULL,writer_session_id=NULL,writer_token_hash=NULL,
      writer_last_activity_at=?,account_version=account_version+1,updated_at=?
    WHERE account_id=? AND writer_device_id=? AND writer_session_id=?
      AND writer_generation=? AND writer_token_hash=? AND active_batch_id IS NULL`)
    .bind(now, now, accountId, credential.clientId, sessionId, credential.generation, hash).run();
  return (result.meta.changes ?? 0) === 1;
}
