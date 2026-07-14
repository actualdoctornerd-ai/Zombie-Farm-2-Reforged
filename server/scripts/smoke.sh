#!/usr/bin/env bash
# Post-deploy smoke checks — the unauthenticated invariants that must hold on a
# live Worker (the ones testable without a real Google sign-in). Run after every
# deploy; a green run does NOT prove the authed flows (use the integration suite +
# a DEV_AUTH staging run for those), but it catches a broken/misconfigured deploy.
#
# Usage:  API=https://zombiefarm-server.example.workers.dev ./scripts/smoke.sh
set -u
API="${API:-http://127.0.0.1:8787}"
ORIGIN="${ORIGIN:-https://evil.example.com}"   # an origin that must NOT be allowed
pass=0; fail=0
check() { # name  expected  actual
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1));
  else echo "  FAIL $1 — expected $2, got $3"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Smoke checks against $API"

# 1. Root is up.
check "root 200"            200 "$(code "$API/")"
# 2. Unauthenticated account access is rejected.
check "/me unauthorized"    401 "$(code "$API/me")"
check "/save unauthorized"  401 "$(code "$API/save")"
# 3. Empty / missing-token auth is rejected.
check "/auth empty 400"     400 "$(code -X POST -H 'content-type: application/json' -d '{}' "$API/auth")"
# 4. An oversized body is rejected before parsing (413).
big=$(head -c 700000 /dev/zero | tr '\0' 'x')
check "oversized 413"       413 "$(code -X POST -H 'content-type: application/json' --data-binary "{\"x\":\"$big\"}" "$API/auth")"
# 5. An arbitrary browser origin is NOT granted an allow-origin header.
acao=$(curl -s -D - -o /dev/null -H "Origin: $ORIGIN" "$API/" | grep -i '^access-control-allow-origin:' | tr -d '\r' | awk '{print $2}')
check "CORS not wildcarded" "" "${acao:-}"

echo "---"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
