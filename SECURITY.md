# Security and Anti-Cheat Audit

Last reviewed: 2026-07-13

## Scope

This document reviews the browser client, save system, Cloudflare Worker/D1 backend,
Google authentication, sessions, friends, gifting, farm visits, economy, raids, build and
deployment configuration, and the currently deployed API boundary.

The audit is based on the current working tree. The production Worker was also checked to
confirm that it is live and rejects unauthenticated account access. Because Worker deployment
is manual, that check does not prove that every line in the local server tree is deployed.

## Executive Assessment

Anti-cheat is currently weak overall because gameplay authority remains almost entirely in
the browser.

- Manipulating one's own farm, gold, brains, XP, inventory, zombies, raid history, cooldowns,
  or rewards is trivial.
- Directly overwriting another player's save is not possible through any route found in this
  audit unless the victim's session token is stolen.
- Cross-account influence is still possible through forced friendships, discoverable friend
  codes, gift concurrency, inbox abuse, and malicious saves served to farm visitors.
- The backend protects identity and basic account ownership substantially better than it
  protects game integrity.

The current model is suitable only while progression is intentionally honor-system and
noncompetitive. It is not a safe base for paid currency, trading, leaderboards, PvP, or other
features where one player's illegitimate progress can materially affect another player.

## Risk Summary

| Scenario | Likelihood | Impact |
| --- | --- | --- |
| Change own gold, brains, XP, inventory, or farm | Certain / trivial | High economy impact |
| Forge raid wins, loot, cooldowns, or zombies | Certain / trivial | High |
| Upload an entirely fabricated farm | Certain / trivial | High |
| Directly write another account's save | Low without token theft | Critical |
| Force friendship with another player | High with a known code; plausible by enumeration | Medium |
| Read another player's projected farm | High after establishing friendship | Medium / privacy |
| Exceed the intended gift limit with concurrent requests | Medium-high | Medium |
| Hang a visitor with a maliciously shaped farm | Medium; victim must visit | Medium-high |
| Take over an account using a stolen session token | Low-medium | Critical |

## Existing Controls

The following controls are meaningful and should be retained:

- Google ID tokens are verified against Google's signing keys, accepted issuers, and the
  configured client audience.
- The API issues signed session JWTs and requires them on account, save, friend, and gift
  routes.
- Save ownership is derived from the authenticated session, not from a caller-provided
  account ID.
- SQL uses bound parameters.
- Reading a friend's farm requires an existing friendship.
- Friend farm responses use an allowlist projection and omit balances, XP, storage, boosts,
  quests, raid progress, and social data.
- Gift claims require an unclaimed gift addressed to the authenticated account.
- The production configuration sets `DEV_AUTH = "0"`, and the deployed API rejected
  unauthenticated account access during this review.
- No committed session or deployment secret was found.
- Client and server dependency audits reported no known production dependency
  vulnerabilities at review time.

These controls prevent straightforward insecure-direct-object-reference attacks, but they do
not establish gameplay authority.

## Findings

### Critical: The server accepts client-authored progression

`PUT /save` accepts the complete client-authored save blob. The revision check detects some
ordinary stale writes, but the server does not verify how balances, inventory, zombies, XP,
raid history, cooldowns, or unlocks changed.

The client-side save validator checks only the save version before applying the remainder of
the object. It does not enforce a runtime schema, numeric ranges, catalog membership, array
limits, farm dimensions, or economy invariants.

As a result, a player can construct any valid-looking snapshot and make it the cloud save for
their account.

### Critical: Production exposes developer mutation tools

The production client includes an invisible developer-menu hotspot with direct controls for
level, gold, brains, and raid wins. It also publishes `window.ZF`, which exposes live game
state and helpers for instant raids, boost grants, zombie spawning, combining, placement, and
raid wins.

Removing these affordances is worthwhile because it stops the easiest form of casual
cheating. It is not a security boundary: browser state, JavaScript, network requests, and save
payloads remain under player control.

### Critical: Economy and farm state are client-authoritative

Gold, brains, XP, inventory, zombies, storage, objects, crops, boosts, unlocks, and most
progression are calculated and mutated locally. Autosave serializes the resulting values and
uploads them.

Client wall-clock time also drives crop growth, combination completion, and raid cooldowns.
Changing saved timestamps or the clock can therefore affect progression.

### Critical: Raid outcomes and rewards are client-authoritative

Raid setup, player actions, combat state, RNG, wins, casualties, cooldowns, XP, gold, brains,
loot, boosts, and ability unlocks currently resolve in the browser. The server sees only the
finished save blob.

Raids are interactive: targeting, ability use, concentration interactions, timing, ordering,
and other player choices can significantly change the result. A security design must not
assume that an automatic resolver can predict the outcome of a raid the player actively
plays. See **Raid Authority Design** below for approaches that preserve those inputs.

### High: Friendship is created without recipient consent

Adding a friend inserts both directions of the friendship immediately. The target never
accepts the relationship, and the online API has no remove or block endpoint.

This lets anyone who knows a code change the target's server-side friend graph, appear in the
target's friend list, send gifts, and read the target's projected farm.

### High: Friend codes are enumerable

Generated friend codes use four characters from a 31-character alphabet, for only 923,521
possible codes. The add endpoint distinguishes nonexistent codes from valid ones, and no
application-level rate limiting or abuse detection was found.

An attacker who knows a particular code can force friendship immediately. Automated probing
could also discover arbitrary accounts, with success becoming easier as the account
population grows.

### High: The gift send limit is not atomic

Gift sending reads the most recent gift, checks the rolling 24-hour window, and then performs
a separate insert. There is no uniqueness constraint or atomic conditional insert enforcing
the sender/recipient/window rule.

Concurrent requests can potentially observe the same eligible state and create multiple
gifts. There is also no route rate limit or explicit inbox cap.

The recipient must claim a gift before it changes their brains, so this does not silently
subtract or overwrite their farm. It can nevertheless inflate premium currency, fill the
inbox, and create storage or request abuse.

### High: Gift claiming is not a robust idempotent ledger operation

Claiming first reads a claimable gift and the current save. A batch then conditionally marks
the gift claimed and unconditionally writes the modified save. The save update is not
dependent on the claim update actually changing a row.

Concurrent claims and concurrent save activity can produce lost updates or ambiguous results.
The operation needs a durable, unique grant event and server-owned balance rather than a
mutation of an opaque client save.

### Medium-high: Malicious saves can attack farm visitors

The friend-save projection omits private sections, but retained farm data is not validated or
bounded. Farm dimensions, plot/object/zombie arrays, timestamps, IDs, coordinates, and catalog
keys originate in an attacker-authored save.

The visitor client hydrates this data and may resize the field according to the supplied
dimensions. Extreme dimensions or collection sizes can consume excessive CPU or memory and
hang the browser. Because visit state survives a reload within the tab, a sufficiently bad
farm could retrigger until the visit state or tab session is cleared.

No confirmed remote-code-execution path was found through friend farm data. This finding is
principally denial of service and robustness exposure.

### Medium: Save revision enforcement is subject to a race

`PUT /save` reads the current revision, compares it, and later performs an upsert. Two
concurrent requests can potentially read the same revision, both pass, and both write the same
next revision, with the last write winning.

The revision guard should be implemented as an atomic database compare-and-swap, such as a
conditional update on both account ID and expected revision followed by a check of the number
of changed rows.

### Medium: Long-lived bearer sessions have no revocation

Session JWTs are stored in `localStorage` and remain valid for 30 days. Signing out deletes
the browser copy but does not revoke the token server-side. There is no session list, device
management, rotation, or emergency revocation mechanism.

No currently exploitable stored XSS was confirmed during this review. However, a future XSS,
malicious extension, shared-device user, or token leak would grant full account access for the
remaining token lifetime.

### Medium: No application-level rate limiting or abuse controls

No per-account or per-IP rate limits were found for authentication, username changes, friend
code attempts, friend addition, gifts, inbox polling, claims, save reads, or save writes.

CORS is correctly useful for browser-origin policy, but it is not an anti-bot or anti-cheat
control. A custom client can call the API directly with its own valid session.

### Low-medium: Dynamic HTML and missing browser hardening

Several UI paths interpolate account or gift names into `innerHTML`. Current username
validation excludes the characters normally required for HTML markup, which substantially
reduces the immediate risk, but using text nodes is safer and avoids coupling rendering safety
to a remote validator.

The page also has no restrictive Content Security Policy. This increases the impact of any
future injection vulnerability.

## Raid Authority Design

The purpose of server authority is to verify the raid the player actually played, not to have
an auto-runner guess what would have happened without the player's decisions.

### Recommended model: signed raid session plus deterministic replay

1. `POST /raid/start` runs before the fight.
2. The server validates the player's level, owned and deployed zombies, attack order,
   cooldown, boosts, and other launch requirements against server-owned state.
3. It atomically consumes any voucher, Concentration, or Golden Dice and records an open raid
   session with a unique ID, expiry, ruleset/version, roster snapshot, and server-generated RNG
   seed.
4. The client plays the normal interactive raid. Every outcome-relevant player input is
   recorded in order, including its simulation tick or bounded timestamp. Examples include
   ability activation, target selection, concentration actions, retreat, and any future
   direct-control mechanic.
5. `POST /raid/finish` submits that input transcript and the raid session ID. It does not submit
   an authoritative `win`, reward amount, or arbitrary final state.
6. The server replays the same deterministic combat rules with the same roster, seed, and exact
   player inputs. It validates that each action was legal at that tick, respects cooldowns and
   resources, and derives the resulting win/loss, casualties, loot, and rewards.
7. The server commits the result once using the raid session ID as an idempotency key.

This is a replay of the player's decisions, not an auto-runner prediction. If the player makes
better or worse choices, those exact choices are included and the verified result changes
accordingly.

The current deterministic simulation work can help, but security replay requires all
outcome-relevant behavior to be deterministic from the server seed, ruleset, initial snapshot,
and submitted input stream. Rendering and animation do not need to be replayed.

### Alternative: authoritative raid state machine

If exact replay is too difficult initially, the server can own a coarser raid state machine.
The client submits each meaningful action while the raid is active, and the server validates
and advances combat state. The client remains responsible for animation and presentation.

This provides stronger authority but adds network latency and requires reconnect handling. It
may be practical if actions are relatively infrequent rather than frame-by-frame.

### Transitional model: invariant and plausibility verification

As an intermediate step, the server can issue a signed start ticket and validate a bounded
combat transcript, elapsed time, legal action count, cooldowns, initial roster, maximum
possible damage/healing, and allowed state transitions.

This is weaker than deterministic replay and should be treated as cheat resistance rather
than proof of the outcome. It is still materially better than accepting a final save or a
client-provided win flag.

### Raid requirements regardless of model

- The server owns raid cooldown time.
- Raid start consumes boosts and vouchers atomically.
- A raid session expires and can finish only once.
- The ruleset/version is pinned when the raid starts.
- RNG seeds and reward rolls originate on the server.
- Rewards, casualties, progress, and unlocks are committed server-side.
- Disconnect and retry behavior is idempotent.
- The client cannot replace roster stats, inventory, or raid progress in a later save.
- The `ZF.runRaid` auto-runner and other developer hooks are never accepted as security
  evidence of a legitimate player raid.

## Remediation Plan

### Priority 0: Protect cross-account state

- Replace automatic mutual friendship with a request/accept flow.
- Add online remove, block, and report endpoints.
- Increase friend codes to at least 8-10 random characters and allow code rotation.
- Avoid exposing a high-speed validity oracle for arbitrary codes.
- Add per-account and per-IP rate limits to friend, gift, auth, and save routes.
- Cap friend count, pending requests, pending gifts, and inbox response size.

### Priority 0: Make gifts atomic

- Store a server-derived gift window or day bucket.
- Add a unique constraint for sender, recipient, and allowed window/bucket.
- Make sending an atomic insert that succeeds or conflicts without a preceding eligibility
  read.
- Move brains into a server-owned balance or ledger.
- Credit claims through a unique grant event keyed by gift ID.
- Make retries return the already-committed result without granting twice.

### Priority 0: Validate saves and visitor data

- Add a real runtime schema at the API boundary.
- Set explicit request and serialized-save size limits.
- Require finite, bounded, nonnegative integers where appropriate.
- Bound field dimensions and plot, object, zombie, inventory, quest, and social collection
  sizes.
- Validate coordinates and catalog keys.
- Reject duplicate instance IDs and impossible ownership counts.
- Construct a separate, sanitized friend-farm DTO field by field.
- Repeat safe bounds checks in the visitor client before allocation or hydration.

### Priority 1: Move valuable state out of the opaque save

The server should become authoritative for at least:

- gold and brains;
- XP and level-derived unlocks;
- inventory, boosts, and unique items;
- zombie ownership and permanent casualties;
- raid wins, cooldowns, loot, and ability unlocks;
- gift grants and any future purchase grants.

Farm presentation and placement can remain snapshot-based if the server validates dimensions,
ownership, counts, and legal transitions. A command/event model provides stronger integrity
than arbitrary snapshot replacement.

### Priority 1: Implement raid verification

- Start with signed, expiring, one-use raid sessions.
- Capture every outcome-relevant player input.
- Choose deterministic replay, an authoritative action state machine, or transitional
  invariant verification based on fidelity and latency requirements.
- Never rely on the automatic resolver to predict an interactive player's outcome.

### Priority 1: Make save concurrency atomic

- Replace the read/check/upsert sequence with a database compare-and-swap.
- Return a conflict unless exactly one row was updated from the expected revision.
- Make initial-save creation safe under concurrent requests.
- Decide and document conflict recovery instead of silently accepting last-writer behavior.

### Priority 2: Harden sessions and the browser

- Use shorter-lived access tokens backed by renewable, revocable server sessions.
- Track session IDs and allow logout, account-wide logout, and device/session removal.
- Rotate credentials after renewal and sensitive account events.
- Add a restrictive Content Security Policy compatible with the required Google sign-in
  resources.
- Replace dynamic `innerHTML` containing runtime data with DOM construction and
  `textContent`.
- Review storage of bearer credentials against the final hosting and CSRF model.

### Priority 2: Remove production development surfaces

- Compile the invisible developer menu out of production builds.
- Do not publish `window.ZF` mutation helpers in production.
- Keep development-only authentication and debug behavior behind both build-time and
  server-side controls.

This reduces casual abuse but is not a substitute for server validation.

### Priority 2: Add adversarial tests and monitoring

Add integration tests for:

- unauthorized and cross-account save access;
- concurrent save writes;
- concurrent gift sends and claims;
- friend request acceptance, removal, blocking, and enumeration limits;
- malformed, oversized, deeply nested, and high-cardinality saves;
- malicious visitor dimensions and collections;
- session expiry and revocation;
- raid replay legality, tampered transcripts, duplicate completion, stale rulesets, altered
  rosters, invalid timing, and reward idempotency.

Operationally, record security-relevant events and alert on unusual friend-code attempts,
gift bursts, save-write rates, repeated conflicts, oversized payloads, and impossible
progression deltas.

## Verification Performed

At the time of the audit:

- The production Worker root responded successfully.
- An unauthenticated `/me` request was rejected.
- An empty authentication request was rejected.
- An arbitrary browser origin was not granted an `Access-Control-Allow-Origin` response.
- The client test suite passed 109 tests.
- The server test suite passed 21 tests.
- The production client build and server typecheck passed.
- Client and server production dependency audits reported zero known vulnerabilities.

These checks establish baseline correctness and dependency health. They do not test the
adversarial concurrency, authorization, validation, raid transcript, or abuse cases described
above.

## Security Posture Summary

Direct cross-account save writes are currently constrained by authenticated ownership, which
is the strongest part of the design. Cross-account social abuse and visitor robustness still
need prompt attention.

For anti-cheat, the decisive architectural issue is that the cloud save is a client-authored
snapshot. Until valuable state and reward decisions become server-owned, a player can grant
themselves essentially anything. Raid authority must preserve and validate the player's real
interactive decisions; it should not assume that an automatic battle resolver can substitute
for them.
