#!/usr/bin/env bash
# Tests deploy-vps.sh / rollback-vps.sh with fake git/docker. Run from repo root (via deploy/tests/run.sh).
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' MSYS2_ENV_CONV_EXCL='*'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$ROOT/deploy/tests/tmp/build"
rm -rf "$TMP"
mkdir -p "$TMP/bin" "$TMP/app"
trap 'rm -rf "$TMP"' EXIT

export FAKE_LOG="$TMP/log"
OUT="$TMP/out.txt"
A40="$(printf 'a%.0s' $(seq 1 40))"
B40="$(printf 'b%.0s' $(seq 1 40))"
C40="$(printf 'c%.0s' $(seq 1 40))"

fake() { # name, body
  {
    echo '#!/usr/bin/env bash'
    echo 'echo "$(basename "$0") $*" >> "$FAKE_LOG"'
    printf '%s\n' "$2"
  } > "$TMP/bin/$1"
  chmod +x "$TMP/bin/$1"
}

fake git 'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "HEAD" ]; then printf "%s\n" "'"$A40"'"; fi; exit 0'
fake docker 'case "${1:-} ${2:-}" in
  "info "*) [ "${FAKE_NO_DOCKER:-}" = "1" ] && exit 1 ;;
  "image inspect") [ "${FAKE_NO_IMAGE:-}" = "1" ] && exit 1 ;;
esac
exit 0'
fake flock 'exit 0'
fake systemctl 'exit 0'
fake npm 'exit 0'
PATH="$TMP/bin:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }

run() { # script args...
  : > "$FAKE_LOG"
  rm -rf "$TMP/app/.deploy-backups"
  set +e
  APP_DIR="$TMP/app" DEPLOY_SHA="$B40" bash "$@" >"$OUT" 2>&1
  RC=$?
  set -e
}

# Case 1: build
run "$ROOT/deploy/deploy-vps.sh"
[ "$RC" -eq 0 ] || fail "build: exit $RC: $(cat "$OUT")"
grep -qxF 'docker build -f docker/headless.Dockerfile -t deplao-engine:aaaaaaaaaaaa .' "$FAKE_LOG" || fail "build: docker build line missing: $(cat "$FAKE_LOG")"
[ "$(cat "$TMP/app/.deploy-backups/built-image")" = "deplao-engine:aaaaaaaaaaaa" ] || fail "build: built-image wrong"
grep -qF 'image=deplao-engine:aaaaaaaaaaaa' "$OUT" || fail "build: stdout missing image=...: $(cat "$OUT")"
if grep -qE '^(systemctl|npm|docker compose|docker run|docker stop|docker rm)' "$FAKE_LOG"; then
  fail "build: forbidden command in log: $(cat "$FAKE_LOG")"
fi

# Case 2: no docker access
FAKE_NO_DOCKER=1 run "$ROOT/deploy/deploy-vps.sh"
[ "$RC" -eq 2 ] || fail "no docker: exit $RC, expected 2"
if grep -q '^git ' "$FAKE_LOG"; then fail "no docker: git was called"; fi

# Case 3: rollback, image still present
printf '%s\n' "$C40" > "$TMP/c.commit"
run "$ROOT/deploy/rollback-vps.sh" "$TMP/c.commit"
[ "$RC" -eq 0 ] || fail "rollback present: exit $RC"
if grep -q 'docker build' "$FAKE_LOG"; then fail "rollback present: must not build"; fi
grep -qF 'deplao-engine:cccccccccccc' "$OUT" || fail "rollback present: stdout missing tag"

# Case 4: rollback, image gone
FAKE_NO_IMAGE=1 run "$ROOT/deploy/rollback-vps.sh" "$TMP/c.commit"
[ "$RC" -eq 0 ] || fail "rollback missing: exit $RC: $(cat "$OUT")"
grep -qxF "git reset --hard $C40" "$FAKE_LOG" || fail "rollback missing: git reset line missing"
grep -qxF 'docker build -f docker/headless.Dockerfile -t deplao-engine:cccccccccccc .' "$FAKE_LOG" || fail "rollback missing: docker build line missing"

echo "test_build: all cases OK"
