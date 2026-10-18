--!strict
-- The giant chess corner, built by hand from parts (Config.BUILT_ROOMS): the alcove chess-room was scanned in, at its
-- real size and in the scan's own frame, so the board Chess.luau draws lies where the real rubber mat does.
--
-- Measured from the scan (world.spz, pipeline frame: metres, floor y = 0; scene.json's transform is the identity):
-- the walls run 32.3 degrees off the scan's x axis. In the alcove's own axes (u along white's back rank, a to h; v
-- towards black and the TV wall; origin under the board's centre) it is the corner of two recessed white walls:
-- the TV wall at v = 1.88 (u -1.62..2.47) and the whiteboard niche at u = -1.62 (v -1.5..1.88), both 0.2 m deep in
-- orange walls (faces v = 1.68 and u = -1.41) under an orange bulkhead from 2.48 m to the 3.25 m tile ceiling. Grey
-- moulded wainscot panels run below a chair rail at 0.95 m. A 65" TV (0.68..2.08 by 1.33..2.15 m) and three framed
-- prints hang on the TV wall; a grey strip runs along its foot; a green putting mat lies along the h-file; bins
-- stand at the orange pier where the TV wall ends, and a UF roll-up banner at the end of the niche wall. The other
-- two sides open onto the hall: terrazzo, a glass front with a foosball table and a putting green before it, and a
-- wood-panelled entrance down the long wall. Colours are the photos' (the splats are darker than the place looks).
-- The board itself (3.0 m, 0.376 m squares, 34.8 degrees) and its pieces are Chess.luau's.

local ChessRoom = {}

local S = 3.57 -- studs per metre (the block map's)
local T = math.rad(32.3)
local C = Vector3.new(-0.4058, 0, -2.9405) -- the board's centre (features.json), the alcove's origin
-- alcove axes (u, v) -> scan axes (x, z): x = Cx + u cos T + v sin T, z = Cz + u sin T - v cos T
local BASE = CFrame.new(C * S) * CFrame.Angles(0, -T, 0)
-- the board's own axes: x along the files, -z the way white looks (features.json whiteForward)
local BOARD = CFrame.new(C * S) * CFrame.Angles(0, math.atan2(-0.57114, 0.82085), 0)

local H, HEAD = 3.25, 2.48 -- ceiling, bottom of the bulkhead (top of the recesses)
local AU, AV = -1.62, 1.88 -- the niche's back (u) and the TV wall (v): the corner
local OU, OV = -1.41, 1.68 -- the orange faces in front of them
local A_END, B_END, B_TIP = 2.47, -1.5, -2.35 -- TV wall ends (u), niche ends (v), niche wall's free end (v)

local PLASTER = Color3.fromRGB(236, 233, 226)
local ORANGE = Color3.fromRGB(234, 92, 36)
local TRIM = Color3.fromRGB(160, 162, 166)
local BASEBOARD = Color3.fromRGB(122, 124, 128)
local STRIP = Color3.fromRGB(112, 114, 118)
local TERRAZZO = Color3.fromRGB(230, 226, 216)
local CEILING = Color3.fromRGB(240, 240, 236)
local TBAR = Color3.fromRGB(212, 212, 208)
local LAMP = Color3.fromRGB(255, 250, 238)
local BLACK = Color3.fromRGB(20, 20, 22)
local MAT = Color3.fromRGB(244, 242, 236)
local TURF = Color3.fromRGB(38, 124, 62)
local WOOD = Color3.fromRGB(150, 96, 56)
local METAL = Color3.fromRGB(150, 156, 164)

-- An alcove point (metres) as a scan-frame CFrame in studs, turned with the alcove; `yaw` turns it further about y
-- (a part turned by math.pi shows its front face into the room from the TV wall, -math.pi / 2 from the niche wall).
local function at(u: number, y: number, v: number, yaw: number?): CFrame
	local cf = BASE * CFrame.new(u * S, y * S, -v * S)
	return if yaw then cf * CFrame.Angles(0, yaw, 0) else cf
end

-- A point in the board's frame (f along the files, w towards black), metres.
local function onBoard(f: number, y: number, w: number): CFrame
	return BOARD * CFrame.new(f * S, y * S, -w * S)
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

-- The box between two corners of the alcove (u0..u1, y0..y1, v0..v1), metres.
local function span(parent: Instance, name: string, u0: number, u1: number, y0: number, y1: number, v0: number, v1: number,
	colour: Color3, o: Opts?): Part
	return box(parent, name, Vector3.new(math.abs(u1 - u0), math.abs(y1 - y0), math.abs(v1 - v0)),
		at((u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2), colour, o)
end

local function detail(o: Opts?): Opts
	local d: Opts = { collide = false, shadow = false }
	if o then
		for k, v in o :: any do
			(d :: any)[k] = v
		end
	end
	return d
end

local function glow(part: BasePart, face: Enum.NormalId, range: number, brightness: number)
	local l = Instance.new("SurfaceLight")
	l.Face = face
	l.Angle = 150
	l.Range = range
	l.Brightness = brightness
	l.Color = Color3.fromRGB(255, 246, 230)
	l.Parent = part
end

-- A SurfaceGui on a part's front face, `px` pixels per stud, for pictures drawn with frames.
local function canvas(part: BasePart, px: number): SurfaceGui
	local g = Instance.new("SurfaceGui")
	g.Face = Enum.NormalId.Front
	g.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
	g.PixelsPerStud = px
	g.LightInfluence = 1
	g.Parent = part
	return g
end

-- A flat shape on a canvas: position and size as fractions of it, optionally round.
local function shape(g: Instance, x: number, y: number, w: number, h: number, colour: Color3, round: boolean?): Frame
	local f = Instance.new("Frame")
	f.BorderSizePixel = 0
	f.BackgroundColor3 = colour
	f.Position = UDim2.fromScale(x, y)
	f.Size = UDim2.fromScale(w, h)
	if round then
		local c = Instance.new("UICorner")
		c.CornerRadius = UDim.new(0.5, 0)
		c.Parent = f
	end
	f.Parent = g
	return f
end

local function text(g: Instance, s: string, x: number, y: number, w: number, h: number, colour: Color3, font: Enum.Font)
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Position = UDim2.fromScale(x, y)
	l.Size = UDim2.fromScale(w, h)
	l.Text = s
	l.TextScaled = true
	l.Font = font
	l.TextColor3 = colour
	l.Parent = g
end

-- Floor, walls, bulkhead and ceiling of the alcove and the hall around it.
local function shell(f: Folder)
	-- terrazzo through the alcove and the hall, polished
	span(f, "Floor", -9, 13, -0.3, 0, -12, 2.4, TERRAZZO, { reflectance = 0.05 })
	-- the grey border strip along the foot of the TV wall
	span(f, "Strip", AU, A_END, 0, 0.004, 1.58, AV, STRIP, detail())
	-- the TV wall (its recess runs into the building), the orange pier and the hall's long wall beyond it
	span(f, "WallA", -1.95, A_END, 0, H, AV, 2.3, PLASTER)
	span(f, "Pier", A_END, 4.0, 0, H, OV, 2.3, ORANGE)
	span(f, "HallWall", 4.0, 13, 0, H, OV, 2.3, PLASTER)
	span(f, "HallWallWest", -8, -1.95, 0, H, OV, 2.3, PLASTER)
	-- the niche wall: white niche back, its orange free end (with a white return where the niche stops)
	span(f, "WallB", -1.95, AU, 0, H, B_END, AV, PLASTER)
	span(f, "WallBEnd", -1.95, OU, 0, H, B_TIP, B_END - 0.02, ORANGE)
	span(f, "Return", AU, OU, 0, HEAD, B_END - 0.02, B_END, PLASTER)
	-- the orange bulkhead framing both recesses, down to 2.48 m
	span(f, "BulkheadA", AU, A_END, HEAD, H, OV, AV, ORANGE)
	span(f, "BulkheadB", AU, OU, HEAD, H, B_END - 0.02, OV, ORANGE)
	-- a white access panel low on the orange end
	span(f, "Panel", OU, OU + 0.012, 0.2, 0.9, -2.25, -1.6, Color3.fromRGB(238, 238, 234), detail())
	span(f, "PanelEdge", OU, OU + 0.006, 0.18, 0.92, -2.27, -1.58, TRIM, detail())
	-- the hall's far walls, so the open sides look onto a room
	span(f, "HallEnd", 13, 13.3, 0, H, -12, OV, PLASTER)
	span(f, "HallFar", -8, 13.3, 0, H, -12.3, -12, PLASTER)
	-- acoustic tile ceiling over everything, a T-bar grid every 0.61 m
	span(f, "Ceiling", -9, 13.3, H, H + 0.1, -12.3, 2.3, CEILING)
	for u = -7.93, 13, 0.61 do
		span(f, "TBar", u - 0.012, u + 0.012, H - 0.006, H, -12, OV, TBAR, detail())
	end
	for v = -11.9, OV, 0.61 do
		span(f, "TBar", -8, 13, H - 0.006, H, v - 0.012, v + 0.012, TBAR, detail())
	end
	-- the linear light along the TV wall's bulkhead
	local strip = span(f, "LinearLight", -1.4, 2.3, H - 0.02, H, 1.52, 1.6, LAMP, detail({ material = Enum.Material.Neon }))
	glow(strip, Enum.NormalId.Bottom, 18, 1.2)
	-- round downlights through the hall; those near the board light it
	for u = -6.0, 12.5, 2.44 do
		for v = -10.4, 0.5, 2.44 do
			local lamp = box(f, "Downlight", Vector3.new(0.02, 0.16, 0.16), at(u, H - 0.008, v) * CFrame.Angles(0, 0, math.pi / 2),
				LAMP, detail({ material = Enum.Material.Neon, shape = Enum.PartType.Cylinder }))
			if u > -2 and u < 4 and v > -6 then
				glow(lamp, Enum.NormalId.Left, 16, 0.9)
			end
		end
	end
end

-- Grey moulded wainscot: a chair rail at 0.95 m, a grey base and one moulded panel per bay below the rail.
-- `along` gives the wall's span, `face` builds a strip on the wall from (a0..a1, y0..y1) at `proud` metres out.
local function wainscot(f: Folder, a0: number, a1: number, bays: number, face: (string, number, number, number, number, number, Color3) -> ())
	face("Rail", a0, a1, 0.93, 0.98, 0.025, TRIM)
	face("Base", a0, a1, 0, 0.1, 0.015, BASEBOARD)
	local gap = 0.1
	local w = (a1 - a0 - gap * (bays + 1)) / bays
	for i = 0, bays - 1 do
		local p0 = a0 + gap + i * (w + gap)
		local p1 = p0 + w
		face("Moulding", p0, p1, 0.82, 0.85, 0.012, TRIM)
		face("Moulding", p0, p1, 0.17, 0.2, 0.012, TRIM)
		face("Moulding", p0, p0 + 0.03, 0.17, 0.85, 0.012, TRIM)
		face("Moulding", p1 - 0.03, p1, 0.17, 0.85, 0.012, TRIM)
	end
end

local function walls(f: Folder)
	-- on the TV wall (face v = AV, facing -v)
	wainscot(f, AU, A_END, 4, function(name, a0, a1, y0, y1, proud, colour)
		span(f, name, a0, a1, y0, y1, AV - proud, AV, colour, detail())
	end)
	-- on the niche wall (face u = AU, facing +u)
	wainscot(f, B_END, AV, 3, function(name, a0, a1, y0, y1, proud, colour)
		span(f, name, AU, AU + proud, y0, y1, a0, a1, colour, detail())
	end)
end

-- The TV (its screen is the part named ChessScreen: Chess.luau shows the game on its front face) and three prints.
local function tvAndArt(f: Folder)
	span(f, "TV", 0.68, 2.08, 1.33, 2.15, AV - 0.06, AV, BLACK, detail({ collide = true }))
	local screen = box(f, "ChessScreen", Vector3.new(1.36, 0.78, 0.004), at(1.38, 1.74, AV - 0.062, math.pi),
		Color3.fromRGB(12, 14, 18), detail({ reflectance = 0.12 }))
	screen.Material = Enum.Material.Glass
	-- prints: black frame, white mat, the picture (centres at 1.69 m, as hung)
	local prints = {
		{ u0 = -1.32, u1 = -0.87, h = 0.62, bg = Color3.fromRGB(204, 172, 104) },
		{ u0 = -0.72, u1 = -0.12, h = 0.5, bg = Color3.fromRGB(238, 226, 204) },
		{ u0 = 0.03, u1 = 0.63, h = 0.76, bg = Color3.fromRGB(72, 128, 94) },
	}
	for i, p in prints do
		local y0, y1 = 1.69 - p.h / 2, 1.69 + p.h / 2
		span(f, "PrintFrame", p.u0, p.u1, y0, y1, AV - 0.025, AV, Color3.fromRGB(24, 24, 26), detail())
		span(f, "PrintMat", p.u0 + 0.03, p.u1 - 0.03, y0 + 0.03, y1 - 0.03, AV - 0.027, AV, MAT, detail())
		local w, h = p.u1 - p.u0 - 0.14, p.h - 0.14
		local pic = box(f, "Print" .. i, Vector3.new(w, h, 0.004), at((p.u0 + p.u1) / 2, 1.69, AV - 0.029, math.pi), p.bg, detail())
		local g = canvas(pic, 60)
		if i == 1 then
			-- a figure in a warm scene
			shape(g, 0.2, 0.62, 0.6, 0.38, Color3.fromRGB(150, 110, 60))
			shape(g, 0.36, 0.2, 0.28, 0.5, Color3.fromRGB(92, 64, 42))
			shape(g, 0.4, 0.06, 0.2, 0.16, Color3.fromRGB(70, 48, 34), true)
		elseif i == 2 then
			-- two halved blood oranges
			for _, x in { 0.12, 0.54 } do
				shape(g, x, 0.24, 0.34, 0.5, Color3.fromRGB(216, 76, 44), true)
				shape(g, x + 0.08, 0.36, 0.18, 0.26, Color3.fromRGB(150, 40, 34), true)
			end
		else
			-- a portrait on green
			shape(g, 0.22, 0.4, 0.56, 0.6, Color3.fromRGB(206, 170, 120))
			shape(g, 0.32, 0.12, 0.36, 0.34, Color3.fromRGB(224, 194, 160), true)
			shape(g, 0.28, 0.06, 0.44, 0.16, Color3.fromRGB(64, 44, 30), true)
		end
	end
end

-- The green putting mat along the h-file (in the board's frame, 0.45 m past its edge), cups at the TV wall's end.
local function puttingMat(f: Folder)
	box(f, "PuttingMat", Vector3.new(0.6, 0.012, 3.5), onBoard(1.95, 0.006, -0.05), TURF,
		detail({ material = Enum.Material.Fabric }))
	for i, c in { { -0.15, 1.38 }, { 0.15, 1.38 }, { 0, 1.5 }, { -0.15, 1.62 }, { 0.15, 1.62 } } do
		box(f, "Cup" .. i, Vector3.new(0.004, 0.1, 0.1), onBoard(1.95 + c[1], 0.013, c[2]) * CFrame.Angles(0, 0, math.pi / 2),
			Color3.fromRGB(236, 236, 230), detail({ shape = Enum.PartType.Cylinder }))
		box(f, "Hole" .. i, Vector3.new(0.005, 0.07, 0.07), onBoard(1.95 + c[1], 0.014, c[2]) * CFrame.Angles(0, 0, math.pi / 2),
			Color3.fromRGB(18, 22, 18), detail({ shape = Enum.PartType.Cylinder }))
	end
end

-- The black round trash can and a two-bin recycling station against the orange pier, a sign above them.
local function bins(f: Folder)
	box(f, "TrashCan", Vector3.new(0.82, 0.5, 0.5), at(2.75, 0.41, 1.38) * CFrame.Angles(0, 0, math.pi / 2), BLACK,
		{ shape = Enum.PartType.Cylinder, collide = true })
	box(f, "TrashLid", Vector3.new(0.04, 0.52, 0.52), at(2.75, 0.84, 1.38) * CFrame.Angles(0, 0, math.pi / 2),
		Color3.fromRGB(34, 34, 36), detail({ shape = Enum.PartType.Cylinder }))
	box(f, "TrashMouth", Vector3.new(0.005, 0.24, 0.24), at(2.75, 0.862, 1.38) * CFrame.Angles(0, 0, math.pi / 2),
		Color3.fromRGB(6, 6, 8), detail({ shape = Enum.PartType.Cylinder }))
	for i, c in { Color3.fromRGB(28, 86, 168), Color3.fromRGB(46, 128, 70) } do
		local u = 3.1 + (i - 1) * 0.44
		span(f, "Bin", u, u + 0.4, 0, 1.0, OV - 0.48, OV - 0.02, c, { collide = true })
		span(f, "BinTop", u - 0.01, u + 0.41, 1.0, 1.04, OV - 0.49, OV - 0.02, Color3.fromRGB(40, 42, 46), detail())
		span(f, "BinLabel", u + 0.08, u + 0.32, 0.55, 0.85, OV - 0.485, OV - 0.48, Color3.fromRGB(240, 240, 236), detail())
	end
	local sign = box(f, "BinSign", Vector3.new(0.84, 0.36, 0.01), at(3.52, 1.45, OV - 0.006, math.pi), MAT, detail())
	local g = canvas(sign, 60)
	shape(g, 0, 0, 1, 0.3, Color3.fromRGB(28, 86, 168))
	text(g, "SORT IT", 0.05, 0.02, 0.9, 0.26, MAT, Enum.Font.GothamBlack)
	shape(g, 0.08, 0.4, 0.38, 0.5, Color3.fromRGB(28, 86, 168))
	shape(g, 0.54, 0.4, 0.38, 0.5, Color3.fromRGB(46, 128, 70))
end

-- The UF roll-up banner just past the niche wall's end, facing into the alcove.
local function banner(f: Folder)
	local u, v = -1.3, -2.62
	span(f, "BannerFoot", u - 0.12, u + 0.04, 0, 0.1, v - 0.3, v + 0.3, METAL, { collide = true, material = Enum.Material.Metal })
	local b = box(f, "Banner", Vector3.new(0.008, 2.1, 0.56), at(u - 0.04, 1.15, v), Color3.fromRGB(22, 58, 150), detail())
	local face = box(f, "BannerFace", Vector3.new(0.56, 2.1, 0.002), at(u - 0.034, 1.15, v, -math.pi / 2),
		Color3.fromRGB(22, 58, 150), detail())
	b.CanCollide = true
	local g = canvas(face, 100)
	shape(g, 0, 0, 1, 0.2, Color3.fromRGB(250, 70, 22))
	text(g, "UF", 0.1, 0.02, 0.8, 0.12, MAT, Enum.Font.GothamBlack)
	text(g, "UNIVERSITY of FLORIDA", 0.08, 0.14, 0.84, 0.04, MAT, Enum.Font.GothamBold)
	shape(g, 0.3, 0.27, 0.4, 0.15, MAT)
	text(g, "Room for everything inside.", 0.08, 0.5, 0.84, 0.12, MAT, Enum.Font.GothamBlack)
	text(g, "Rec & Re", 0.08, 0.86, 0.6, 0.06, MAT, Enum.Font.GothamBold)
end

-- The hall past the open sides: the glass front with a foosball table and a putting green before it, and the
-- wood-panelled entrance down the long wall.
local function hall(f: Folder)
	local gu = -8
	-- the night outside, the glass, mullions every 1.5 m, a transom and the blue fascia over it
	span(f, "Night", gu - 1.3, gu - 1.0, 0, H + 1, -12.3, OV, Color3.fromRGB(14, 18, 28), detail())
	span(f, "Glass", gu - 0.03, gu, 0, H, -12, OV, Color3.fromRGB(46, 58, 76),
		{ material = Enum.Material.Glass, transparency = 0.35, reflectance = 0.2 })
	for v = -11.25, OV, 1.5 do
		span(f, "Mullion", gu - 0.06, gu + 0.04, 0, H, v - 0.03, v + 0.03, METAL, detail({ material = Enum.Material.Metal }))
	end
	span(f, "Transom", gu - 0.06, gu + 0.04, 2.36, 2.42, -12, OV, METAL, detail({ material = Enum.Material.Metal }))
	span(f, "Fascia", gu, gu + 0.35, 2.85, H, -12, OV, Color3.fromRGB(28, 62, 150), detail())
	-- a foosball table near the glass: dark wood cabinet, green field, steel rods and legs
	local fu, fv = -6.6, -3.2
	span(f, "FoosCabinet", fu - 0.38, fu + 0.38, 0.62, 0.92, fv - 0.7, fv + 0.7, Color3.fromRGB(84, 58, 40), { collide = true })
	span(f, "FoosField", fu - 0.34, fu + 0.34, 0.921, 0.925, fv - 0.64, fv + 0.64, Color3.fromRGB(46, 120, 70), detail())
	for i = 1, 8 do
		local v = fv - 0.56 + (i - 1) * 0.16
		box(f, "FoosRod", Vector3.new(1.3, 0.016, 0.016), at(fu, 0.98, v), METAL,
			detail({ shape = Enum.PartType.Cylinder, material = Enum.Material.Metal }))
	end
	for _, du in { -0.32, 0.32 } do
		for _, dv in { -0.62, 0.62 } do
			span(f, "FoosLeg", fu + du - 0.04, fu + du + 0.04, 0, 0.62, fv + dv - 0.04, fv + dv + 0.04, Color3.fromRGB(70, 48, 34), detail())
		end
	end
	-- the putting green with a cup and a red flag
	span(f, "Green", -7.6, -5.4, 0, 0.015, -7.2, -4.6, TURF, detail({ material = Enum.Material.Grass }))
	box(f, "GreenCup", Vector3.new(0.005, 0.11, 0.11), at(-6.6, 0.017, -6.4) * CFrame.Angles(0, 0, math.pi / 2),
		Color3.fromRGB(10, 14, 10), detail({ shape = Enum.PartType.Cylinder }))
	span(f, "FlagPole", -6.61, -6.59, 0, 1.1, -6.41, -6.39, Color3.fromRGB(236, 236, 230), detail())
	span(f, "Flag", -6.6, -6.598, 0.86, 1.08, -6.39, -6.12, Color3.fromRGB(214, 40, 40), detail())
	-- the entrance: wood panelling with glass double doors
	span(f, "WoodPanel", 6.0, 9.0, 0, H, OV - 0.04, OV, WOOD, detail({ material = Enum.Material.Wood }))
	span(f, "DoorFrame", 6.9, 8.1, 0, 2.3, OV - 0.07, OV - 0.04, Color3.fromRGB(92, 60, 36), detail())
	for _, u in { 7.2, 7.8 } do
		span(f, "DoorGlass", u - 0.27, u + 0.27, 0.1, 2.2, OV - 0.075, OV - 0.07, Color3.fromRGB(50, 62, 78),
			detail({ material = Enum.Material.Glass, transparency = 0.3 }))
	end
	span(f, "ExitSign", 7.3, 7.7, 2.45, 2.62, OV - 0.08, OV - 0.04, Color3.fromRGB(200, 30, 30), detail({ material = Enum.Material.Neon }))
end

-- Builds the room into `parent` (Workspace.Room). The board and pieces are Chess.luau's.
function ChessRoom.build(parent: Instance): Folder
	local old = parent:FindFirstChild("ChessRoom")
	if old then
		old:Destroy()
	end
	local f = Instance.new("Folder")
	f.Name = "ChessRoom"
	shell(f)
	walls(f)
	tvAndArt(f)
	puttingMat(f)
	bins(f)
	banner(f)
	hall(f)
	f.Parent = parent
	return f
end

return ChessRoom
