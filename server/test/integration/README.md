# Integration suite

These specs drive a **real `wrangler dev` Worker + local D1** over HTTP (`globalSetup.ts`
boots it once on port 8799). They are the only tests that exercise the Worker as
Cloudflare actually runs it — the unit suite imports modules directly and never boots
workerd.

That difference is not academic. A named export of a non-function from `src/index.ts`
(the Worker entry) makes workerd refuse to start:

```
Incorrect type for map entry 'X': the provided value is not of type 'function or ExportedHandler'
```

The unit suite cannot see that. This suite fails instantly on it.

Run with `npm run test:integration`.

## Which specs run

`vitest.integration.config.ts` uses a **glob**, so a new `*.spec.ts` in this directory
runs the day it is written. Opting out is the thing that has to be spelled out.

It did not always work that way. The config used to name two files explicitly, so 19 of
21 specs silently did not run while CI reported the suite green. Most were legitimately
dead — they drove protocol-v2 routes that now answer 410 — and have been deleted
(`combine`, `farm`, `fertilize`, `objects`, `quests`, `roster`, `shop`,
`stateConsistency`, `zombieField`). But `smoke`, `sessions` and `raidGates` were not
dead: they cover live v3 routes and had gone dark alongside them, with nothing recording
the loss. Both `sessions` and `raidGates` needed real repairs when they were brought
back — the game had moved under them while nothing was running them.

## The retired v2 specs

The four specs that were still excluded after that (`api`, `inventory`, `raidLoot`,
`raidRewards`) have been **deleted** along with the protocol-v2 routes they drove and the
D1 tables those routes read (dropped in migration `0020_protocol_v3_reset.sql`). Before
deleting, the assertions that were unique to the live surface were ported:

| Was in | Now in | What it proves |
| --- | --- | --- |
| `api.spec.ts` | `sessions.spec.ts` | `/logout` and `/session/logout-all` really revoke (a revoked token gets 401 on `/me`). |
| `api.spec.ts` | `v3.spec.ts` | `/friends/block` tears the edge down both ways, refuses the blocked side's gift, and swallows its re-add. |
| `raidRewards.spec.ts` | `raidGates.spec.ts` | the finish gates (paced past real time, body-asserted win paying nothing, duplicate finish replaying the stored result). |

Still asserted nowhere at the route level, as before: the raid **payout curve** and
**boost consumption** across `/raid/start` → `/raid/finish` (`v3.spec.ts` settles raids
without checking the numbers; the unit suites cover the catalogs). `/raid/checkpoint` is
no longer a gap — it was a v2 route and now answers `410` like the rest.

## Conventions

- **Isolate by account, not by database.** One Worker and one D1 are shared for the whole
  run, so every spec gets fresh accounts via `signIn(uniqueSub("prefix"))`. Never reuse a
  `devSub` across tests.
- **Only one session per account may hold the writer lease.** A second device must use
  `signIn(sub, false)`, or its acquire is refused with 423.
- **`grantRoster` files units in the Mausoleum by default.** Pass `stored: false` for a
  zombie that needs to be deployable, or `/raid/start` answers `unit_not_owned`.
- **Read a fresh `/bootstrap` before every `/commands` batch.** The envelope is fenced on
  `accountVersion`; a stale one is refused, not applied.
