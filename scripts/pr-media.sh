#!/usr/bin/env bash
# Publish screenshots / GIFs / recordings for a pull request and print the
# markdown to paste into it.
#
#   scripts/pr-media.sh [-r <repo>] [-c <caption>] <file>...
#
# Files are uploaded content-addressed (first 12 hex chars of their sha256)
# under <repo>/<yyyy-mm>/ on the media host, so the same file always gets the
# same URL and nothing is ever overwritten. Images and GIFs render inline in
# GitHub markdown (fetched through Camo — keep GIFs under ~5 MB); video files
# are linked, GitHub does not inline external video.
#
# Host: nginx on `ssh www` (port 4700, /srv/git-pr), published as
# https://git-pr.mimiri.io by haproxy. Override with PR_MEDIA_HOST /
# PR_MEDIA_DIR / PR_MEDIA_URL.
set -euo pipefail

host="${PR_MEDIA_HOST:-www}"
dir="${PR_MEDIA_DIR:-/srv/git-pr}"
base="${PR_MEDIA_URL:-https://git-pr.mimiri.io}"
repo=""
caption=""

while getopts "r:c:h" opt; do
	case "$opt" in
		r) repo="$OPTARG" ;;
		c) caption="$OPTARG" ;;
		*) sed -n '2,15p' "$0"; exit 1 ;;
	esac
done
shift $((OPTIND - 1))
if [ $# -eq 0 ]; then
	sed -n '2,15p' "$0"
	exit 1
fi
if [ -z "$repo" ]; then
	repo="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
fi
month="$(date +%Y-%m)"

for file in "$@"; do
	[ -f "$file" ] || { echo "not a file: $file" >&2; exit 1; }
	ext="${file##*.}"
	ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
	sha="$(sha256sum "$file" | cut -c1-12)"
	name="${sha}.${ext}"
	target="${dir}/${repo}/${month}"
	url="${base}/${repo}/${month}/${name}"
	ssh "$host" "mkdir -p '$target'"
	# --ignore-existing: content-addressed, so an existing file is the same file
	rsync -q --ignore-existing --chmod=F644 "$file" "${host}:${target}/${name}"
	label="${caption:-$(basename "$file")}"
	case "$ext" in
		png|jpg|jpeg|gif|webp|svg) echo "![${label}](${url})" ;;
		*) echo "[${label}](${url})" ;;
	esac
done
