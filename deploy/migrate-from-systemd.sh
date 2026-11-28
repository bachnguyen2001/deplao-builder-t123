#!/usr/bin/env bash
# Copies Electron data of the systemd `deplao-web` install into the directory the
# Porter `deplao` container bind-mounts. The source is never modified.
# Usage: sudo [SRC_DIR=..] [DEPLAO_DATA_DIR=..] [DEPLAO_SERVICE=..] deploy/migrate-from-systemd.sh
# Exit: 0 done / already migrated, 2 systemd still running, 3 no source data, 4 dest not empty.
set -Eeuo pipefail

SRC_DIR="${SRC_DIR:-/home/deplao/.config/Deplao}"
DEPLAO_DATA_DIR="${DEPLAO_DATA_DIR:-/opt/deplao-data}"
DEPLAO_SERVICE="${DEPLAO_SERVICE:-deplao-web}"
SKIP_SYSTEMD_CHECK="${SKIP_SYSTEMD_CHECK:-}"
CONTAINER_DIR=/root/.config/Deplao
MARKER=.porter-docker-migrated

if [ "$SKIP_SYSTEMD_CHECK" != "1" ] && systemctl is-active --quiet "$DEPLAO_SERVICE"; then
  echo "Dừng $DEPLAO_SERVICE trước: sudo systemctl stop $DEPLAO_SERVICE" >&2
  exit 2
fi

if [ ! -f "$SRC_DIR/deplao-tool.db" ]; then
  echo "Không thấy $SRC_DIR/deplao-tool.db" >&2
  exit 3
fi

if [ -e "$DEPLAO_DATA_DIR/$MARKER" ]; then
  echo "Đã chuyển từ trước ($DEPLAO_DATA_DIR/$MARKER) — không làm gì"
  exit 0
fi

if [ -d "$DEPLAO_DATA_DIR" ] && [ -n "$(find "$DEPLAO_DATA_DIR" -mindepth 1 -print -quit)" ]; then
  echo "$DEPLAO_DATA_DIR không rỗng mà chưa có $MARKER — kiểm tra tay" >&2
  exit 4
fi

mkdir -p "$DEPLAO_DATA_DIR"
cp -a "$SRC_DIR/." "$DEPLAO_DATA_DIR/"

# cp -a copied the 700 mode of the source root; the runner user must read the marker.
chmod 755 "$DEPLAO_DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown root:root "$DEPLAO_DATA_DIR"
fi

WS="$DEPLAO_DATA_DIR/workspaces.json"
if [ -f "$WS" ]; then
  count="$({ grep -oF "$SRC_DIR" "$WS" || true; } | wc -l | tr -d ' ')"
  if [ "$count" -gt 0 ]; then
    esc_src="$(printf '%s' "$SRC_DIR" | sed 's/[][\.*^$|]/\\&/g')"
    esc_dst="$(printf '%s' "$CONTAINER_DIR" | sed 's/[\&|]/\\&/g')"
    sed -i "s|$esc_src|$esc_dst|g" "$WS"
    echo "workspaces.json: đã đổi $count đường dẫn $SRC_DIR → $CONTAINER_DIR"
  fi
  if grep -qF '/home/' "$WS"; then
    echo "CẢNH BÁO: workspaces.json còn đường dẫn /home/… — xem tay"
  fi
fi

{
  echo "source=$SRC_DIR"
  echo "copied_at=$(date -u +%FT%TZ)"
  echo "files=$(find "$DEPLAO_DATA_DIR" -type f | wc -l | tr -d ' ')"
} > "$DEPLAO_DATA_DIR/$MARKER"
chmod 644 "$DEPLAO_DATA_DIR/$MARKER"

echo "Xong: $(du -sh "$DEPLAO_DATA_DIR" | cut -f1)	$DEPLAO_DATA_DIR. Bản gốc $SRC_DIR giữ nguyên."
