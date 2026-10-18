--!strict
-- The Infinity Hall Game Lawn, built by hand from parts (Config.BUILT_ROOMS): the covered patio the-courts was
-- scanned in, at its real size and in the scan's own frame, so the ping pong and foosball tables the games build
-- stand where the real ones do.
--
-- Measured from the scan (world.spz, pipeline frame: metres, floor y = 0): the walls run 41 degrees off the scan's x
-- axis. In the patio's own axes (u along the long side of the ping pong table, v across it) it is u -7.82..2.45 by
-- v -7.15..3.25 under a 3.1 m ceiling. Two sides are painted plaster walls; the v = -7.15 side is the hall's tinted
-- glass front on a dark sill; the v = 3.25 side is open to the lawn, the ceiling held up by columns every 2.85 m.
-- Linear lights hang in rows 2.5 m apart along v, 2.2 m apart along u. A folded ping pong table stands against the
-- u = -7.82 wall, black metal chairs sit near it, and the lawn outside has trees, a trash can and a fence. Colours
-- are the photos' (the splats are darker than the place looks).

local GameLawn = {}

local S = 3.57 -- studs per metre (the block map's)
local ROT = CFrame.Angles(0, math.rad(-41), 0) -- room axes (u, v) -> scan axes (x, z): x = u cos - v sin, z = u sin + v cos
local U0, U1, V0, V1, H = -7.82, 2.45, -7.15, 3.25, 3.1

local PLASTER = Color3.fromRGB(226, 221, 210)
local CONCRETE = Color3.fromRGB(172, 166, 156)
local JOINT = Color3.fromRGB(120, 116, 110)
local CEILING = Color3.fromRGB(236, 234, 230)
local TRIM = Color3.fromRGB(92, 90, 88)
local FRAME = Color3.fromRGB(214, 216, 218)
local GLASS = Color3.fromRGB(58, 66, 66)
local SILL = Color3.fromRGB(30, 30, 32)
local TABLE_BLUE = Color3.fromRGB(38, 98, 176)
local LINE = Color3.fromRGB(240, 240, 240)
local STEEL = Color3.fromRGB(70, 72, 78)
local CHAIR = Color3.fromRGB(38, 40, 44)
local RUBBER = Color3.fromRGB(22, 22, 24)

-- A room-frame point (metres) as a scan-frame CFrame in studs, turned with the room; `yaw` turns it further about y.
local function at(u: number, y: number, v: number, yaw: number?): CFrame
	local cf = ROT * CFrame.new(u * S, y * S, v * S)
	return if yaw then cf * CFrame.Angles(0, yaw, 0) else cf
end

type Opts = { material: Enum.Material?, collide: boolean?, shadow: boolean?, transparency: number?, reflectance: number?, shape: Enum.PartType? }

-- A box `size` metres (along u, y, v) centred on `cf`.
local function box(parent: Instance, name: string, size: Vector3, cf: CFrame, colour: Color3, o: Opts?): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored = true
	p.CanTouch = false
	p.Size = size * S
	p.CFrame = cf
	p.Color = colour
	p.Material = (o and o.material) or Enum.Material.SmoothPlastic
	p.TopSurface, p.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
	p.CanCollide = if o and o.collide ~= nil then o.collide else true
	p.CanQuery = p.CanCollide
	p.CastShadow = if o and o.shadow ~= nil then o.shadow else false
	p.Transparency = (o and o.transparency) or 0
	p.Reflectance = (o and o.reflectance) or 0
	if o and o.shape then
		p.Shape = o.shape
	end
	p.Parent = parent
	return p
end

local function detail(o: Opts?): Opts
	local d: Opts = { collide = false, shadow = true }
	if o then
		for k, v in o :: any do
			(d :: any)[k] = v
		end
	end
	return d
end

local GRASS = Color3.fromRGB(62, 98, 52)
local BARK = Color3.fromRGB(96, 84, 72)
local LEAVES = Color3.fromRGB(44, 74, 40)

local function shell(f: Folder)
	local W, D = U1 - U0, V1 - V0
	local cu, cv = (U0 + U1) / 2, (V0 + V1) / 2
	-- polished concrete with saw-cut joints about every 3.4 m, running 1.5 m out past the columns onto the lawn
	local slabV1 = V1 + 1.5
	box(f, "Floor", Vector3.new(W + 0.6, 0.3, slabV1 - V0 + 0.3), at(cu, -0.15, (V0 - 0.3 + slabV1) / 2), CONCRETE,
		{ reflectance = 0.04 })
	for _, u in { -4.4, -1.0 } do
		box(f, "Joint", Vector3.new(0.012, 0.004, slabV1 - V0), at(u, 0.002, (V0 + slabV1) / 2), JOINT, detail({ shadow = false }))
	end
	for _, v in { -3.75, -0.35, 3.05 } do
		box(f, "Joint", Vector3.new(W, 0.004, 0.012), at(cu, 0.002, v), JOINT, detail({ shadow = false }))
	end
	-- two plaster walls (outside the patio's box) with a dark cove base
	box(f, "WallBack", Vector3.new(0.2, H, D + 0.5), at(U0 - 0.1, H / 2, cv + 0.05), PLASTER)
	box(f, "WallFront", Vector3.new(0.2, H, D + 0.5), at(U1 + 0.1, H / 2, cv + 0.05), PLASTER)
	box(f, "Base", Vector3.new(0.015, 0.1, D), at(U0 + 0.0075, 0.05, cv), TRIM, detail({ shadow = false }))
	box(f, "Base", Vector3.new(0.015, 0.1, D), at(U1 - 0.0075, 0.05, cv), TRIM, detail({ shadow = false }))
	-- the hall's glass front: a dark sill, one long tinted pane, a header and mullions about every 1.3 m
	box(f, "Sill", Vector3.new(W, 0.35, 0.15), at(cu, 0.175, V0 - 0.075), SILL)
	box(f, "Glass", Vector3.new(W, H - 0.5, 0.03), at(cu, 0.35 + (H - 0.5) / 2, V0 - 0.075), GLASS,
		{ material = Enum.Material.Glass, transparency = 0.2, reflectance = 0.25 })
	box(f, "Header", Vector3.new(W, 0.15, 0.14), at(cu, H - 0.075, V0 - 0.075), FRAME)
	box(f, "HallInside", Vector3.new(W, H, 0.1), at(cu, H / 2, V0 - 1.2), Color3.fromRGB(46, 48, 50), detail({ collide = true }))
	for i = 1, 7 do
		box(f, "Mullion", Vector3.new(0.05, H - 0.5, 0.12), at(U0 + W * i / 8, 0.35 + (H - 0.5) / 2, V0 - 0.075), FRAME)
	end
	-- the open side: square columns every 2.85 m under a deep fascia; the ceiling runs out over them
	for _, u in { -7.15, -4.3, -1.45, 1.25 } do
		box(f, "Column", Vector3.new(0.28, H, 0.28), at(u, H / 2, V1), PLASTER)
	end
	box(f, "Fascia", Vector3.new(W + 0.4, 0.4, 0.3), at(cu, H - 0.2, V1), PLASTER)
	-- the ceiling lets the sky light in (no shadow), so the patio is bright whatever the time of day
	box(f, "Ceiling", Vector3.new(W + 0.6, 0.2, D + 0.8), at(cu, H + 0.1, cv + 0.1), CEILING)
	-- linear lights: rows along v, columns along u, each a glowing strip with a light under it
	for _, v in { -6.85, -4.72, -2.22, 0.28, 2.78 } do
		for _, u in { -6.9, -4.7, -2.5, -0.3, 1.9 } do
			box(f, "LightHousing", Vector3.new(1.24, 0.03, 0.17), at(u, H - 0.015, v), FRAME, detail({ shadow = false }))
			local strip = box(f, "Light", Vector3.new(1.2, 0.012, 0.12), at(u, H - 0.036, v), Color3.fromRGB(255, 250, 238),
				detail({ material = Enum.Material.Neon, shadow = false }))
			local glow = Instance.new("SurfaceLight")
			glow.Face = Enum.NormalId.Bottom
			glow.Angle = 150
			glow.Range = 16
			glow.Brightness = 1.1
			glow.Color = Color3.fromRGB(255, 246, 230)
			glow.Parent = strip
		end
	end
	-- the thermostat by the folded table and a camera dome in the glass corner
	box(f, "Thermostat", Vector3.new(0.025, 0.12, 0.08), at(U0 + 0.0125, 1.5, 0.4), Color3.fromRGB(235, 235, 232), detail())
	box(f, "CameraDome", Vector3.new(0.14, 0.14, 0.14), at(U0 + 0.3, H - 0.05, V0 + 0.3), Color3.fromRGB(28, 28, 30),
		detail({ shape = Enum.PartType.Ball, shadow = false }))
end

-- The lawn past the open side: grass, a few tall trees, a trash can by the slab and a fence with a low building behind.
local function lawn(f: Folder)
	local v0 = V1 + 1.5
	box(f, "Grass", Vector3.new(30, 0.3, 16), at(-2.7, -0.17, v0 + 8), GRASS, { material = Enum.Material.Grass })
	for _, t in { { -9.5, 6.5, 7.5 }, { -5.2, 9.5, 8.5 }, { -1.2, 6.0, 7 }, { 3.2, 9.0, 8 }, { 7.5, 6.8, 7.5 } } do
		local u, v, h = t[1], t[2], t[3]
		box(f, "Trunk", Vector3.new(h, 0.34, 0.34), at(u, h / 2, v) * CFrame.Angles(0, 0, math.rad(90)), BARK,
			detail({ shape = Enum.PartType.Cylinder, collide = true }))
		for _, c in { { 0, 0, 0, 3.2 }, { 0.9, -0.5, 0.4, 2.4 }, { -0.8, -0.4, -0.6, 2.2 } } do
			box(f, "Leaves", Vector3.new(c[4], c[4] * 0.7, c[4]), at(u + c[1], h + c[2], v + c[3]), LEAVES,
				detail({ shape = Enum.PartType.Ball, material = Enum.Material.Grass }))
		end
	end
	box(f, "TrashCan", Vector3.new(0.95, 0.6, 0.6), at(-3.6, 0.475, V1 + 1.0) * CFrame.Angles(0, 0, math.rad(90)),
		Color3.fromRGB(96, 100, 104), detail({ shape = Enum.PartType.Cylinder, collide = true, material = Enum.Material.Metal }))
	local fv = v0 + 13
	for u = -16, 10, 2.6 do
		box(f, "FencePost", Vector3.new(0.06, 1.8, 0.06), at(u, 0.9, fv), Color3.fromRGB(40, 44, 42), detail())
	end
	box(f, "Fence", Vector3.new(27, 1.8, 0.02), at(-3, 0.9, fv), Color3.fromRGB(40, 44, 42),
		detail({ transparency = 0.55, collide = true }))
	box(f, "FarBuilding", Vector3.new(30, 3, 0.4), at(-3, 1.5, fv + 3), Color3.fromRGB(184, 174, 154), detail())
end

-- The second table, folded up for storage against the back wall: two halves face to face on a wheeled frame.
local function foldedTable(f: Folder)
	local u, v = -7.55, -2.15
	for i, du in { 0.07, -0.07 } do
		local half = box(f, "FoldedTop", Vector3.new(0.03, 1.4, 1.525), at(u + du, 0.18 + 0.7, v), TABLE_BLUE, detail({ collide = true }))
		half.Name = "FoldedTop" .. i
		local face = u + du + (if du > 0 then 0.016 else -0.016)
		-- white edges and the centre line on each playing face
		box(f, "Edge", Vector3.new(0.004, 0.02, 1.525), at(face, 0.18 + 1.39, v), LINE, detail({ shadow = false }))
		box(f, "Edge", Vector3.new(0.004, 0.02, 1.525), at(face, 0.19, v), LINE, detail({ shadow = false }))
		for _, dv in { -0.7525, 0.7525 } do
			box(f, "Edge", Vector3.new(0.004, 1.4, 0.02), at(face, 0.88, v + dv), LINE, detail({ shadow = false }))
		end
		box(f, "Centre", Vector3.new(0.004, 1.4, 0.006), at(face, 0.88, v), LINE, detail({ shadow = false }))
	end
	-- frame: two uprights, a cross bar and a base on four wheels
	for _, dv in { -0.55, 0.55 } do
		box(f, "Upright", Vector3.new(0.04, 1.1, 0.04), at(u, 0.65, v + dv), STEEL, detail({ material = Enum.Material.Metal }))
		box(f, "Foot", Vector3.new(0.6, 0.04, 0.05), at(u, 0.1, v + dv), STEEL, detail({ material = Enum.Material.Metal }))
		for _, du in { -0.27, 0.27 } do
			box(f, "Wheel", Vector3.new(0.04, 0.09, 0.09), at(u + du, 0.045, v + dv), RUBBER,
				detail({ shape = Enum.PartType.Cylinder }))
		end
	end
	box(f, "CrossBar", Vector3.new(0.04, 0.04, 1.14), at(u, 0.5, v), STEEL, detail({ material = Enum.Material.Metal }))
end

-- A black metal café chair at (u, v), facing `yaw` (0 faces +u, into the room).
local function chair(f: Folder, u: number, v: number, yaw: number)
	local base = at(u, 0, v, yaw)
	local function piece(name: string, size: Vector3, x: number, y: number, z: number, o: Opts?)
		box(f, name, size, base * CFrame.new(x * S, y * S, z * S), CHAIR, detail(o))
	end
	-- slatted seat at 46 cm, a slatted back leaning a little, four legs
	for i = -2, 2 do
		piece("Seat", Vector3.new(0.42, 0.015, 0.06), 0, 0.46, i * 0.085, { collide = true, material = Enum.Material.Metal })
	end
	for _, z in { -0.2, 0.2 } do
		for _, x in { -0.19, 0.19 } do
			piece("Leg", Vector3.new(0.02, 0.46, 0.02), x, 0.23, z, { material = Enum.Material.Metal })
		end
		piece("BackPost", Vector3.new(0.02, 0.42, 0.02), -0.2, 0.67, z, { material = Enum.Material.Metal })
	end
	for i = 0, 3 do
		piece("BackSlat", Vector3.new(0.012, 0.05, 0.42), -0.205, 0.56 + i * 0.09, 0, { material = Enum.Material.Metal })
	end
end

-- Builds the room into `parent` (Workspace.Room). The games put their own tables in it.
function GameLawn.build(parent: Instance): Folder
	local old = parent:FindFirstChild("GameLawn")
	if old then
		old:Destroy()
	end
	local f = Instance.new("Folder")
	f.Name = "GameLawn"
	shell(f)
	lawn(f)
	foldedTable(f)
	chair(f, -6.3, -3.3, math.rad(-15))
	chair(f, -5.7, -1.2, math.rad(10))
	chair(f, -6.2, 0.9, math.rad(35))
	chair(f, -4.9, 2.3, math.rad(-60))
	f.Parent = parent
	return f
end

return GameLawn
