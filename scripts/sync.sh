#!/usr/bin/env bash
# sync.sh — update all skills in skills/ from upstream repos
#
# Usage: bash scripts/sync.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$REPO_DIR/skills"
STAGING_DIR="$REPO_DIR/.agents/skills"

add_skill() {
  local slug="${1:?}"
  shift

  local args=( pnpx skills@latest add "$slug" --agent universal --copy --yes )
  if [ "$#" -eq 0 ]; then
    args+=( --skill '*' )
  else
    for s in "$@"; do args+=( --skill "$s" ); done
  fi

  echo "  $slug"
  (cd "$REPO_DIR" && "${args[@]}" 2>/dev/null)

  # Move from staging into skills/
  if [ -d "$STAGING_DIR" ]; then
    for skill_dir in "$STAGING_DIR"/*/; do
      local skill_name
      skill_name="$(basename "$skill_dir")"
      rm -rf "$SKILLS_DIR/${skill_name}"
      mv "$skill_dir" "$SKILLS_DIR/${skill_name}"
    done
    rmdir "$STAGING_DIR" 2>/dev/null || true
  fi
}

mkdir -p "$SKILLS_DIR"

echo "Syncing skills into skills/..."
add_skill flutter/skills
add_skill dart-lang/skills
add_skill cloudflare/skills
add_skill mattpocock/skills
add_skill android/skills

# Clean up staging dir
rm -rf "$REPO_DIR/.agents"

echo ""
echo "Done. Skills are in skills/"
