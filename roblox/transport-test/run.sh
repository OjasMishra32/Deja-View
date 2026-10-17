#!/usr/bin/env bash
# Transport test (team/shivin.md 9.3): serve the scenes fixture + a ~300 KB map through a Cloudflare quick tunnel.
# Then set dejaview_base (or Config.BASE_FALLBACK) to the printed https URL and join the LIVE game.
set -euo pipefail
DIR="$(mktemp -d)/dv-fixture"
mkdir -p "$DIR/api"
python3 - "$DIR" <<'PY'
import json, sys, os
d = sys.argv[1]
scenes = [{"id":"big","name":"Big","mode":"photo","status":"ready","stage":"Ready","progress":1,"createdAt":"2026-10-17T10:00:00Z"}]
open(os.path.join(d,"api","scenes"),"w").write(json.dumps(scenes))
os.makedirs(os.path.join(d,"api","roblox","big"), exist_ok=True)
big = {"sceneId":"big","name":"Big","studsPerMeter":3.57,"spawn":[0,0,5],
       "parts":[[i%50,0.5,i//50,1,1,1,120,104,90] for i in range(8000)]}
s = json.dumps(big)
open(os.path.join(d,"api","big"),"w").write(s)
open(os.path.join(d,"api","roblox","big","map"),"w").write(s)
print("map bytes:", len(s))
PY
cd "$DIR"
python3 -m http.server 8000 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
echo "serving $DIR on :8000; starting tunnel (Ctrl+C to stop)"
cloudflared tunnel --url http://localhost:8000
