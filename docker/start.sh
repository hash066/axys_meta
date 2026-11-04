#!/bin/bash
# One-container start for platforms that run a single service (Render, Railway, Fly.io ...):
# the Muse gateway listens on loopback only; the app serves on $PORT. If either process exits, the container exits so the platform restarts it.
set -u
/opt/venv/bin/python -m uvicorn gateway.server:app --host 127.0.0.1 --port 8766 &
npm start &
wait -n
code=$?
kill 0 2>/dev/null
exit "$code"
