-- Mini simulation of the ping pong physics, run with Lune:
--   lune run roblox/tests/pingpong_sim_test.luau
-- It exercises the real PingPongSim module and prints PASS/FAIL per scenario.
local roblox = require("@lune/roblox")
local Vector3 = roblox.Vector3
local CFrame = roblox.CFrame
_G.Vector3 = Vector3
_G.CFrame = CFrame

local Sim = require("../src/shared/PingPongSim")

local LEN, WID = Sim.LEN, Sim.WID
local function approx(a: number, b: number, eps: number?): boolean
	return math.abs(a - b) <= (eps or 1e-6)
end

local failures = 0
local function check(name: string, ok: boolean, detail: string?)
	if ok then
		print(("PASS  %s"):format(name))
	else
		failures += 1
		print(("FAIL  %s  %s"):format(name, detail or ""))
	end
end

-- Fly a state forward and count table/net events over `seconds`.
local function fly(st: any, seconds: number): { tables: { string }, nets: number, maxZ: number, dead: boolean }
	local dt = 1 / 240
	local tables = {}
	local nets = 0
	local maxZ = st.p.Z
	for _ = 1, math.floor(seconds / dt) do
		local ev = Sim.step(st, dt, LEN, WID)
		maxZ = math.max(maxZ, st.p.Z)
		if ev.table then
			table.insert(tables, ev.table)
		end
		if ev.net then
			nets += 1
		end
		if not st.live then
			break
		end
	end
	return { tables = tables, nets = nets, maxZ = maxZ, dead = not st.live }
end

-- 1. table geometry from four corners
local corners = {
	{ -WID / 2, 0, -LEN / 2 },
	{ WID / 2, 0, -LEN / 2 },
	{ WID / 2, 0, LEN / 2 },
	{ -WID / 2, 0, LEN / 2 },
}
local c, yaw, l, w = Sim.fromCorners(corners)
check("corners give the table size", c ~= nil and approx(l, LEN, 0.01) and approx(w, WID, 0.01), `l={l} w={w}`)

-- 2. the serve sits over the server's end
local sa = Sim.servePos("A", LEN)
local sb = Sim.servePos("B", LEN)
check("A serves from the far negative end", sa.Z < -LEN / 2 and sb.Z > LEN / 2)

-- 3. power: half charge crosses the net and lands in the far half
local p0 = Vector3.new(0, 0.9, -LEN / 2 - 1.5)
local dir = Vector3.new(0, 0, 1)
for _, case in { { 0.0, "min" }, { 0.5, "half" }, { 0.8, "80%" }, { 1.0, "max" } } do
	local charge = case[1]
	local label = case[2]
	local v = Sim.aimedVelocity(p0, dir, charge, LEN)
	local st = Sim.newState(p0, v, 0)
	local r = fly(st, 5)
	local first = r.tables[1]
	local landed = first ~= nil
	local farHalf = landed and first == "B"
	local out = r.maxZ > LEN / 2 + 0.5
	print(
		("INFO  %s charge: speed=%.1f first bounce=%s maxZ=%.2f nets=%d"):format(
			label,
			v.Magnitude,
			tostring(first),
			r.maxZ,
			r.nets
		)
	)
	if label == "min" or label == "half" or label == "80%" then
		check(`{label} charge lands on the far half`, farHalf, `first={first} maxZ={r.maxZ}`)
		check(`{label} charge clears the net`, r.nets == 0, `nets={r.nets}`)
	else
		check("full charge from a step back reaches the far edge", farHalf, `first={first} maxZ={r.maxZ}`)
	end
end

-- full charge from the table edge must go out
local edge = Sim.newState(
	Vector3.new(0, 0.9, -LEN / 2 - 0.2),
	Sim.aimedVelocity(Vector3.new(0, 0.9, -LEN / 2 - 0.2), dir, 1, LEN),
	0
)
local er = fly(edge, 5)
check("full charge at the table edge goes out", er.maxZ > LEN / 2 + 0.5, `maxZ={er.maxZ} first={er.tables[1]}`)

-- 4. one descent gives one bounce; the ball then keeps bouncing, which is why the server counts per bounce
local drop = Sim.newState(Vector3.new(0, 2, -1), Vector3.new(0, 0, 0), 0)
local first = fly(drop, 3)
check("the first table event is on the correct half", first.tables[1] == "A", `first={first.tables[1]}`)

-- 5. a single contact is reported once even when the ball skims the surface
local skim = Sim.newState(Vector3.new(0, 0.9, -1), Vector3.new(0, -1, 2), 0)
local sk = fly(skim, 0.5)
check("one skimmed contact is one reported bounce", #sk.tables == 1, `bounces={#sk.tables}`)

-- 5b. two real descents count as two bounces (the server turns the second into a point)
local bounce = Sim.newState(Vector3.new(0, 2, -1), Vector3.new(0, -6, 0), 0)
local two = fly(bounce, 3)
check("a second descent is a second bounce", #two.tables >= 2, `bounces={#two.tables}`)

-- 6. a flat shot into the net is a net event, not a table bounce
local netShot = Sim.newState(Vector3.new(0, 0.25, -2), Vector3.new(0, 0, 30), 0)
local nr = fly(netShot, 1)
check("a low flat shot hits the net", nr.nets >= 1, `nets={nr.nets}`)

-- 7. a shot aimed backwards never comes over the table: it goes out past the hitter's own end
local back = Sim.aimedVelocity(p0, Vector3.new(0, 0, -1), 0.5, LEN)
local backState = Sim.newState(p0, back, 0)
local br = fly(backState, 5)
check(
	"a backwards shot goes out past the hitter's end",
	#br.tables == 0 and br.maxZ < -LEN / 2 and backState.p.Z < p0.Z,
	`maxZ={br.maxZ} endZ={backState.p.Z} first={br.tables[1]}`
)

-- 8. speed stays under the smash cap
local fast = Sim.aimedVelocity(p0, dir, 1, LEN)
check("speed is capped", fast.Magnitude <= Sim.MAX_SPEED + 0.01, `speed={fast.Magnitude}`)

-- 9. spin: topspin dips the ball shorter than the same flat shot; backspin floats it longer
local function firstBounceZ(w: Vector3): number
	local st = Sim.newState(Vector3.new(0, 1.2, -LEN / 2), Vector3.new(0, 8, 14), 0)
	st.w = w
	for _ = 1, 240 * 3 do
		local ev = Sim.step(st, 1 / 240, LEN, WID)
		if ev.table then
			return st.p.Z
		end
	end
	return math.huge
end
local flatZ = firstBounceZ(Vector3.zero)
local topZ = firstBounceZ(Vector3.new(400, 0, 0)) -- forward roll for a ball moving along +Z
local backZ = firstBounceZ(Vector3.new(-400, 0, 0))
check("topspin dips shorter, backspin floats longer", topZ < flatZ and backZ > flatZ, `top={topZ} flat={flatZ} back={backZ}`)

-- 10. a brushing stroke spins the ball, and either face of the blade returns it
local brush = Sim.newState(Vector3.new(0, 1, 2), Vector3.new(0, -2, -20), 0)
Sim.paddleHit(brush, Vector3.new(0, 0, 1), Vector3.new(0, 12, 6))
check("brushing up the ball makes topspin toward the far end", brush.v.Z > 0 and brush.w.X > 50, `v={brush.v} w={brush.w}`)
local backhand = Sim.newState(Vector3.new(0, 1, 2), Vector3.new(0, -2, -20), 0)
Sim.paddleHit(backhand, Vector3.new(0, 0, -1), Vector3.new(0, 0, 4))
check("the other face of the blade returns the ball too", backhand.v.Z > 0, `v={backhand.v}`)

print(("\n%s  (%d failure(s))"):format(if failures == 0 then "ALL PASS" else "FAILURES", failures))
if failures > 0 then
	error("ping pong sim failures: " .. failures)
end
