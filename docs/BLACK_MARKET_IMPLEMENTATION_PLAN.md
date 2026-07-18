# Black Market implementation plan

## Objective

Add an asynchronous, account-backed Black Market where players can either sell an
owned zombie for brains or escrow brains in exchange for a requested zombie. The
feature must remain safe when either party is offline, prevent duplicated assets under
concurrent requests, and reconcile cleanly with protocol v3's authoritative balances,
roster, writer lease, and account version.

The right-side navigation will be simplified at the same time:

- Remove the standalone Boss button. Epic Bosses will move into the raid UI.
- Replace the standalone Friends button with a Social button.
- Social opens a small hub containing Friends and Black Market destinations.
- Friends retains its current panel and refresh behavior.
- Black Market opens a full-page screen comparable to the existing Market.

## Production release gate

Black Market development may proceed behind a server-controlled feature flag, but it
must not be enabled in production while the protocol v3 security restriction in
`PROTOCOL_V3_ROLLOUT.md` remains in effect. Trading makes existing balance, roster, and
cross-route race vulnerabilities economically transferable between accounts.

Production activation requires, at minimum:

1. Raid and Epic Boss mutations participate in the same per-account version/CAS
   boundary as ordinary gameplay commands.
2. Known repeatable economy exploits are closed and covered by regression tests.
3. All Black Market mutations obey the shared build, integrity, mutation-disable, and
   authenticated-writer gates.
4. Adversarial concurrency tests prove that one asset can be escrowed, cancelled, or
   fulfilled only once.
5. Operational metrics and a market-specific kill switch are deployed before listings
   are accepted.

Use `BLACK_MARKET_ENABLED=0` as the default in every environment except explicit local
or integration-test environments. Disabled mutation routes return
`503 {"error":"black_market_disabled"}`; the client hides the destination or renders a
clear unavailable state.

## Agreed product behavior

### Order types

The market has two public categories:

| Page tab | Order kind | Creator escrows | Fulfiller provides | Settlement |
|---|---|---|---|---|
| Requests | `BUY_ZOMBIE` | Brains | A matching zombie | Requester receives zombie; fulfiller receives brains |
| Zombie Sales | `SELL_ZOMBIE` | One exact zombie | Listed brains | Buyer receives zombie; creator receives brains |

Each order exposes:

- Zombie catalog type.
- Mutated: Yes or No.
- Price in whole brains.
- Creation time.
- For a sale, the exact mutation labels and veterancy of the escrowed zombie.
- An ownership marker when the current account created the post.

For the first release, `Mutated: Yes` means `mutation != 0` and accepts any nonzero
mutation mask. `Mutated: No` means `mutation == 0`. Exact-mask requests are deferred.

### Limits

- At most two `OPEN` orders per account.
- At most ten newly created orders per account per UTC calendar day.
- Cancelling an order frees an active slot but does not refund the daily allowance.
- Fulfilling another player's order does not consume a posting allowance.
- An account cannot fulfill its own order.
- Price must be an integer in a server-owned range. Start with `1..1_000_000` brains,
  below the existing maximum authoritative balance.
- There is no listing fee or automatic expiration in the first release.

The creation UI displays both counters and the UTC reset policy before confirmation.

### Escrow and delivery

Posting immediately removes the offered asset from usable account state:

- A sale removes the exact zombie from the authoritative roster and stores its snapshot
  in the order.
- A request deducts the entire brain offer from the authoritative balance and stores it
  in the order.

Cancellation automatically restores the escrowed asset. A returned or purchased zombie
is delivered as stored and may overflow normal storage capacity, matching protected
reward delivery; an offline recipient must never lose a fulfilled trade because its
farm or Mausoleum is full.

Fulfillment settles both sides automatically. There is no proceeds inbox or separate
claim step. If the order creator is offline, the server updates that account and bumps
its account version. A stale active client will then reload authoritative state through
the normal conflict path.

The recipient receives a new server-generated unit ID. Preserve authoritative gameplay
traits (`zombie_key`, `mutation`, and `invasions`) and retain the source unit ID only in
audit data. In the first release, custom names and presentation-only mixed colors do not
transfer; the recipient receives the normal generated name and catalog appearance. If
identity preservation becomes a requirement, first promote those fields from
`presentations_v3.rosterLayout` into the authoritative roster contract.

## Player experience

### Right-side navigation

The target right rail is:

1. Invade
2. Zombies
3. Boosts
4. Storage
5. Market
6. Social

Epic Bosses move into the raid screen under an `Epic Bosses` section or tab. An active
boss can place a badge such as `Boss Active` on Invade rather than restoring a separate
button.

Selecting Social opens a compact choice screen:

- **Friends** opens the existing Friends interface.
- **Black Market** opens the dedicated full-page market screen.

### Black Market screen

The screen uses the existing Market's full-page layout, close behavior, responsive
breakpoints, paging controls, and visual language. Its primary tabs are:

- **Requests**: brain offers seeking zombies.
- **Zombie Sales**: exact zombies listed for brains.

Each tab supports:

- Zombie-type filter.
- Mutated Yes/No filter.
- Newest, price-low, and price-high sorting.
- Cursor-based pagination.
- A `My Posts` filter.
- A manual refresh action and visible loading/error state.

Opening the screen paints the most recent in-memory results immediately, then fetches a
fresh first page, following the Friends menu pattern. Switching categories or filters
fetches that query. Do not poll while the page is closed or idle.

Order cards use catalog portraits and safe DOM text nodes for all account-controlled
labels. A card created by the current account shows `Your Post` and a Cancel action;
fulfillment is disabled. Other cards show a context-specific Buy or Sell action followed
by an in-game confirmation.

### Creating and managing posts

A persistent `Create Post` area is reachable from both tabs. It may be a side/bottom
panel on desktop and a dedicated composer step on narrow screens.

`Sell a Zombie` flow:

1. Show eligible owned zombies from the reconciled authoritative roster.
2. Select one zombie; derive its type and mutated status rather than accepting editable
   values.
3. Enter the brain price.
4. Show active/daily limits and an explicit escrow warning.
5. Confirm, wait for authoritative settlement, then open Zombie Sales with the new card
   highlighted.

`Request a Zombie` flow:

1. Select a tradable zombie catalog type.
2. Select Mutated Yes or No.
3. Enter the offered brains.
4. Show the current balance, post limits, and escrow warning.
5. Confirm, wait for authoritative settlement, then open Requests with the new card
   highlighted.

Both public tabs include a `My Posts` filter. A compact summary near Create Post shows
all active posts and provides cancellation without adding a third primary category tab.

The Black Market has no offline/local fallback. Social can still expose the existing
offline Friends stub, but Black Market displays `Sign in to use the Black Market` when
no authenticated server session exists.

## Tradability policy

Create a server-owned `isTradableZombie(key)` rule. Client filtering is presentation
only and is never an authority boundary.

Initially allow:

- Ordinary plantable zombies.
- Standard mutant zombies.
- Combined zombies whose resulting catalog type is otherwise tradable.

Initially reject:

- A unit locked by a raid or Epic Boss session.
- A unit reserved by a Zombie Pot job or another market order.
- Reward-only boss/event zombies.
- `marketHidden` or voucher-only special zombies.
- Unknown/deprecated catalog keys.

Keep this rule explicit so individual special zombies can be enabled later without
loosening validation for the entire category.

## Server data model

Add `server/migrations/0026_black_market.sql`, update `server/schema.sql`, and add the
migration to the fresh-database baseline documentation.

### `black_market_orders`

Suggested columns:

```sql
id                         TEXT PRIMARY KEY,
creator_account_id         TEXT NOT NULL REFERENCES accounts(id),
kind                       TEXT NOT NULL, -- BUY_ZOMBIE | SELL_ZOMBIE
zombie_key                 TEXT NOT NULL,
mutated_required           INTEGER NOT NULL,
price_brains               INTEGER NOT NULL,
status                     TEXT NOT NULL, -- OPEN | FULFILLED | CANCELLED
created_day                INTEGER NOT NULL,
created_at                 INTEGER NOT NULL,
closed_at                  INTEGER,
fulfilled_by_account_id    TEXT REFERENCES accounts(id),
fulfillment_operation_id   TEXT,
source_unit_id             TEXT,
escrow_mutation            INTEGER,
escrow_invasions           INTEGER,
escrow_brains              INTEGER NOT NULL DEFAULT 0
```

Add `CHECK` constraints for kind, status, boolean fields, positive price, and escrow
shape. A sell order must contain a zombie snapshot and zero escrowed brains. A buy order
must contain `escrow_brains == price_brains` and no source zombie.

Indexes:

- `(status, kind, created_at DESC, id)` for default browsing.
- `(status, kind, zombie_key, mutated_required, created_at DESC, id)` for filtering.
- `(creator_account_id, status, created_at DESC)` for limits and My Posts.
- `(creator_account_id, created_day)` for the daily posting count.

### `black_market_receipts`

Every mutation accepts a client-generated `operationId`. Store its account, operation
kind, request fingerprint, response JSON, and creation time under a unique primary key.
A retry with the same operation and fingerprint returns the prior result. Reusing an ID
with different input returns `409 operation_mismatch`.

Use audit events for successful creation, cancellation, and fulfillment, recording order
ID, both account IDs as hashes in logs, source/recipient unit IDs, zombie key, mutation
state, price, and reason. Never log session credentials or raw display names.

## Server transaction design

Black Market writes cannot be implemented as independent updates to `balances` or
`roster_v3`. Extract the account reservation and guarded-write behavior used by
`applyBatch` into a shared helper that can reserve one initiating account and safely
bump affected offline accounts.

All write routes require authentication, current protocol/build/integrity versions, the
mutations-enabled gate, the market feature flag, and an authenticated writer credential.
The request includes the initiator's expected account version and writer generation.

### Create sale

Atomically:

1. Resolve an existing receipt or reserve `operationId`.
2. Validate expected version, writer ownership, active-post count, and daily-post count.
3. Load the roster row by authenticated account and `unitId`.
4. Validate catalog tradability and all locks.
5. Insert the `OPEN` sell order snapshot.
6. Delete the roster row under the same guarded account reservation.
7. Increment account version, clear the reservation, write audit/receipt rows, and return
   the updated gameplay projection plus order.

### Create request

Follow the same sequence, but validate and deduct `priceBrains`, then insert an `OPEN`
buy order with equal escrowed brains.

### Cancel

Atomically claim an `OPEN` order owned by the authenticated account. Restore its escrow,
mark it `CANCELLED`, bump the creator account version, and return the new projection.
For a zombie, allocate a new unit ID and restore it as stored. A cancel racing fulfillment
must produce one winner and one `409 order_closed` response.

### Fulfill sale

Atomically:

1. Reserve the buyer's expected account version and authenticated writer.
2. Claim the still-`OPEN` order with a unique fulfillment operation.
3. Reject self-fulfillment and validate the buyer's current brain balance.
4. Deduct the buyer's brains and create the escrowed zombie in the buyer's roster as
   stored under a new unit ID.
5. Credit the creator's authoritative balance.
6. Mark the order `FULFILLED` and record both accounts and unit IDs.
7. Increment both account versions, finish the receipt/audit rows, and return the buyer's
   full gameplay projection.

### Fulfill request

Reserve the fulfiller, claim the order, and load the selected `unitId`. Validate type,
mutated requirement, tradability, and locks. Delete that unit, credit the fulfiller with
the escrowed brains, create a stored unit for the requester under a new ID, mark the
order fulfilled, and bump both account versions.

Use one D1 batch with a unique order-operation claim and guarded subqueries so every
downstream mutation is conditional on winning both the account reservation and order
claim. Check the reservation statement's affected-row count before reporting success.
No route may acknowledge a trade based only on a pre-transaction read.

## API contract

### Reads

```text
GET /black-market/orders
  ?kind=BUY_ZOMBIE|SELL_ZOMBIE
  &zombieKey=...
  &mutated=true|false
  &sort=newest|price_asc|price_desc
  &mine=true|false
  &cursor=...

GET /black-market/summary
```

The list response contains sanitized public order views, a next cursor, server time, and
the current account's active/daily counters. Cursor ordering must include the order ID as
a stable tie-breaker. Cap page size server-side.

### Writes

```text
POST /black-market/orders
POST /black-market/orders/:id/cancel
POST /black-market/orders/:id/fulfill
```

Create body variants:

```ts
{ operationId, expectedAccountVersion, kind: "SELL_ZOMBIE", unitId, priceBrains }
{ operationId, expectedAccountVersion, kind: "BUY_ZOMBIE", zombieKey, mutated, priceBrains }
```

Fulfill body variants:

```ts
{ operationId, expectedAccountVersion }          // buy a SELL_ZOMBIE order
{ operationId, expectedAccountVersion, unitId }  // fill a BUY_ZOMBIE order
```

Successful mutations return the new account/writer versions, complete initiating-account
gameplay projection, affected order view, and updated posting counters. Standardize error
codes for closed orders, ownership, mismatch, insufficiency, limits, locks, stale state,
writer replacement, feature disablement, and rate limiting.

Apply separate read and write rate limits. Browse results must not expose account IDs,
friend codes, roster IDs, or escrow internals.

## Client integration

Add Black Market wire types and API functions beside `src/net/api.ts`, but put cache,
filter, cursor, and action orchestration in a focused `src/social/blackMarket.ts` module.

Before a market mutation:

1. Ask `EconomyClient` to flush and await its protocol-v3 command queue.
2. Read the settled account version and ensure this client still owns the writer lease.
3. Submit the market operation.
4. Adopt the returned gameplay projection through the same balance/roster reconciliation
   path as a command response.
5. Clear affected browse caches and refresh the current page.

Do not optimistically remove brains or zombies before the server response. Escrow is a
high-value, cross-account mutation; show a pending state and reconcile only from the
authoritative response. On `state_conflict`, bootstrap, rerender, and require the player
to confirm again rather than automatically replaying a trade against changed state.

Add HUD callbacks for opening Social, browsing market pages, reading eligible roster
units, creating/cancelling/fulfilling orders, and adopting counters. Keep raw network
calls out of DOM construction.

## Implementation phases

### Phase 0: security prerequisites

- Close the protocol rollout's economy blockers.
- Put raid and Epic Boss mutations inside the shared account CAS boundary.
- Add the disabled Black Market feature flag and route gates.

### Phase 1: domain and persistence

- Add tradability catalog rules and unit tests.
- Add the D1 migration, schema snapshot, indexes, receipts, and audit shape.
- Extract the reusable account reservation/commit helper.
- Implement order projection and cursor encoding.

### Phase 2: server mutations

- Implement create-sale and create-request escrow.
- Implement cancellation and automatic restoration.
- Implement both fulfillment directions.
- Add idempotency, rate limits, metrics, and structured error mapping.

### Phase 3: client data layer

- Add API contracts and cached browse queries.
- Expose queue flush/version adoption through `EconomyClient`.
- Add mutation orchestration and conflict recovery.

### Phase 4: navigation and UI

- Consolidate Boss into the raid UI.
- Replace Friends with Social and build the two-destination hub.
- Build the full-page Requests and Zombie Sales tabs.
- Build filters, pagination, My Posts, composer flows, confirmations, and responsive
  behavior.
- Add loading, empty, unavailable, stale-cache, and error states.

### Phase 5: verification and controlled rollout

- Complete unit, integration, race, and client UI tests.
- Run local multi-account smoke tests with forced retries and stale clients.
- Deploy schema and disabled routes first.
- Deploy the compatible client while the flag remains disabled.
- Enable for internal accounts, inspect metrics and audit integrity, then expand gradually.

## Required tests

### Rules and validation

- Both mutation states match exactly as specified.
- Every allowed and excluded catalog category follows the server tradability rule.
- Prices reject zero, negatives, fractions, overflow, strings, and out-of-range values.
- Raid-, boss-, pot-, and market-locked zombies cannot be posted or used to fulfill.
- A forged or foreign `unitId` never creates an order or payout.

### Limits and time

- Two active orders succeed and the third fails.
- Ten daily creations succeed and the eleventh fails.
- Cancellation frees an active slot but not a daily slot.
- UTC day rollover uses server time and resets only the daily count.
- Concurrent creates cannot exceed either limit.

### Escrow and idempotency

- Posting removes exactly one zombie or the exact brain price.
- Cancellation restores exactly once.
- Retrying every mutation with the same operation ID returns the original result.
- Reusing an operation ID with changed input fails.
- A failed transaction leaves order, roster, balance, account version, receipts, and
  audit state mutually consistent.

### Concurrency

- Two buyers race one sale; exactly one trade settles.
- Two sellers race one request; exactly one trade settles.
- Cancel racing fulfill has exactly one terminal winner.
- Ordinary `/commands` racing create/cancel/fulfill produces a conflict without lost
  updates.
- The offline counterparty's active stale client is forced through reconciliation.
- Writer takeover during confirmation prevents the replaced client from trading.

### Delivery

- Mutation mask and invasions survive sale, request fulfillment, and cancellation.
- Recipient unit IDs are new and cannot collide with existing roster IDs.
- Delivery succeeds with a full deployed army and full ordinary storage.
- Self-fulfillment and transfer of excluded special units fail without moving assets.

### UI

- Social opens Friends and Black Market correctly.
- Black Market refreshes on open and category changes without background polling.
- Cached content is replaced by fresh content and stale cards cannot settle silently.
- Create controls reflect active/daily limits and authoritative balance/roster changes.
- Requests, sales, My Posts, filters, confirmations, keyboard navigation, and narrow-screen
  layout remain usable.
- Account-controlled text is rendered without HTML injection.

## Observability and operations

Record counters and latency for browse, create, cancel, and both fulfillment directions;
state conflicts; order-closed races; writer failures; limit rejection; insufficient
funds; tradability rejection; D1 errors; and idempotent retries. Track aggregate active
order count, age distribution, fulfillment rate, cancellation rate, price distribution,
and escrowed-brain total without exposing raw account identifiers in logs.

Add operational checks that compare open sell orders to their zombie escrow shape and
open buy orders to their brain escrow shape. Provide a read-only reconciliation script
before enabling production writes. Any repair tooling must operate through audited,
idempotent operations and update account versions; never edit one side of a trade alone.

Emergency response:

- `BLACK_MARKET_ENABLED=0` immediately stops create, cancel, and fulfill while preserving
  authenticated reads and escrow state.
- `MUTATIONS_DISABLED=1` remains the global stop for gameplay mutations.
- Disabling the market does not automatically cancel orders; automatic mass refunds
  require a separately reviewed maintenance operation.

## Deferred decisions

These do not block the first implementation:

- Whether seller/requester display names should be visible or anonymous.
- Exact-mutation requests rather than the agreed Yes/No match.
- Transfer of custom zombie names and combined presentation colors.
- Listing expiration and automatic refund.
- Fees or taxes as an economy sink.
- Saved searches, notifications, price history, and completed-order history in the UI.

Do not add these to the first release until the core escrow lifecycle and cross-account
transaction behavior have production evidence.
