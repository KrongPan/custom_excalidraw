#!/bin/sh
# entrypoint — makes a bare `docker compose up` enough to have a working site:
#
#   1. move legacy flat boards (<id>.excalidraw) into per-board folders, which is
#      idempotent and a no-op once everything already sits in folders;
#   2. write the catalogue (index.html + manifest.json) from whatever is in the
#      data folder, so a fresh install is not a 404 and a moved library is not a
#      stale page.
#
# Thumbnails are NOT rendered here: that needs the excalidraw CLI and a browser,
# which do not belong in a runtime image. Boards without a preview show the
# "ยังไม่มีภาพตัวอย่าง" tile until the host renders them — either
# `node scripts/watch-previews.mjs` (keeps them in step) or a one-off
# `node gallery/build.mjs`.
#
# Both steps are best-effort: a failure is logged and the server still starts.
# Set SKIP_MIGRATE=1 / SKIP_GALLERY=1 to opt out.
set -eu

: "${DATA_DIR:=/data}"
: "${GALLERY_DIR:=/gallery}"
export DATA_DIR GALLERY_DIR

if [ "${SKIP_MIGRATE:-0}" != "1" ] && [ -d "$DATA_DIR" ]; then
  node /srv/tools/migrate-scenes.mjs || echo "warn: board migration failed; continuing"
fi

if [ "${SKIP_GALLERY:-0}" != "1" ] && [ -d "$GALLERY_DIR" ] && [ -w "$GALLERY_DIR" ]; then
  SCENES_DIR="$DATA_DIR" SITE_DIR="$GALLERY_DIR" node /srv/tools/build.mjs --no-render ||
    echo "warn: catalogue build failed; continuing"
fi

exec "$@"
