#!/usr/bin/env bash
# Smoke test: Dockerfile.frontend (nginx + SPA + backend proxy)
# Requires the full pipeline compose stack to be running (review + frontend).
set -euo pipefail

FRONTEND_URL="http://127.0.0.1:18090"
BACKEND_URL="http://127.0.0.1:18080"
PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL  $1"; FAIL=$(( FAIL + 1 )); }

echo "=== smoke_frontend_container ==="
echo "frontend: $FRONTEND_URL"
echo ""

# 1. SPA index served
status=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND_URL/")
[ "$status" = "200" ] && ok "GET / → 200" || fail "GET / → $status (want 200)"

# 2. SPA routing catch-all (non-existent path serves index.html, not 404)
status=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND_URL/jobs")
[ "$status" = "200" ] && ok "GET /jobs → 200 (SPA fallback)" || fail "GET /jobs → $status (want 200)"

# 3. Content-Type is HTML for SPA
ct=$(curl -s -o /dev/null -w "%{content_type}" "$FRONTEND_URL/")
[[ "$ct" == *"text/html"* ]] && ok "/ content-type is text/html" || fail "/ content-type: $ct"

# 4. Health proxied from backend
status=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND_URL/health")
[ "$status" = "200" ] && ok "GET /health proxied → 200" || fail "GET /health proxied → $status (want 200)"

# 5. API proxied from backend (unauthenticated summary should return 401 or 200, not 502/504)
status=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND_URL/api/summary")
{ [ "$status" = "200" ] || [ "$status" = "401" ]; } && ok "GET /api/summary proxied → $status" || fail "GET /api/summary proxied → $status (want 200 or 401)"

# 6. Auth endpoint proxied (should return 405 GET or 200, not 502)
status=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND_URL/auth/me")
{ [ "$status" = "401" ] || [ "$status" = "200" ] || [ "$status" = "405" ]; } \
  && ok "GET /auth/me proxied → $status" || fail "GET /auth/me proxied → $status (want 401/200/405)"

# 7. Static assets served correctly (if built)
status=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND_URL/assets/")
{ [ "$status" = "403" ] || [ "$status" = "404" ] || [ "$status" = "200" ]; } \
  && ok "GET /assets/ → $status (directory listing disabled or empty)" \
  || fail "GET /assets/ → $status"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "frontend container smoke PASSED" && exit 0 || { echo "frontend container smoke FAILED"; exit 1; }
