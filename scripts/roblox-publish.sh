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
