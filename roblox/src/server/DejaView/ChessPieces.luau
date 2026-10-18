--!strict
-- Giant chess pieces built from parts: turned bodies (stacked cylinders and balls), the rook's battlements, the
-- knight's head, the bishop's mitre, the queen's crown and the king's cross. Proportions are the scan's giant set
-- (chess-room, tops over 0.376 m squares: king 0.64 m, queen 0.58, bishop 0.52, knight 0.46, rook 0.42, pawn 0.40),
-- so every measure below is in squares.

local ChessPieces = {}

local WHITE, BLACK = Color3.fromRGB(238, 238, 234), Color3.fromRGB(26, 26, 28)
local WIDE = 1.12 -- the moulded set is stout: bodies a little wider than turned wooden ones

-- Bodies from the floor up: { bottom, top, radius }, in squares. Every piece stands on a two-step base.
local LATHE: { [string]: { { number } } } = {
	P = { { 0, 0.1, 0.33 }, { 0.1, 0.16, 0.28 }, { 0.16, 0.42, 0.21 }, { 0.42, 0.62, 0.15 }, { 0.62, 0.68, 0.22 } },
	R = { { 0, 0.1, 0.35 }, { 0.1, 0.16, 0.3 }, { 0.16, 0.5, 0.25 }, { 0.5, 0.8, 0.22 }, { 0.8, 0.86, 0.28 }, { 0.86, 1.0, 0.27 } },
	N = { { 0, 0.1, 0.35 }, { 0.1, 0.16, 0.3 }, { 0.16, 0.3, 0.25 }, { 0.3, 0.36, 0.27 } },
	B = { { 0, 0.1, 0.34 }, { 0.1, 0.16, 0.29 }, { 0.16, 0.5, 0.22 }, { 0.5, 0.8, 0.16 }, { 0.8, 0.86, 0.23 } },
	Q = { { 0, 0.11, 0.36 }, { 0.11, 0.18, 0.31 }, { 0.18, 0.55, 0.23 }, { 0.55, 0.95, 0.16 }, { 0.95, 1.01, 0.25 }, { 1.01, 1.22, 0.22 } },
	K = { { 0, 0.11, 0.37 }, { 0.11, 0.18, 0.32 }, { 0.18, 0.58, 0.24 }, { 0.58, 1.0, 0.17 }, { 1.0, 1.06, 0.26 }, { 1.06, 1.3, 0.22 }, { 1.3, 1.36, 0.24 } },
}

-- How tall each piece stands, in squares.
ChessPieces.HEIGHT = { P = 1.04, R = 1.12, N = 1.22, B = 1.36, Q = 1.54, K = 1.7 } :: { [string]: number }

local function newPart(m: Model, name: string, colour: Color3): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored = true
	p.CanCollide, p.CanTouch = false, false
	p.CastShadow = true
	p.Color = colour
	p.Material = Enum.Material.SmoothPlastic
	p.Reflectance = 0.04
	p.TopSurface, p.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
	p.Parent = m
	return p
end

-- Builds piece `code` ("wK", "bP", ...) standing on `cf` (a square's top centre, -Z the way white looks), `q` studs
-- to a square. The model's pivot is `cf`, so PivotTo moves it square to square. The highest part is named "Top".
function ChessPieces.build(code: string, cf: CFrame, q: number): Model
	local white = string.sub(code, 1, 1) == "w"
	local kind = string.sub(code, 2, 2)
	local colour = if white then WHITE else BLACK
	local accent = if white then Color3.fromRGB(196, 196, 192) else Color3.fromRGB(62, 62, 66)
	local m = Instance.new("Model")
	m.Name = code
	local function disc(name: string, y0: number, y1: number, r: number)
		local p = newPart(m, name, colour)
		p.Shape = Enum.PartType.Cylinder
		p.Size = Vector3.new((y1 - y0) * q, 2 * r * WIDE * q, 2 * r * WIDE * q)
		p.CFrame = cf * CFrame.new(0, (y0 + y1) / 2 * q, 0) * CFrame.Angles(0, 0, math.pi / 2)
	end
	local function ball(name: string, y: number, d: number, x: number?, z: number?)
		local p = newPart(m, name, colour)
		p.Shape = Enum.PartType.Ball
		p.Size = Vector3.one * d * 1.06 * q
		p.CFrame = cf * CFrame.new((x or 0) * WIDE * q, y * q, (z or 0) * WIDE * q)
	end
	-- a block of size (x, y, z) squares at `at` (squares, in the piece's frame), turned by `turn`
	local function block(name: string, x: number, y: number, z: number, at: Vector3, turn: CFrame?, c: Color3?)
		local p = newPart(m, name, c or colour)
		p.Size = Vector3.new(x * WIDE, y, z * WIDE) * q
		p.CFrame = cf * CFrame.new(at * q) * (turn or CFrame.identity)
	end
	for i, seg in LATHE[kind] do
		disc(if i <= 2 then "Base" else "Body", seg[1], seg[2], seg[3])
	end
	if kind == "P" then
		ball("Top", 0.84, 0.4)
	elseif kind == "R" then
		-- four battlements round the rim
		for i = 0, 3 do
			local p = newPart(m, if i == 0 then "Top" else "Merlon", colour)
			p.Size = Vector3.new(0.17 * WIDE, 0.12, 0.1 * WIDE) * q
			p.CFrame = cf * CFrame.Angles(0, i * math.pi / 2, 0) * CFrame.new(0, 1.06 * q, -0.21 * WIDE * q)
		end
	elseif kind == "N" then
		-- the horse faces the other side of the board: white looks to -Z, black to +Z
		local face = if white then CFrame.identity else CFrame.Angles(0, math.pi, 0)
		local function part(name: string, x: number, y: number, z: number, at: Vector3, tilt: number)
			local p = newPart(m, name, colour)
			p.Size = Vector3.new(x * WIDE, y, z * WIDE) * q
			p.CFrame = cf * face * CFrame.new(at.X * WIDE * q, at.Y * q, at.Z * WIDE * q) * CFrame.Angles(tilt, 0, 0)
		end
		part("Neck", 0.26, 0.56, 0.3, Vector3.new(0, 0.62, 0.04), -0.2)
		part("Mane", 0.09, 0.62, 0.1, Vector3.new(0, 0.74, 0.2), -0.2)
		part("Head", 0.24, 0.24, 0.5, Vector3.new(0, 0.98, -0.12), -0.45)
		part("Muzzle", 0.2, 0.16, 0.2, Vector3.new(0, 0.82, -0.34), -0.45)
		for _, x in { -0.07, 0.07 } do
			part(if x < 0 then "Top" else "Ear", 0.06, 0.12, 0.06, Vector3.new(x, 1.16, 0.02), -0.2)
		end
	elseif kind == "B" then
		-- the mitre, its slit and the bead on top
		ball("Mitre", 1.06, 0.38)
		block("Slit", 0.03, 0.22, 0.3, Vector3.new(0, 1.12, 0), CFrame.Angles(0.6, 0, 0), accent)
		ball("Top", 1.3, 0.12)
	elseif kind == "Q" then
		-- the crown's eight points, the orb and its bead
		for i = 0, 7 do
			local a = i * math.pi / 4
			ball("Point", 1.25, 0.09, 0.19 * math.cos(a), 0.19 * math.sin(a))
		end
		ball("Orb", 1.34, 0.2)
		ball("Top", 1.48, 0.1)
	elseif kind == "K" then
		-- the cross, its arms along the files
		block("Top", 0.08, 0.34, 0.08, Vector3.new(0, 1.53, 0))
		block("Arm", 0.24, 0.08, 0.08, Vector3.new(0, 1.58, 0))
	end
	m.WorldPivot = cf
	return m
end

return ChessPieces
