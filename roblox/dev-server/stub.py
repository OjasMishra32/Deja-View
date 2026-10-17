#!/usr/bin/env python3
"""Stand-in for the Déjà View server's Roblox endpoints (team/contracts.md section 6), for local Studio tests.

    python3 roblox/dev-server/stub.py            # http://localhost:8788
Then set Config.USE_MOCK = false (BASE_FALLBACK is http://localhost:8788) and press Play in Studio.
Logs every request so you can check shapes and headers.
"""
import json, math, random, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SPM = 3.57
T0 = time.time()
SCENES = [
    {"id": "stub-room", "name": "Stub room", "mode": "photo", "status": "ready", "stage": "Ready", "progress": 1,
     "createdAt": "2026-10-17T10:00:00Z"},
    {"id": "stub-slow", "name": "Slow room", "mode": "video", "status": "ready", "stage": "Ready", "progress": 1,
     "createdAt": "2026-10-17T10:05:00Z"},
]
slow_calls = 0
last_players = {}


def room(scene_id):
    rng = random.Random(scene_id)
    W, D, H = 28, 24, 10
    parts = [[0, -0.5, 0, W, 1, D, 120, 104, 90],
             [0, H / 2, -D / 2 - 0.5, W, H, 1, 214, 208, 196],
             [0, H / 2, D / 2 + 0.5, W, H, 1, 214, 208, 196],
             [-W / 2 - 0.5, H / 2, 0, 1, H, D, 205, 199, 188],
             [W / 2 + 0.5, H / 2, 0, 1, H, D, 205, 199, 188],
             [-6, 1, -8, 10, 2, 4, 60, 90, 160, 0]]
    for _ in range(200):
        s = rng.uniform(0.5, 1.5)
        parts.append([round(rng.uniform(-13, 13), 2), s / 2, round(rng.uniform(-11, 11), 2), s, s, s,
                      rng.randint(80, 220), rng.randint(80, 220), rng.randint(80, 220), rng.choice([0, 1])])
    parts.sort(key=lambda p: p[1] - p[4] / 2)
    return {"sceneId": scene_id, "name": scene_id, "studsPerMeter": SPM, "spawn": [0, 0, 6], "parts": parts}


def judge():
    t = time.time() - T0
    a = t * 0.5
    x, z = math.cos(a) * 5, math.sin(a) * 4
    yaw = math.atan2(math.sin(a) * 5, -math.cos(a) * 4)
    return {"id": "quest-1", "name": "Judge", "kind": "vr", "x": x, "y": 0, "z": z, "yaw": yaw,
            "head": [x, 5.7, z], "hands": [[x - 1.2, 4.3, z - 1], [x + 1.2, 4.3, z - 1]]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        global slow_calls
        p = self.path.split("?")[0].strip("/").split("/")
        key = self.headers.get("x-dejaview-key")
        print("GET", self.path, "key" if key else "nokey", flush=True)
        if p == ["api", "scenes"]:
            return self.send(200, SCENES)
        if len(p) == 4 and p[:2] == ["api", "roblox"] and p[3] == "map":
            sid = p[2]
            if sid not in [s["id"] for s in SCENES]:
                return self.send(404, {"error": "No such scene"})
            if sid == "stub-slow" and slow_calls < 2:
                slow_calls += 1
                return self.send(202, {"status": "building", "retryAfter": 2})
            return self.send(200, room(sid))
        if len(p) == 3 and p[:2] == ["api", "presence"]:
            people = [dict(judge(), x=judge()["x"] / SPM, z=judge()["z"] / SPM, age=0.1)] if p[2] == "stub-room" else []
            return self.send(200, {"t": time.time(), "people": people})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        p = self.path.strip("/").split("/")
        b = self.body()
        if len(p) == 4 and p[:2] == ["api", "roblox"] and p[3] == "presence":
            players = b.get("players")
            assert isinstance(players, list), "players must be a JSON array"
            if players != last_players.get(p[2]):
                print("PRESENCE", p[2], json.dumps(b)[:300], flush=True)
                last_players[p[2]] = players
            others = [judge()] if p[2] == "stub-room" else []
            return self.send(200, {"t": time.time(), "others": others, "active": {"sceneId": "stub-room", "name": "Stub room"}})
        if len(p) == 4 and p[:2] == ["api", "roblox"] and p[3] == "event":
            print("EVENT", p[2], json.dumps(b), flush=True)
            return self.send(200, {"ok": True})
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    print(f"stub on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
