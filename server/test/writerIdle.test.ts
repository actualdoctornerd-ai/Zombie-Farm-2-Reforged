import { describe, expect, it } from "vitest";
import { WRITER_IDLE_MS, acquire, projection } from "../src/v3/writer";

// The lease row as the server reads it. Overrides describe the scenario under test.
interface RuntimeRow {
  account_version: number;
  writer_device_id: string | null;
  writer_session_id: string | null;
  writer_token_hash: string | null;
  writer_generation: number;
  writer_last_activity_at: number;
  active_batch_id: string | null;
  active_batch_expires_at: number;
}

class Statement {
  args: unknown[] = [];
  constructor(readonly sql: string, private readonly fake: Fake) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    this.fake.calls.push(this);
    return (this.sql.startsWith("SELECT") ? this.fake.row : null) as T;
  }
  async run() {
    this.fake.calls.push(this);
    return { meta: { changes: this.fake.changes } };
  }
}

interface Fake {
  row: RuntimeRow;
  calls: Statement[];
  changes: number;
}

const fakeDb = (row: Partial<RuntimeRow>, changes = 1) => {
  const fake: Fake = {
    row: {
      account_version: 7,
      writer_device_id: null,
      writer_session_id: null,
      writer_token_hash: null,
      writer_generation: 3,
      writer_last_activity_at: 0,
      active_batch_id: null,
      active_batch_expires_at: 0,
      ...row,
    },
    calls: [],
    changes,
  };
  const db = {
    prepare(sql: string) { return new Statement(sql, fake); },
    async batch(statements: Statement[]) {
      fake.calls.push(...statements);
      return statements.map(() => ({ meta: { changes: fake.changes } }));
    },
  };
  return {
    db: db as unknown as D1Database,
    calls: fake.calls,
    sql: () => fake.calls.map((c) => c.sql),
  };
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const NOW = 1_000_000_000;
const TOKEN = "t".repeat(48);
const MINE = { clientId: "client-mine", sessionId: "session-mine" };

/** A lease held by MINE, idle for `idleMs`. */
const heldByMe = async (idleMs: number): Promise<Partial<RuntimeRow>> => ({
  writer_device_id: MINE.clientId,
  writer_session_id: MINE.sessionId,
  writer_token_hash: await sha256(TOKEN),
  writer_generation: 3,
  writer_last_activity_at: NOW - idleMs,
});

/** A lease held by some other client, idle for `idleMs`. */
const heldByOther = async (idleMs: number): Promise<Partial<RuntimeRow>> => ({
  writer_device_id: "client-other",
  writer_session_id: "session-other",
  writer_token_hash: await sha256("other-token"),
  writer_generation: 3,
  writer_last_activity_at: NOW - idleMs,
});

const credential = { clientId: MINE.clientId, generation: 3, token: TOKEN };

describe("writer lease idle expiry", () => {
  it("keeps an AFK holder's lease long past the idle window", async () => {
    // The regression this guards: if staleness were checked before ownership, the
    // client's 5s poll would see status !== "mine" and raise the takeover gate on a
    // player who simply walked away.
    const { db } = fakeDb(await heldByMe(3 * 60 * 60_000));
    const result = await projection(db, "account", MINE.sessionId, credential, NOW);
    expect(result.status).toBe("mine");
  });

  it("refreshes the lease from the holder's ownership poll", async () => {
    const { db, sql } = fakeDb(await heldByMe(5 * 60_000));
    const result = await projection(db, "account", MINE.sessionId, credential, NOW);
    expect(sql()).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE account_runtime_v3 SET writer_last_activity_at"),
    ]));
    expect(result.lastActivityAt).toBe(NOW);
  });

  it("throttles the heartbeat to one write per minute", async () => {
    const { db, sql } = fakeDb(await heldByMe(5_000));
    const result = await projection(db, "account", MINE.sessionId, credential, NOW);
    expect(result.status).toBe("mine");
    expect(sql().some((s) => s.startsWith("UPDATE"))).toBe(false);
    expect(result.lastActivityAt).toBe(NOW - 5_000);
  });

  it("reports a stale lease as free to other clients", async () => {
    const { db } = fakeDb(await heldByOther(WRITER_IDLE_MS + 60_000));
    expect((await projection(db, "account", "session-new", null, NOW)).status).toBe("free");
  });

  it("still reports a live lease as held by someone else", async () => {
    const { db } = fakeDb(await heldByOther(30_000));
    expect((await projection(db, "account", "session-new", null, NOW)).status).toBe("other");
  });

  it("lets a new client claim a stale lease without a takeover", async () => {
    const { db } = fakeDb(await heldByOther(WRITER_IDLE_MS + 60_000));
    const result = await acquire(db, "account", "session-new", {
      clientId: "client-new", token: TOKEN, observedGeneration: 3, takeover: false,
    }, NOW);
    expect(result).toMatchObject({ status: 200, generation: 4 });
  });

  it("still gates a live lease behind the takeover prompt", async () => {
    const { db } = fakeDb(await heldByOther(30_000));
    const result = await acquire(db, "account", "session-new", {
      clientId: "client-new", token: TOKEN, observedGeneration: 3, takeover: false,
    }, NOW);
    expect(result).toMatchObject({ status: 423, error: "writer_active" });
  });

  it("does not sign out the displaced device when claiming an idle lease", async () => {
    // An idle claim is automatic. Revoking the other session would kick a player who
    // only backgrounded a tab; the generation bump alone tells them they lost it.
    const { db, sql } = fakeDb(await heldByOther(WRITER_IDLE_MS + 60_000));
    await acquire(db, "account", "session-new", {
      clientId: "client-new", token: TOKEN, observedGeneration: 3, takeover: false,
    }, NOW);
    expect(sql().some((s) => s.includes("UPDATE sessions SET revoked_at"))).toBe(false);
  });

  it("still signs out the displaced device on a deliberate takeover", async () => {
    const { db, sql } = fakeDb(await heldByOther(30_000));
    await acquire(db, "account", "session-new", {
      clientId: "client-new", token: TOKEN, observedGeneration: 3, takeover: true,
    }, NOW);
    expect(sql()).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE sessions SET revoked_at"),
    ]));
  });

  it("refuses to claim an idle lease with a write still in flight", async () => {
    const { db } = fakeDb({
      ...(await heldByOther(WRITER_IDLE_MS + 60_000)),
      active_batch_id: "batch-live",
      active_batch_expires_at: NOW + 30_000,
    });
    const result = await acquire(db, "account", "session-new", {
      clientId: "client-new", token: TOKEN, observedGeneration: 3, takeover: false,
    }, NOW);
    expect(result).toMatchObject({ status: 409, error: "operation_in_progress" });
  });
});
