#!/usr/bin/env bash
# Tests deploy/migrate-from-systemd.sh. Run from repo root (via deploy/tests/run.sh).
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' MSYS2_ENV_CONV_EXCL='*'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/deploy/migrate-from-systemd.sh"
TMP="$ROOT/deploy/tests/tmp/migrate"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

SRC="$TMP/src"
DEST="$TMP/dest"
OUT="$TMP/out.txt"

fail() { echo "FAIL: $*" >&2; exit 1; }

run() {
  set +e
  SKIP_SYSTEMD_CHECK=1 SRC_DIR="$SRC" DEPLAO_DATA_DIR="$DEST" bash "$SCRIPT" >"$OUT" 2>&1
  RC=$?
  set -e
}

make_src() {
  rm -rf "$SRC"
  mkdir -p "$SRC/media"
  printf 'db' > "$SRC/deplao-tool.db"
  printf 'img' > "$SRC/media/a.jpg"
  printf '{"dbPath":"%s/ws1/deplao-tool.db"}' "$SRC" > "$SRC/workspaces.json"
  chmod 700 "$SRC"
}

# Case 1: migrates
make_src
cp "$SRC/workspaces.json" "$TMP/ws.orig"
run
[ "$RC" -eq 0 ] || fail "migrate: exit $RC, expected 0: $(cat "$OUT")"
[ -f "$DEST/media/a.jpg" ] || fail "migrate: dest/media/a.jpg missing"
grep -qF '/root/.config/Deplao/ws1/deplao-tool.db' "$DEST/workspaces.json" || fail "migrate: path not rewritten"
if grep -qF "$SRC" "$DEST/workspaces.json"; then fail "migrate: dest still has source path"; fi
cmp -s "$SRC/workspaces.json" "$TMP/ws.orig" || fail "migrate: source workspaces.json changed"
grep -qxF "source=$SRC" "$DEST/.porter-docker-migrated" || fail "migrate: marker missing source line"
case "$(uname -s)" in
  MINGW*|MSYS*) ;;
  *) [ "$(stat -c %a "$DEST")" = "755" ] || fail "migrate: dest mode is $(stat -c %a "$DEST"), expected 755" ;;
esac

# Case 2: re-run
run
[ "$RC" -eq 0 ] || fail "rerun: exit $RC, expected 0"
grep -qF 'Đã chuyển từ trước' "$OUT" || fail "rerun: missing 'Đã chuyển từ trước': $(cat "$OUT")"

# Case 3: missing DB
rm -rf "$SRC" "$DEST"
mkdir -p "$SRC"
run
[ "$RC" -eq 3 ] || fail "missing db: exit $RC, expected 3"

# Case 4: dirty dest
make_src
rm -rf "$DEST"
mkdir -p "$DEST"
printf 'x' > "$DEST/x.txt"
run
[ "$RC" -eq 4 ] || fail "dirty dest: exit $RC, expected 4"
[ ! -e "$DEST/.porter-docker-migrated" ] || fail "dirty dest: marker must not exist"

# Case 5: workspaces.json without the source path (relative dbPath) still migrates
make_src
rm -rf "$DEST"
printf '{"dbPath":"deplao-tool.db"}' > "$SRC/workspaces.json"
run
[ "$RC" -eq 0 ] || fail "relative paths: exit $RC, expected 0: $(cat "$OUT")"
grep -qxF "source=$SRC" "$DEST/.porter-docker-migrated" || fail "relative paths: marker missing"

echo "test_migrate: all cases OK"
