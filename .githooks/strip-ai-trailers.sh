#!/bin/sh
# Remove AI editor/agent attribution lines from commit messages.
# Used by prepare-commit-msg and commit-msg hooks.
# Must strip Cursor-injected: Co-authored-by: Cursor <cursoragent@cursor.com>
# Refuses the commit if forbidden attribution remains after stripping.

file=$1
[ -n "$file" ] && [ -f "$file" ] || exit 0

tmp=$(mktemp "${TMPDIR:-/tmp}/lsm-commit-msg.XXXXXX") || exit 0

sed -E \
	-e '/^Co-authored-by: Cursor /d' \
	-e '/^Co-authored-by:.*cursoragent/Id' \
	-e '/^Co-authored-by:.*cursoragent@/Id' \
	-e '/^Co-authored-by:.*@cursor\.com/Id' \
	-e '/^Co-authored-by:.*cursor\.com>/Id' \
	-e '/^Co-authored-by:.*[Cc]ursor/d' \
	-e '/^Co-authored-by:.*[Cc]opilot/d' \
	-e '/^Signed-off-by: Cursor /d' \
	-e '/^Signed-off-by:.*cursoragent/Id' \
	-e '/^Signed-off-by:.*@cursor\.com/Id' \
	-e '/^Generated with Cursor/d' \
	-e '/^Made with AI/d' \
	-e '/^Made with [Cc]ursor/d' \
	"$file" >"$tmp" || exit 0

mv "$tmp" "$file"

# Block only attribution/marketing lines — not incidental mentions in the commit body.
if grep -Eiq '^(Co-authored-by|Signed-off-by):.*(cursoragent|@cursor\.com|[Cc]ursor|[Cc]opilot)' "$file"; then
	echo "commit-msg hook: refused — AI co-author attribution must not reach git" >&2
	exit 1
fi
if grep -Eiq '^(Generated with Cursor|Made with AI|Made with Cursor)' "$file"; then
	echo "commit-msg hook: refused — AI marketing footer must not reach git" >&2
	exit 1
fi

exit 0
