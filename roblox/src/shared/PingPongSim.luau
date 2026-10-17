-- The ping pong physics, shared by the server and every client (team/seb.md Update 5, section B).
-- Everything here is in the table frame: long axis Z, net at z = 0, table top at y = 0, studs.
-- The server owns the ball; clients use the same step to predict and to smooth the render.
local Sim = {}

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

local function fin(v: number): boolean
	return type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge
end

Sim.fin = fin

-- New ball state. `pos` and `vel` are table-frame vectors.
function Sim.newState(pos: Vector3, vel: Vector3, t: number): any
	return { p = pos, v = vel, t = t, live = true, lastTouch = t, bounces = 0, shot = 0 }
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
	local p0 = p
	v = v + Vector3.new(0, -Sim.GRAVITY * dt, 0)
	v = v - v * (Sim.DRAG * v.Magnitude * dt)
	p = p + v * dt

	-- Table top: the ball's bottom crosses y = 0 while moving down, inside the top rectangle.
	if v.Y < 0 and p.Y - Sim.BALL_R <= Sim.TOP_Y and p0.Y - Sim.BALL_R > Sim.TOP_Y then
		local a = (p0.Y - Sim.BALL_R - Sim.TOP_Y) / math.max(1e-6, (p0.Y - Sim.BALL_R) - (p.Y - Sim.BALL_R))
		local hit = p0:Lerp(p, math.clamp(a, 0, 1))
		if Sim.overTable(hit, len, wid) then
			p = Vector3.new(hit.X, Sim.TOP_Y + Sim.BALL_R, hit.Z)
			v = Vector3.new(v.X * 0.95, -v.Y * Sim.REST_TABLE, v.Z * 0.95)
			st.bounces += 1
			ev.table = if hit.Z < 0 then "A" else "B"
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

	st.p, st.v, st.t = p, v, st.t + dt
	return ev
end

-- Reflect the ball off a paddle. `n` is the blade normal, `pv` the paddle velocity.
function Sim.paddleHit(st: any, n: Vector3, pv: Vector3, restitution: number?): void
	local rel = st.v - pv
	local vn = rel:Dot(n)
	if vn < 0 then
		rel = rel - n * ((1 + (restitution or 0.8)) * vn)
		-- keep a little of the sideways paddle movement, not all of it
		st.v = rel
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

return Sim
