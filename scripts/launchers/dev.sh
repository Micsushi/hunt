#!/usr/bin/env bash
# Start backend (auto-reload) + frontend (HMR) for development.
# Ctrl+C kills both.
set -euo pipefail
cd "$(dirname "$0")/../.."

PYTHON=".venv/bin/python"
[[ -x "$PYTHON" ]] || PYTHON="venv/bin/python"
[[ -x "$PYTHON" ]] || PYTHON="python3"

cleanup() {
  echo ""
  echo "[dev] Stopping…"
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  echo "[dev] Done."
}
trap cleanup INT TERM

echo "[dev] Starting backend (--reload) on :8000…"
"$PYTHON" -m backend.app --reload &
BACKEND_PID=$!

echo "[dev] Starting frontend (HMR) on :5173…"
cd frontend && npm run dev &
FRONTEND_PID=$!
cd ..

echo "[dev] Both running. Ctrl+C to stop."
echo "[dev]   Backend:  http://localhost:8000"
echo "[dev]   Frontend: http://localhost:5173"
wait "$BACKEND_PID" "$FRONTEND_PID"
