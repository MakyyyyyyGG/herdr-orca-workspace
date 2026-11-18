#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_HOME=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
FORCE=0
BACKUP=0
SWITCH=0
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-home) APP_HOME=$2; shift 2 ;;
    --force|-f) FORCE=1; shift ;;
    --backup) BACKUP=1; shift ;;
    --switch) SWITCH=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  rm -f "$APP_HOME/layouts/orca.json" "$APP_HOME/layouts/orca.svg"
  for mod in "$SCRIPT_DIR"/mods/*; do
    [ -d "$mod" ] && rm -rf "$APP_HOME/mods/$(basename "$mod")"
  done
  echo "Removed Orca from $APP_HOME."
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
INSTALLED=0
UPDATED=0

for group in mods layouts; do
  find "$SCRIPT_DIR/$group" -type f | while IFS= read -r src; do
    name=$(basename "$src")
    [ "$name" = "gpui-kit.d.ts" ] || [ "$name" = "jsconfig.json" ] && continue
    rel=${src#"$SCRIPT_DIR/"}
    dst="$APP_HOME/$rel"
    if [ -e "$dst" ]; then
      if ! cmp -s "$src" "$dst"; then
        if [ "$FORCE" -ne 1 ]; then
          echo "A different copy of $rel already exists. Re-run with --force (and optionally --backup) to update it." >&2
          exit 1
        fi
        [ "$BACKUP" -eq 1 ] && cp "$dst" "$dst.bak-$STAMP"
        cp "$src" "$dst"
      fi
    else
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
    fi
  done
done

echo "Orca installed in $APP_HOME."
if [ "$SWITCH" -eq 1 ] && command -v herdr-app >/dev/null 2>&1; then
  herdr-app do layout.switch --name orca
else
  echo "In Herdr select the orca layout, or run 'herdr-app do layout.switch --name orca'."
fi
