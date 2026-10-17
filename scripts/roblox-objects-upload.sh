#!/usr/bin/env bash
# Upload a scene's objects.json to a running DejaView server.
#
#   BASE=https://your-tunnel.trycloudflare.com SCENE=kitchen scripts/roblox-objects-upload.sh
#
# The key is read from DEJAVIEW_KEY. It is never printed. The server route checks it
# when DV_KEY is configured. The server checks that `objects` is an array and the units are studs before it writes.
set -euo pipefail

BASE="${BASE:-}"
SCENE="${SCENE:-kitchen}"
FILE="${FILE:-data/scenes/$SCENE/objects.json}"
KEY="${DEJAVIEW_KEY:-}"

if [[ -z "$BASE" ]]; then
	echo "BASE is required, for example BASE=https://your-tunnel.trycloudflare.com" >&2
	exit 2
fi
if [[ ! -f "$FILE" ]]; then
	echo "missing $FILE" >&2
	exit 2
fi

auth=()
if [[ -n "$KEY" ]]; then
	auth=(-H "x-dejaview-key: $KEY")
fi

url="${BASE%/}/api/roblox/$SCENE/objects"
# ${auth[@]+...}: macOS bash 3.2 treats an empty array as unbound under set -u
curl -fsS -X POST ${auth[@]+"${auth[@]}"} -H "content-type: application/json" --data-binary "@$FILE" "$url"
echo
curl -fsS ${auth[@]+"${auth[@]}"} "$url" | python3 -c 'import json, sys; d = json.load(sys.stdin); print(len(d.get("objects", [])), "objects live for", d.get("sceneId", "?"))'
