#!/usr/bin/env bash
# Upload a scene's objects.json to a running DejaView server.
#
#   BASE=https://your-tunnel.trycloudflare.com SCENE=kitchen scripts/roblox-objects-upload.sh
#
# The key is read from DEJAVIEW_KEY. It is never printed. The server route checks it
# when DV_KEY is configured. The file is validated on the server before it is written.
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
curl -fsS -X POST "${auth[@]}" -H "content-type: application/json" --data-binary "@$FILE" "$url"
echo
curl -fsS "${auth[@]}" "$url" -o /tmp/dejaview-objects-check.json
python3 -c 'import json,sys; d=json.load(open("/tmp/dejaview-objects-check.json")); print(f"{len(d.get(\"objects\", []))} objects live for {d.get(\"sceneId\", \"?\")}")'
