#!/usr/bin/env bash
# Rebuilds (if missing) the engine image of an older commit. Usage: rollback-vps.sh <BACKUP_DIR>/<timestamp>.commit
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/deplao-builder-t123}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/.deploy-backups}"
COMMIT_FILE="${1:?Usage: rollback-vps.sh <BACKUP_DIR>/<timestamp>.commit}"

# Builds the image for COMMIT inside $APP_DIR; prints the tag as the last stdout line.
build_image() {
  local commit="$1"
  local tag="deplao-engine:${commit:0:12}"
  (cd "$APP_DIR" && docker build -f docker/headless.Dockerfile -t "$tag" . >&2)
  printf '%s\n' "$tag"
}

COMMIT="$(cat "$COMMIT_FILE")"
TAG="deplao-engine:${COMMIT:0:12}"

if docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "Image $TAG còn trên máy"
  printf 'Built %s. Activate it: P-123 → Actions → "Deploy Deplao engine" → image=%s\n' "$TAG" "$TAG"
  exit 0
fi

cd "$APP_DIR"
git cat-file -e "$COMMIT^{commit}"
git reset --hard "$COMMIT"
TAG="$(build_image "$COMMIT")"
printf 'Built %s. Activate it: P-123 → Actions → "Deploy Deplao engine" → image=%s\n' "$TAG" "$TAG"
