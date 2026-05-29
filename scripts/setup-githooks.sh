#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
hooks="$root/.githooks"

chmod +x "$hooks/strip-ai-trailers.sh" "$hooks/commit-msg" "$hooks/prepare-commit-msg"
git -C "$root" config core.hooksPath .githooks

echo "Git hooks installed (core.hooksPath=.githooks)"
echo "Commits are blocked if cursoragent / @cursor.com attribution remains in the message."
