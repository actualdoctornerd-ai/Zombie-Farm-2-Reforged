// Minimal declarations for the Node builtins used by migration0044.test.ts.
//
// tsconfig.json pins `types: ["@cloudflare/workers-types"]` on purpose: the Worker has
// no Node runtime, and leaving @types/node out is what stops `fs`/`path` being imported
// into src/ by accident. That's worth keeping — so the one test that genuinely runs
// under Node (it rehearses a migration against a real SQLite database) declares exactly
// the surface it uses here, rather than opening the whole Node API to the project.
//
// Only widen this if another Node-hosted test needs it.

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      /** Widened for migration0049.test.ts, which binds a JSON board into an UPDATE
       *  rather than inlining it into an exec() string. */
      run(...params: unknown[]): { changes: number };
      /** Widened for accountDeletion.test.ts, which reads the schema's whole
       *  foreign-key list back in one query to hold the purge list to it. */
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  /** Widened for spentFightConfig.test.ts, which reads the v3 sources back to assert a
   *  rule about the SQL in them rather than about any one code path's behaviour. */
  export function readdirSync(path: string): string[];
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
