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
  const free = !row.writer_device_id || !row.writer_token_hash || !row.writer_session_id;
  return {
    status: free ? "free" : await matches(row, sessionId, credential) ? "mine" : "other",
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
  const free = !row.writer_device_id || !row.writer_token_hash || !row.writer_session_id;
  if (!free && !body.takeover) return { status: 423, error: "writer_active", generation: row.writer_generation };
  if (body.observedGeneration !== row.writer_generation) {
    return { status: 409, error: "writer_changed", generation: row.writer_generation };
  }
  if (row.active_batch_id && row.active_batch_expires_at > now) {
    return { status: 409, error: "operation_in_progress", generation: row.writer_generation };
  }
  const updated = await db.prepare(`UPDATE account_runtime_v3 SET
      writer_device_id=?,writer_session_id=?,writer_token_hash=?,
      writer_generation=writer_generation+1,writer_last_activity_at=?,
      account_version=account_version+1,active_batch_id=NULL,active_batch_expires_at=0,updated_at=?
    WHERE account_id=? AND writer_generation=? AND account_version=?
      AND (active_batch_id IS NULL OR active_batch_expires_at<=?)`)
    .bind(body.clientId, sessionId, hash, now, now, accountId, row.writer_generation,
      row.account_version, now).run();
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
