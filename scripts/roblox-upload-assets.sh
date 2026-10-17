#!/usr/bin/env bash
# Upload every personally approved object GLB for one scene and write its asset id into objects.json.
#
#   scripts/roblox-upload-assets.sh --dry-run [scene]
#   scripts/roblox-upload-assets.sh [scene]
#
# An object uploads only when preflight/approval.json says approved and its sha1 matches the
# current roblox.glb. Pending, denied, or changed files are skipped. The asset key is never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; shift; fi
SCENE="${1:-kitchen}"
SCENE_DIR="$ROOT/data/scenes/$SCENE"
[[ -d "$SCENE_DIR/objects" ]] || { echo "no objects for $SCENE at $SCENE_DIR" >&2; exit 1; }
cd "$ROOT"

PLAN="$(python3 -m pipeline.objects.assets --scene "$SCENE_DIR" --json)"
if [[ "$DRY" == 1 ]]; then
  echo "dry run: no upload, no key needed"
  python3 - "$PLAN" <<'PY'
import json, sys
items = json.loads(sys.argv[1])
for it in items:
    mark = "READY" if it["approved"] else "SKIP"
    print(f"{mark}  {it['objectId']:24} {it['bytes'] / 1e6:5.2f} MB  {it['reason']}")
print(f"\n{sum(1 for i in items if i['approved'])} approved, {sum(1 for i in items if not i['approved'])} skipped")
PY
  exit 0
fi

ASSET_KEY_FILE="${ROBLOX_ASSET_KEY_FILE:-$HOME/.config/dejaview/roblox-assets.key}"
[[ -s "$ASSET_KEY_FILE" ]] || { echo "missing assets:write key at $ASSET_KEY_FILE" >&2; exit 1; }
ASSET_KEY="$(tr -d '\r\n' < "$ASSET_KEY_FILE")"
CREATOR="${ROBLOX_CREATOR_ID:-4348140549}"
count=0
while IFS=$'\t' read -r id file sha approved reason; do
  if [[ "$approved" != "1" ]]; then
    echo "skip   $id: $reason"
    continue
  fi
  name="DejaView $SCENE $id"
  req="$(NAME="$name" CREATOR="$CREATOR" python3 -c 'import json,os; print(json.dumps({"assetType":"Model","displayName":os.environ["NAME"][:50],"description":"DejaView object mesh from the scan","creationContext":{"creator":{"userId":int(os.environ["CREATOR"])}}}))')"
  echo "upload $id ($(du -h "$file" | cut -f1))"
  code="$(curl -sS --max-time 180 -o /tmp/object-upload.json -w '%{http_code}' \
    -X POST https://apis.roblox.com/assets/v1/assets \
    -H "x-api-key: $ASSET_KEY" \
    -F "request=$req;type=application/json" \
    -F "fileContent=@$file;type=model/gltf-binary")"
  if [[ "$code" != "200" ]]; then
    echo "upload failed for $id: http $code" >&2
    sed -e 's/[A-Za-z0-9._-]\{40,\}/<redacted>/g' /tmp/object-upload.json >&2
    exit 1
  fi
  op="$(python3 -c 'import json; d=json.load(open("/tmp/object-upload.json")); print(d.get("operationId") or (d.get("path") or "").split("/")[-1])')"
  [[ -n "$op" ]] || { echo "no operation id for $id" >&2; exit 1; }
  for _ in $(seq 1 60); do
    sleep 2
    curl -sS --max-time 30 -o /tmp/object-op.json -H "x-api-key: $ASSET_KEY" "https://apis.roblox.com/assets/v1/operations/$op"
    if python3 -c 'import json; raise SystemExit(0 if json.load(open("/tmp/object-op.json")).get("done") else 1)'; then break; fi
  done
  asset="$(python3 -c 'import json; d=json.load(open("/tmp/object-op.json")); r=d.get("response") or {}; print(r.get("assetId") or ""); raise SystemExit(1 if d.get("error") else 0)')" || {
    echo "upload failed for $id" >&2
    python3 -c 'import json; print(json.load(open("/tmp/object-op.json")).get("error"))' >&2
    exit 1
  }
  [[ -n "$asset" ]] || { echo "no asset id for $id" >&2; exit 1; }
  python3 -c 'import sys; from pipeline.objects.assets import record; record(sys.argv[1], sys.argv[2], int(sys.argv[3]))' "$SCENE_DIR" "$id" "$asset"
  echo "asset  $id -> $asset"
  count=$((count + 1))
done < <(python3 - "$PLAN" <<'PY'
import json, sys
for it in json.loads(sys.argv[1]):
    print(f"{it['objectId']}\t{it['glb']}\t{it['sha1']}\t{1 if it['approved'] else 0}\t{it['reason']}")
PY
)
echo "uploaded $count approved object(s) for $SCENE"
