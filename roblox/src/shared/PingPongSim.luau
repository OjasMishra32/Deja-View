-- The ping pong physics, shared by the server and every client (team/seb.md Update 5, section B).
-- Everything here is in the table frame: long axis Z, net at z = 0, table top at y = 0, studs.
-- The server owns the ball and runs this step; clients see the server's ball Part (no client prediction yet).
local Sim = {}

-- Roblox provides Vector3 as a global; the Lune test harness injects it through _G.
local Vector3 = (rawget(_G, "Vector3")) or Vector3

Sim.LEN = 9.78 -- 2.74 m table top
Sim.WID = 5.44 -- 1.525 m
Sim.TOP_Y = 0
Sim.NET_H = 0.54
Sim.NET_L = 6.53
Sim.BALL_R = 0.15 -- physics radius, bigger than a real ball so it is visible
Sim.GRAVITY = 35.0 -- 9.81 m/s^2 in studs
Sim.MAX_SPEED = 107 -- a 30 m/s smash
Sim.REST_TABLE = 0.88
Sim.DRAG = 0.02
Sim.DEAD_Y = -2.5
Sim.DEAD_AFTER = 1.5
Sim.SUBSTEPS = 4
Sim.WIN_SCORE = 11
Sim.SKIT_SCORE = 7
-- Spin, as in a real rally: the rubber grips the ball and a brushing stroke spins it; spin curves its flight (Magnus:
-- topspin dips, backspin floats, sidespin curls) and kicks it off the table (topspin jumps forward, backspin checks).
Sim.REAL_R = 0.071 -- the real ball's radius in studs (20 mm); spin and grip use it, collisions use BALL_R
Sim.MAGNUS = 0.0012 -- acceleration per (rad/s x stud/s)
Sim.SPIN_DECAY = 0.25 -- per second in the air
Sim.GRIP = 0.45 -- share of the brushing slip the rubber turns into spin
Sim.MAX_SPIN = 900 -- rad/s, about 140 turns a second
Sim.BOUNCE_KICK = 0.4 -- a hollow ball's share of contact slip removed on the table

local function fin(v: number): boolean
	return type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge
end

Sim.fin = fin

-- New ball state. `pos` and `vel` are table-frame vectors.
function Sim.newState(pos: Vector3, vel: Vector3, t: number): any
	return { p = pos, v = vel, t = t, live = true, lastTouch = t, bounces = 0, shot = 0, lastBounceAt = -1 }
end

-- Table frame from the four top corners the server sends (contract 6.6): corners in order around the top.
-- Returns centre, yaw (long axis), length and width in studs.
function Sim.fromCorners(corners: { any }): (Vector3?, number?, number?, number?)
	if type(corners) ~= "table" or #corners < 4 then
		return nil
	end
	local c = {}
	for i = 1, 4 do
		local v = corners[i]
		if type(v) ~= "table" then
			return nil
		end
		local x = v[1] or v.x
		local y = v[2] or v.y
		local z = v[3] or v.z
		if not (fin(x) and fin(y) and fin(z)) then
			return nil
		end
		c[i] = Vector3.new(x, y, z)
	end
	local centre = (c[1] + c[2] + c[3] + c[4]) / 4
	local e1, e2 = c[2] - c[1], c[3] - c[2]
	local long, short = e1, e2
	if e2.Magnitude > e1.Magnitude then
		long, short = e2, e1
	end
	if long.Magnitude < 1 or short.Magnitude < 1 then
		return nil
	end
	local yaw = math.atan2(-long.X, -long.Z)
	return centre, yaw, long.Magnitude, short.Magnitude
end

-- A serve waiting over the server's end line, at chest height.
function Sim.servePos(side: string, len: number): Vector3
	local dir = if side == "A" then -1 else 1
	return Vector3.new(0, 1.55, dir * (len / 2 + 0.7))
end

-- True when a table-frame point is over the top.
function Sim.overTable(p: Vector3, len: number, wid: number): boolean
	return math.abs(p.X) <= wid / 2 and math.abs(p.Z) <= len / 2
end

-- One fixed step of the ball. Returns an event table: { table = side?, net = boolean, dead = boolean }.
-- The caller decides points; this only moves the ball and reports what it touched.
function Sim.step(st: any, dt: number, len: number, wid: number): any
	local ev = {}
	if not st.live then
		return ev
	end
	local p, v = st.p, st.v
	local w: Vector3 = st.w or Vector3.zero
	local p0 = p
	v = v + Vector3.new(0, -Sim.GRAVITY * dt, 0)
	v = v - v * (Sim.DRAG * v.Magnitude * dt)
	if w.Magnitude > 1e-3 then
		v = v + w:Cross(v) * (Sim.MAGNUS * dt)
		w = w * math.max(0, 1 - Sim.SPIN_DECAY * dt)
	end
	p = p + v * dt

	-- Table top: the ball's bottom crosses y = 0 while moving down, inside the top rectangle.
	-- a small tolerance: a fast, flat shot can skim the surface for several steps before its centre drops below R
	if v.Y < 0 and p.Y - Sim.BALL_R <= Sim.TOP_Y + 0.06 and p0.Y - Sim.BALL_R > Sim.TOP_Y - 0.06 then
		local a = (p0.Y - Sim.BALL_R - Sim.TOP_Y) / math.max(1e-6, (p0.Y - Sim.BALL_R) - (p.Y - Sim.BALL_R))
		local hit = p0:Lerp(p, math.clamp(a, 0, 1))
		if Sim.overTable(hit, len, wid) then
			p = Vector3.new(hit.X, Sim.TOP_Y + Sim.BALL_R, hit.Z)
			v = Vector3.new(v.X * 0.95, -v.Y * Sim.REST_TABLE, v.Z * 0.95)
			if w.Magnitude > 1e-3 then
				-- the spinning contact point slips on the table: friction kicks the ball and eats some of the spin
				local slip = w:Cross(Vector3.new(0, -Sim.REAL_R, 0))
				v = v - Vector3.new(slip.X, 0, slip.Z) * Sim.BOUNCE_KICK
				w = w * 0.55
			end
			st.bounces += 1
			-- one physical contact can be detected for several frames while the ball skims the surface; report it once
			if st.t - (st.lastBounceAt or -1) > 0.12 then
				st.lastBounceAt = st.t
				ev.table = if hit.Z < 0 then "A" else "B"
			end
		end
	end

	-- Net: a thin box at z = 0. A ball that clears the top carries on.
	local crossed = (p0.Z < 0 and p.Z >= 0) or (p0.Z > 0 and p.Z <= 0)
	if crossed and math.abs(p.X) <= Sim.NET_L / 2 and p.Y - Sim.BALL_R < Sim.NET_H then
		local a = (0 - p0.Z) / math.max(1e-6, p.Z - p0.Z)
		local hit = p0:Lerp(p, math.clamp(a, 0, 1))
		if hit.Y - Sim.BALL_R < Sim.NET_H then
			p = Vector3.new(hit.X, hit.Y, 0)
			v = Vector3.new(v.X * 0.5, v.Y * 0.5, -v.Z * 0.2)
			ev.net = true
		end
	end

	if p.Y < Sim.DEAD_Y then
		st.live = false
		ev.dead = true
	end
	if st.t - st.lastTouch > Sim.DEAD_AFTER then
		st.live = false
		ev.dead = true
	end

	st.p, st.v, st.w, st.t = p, v, w, st.t + dt
	return ev
end

-- Reflect the ball off a paddle. `n` is the blade normal (either face: the one toward the ball is used), `pv` the
-- paddle velocity. Solved in the paddle's frame, then the paddle's velocity is added back so a swing carries into the
-- ball. The rubber grips: part of the sideways slip becomes spin (brush up for topspin, under for backspin).
function Sim.paddleHit(st: any, n: Vector3, pv: Vector3, restitution: number?)
	local rel = st.v - pv
	if rel:Dot(n) > 0 then
		n = -n -- the other face of the blade meets the ball
	end
	local vn = rel:Dot(n)
	if vn < 0 then
		local relN = n * vn
		local relT = rel - relN
		local w: Vector3 = (st.w or Vector3.zero) * 0.3 + n:Cross(relT) * (Sim.GRIP / Sim.REAL_R)
		if w.Magnitude > Sim.MAX_SPIN then
			w = w.Unit * Sim.MAX_SPIN
		end
		st.w = w
		-- bounce off the face; what the rubber does not turn into spin stays as sideways speed
		st.v = pv + relT * (0.85 - Sim.GRIP * 0.5) - relN * (restitution or 0.8)
		if st.v.Magnitude > Sim.MAX_SPEED then
			st.v = st.v.Unit * Sim.MAX_SPEED
		end
		st.lastTouch = st.t
		st.bounces = 0
	end
end

-- The phone/PC assist and the bot: aim at a target from p0 and solve for the launch velocity in time t.
function Sim.assistVelocity(p0: Vector3, target: Vector3, t: number): Vector3
	local g = Vector3.new(0, -Sim.GRAVITY, 0)
	return (target - p0) / t - g * (0.5 * t)
end

-- A return from the assist: aim x across the far half and pick a depth, then lift it over the net if needed.
function Sim.assistReturn(p0: Vector3, side: string, aim: number, flight: number, len: number, wid: number): Vector3
	local dir = if side == "A" then -1 else 1
	local x = math.clamp(aim, -1, 1) * (wid / 2 - 0.4)
	local target = Vector3.new(x, Sim.TOP_Y + Sim.BALL_R, dir * (len / 2 - 0.6))
	local v = Sim.assistVelocity(p0, target, math.clamp(flight, 0.5, 0.9))
	-- make sure it clears the net
	local zCross = math.abs(p0.Z)
	local tCross = if math.abs(v.Z) > 0.01 then zCross / math.abs(v.Z) else 1
	local yAtNet = p0.Y + v.Y * tCross - 0.5 * Sim.GRAVITY * tCross * tCross
	local need = Sim.NET_H + Sim.BALL_R + 0.3
	if yAtNet < need then
		v = v + Vector3.new(0, (need - yAtNet) / math.max(0.2, tCross), 0)
	end
	if v.Magnitude > Sim.MAX_SPEED then
		v = v.Unit * Sim.MAX_SPEED
	end
	return v
end

-- Power to distance, in the table frame. Reach runs from 0.80 to 1.13 table lengths: the minimum crosses the net
-- and lands in the far half, half power lands mid-court, and full power goes out from the table edge. Flight time
-- falls from 0.55 s to 0.22 s, so power is speed too. No post-hoc lift: it used to push every strong shot long.
function Sim.aimedVelocity(p0: Vector3, dirLocal: Vector3, charge: number, len: number): Vector3
	local reach = len * (0.80 + charge * 0.33)
	local flight = math.clamp(0.55 - charge * 0.33, 0.22, 0.55)
	local target = p0 + dirLocal * reach
	local surface = Sim.TOP_Y + Sim.BALL_R
	if target.Y < surface or dirLocal.Y <= 0.25 then
		-- a level or downward aim lands on the table; only a deliberate lob may sail long
		target = Vector3.new(target.X, surface, target.Z)
	end
	-- keep the landing point but lengthen the flight until the ball clears the net: a flat smash from far back
	-- would otherwise hit the tape. Power still shortens the flight, so it stays fast.
	local dz = math.abs(target.Z - p0.Z)
	local need = Sim.NET_H + Sim.BALL_R + 0.15
	local v = Sim.assistVelocity(p0, target, flight)
	if dz > 0.01 then
		for t = flight, 0.9, 0.02 do
			local candidate = Sim.assistVelocity(p0, target, t)
			local tc = t * math.abs(p0.Z) / dz
			local yAtNet = p0.Y + candidate.Y * tc - 0.5 * Sim.GRAVITY * tc * tc
			if yAtNet >= need then
				v = candidate
				break
			end
		end
	end
	if v.Magnitude > Sim.MAX_SPEED then
		v = v.Unit * Sim.MAX_SPEED
	end
	return v
end

return Sim
