#!/usr/bin/env bash
# Build the Roblox place from roblox/ and publish it to the test experience over Open Cloud.
#
#   scripts/roblox-publish.sh                 # publish to the DejaView PingPong Test place
#   UNIVERSE=... PLACE=... scripts/roblox-publish.sh
#
# The API key lives in ~/.config/dejaview/roblox.key (mode 600). This script never prints it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="${ROBLOX_KEY_FILE:-$HOME/.config/dejaview/roblox.key}"
UNIVERSE="${UNIVERSE:-10771472038}"
PLACE="${PLACE:-119735023233195}"
ROJO="${ROJO_BIN:-/tmp/rojo/rojo}"
OUT="${OUT:-/tmp/dejaview-place.rbxl}"

[[ -s "$KEY_FILE" ]] || { echo "missing API key at $KEY_FILE" >&2; exit 1; }
[[ -x "$ROJO" ]] || { echo "missing rojo at $ROJO" >&2; exit 1; }

echo "building $OUT"
"$ROJO" build "$ROOT/roblox" -o "$OUT" >/dev/null

KEY="$(tr -d '\r\n' < "$KEY_FILE")"
if [[ "${1:-}" == "--upload-object" ]]; then
	FILE="${2:-}"
	NAME="${3:-DejaView object}"
	REPORT="$(dirname "$FILE")/preflight/preflight.json"
	if [[ "${APPROVE_ASSET:-}" != "1" ]]; then
		echo "No upload. Run pipeline/objects/preflight.py, inspect its sheet, then set APPROVE_ASSET=1." >&2
		exit 2
	fi
	if [[ ! -f "$REPORT" ]] || ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("clear") is True else 1)' "$REPORT"; then
		echo "No upload: the preflight is missing or not clear. The sheet and scan must be reviewed." >&2
		exit 2
	fi
	CREATOR="${ROBLOX_CREATOR_ID:-4348140549}"
	[[ -n "$FILE" && -f "$FILE" ]] || { echo "usage: scripts/roblox-publish.sh --upload-object <glb> [name]" >&2; exit 2; }
	REQ="$(NAME="$NAME" CREATOR="$CREATOR" python3 -c 'import json,os; print(json.dumps({"assetType":"Model","displayName":os.environ["NAME"][:50],"description":"DejaView object mesh from the scan","creationContext":{"creator":{"userId":int(os.environ["CREATOR"])}}}))')"
	echo "uploading $(du -h "$FILE" | cut -f1) as asset for creator $CREATOR"
	CODE="$(curl -sS --max-time 180 -o /tmp/object-upload.json -w '%{http_code}' \
		-X POST https://apis.roblox.com/assets/v1/assets \
		-H "x-api-key: $KEY" \
		-F "request=$REQ;type=application/json" \
		-F "fileContent=@$FILE;type=model/gltf-binary")"
	echo "upload request: http $CODE"
	if [[ "$CODE" != 200 ]]; then
		sed -e 's/[A-Za-z0-9._-]\{40,\}/<redacted>/g' /tmp/object-upload.json
		exit 1
	fi
	OP="$(python3 -c 'import json; d=json.load(open("/tmp/object-upload.json")); print(d.get("operationId") or (d.get("path") or "").split("/")[-1])')"
	[[ -n "$OP" ]] || { echo "no operation id"; exit 1; }
	for attempt in $(seq 1 60); do
		sleep 2
		curl -sS --max-time 30 -o /tmp/object-op.json -H "x-api-key: $KEY" "https://apis.roblox.com/assets/v1/operations/$OP"
		DONE="$(python3 -c 'import json; d=json.load(open("/tmp/object-op.json")); print(1 if d.get("done") else 0)')"
		if [[ "$DONE" == "1" ]]; then break; fi
	done
	python3 -c 'import json; d=json.load(open("/tmp/object-op.json")); print("asset", (d.get("response") or {}).get("assetId")) if not d.get("error") else (_ for _ in ()).throw(SystemExit("upload failed: " + str(d["error"]))))'
	exit $?
fi
echo "publishing to universe $UNIVERSE place $PLACE"
for attempt in 1 2 3 4 5; do
  code="$(curl -sS --max-time 120 -o /tmp/roblox-publish.out -w '%{http_code}' \
    -X POST "https://apis.roblox.com/universes/v1/$UNIVERSE/places/$PLACE/versions?versionType=Published" \
    -H "x-api-key: $KEY" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$OUT")"
  echo "attempt $attempt: http $code"
  if [[ "$code" == 200 ]]; then break; fi
  if [[ "$code" == 409 ]]; then sleep 45; continue; fi
  break
done
sed -e 's/[A-Za-z0-9._-]\{40,\}/<redacted>/g' /tmp/roblox-publish.out
[[ "$code" == 200 ]] || exit 1
echo "published: https://www.roblox.com/games/$PLACE"

# Running servers keep the old scripts until they stop; restart the universe so new joins get this build.
rcode="$(curl -sS --max-time 60 -o /tmp/roblox-restart.out -w '%{http_code}' \
  -X POST "https://apis.roblox.com/cloud/v2/universes/$UNIVERSE:restartServers" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{}')"
echo "restart servers: http $rcode"
if [[ "$rcode" != 200 ]]; then
  sed -e 's/[A-Za-z0-9._-]\{40,\}/<redacted>/g' /tmp/roblox-restart.out
fi
