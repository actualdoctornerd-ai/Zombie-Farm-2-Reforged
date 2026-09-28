#!/usr/bin/env node
// One-time production repair for the over-tuned ruleset-66 invasion window.
//
// Safe properties:
// - Targets only the exact raid variants reverted by ruleset 67.
// - Skips accounts with a live raid or command batch; rerun to collect them later.
// - Uses a D1 transactional batch and a durable per-account audit marker.
// - Re-running cannot restore or refund an account twice.
//
// Dry run: node scripts/compensate-ruleset66.mjs
// Apply:   node scripts/compensate-ruleset66.mjs --apply

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ACCOUNT = "a389a14338b237a5313e5e198220b938";
const PROD_DB = "bf1b288f-7419-41d5-8ee6-0f022c17fd20";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${PROD_DB}/query`;
const AUDIT_KIND = "admin_ruleset66_compensation";
const AUDIT_PREFIX = "admin:ruleset66-compensation:v1:";

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const candidates = [
    path.join(process.env.APPDATA ?? "", "xdg.config", ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".wrangler", "config", "default.toml"),
  ];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    const found = /^oauth_token\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(file, "utf8"));
    if (found) return found[1];
  }
  throw new Error("no Cloudflare token; run `npx wrangler whoami` and retry");
}

async function query(payload) {
  const response = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || !body.success || body.errors?.length) {
    throw new Error(body.errors?.map((e) => e.message).join("; ") || `Cloudflare HTTP ${response.status}`);
  }
  const results = body.result ?? [];
  const failed = results.find((entry) => entry.success === false);
  if (failed) throw new Error(`D1 statement failed: ${JSON.stringify(failed)}`);
  return results;
}

const source = `
affected_sessions AS (
  SELECT s.id, s.account_id
  FROM raid_sessions_v3 s
  WHERE s.ruleset_version = 66
    AND s.started_at >= CAST(strftime('%s','2026-09-28 05:49:59') AS INTEGER) * 1000
    AND s.started_at <  CAST(strftime('%s','2026-09-28 18:27:11') AS INTEGER) * 1000
    AND COALESCE(CAST(json_extract(s.boosts_json,'$.practice') AS INTEGER),0) = 0
    AND (
      (COALESCE(CAST(json_extract(s.boosts_json,'$.elite') AS INTEGER),0) = 0
        AND CAST(s.raid_id AS INTEGER) IN (5,6,9))
      OR
      (COALESCE(CAST(json_extract(s.boosts_json,'$.elite') AS INTEGER),0) = 1
        AND CAST(s.raid_id AS INTEGER) IN (3,4,5,6))
    )
),
casualties AS (
  SELECT a.id AS session_id, a.account_id,
    json_extract(c.value,'$.id') AS unit_id,
    json_extract(c.value,'$.key') AS zombie_key,
    CAST(json_extract(c.value,'$.mutation') AS INTEGER) AS mutation,
    CAST(json_extract(c.value,'$.invasions') AS INTEGER) AS invasions,
    EXISTS (
      SELECT 1 FROM json_each(COALESCE(rr.revived_json,'[]')) v
      WHERE v.value = json_extract(c.value,'$.id')
    ) AS was_revived
  FROM affected_sessions a
  JOIN raid_revivals_v3 rr ON rr.session_id = a.id
  JOIN json_each(rr.casualties_json) c
),
unrevived AS (
  SELECT * FROM casualties WHERE was_revived = 0
),
revived_counts AS (
  SELECT account_id, COUNT(*) AS brain_refund
  FROM casualties WHERE was_revived = 1 GROUP BY account_id
),
restore_counts AS (
  SELECT account_id, COUNT(*) AS restore_count
  FROM unrevived GROUP BY account_id
),
compensation AS (
  SELECT account_id, SUM(brain_refund) AS brain_refund, SUM(restore_count) AS restore_count
  FROM (
    SELECT account_id, brain_refund, 0 AS restore_count FROM revived_counts
    UNION ALL
    SELECT account_id, 0 AS brain_refund, restore_count FROM restore_counts
  ) GROUP BY account_id
)
`;

const eligible = `
eligible AS (
  SELECT c.*
  FROM compensation c
  JOIN account_runtime_v3 runtime ON runtime.account_id = c.account_id
  WHERE NOT EXISTS (
      SELECT 1 FROM audit_events_v3 a
      WHERE a.id = '${AUDIT_PREFIX}' || c.account_id
    )
    AND (runtime.active_batch_id IS NULL
      OR runtime.active_batch_expires_at <= CAST(strftime('%s','now') AS INTEGER) * 1000)
    AND NOT EXISTS (
      SELECT 1 FROM raid_sessions_v3 live
      WHERE live.account_id = c.account_id AND live.finished_at IS NULL
        AND live.expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000
    )
)
`;

const preflightSql = `WITH ${source}, ${eligible}
SELECT
  (SELECT COUNT(*) FROM compensation) AS total_accounts,
  (SELECT COUNT(*) FROM compensation c WHERE NOT EXISTS (
    SELECT 1 FROM audit_events_v3 a WHERE a.id='${AUDIT_PREFIX}'||c.account_id)) AS pending_accounts,
  (SELECT COUNT(*) FROM eligible) AS eligible_accounts,
  (SELECT COALESCE(SUM(brain_refund),0) FROM eligible) AS eligible_brain_refund,
  (SELECT COALESCE(SUM(restore_count),0) FROM eligible) AS eligible_restores,
  (SELECT COUNT(*) FROM audit_events_v3 WHERE kind='${AUDIT_KIND}'
    AND json_extract(detail_json,'$.status')='applied') AS applied_accounts`;

const insertAuditSql = `WITH ${source}, ${eligible}
INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
SELECT '${AUDIT_PREFIX}'||e.account_id, e.account_id, '${AUDIT_KIND}',
  json_object(
    'status','pending',
    'sourceRuleset',66,
    'windowStartUtc','2026-09-28T05:49:59Z',
    'windowEndUtc','2026-09-28T18:27:11Z',
    'brainRefund',e.brain_refund,
    'brainBalanceBefore',(SELECT brains FROM balances b WHERE b.account_id=e.account_id),
    'restoredToReceived',json(COALESCE((
      SELECT json_group_array(json_object(
        'id',u.unit_id,'key',u.zombie_key,'mutation',u.mutation,'invasions',u.invasions,
        'name',f.name
      ))
      FROM unrevived u
      LEFT JOIN fallen_v3 f ON f.account_id=u.account_id AND f.unit_id=u.unit_id
      WHERE u.account_id=e.account_id
    ),'[]'))
  ), CAST(strftime('%s','now') AS INTEGER)*1000
FROM eligible e`;

const bumpVersionSql = `UPDATE account_runtime_v3
SET account_version=account_version+1, updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
WHERE account_id IN (
  SELECT account_id FROM audit_events_v3
  WHERE kind='${AUDIT_KIND}' AND json_extract(detail_json,'$.status')='pending'
)`;

const restoreReceivedSql = `WITH ${source},
targets AS (
  SELECT account_id FROM audit_events_v3
  WHERE kind='${AUDIT_KIND}' AND json_extract(detail_json,'$.status')='pending'
),
markers AS (
  SELECT u.account_id,
    json_group_object('zombie-reward:'||u.unit_id||':'||u.zombie_key||':'||u.mutation||':'||u.invasions,1) AS marker_json
  FROM unrevived u JOIN targets t ON t.account_id=u.account_id
  GROUP BY u.account_id
)
UPDATE gameplay_documents_v3
SET current_json=json_patch(current_json,json_object('storage',json_object('received',
      json((SELECT marker_json FROM markers WHERE markers.account_id=gameplay_documents_v3.account_id))
    ))),
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
WHERE account_id IN (SELECT account_id FROM markers)`;

const refundBrainsSql = `UPDATE balances
SET brains=brains+CAST((
  SELECT json_extract(a.detail_json,'$.brainRefund') FROM audit_events_v3 a
  WHERE a.account_id=balances.account_id AND a.kind='${AUDIT_KIND}'
    AND json_extract(a.detail_json,'$.status')='pending'
) AS INTEGER)
WHERE account_id IN (
  SELECT account_id FROM audit_events_v3
  WHERE kind='${AUDIT_KIND}' AND json_extract(detail_json,'$.status')='pending'
    AND CAST(json_extract(detail_json,'$.brainRefund') AS INTEGER)>0
)`;

const clearFallenSql = `WITH ${source},
targets AS (
  SELECT account_id FROM audit_events_v3
  WHERE kind='${AUDIT_KIND}' AND json_extract(detail_json,'$.status')='pending'
)
DELETE FROM fallen_v3
WHERE EXISTS (
  SELECT 1 FROM unrevived u JOIN targets t ON t.account_id=u.account_id
  WHERE u.account_id=fallen_v3.account_id AND u.unit_id=fallen_v3.unit_id
)`;

const finalizeAuditSql = `UPDATE audit_events_v3
SET detail_json=json_set(detail_json,'$.status','applied','$.appliedAt',
      CAST(strftime('%s','now') AS INTEGER)*1000)
WHERE kind='${AUDIT_KIND}' AND json_extract(detail_json,'$.status')='pending'`;

const verifySql = `WITH ${source}
SELECT
  (SELECT COUNT(*) FROM compensation) AS total_accounts,
  (SELECT COUNT(*) FROM audit_events_v3 WHERE kind='${AUDIT_KIND}'
    AND json_extract(detail_json,'$.status')='applied') AS applied_accounts,
  (SELECT COALESCE(SUM(CAST(json_extract(detail_json,'$.brainRefund') AS INTEGER)),0)
    FROM audit_events_v3 WHERE kind='${AUDIT_KIND}'
      AND json_extract(detail_json,'$.status')='applied') AS brains_refunded,
  (SELECT COALESCE(SUM(json_array_length(json_extract(detail_json,'$.restoredToReceived'))),0)
    FROM audit_events_v3 WHERE kind='${AUDIT_KIND}'
      AND json_extract(detail_json,'$.status')='applied') AS zombies_restored,
  (SELECT COUNT(*) FROM unrevived u JOIN fallen_v3 f
    ON f.account_id=u.account_id AND f.unit_id=u.unit_id
    JOIN audit_events_v3 a ON a.account_id=u.account_id AND a.kind='${AUDIT_KIND}'
      AND json_extract(a.detail_json,'$.status')='applied') AS restored_still_fallen,
  (SELECT COUNT(*) FROM unrevived u
    JOIN audit_events_v3 a ON a.account_id=u.account_id AND a.kind='${AUDIT_KIND}'
      AND json_extract(a.detail_json,'$.status')='applied'
    JOIN gameplay_documents_v3 g ON g.account_id=u.account_id
    JOIN json_each(json_extract(g.current_json,'$.storage.received')) r
      ON r.key='zombie-reward:'||u.unit_id||':'||u.zombie_key||':'||u.mutation||':'||u.invasions
     AND CAST(r.value AS INTEGER)>0) AS restored_markers_present`;

const preflight = (await query({ sql: preflightSql }))[0]?.results?.[0];
console.log(JSON.stringify({ phase: "preflight", ...preflight }));

if (!process.argv.includes("--apply")) process.exit(0);
if (!preflight || preflight.eligible_accounts === 0) {
  console.log(JSON.stringify({ phase: "apply", message: "no eligible accounts in this pass" }));
  process.exit(0);
}

const applied = await query({ batch: [
  { sql: insertAuditSql },
  { sql: bumpVersionSql },
  { sql: restoreReceivedSql },
  { sql: refundBrainsSql },
  { sql: clearFallenSql },
  { sql: finalizeAuditSql },
] });
console.log(JSON.stringify({ phase: "batch", changes: applied.map((r) => r.meta?.changes ?? 0) }));

const verified = (await query({ sql: verifySql }))[0]?.results?.[0];
console.log(JSON.stringify({ phase: "verify", ...verified }));
