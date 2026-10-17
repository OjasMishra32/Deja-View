-- Snapshot interpolation. The server uses this for tag checks and clients use it to draw,
-- so players are tagged by the ghost they can see (team/shivin.md 7.4).
local Util = require(script.Parent.Util)

local Interp = {}

Interp.DELAY = 0.35 -- render this far in the past
Interp.KEEP = 2 -- seconds of history
Interp.MAX_EXTRAPOLATE = 0.25
Interp.STALE = 3

export type Snap = {
	stamp: number,
	pos: Vector3, -- feet
	yaw: number,
	head: Vector3?,
	hl: Vector3?,
	hr: Vector3?,
}

export type Sample = {
	pos: Vector3,
	yaw: number,
	head: Vector3?,
	hl: Vector3?,
	hr: Vector3?,
	age: number, -- seconds since the newest snapshot
}

export type Buffer = { snaps: { Snap } }

function Interp.new(): Buffer
	return { snaps = {} }
end

function Interp.push(buf: Buffer, snap: Snap)
	local snaps = buf.snaps
	local last = snaps[#snaps]
	if last and snap.stamp <= last.stamp then
		snap.stamp = last.stamp + 1e-3
	end
	table.insert(snaps, snap)
	local cutoff = snap.stamp - Interp.KEEP
	while #snaps > 2 and snaps[1].stamp < cutoff do
		table.remove(snaps, 1)
	end
end

function Interp.newest(buf: Buffer): Snap?
	return buf.snaps[#buf.snaps]
end

local function lerpOpt(a: Vector3?, b: Vector3?, t: number): Vector3?
	if a and b then
		return a:Lerp(b, t)
	end
	if t < 0.5 then
		return a
	end
	return b
end

local function blend(a: Snap, b: Snap, t: number, now: number): Sample
	return {
		pos = a.pos:Lerp(b.pos, t),
		yaw = Util.lerpAngle(a.yaw, b.yaw, t),
		head = lerpOpt(a.head, b.head, t),
		hl = lerpOpt(a.hl, b.hl, t),
		hr = lerpOpt(a.hr, b.hr, t),
		age = now - b.stamp,
	}
end

-- renderT and now are workspace:GetServerTimeNow() values (renderT = now - DELAY).
function Interp.sample(buf: Buffer, renderT: number, now: number): Sample?
	local snaps = buf.snaps
	local n = #snaps
	if n == 0 then
		return nil
	end
	local newest = snaps[n]
	if n == 1 or renderT <= snaps[1].stamp then
		local s = if renderT <= snaps[1].stamp then snaps[1] else newest
		return blend(s, s, 0, now)
	end
	if renderT >= newest.stamp then
		-- Past the newest snapshot: extrapolate briefly with the last velocity, then hold.
		local prev = snaps[n - 1]
		local dt = newest.stamp - prev.stamp
		local ahead = math.min(renderT - newest.stamp, Interp.MAX_EXTRAPOLATE)
		local t = if dt > 1e-3 then 1 + ahead / dt else 1
		t = math.min(t, 2)
		local s = blend(prev, newest, t, now)
		-- Hands/head only lerp sensibly inside [0, 1]; for the overshoot keep body-relative offsets.
		local shift = s.pos - newest.pos
		s.head = newest.head and newest.head + shift
		s.hl = newest.hl and newest.hl + shift
		s.hr = newest.hr and newest.hr + shift
		return s
	end
	for i = n - 1, 1, -1 do
		local a = snaps[i]
		if a.stamp <= renderT then
			local b = snaps[i + 1]
			local t = (renderT - a.stamp) / math.max(b.stamp - a.stamp, 1e-3)
			return blend(a, b, t, now)
		end
	end
	return blend(snaps[1], snaps[1], 0, now)
end

return Interp
