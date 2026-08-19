#!/usr/bin/env bash
# Rebuild the app and restart the service it runs under.
#
#   ./scripts/redeploy.sh              typecheck, build, restart, health-check
#   ./scripts/redeploy.sh --smoke      also run the database smoke test first
#   ./scripts/redeploy.sh --fast       skip the checks, just build and restart
#   ./scripts/redeploy.sh --no-restart build only, leave the service alone
#
# Overridable for installs that name things differently:
#   CSBG_SERVICE=csbg-intake.service   systemd unit to restart
#   CSBG_PORT=3100                     port to health-check
set -euo pipefail

SERVICE="${CSBG_SERVICE:-csbg-intake.service}"
PORT="${CSBG_PORT:-3100}"
RUN_SMOKE=0
RUN_CHECKS=1
DO_RESTART=1

for arg in "$@"; do
  case "$arg" in
    --smoke)      RUN_SMOKE=1 ;;
    --fast)       RUN_CHECKS=0 ;;
    --no-restart) DO_RESTART=0 ;;
    # print the header comment, however long it grows
    -h|--help)    awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *)            echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# Run from the project root wherever this was invoked from.
cd "$(dirname "$0")/.."
[[ -f package.json && -d app ]] || fail "run this from the CAP Trellis project (no package.json/app here)"

say "Deploying $(node -p "require('./package.json').name") from $(pwd)"
if git rev-parse --git-dir >/dev/null 2>&1; then
  DIRTY=""
  git diff --quiet && git diff --cached --quiet || DIRTY=" + uncommitted changes"
  echo "    branch $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)${DIRTY}"
  # worth seeing: a build from a dirty tree is not reproducible from the repo
  [[ -n "$DIRTY" ]] && echo "    (this build will include work that isn't committed)"
fi

if [[ "$RUN_CHECKS" == 1 ]]; then
  say "Typecheck"
  npm run typecheck || fail "typecheck — not deploying a build that doesn't compile"
  if [[ "$RUN_SMOKE" == 1 ]]; then
    say "Database smoke test"
    npm run smoke || fail "smoke test"
  fi
else
  echo "    checks skipped (--fast)"
fi

say "Build"
# Overwrites .next in place: a browser holding the previous page can 404 on
# hashed chunks until the restart below lands, so keep the two steps together.
NODE_ENV=production npm run build || fail "build"

if [[ "$DO_RESTART" == 0 ]]; then
  say "Built. Service left alone (--no-restart) — it is still serving the previous build."
  exit 0
fi

if ! systemctl list-unit-files "$SERVICE" >/dev/null 2>&1 || \
   [[ -z "$(systemctl list-unit-files --no-legend "$SERVICE" 2>/dev/null)" ]]; then
  say "Built, but no systemd unit named $SERVICE on this machine."
  echo "    Restart the app however this install runs it (docker compose restart, npm start, …),"
  echo "    or set CSBG_SERVICE to the right unit name."
  exit 0
fi

say "Restarting $SERVICE"
sudo systemctl restart "$SERVICE" || fail "systemctl restart $SERVICE"

say "Health check"
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/login" || true)"
  if [[ "$CODE" == "200" ]]; then
    echo "    /login → 200 after ${i}s"
    ACTIVE="$(systemctl is-active "$SERVICE" || true)"
    echo "    $SERVICE is $ACTIVE"
    say "Done. If a browser tab was open before the rebuild, reload it once."
    exit 0
  fi
  sleep 1
done

printf '\n\033[31mThe app did not answer on port %s within 30s (last status: %s).\033[0m\n' "$PORT" "${CODE:-none}" >&2
echo "Recent log lines:" >&2
sudo journalctl -u "$SERVICE" --since '2 minutes ago' --no-pager | tail -20 >&2
exit 1
