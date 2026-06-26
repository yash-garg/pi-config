#!/usr/bin/env bash

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

function link() {
  local source target
  source="${1:?}"
  target="${2:?}"

  rm -rf "$target"
  ln -s "$source" "$target"
}

function link_pi() {
  local name
  name="${1:?}"
  link "$REPO/${name}" "$HOME/.pi/agent/${name}"
}

mkdir -p "$HOME/.pi/agent"
link_pi agents
link_pi extensions
link_pi prompts
link_pi sandbox.json
link_pi settings.json
link_pi skills
link_pi themes

link "$REPO/mcporter" "$HOME/.mcporter"

echo "Installing extension deps..."
for pkg in "$HOME/.pi/agent/extensions/"*/package.json; do
  dir="$(dirname "$pkg")"
  [ -d "$dir/node_modules" ] && continue
  echo "  $(basename "$dir")"
  pnpm install --dir "$dir" --ignore-scripts --silent || true
done

echo "Done."
