#!/usr/bin/env bash
# Builds the Deplao engine image deplao-engine:<sha12> on the VPS. It never starts a container:
# activation is the P-123 workflow "Deploy Deplao engine".
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/deplao-builder-t123}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/.deploy-backups}"
BRANCH="${DEPLOY_BRANCH:-main}"
SHA="${DEPLOY_SHA:-}"

# Builds the image for COMMIT inside $APP_DIR; prints the tag as the last stdout line.
build_image() {
  local commit="$1"
  local tag="deplao-engine:${commit:0:12}"
  (cd "$APP_DIR" && docker build -f docker/headless.Dockerfile -t "$tag" . >&2)
  printf '%s\n' "$tag"
}

if ! docker info >/dev/null 2>&1; then
  echo "User $(id -un) cannot use docker (add it to the docker group)" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/build.lock"
flock -n 9 || { echo 'Another Deplao build is running'; exit 1; }

cd "$APP_DIR"
git fetch --prune origin "$BRANCH"
TARGET="${SHA:-origin/$BRANCH}"
git cat-file -e "$TARGET^{commit}"

CURRENT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
printf '%s\n' "$CURRENT" > "$BACKUP_DIR/$STAMP.commit"

# Secrets, profile, SQLite and media stay outside Git and are never overwritten.
git reset --hard "$TARGET"

COMMIT="$(git rev-parse HEAD)"
TAG="$(build_image "$COMMIT")"
printf '%s\n' "$TAG" > "$BACKUP_DIR/built-image"

# Keep the last five commit pointers for manual rollback.
ls -1t "$BACKUP_DIR"/*.commit 2>/dev/null | tail -n +6 | xargs -r rm -f
printf 'Built %s. Activate it: P-123 → Actions → "Deploy Deplao engine" → image=%s\n' "$TAG" "$TAG"
