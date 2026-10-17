-- Map JSON -> anchored Parts in batches, with progress, teardown, invisible bounds and baked fallback.
local CollectionService = game:GetService("CollectionService")
local Lighting = game:GetService("Lighting")
local ServerStorage = game:GetService("ServerStorage")
local Config = require(script.Parent.Config)

local MapBuilder = {}

export type RoomInfo = {
	sceneId: string,
	name: string,
	spawn: Vector3,
	spawnYaw: number?,
	walkMin: Vector3?, -- the walkable box (invisible walls go here); defaults to the bounds
	walkMax: Vector3?,
	boundsMin: Vector3,
	boundsMax: Vector3,
	ceilingY: number,
	studsPerMeter: number,
	count: number,
}

local generation = 0
MapBuilder.current = nil :: RoomInfo?

local template = Instance.new("Part")
template.Anchored = true
template.Material = Enum.Material.SmoothPlastic
template.TopSurface = Enum.SurfaceType.Smooth
template.BottomSurface = Enum.SurfaceType.Smooth
template.CanTouch = false

local function invisible(parent: Instance, name: string, size: Vector3, pos: Vector3): Part
	local p = template:Clone()
	p.Name = name
	p.Size = size
	p.CFrame = CFrame.new(pos)
	p.Transparency = 1
	p.CastShadow = false
	p.CanQuery = false
	p.Parent = parent
	return p
end

-- Textured rooms are shown unlit (shivin.md Update 10): their textures already hold the light of the photos, so
-- Roblox must not shade them again. The lighting as it was is kept and put back for block rooms and the lobby.
local UNLIT = {
	GlobalShadows = false,
	Ambient = Color3.fromRGB(255, 255, 255),
	OutdoorAmbient = Color3.fromRGB(255, 255, 255),
	Brightness = 0,
	EnvironmentDiffuseScale = 0,
	EnvironmentSpecularScale = 0,
	ExposureCompensation = 0,
}
local savedLighting: { [string]: any }? = nil
local parkedEffects: { [Instance]: any } = {}

function MapBuilder.setUnlit(on: boolean)
	if on == (savedLighting ~= nil) then
		return
	end
	local L: any = Lighting
	if on then
		local saved = {}
		for k, v in UNLIT do
			saved[k] = L[k]
			L[k] = v
		end
		savedLighting = saved
		-- no Atmosphere, Bloom, ColorCorrection, SunRays or blur while a textured room is up
		for _, e in Lighting:GetChildren() do
			if e:IsA("PostEffect") then
				parkedEffects[e] = e.Enabled
				e.Enabled = false
			elseif e:IsA("Atmosphere") then
				parkedEffects[e] = e.Density
				e.Density = 0
			end
		end
	else
		for k, v in savedLighting :: { [string]: any } do
			L[k] = v
		end
		savedLighting = nil
		for e, v in parkedEffects do
			if e.Parent and e:IsA("PostEffect") then
				e.Enabled = v
			elseif e.Parent and e:IsA("Atmosphere") then
				e.Density = v
			end
		end
		parkedEffects = {}
	end
end

-- Every room has a floor: an invisible slab whose top is exactly y = 0 (the map frame's floor) under the walk box,
-- so nobody falls through a gap in the blocks or the model. The safety floor sits well below it and only catches
-- someone who slips through anyway (the fall guard then puts them back at spawn).
local FLOOR_THICK = 2
local FLOOR_MARGIN = 4
local SAFETY_TOP = -8

local function boundsOf(map: any): (Vector3, Vector3, number)
	local minV = Vector3.new(math.huge, math.huge, math.huge)
	local maxV = -minV
	for _, p in map.parts do
		local half = Vector3.new(p[4], p[5], p[6]) / 2
		local c = Vector3.new(p[1], p[2], p[3])
		minV = minV:Min(c - half)
		maxV = maxV:Max(c + half)
	end
	if #map.parts == 0 then
		minV, maxV = Vector3.new(-10, 0, -10), Vector3.new(10, 10, 10)
	end
	local b = map.bounds
	if type(b) == "table" then
		-- accept {min=[...], max=[...]} or [[min],[max]]
		local bmin, bmax = b.min or b[1], b.max or b[2]
		if type(bmin) == "table" and type(bmax) == "table" then
			minV = Vector3.new(bmin[1] or bmin.x, bmin[2] or bmin.y, bmin[3] or bmin.z)
			maxV = Vector3.new(bmax[1] or bmax.x, bmax[2] or bmax.y, bmax[3] or bmax.z)
		end
	end
	local ceilingY = if type(map.ceilingY) == "number" then map.ceilingY else maxV.Y
	return minV, maxV, ceilingY
end

local function parseBox(b: any): (Vector3?, Vector3?)
	if type(b) ~= "table" then
		return nil, nil
	end
	local bmin, bmax = b.min or b[1], b.max or b[2]
	if type(bmin) ~= "table" or type(bmax) ~= "table" then
		return nil, nil
	end
	return Vector3.new(bmin[1] or bmin.x, bmin[2] or bmin.y, bmin[3] or bmin.z),
		Vector3.new(bmax[1] or bmax.x, bmax[2] or bmax.y, bmax[3] or bmax.z)
end

-- The walkable box: the server's walkBounds when it sends them (Update 4); otherwise the area the camera actually
-- captured (parts flagged 0 = captured, not imagined), widened to take in the spawn and the headset's start at the
-- origin, plus a small margin; otherwise the whole bounds.
local WALK_MARGIN = 4

local function walkBoxOf(map: any, mn: Vector3, mx: Vector3): (Vector3, Vector3)
	local wmin, wmax = parseBox(map.walkBounds)
	if wmin and wmax then
		return Vector3.new(wmin.X, mn.Y, wmin.Z), Vector3.new(wmax.X, mx.Y, wmax.Z)
	end
	local x0, z0, x1, z1 = math.huge, math.huge, -math.huge, -math.huge
	for _, p in map.parts do
		if p[10] == 0 then
			x0, x1 = math.min(x0, p[1] - p[4] / 2), math.max(x1, p[1] + p[4] / 2)
			z0, z1 = math.min(z0, p[3] - p[6] / 2), math.max(z1, p[3] + p[6] / 2)
		end
	end
	if not (x0 < x1 and z0 < z1) then
		return mn, mx
	end
	local sp = map.spawn or { 0, 0, 0 }
	for _, pt in { { sp[1] or 0, sp[3] or 0 }, { 0, 0 } } do
		x0, x1 = math.min(x0, pt[1]), math.max(x1, pt[1])
		z0, z1 = math.min(z0, pt[2]), math.max(z1, pt[2])
	end
	x0, z0 = math.max(x0 - WALK_MARGIN, mn.X), math.max(z0 - WALK_MARGIN, mn.Z)
	x1, z1 = math.min(x1 + WALK_MARGIN, mx.X), math.min(z1 + WALK_MARGIN, mx.Z)
	return Vector3.new(x0, mn.Y, z0), Vector3.new(x1, mx.Y, z1)
end

local function newFolder(info: RoomInfo): Folder
	local old = workspace:FindFirstChild("Room")
	if old then
		old:Destroy()
	end
	local folder = Instance.new("Folder")
	folder.Name = "Room"
	folder:SetAttribute("SceneId", info.sceneId)
	folder:SetAttribute("RoomName", info.name)
	folder:SetAttribute("Spawn", info.spawn)
	folder:SetAttribute("BoundsMin", info.boundsMin)
	folder:SetAttribute("BoundsMax", info.boundsMax)
	folder:SetAttribute("CeilingY", info.ceilingY)
	folder:SetAttribute("WalkMin", info.walkMin)
	folder:SetAttribute("WalkMax", info.walkMax)
	folder:SetAttribute("StudsPerMeter", info.studsPerMeter)
	folder:SetAttribute("Count", info.count)
	folder.Parent = workspace
	return folder
end

local function addBounds(folder: Folder, info: RoomInfo)
	local bounds = Instance.new("Folder")
	bounds.Name = "Bounds"
	local mn, mx = info.boundsMin, info.boundsMax
	local size = mx - mn
	local c = (mn + mx) / 2
	local h = math.max(info.ceilingY - mn.Y, 8) + 4
	local midY = mn.Y + h / 2
	local wmn, wmx = info.walkMin or mn, info.walkMax or mx
	-- the floor: top exactly at y = 0, under the walk box (the whole bounds without one) and the spawn, plus a margin
	local fx0 = math.min(wmn.X, info.spawn.X) - FLOOR_MARGIN
	local fz0 = math.min(wmn.Z, info.spawn.Z) - FLOOR_MARGIN
	local fx1 = math.max(wmx.X, info.spawn.X) + FLOOR_MARGIN
	local fz1 = math.max(wmx.Z, info.spawn.Z) + FLOOR_MARGIN
	local floor = invisible(bounds, "Floor", Vector3.new(fx1 - fx0, FLOOR_THICK, fz1 - fz0),
		Vector3.new((fx0 + fx1) / 2, -FLOOR_THICK / 2, (fz0 + fz1) / 2))
	floor.CanCollide = true
	floor.CanQuery = true -- the spawn raycast lands on it
	-- safety floor well under everything
	local safetyTop = math.min(SAFETY_TOP, mn.Y - 4)
	invisible(bounds, "SafetyFloor", Vector3.new(size.X + 8, 2, size.Z + 8), Vector3.new(c.X, safetyTop - 1, c.Z))
	-- Invisible walls around the walkable box (Update 4), tight to its edge.
	local wsize, wc = wmx - wmn, (wmn + wmx) / 2
	invisible(bounds, "WallN", Vector3.new(wsize.X + 2, h, 1), Vector3.new(wc.X, midY, wmn.Z - 0.5))
	invisible(bounds, "WallS", Vector3.new(wsize.X + 2, h, 1), Vector3.new(wc.X, midY, wmx.Z + 0.5))
	invisible(bounds, "WallW", Vector3.new(1, h, wsize.Z + 2), Vector3.new(wmn.X - 0.5, midY, wc.Z))
	invisible(bounds, "WallE", Vector3.new(1, h, wsize.Z + 2), Vector3.new(wmx.X + 0.5, midY, wc.Z))
	invisible(bounds, "Lid", Vector3.new(size.X + 8, 1, size.Z + 8), Vector3.new(c.X, info.ceilingY + 0.5, c.Z))
	bounds.Parent = folder
end

function MapBuilder.infoFromMap(map: any): RoomInfo
	local mn, mx, ceilingY = boundsOf(map)
	local wmin, wmax = walkBoxOf(map, mn, mx)
	local s = map.spawn or { 0, 0, 0 }
	return {
		sceneId = map.sceneId or "?",
		name = map.name or map.sceneId or "Room",
		spawn = Vector3.new(s[1] or s.x or 0, s[2] or s.y or 0, s[3] or s.z or 0),
		spawnYaw = tonumber(map.spawnYaw),
		walkMin = wmin,
		walkMax = wmax,
		boundsMin = mn,
		boundsMax = mx,
		ceilingY = ceilingY,
		studsPerMeter = map.studsPerMeter or 3.57,
		count = #map.parts,
	}
end

-- Builds the map; onProgress(built, total). Returns info, or nil if cancelled by a newer build.
-- opts.collisionOnly: the blocks are invisible collision under a textured room model (shivin.md Update 2).
function MapBuilder.build(map: any, onProgress: ((number, number) -> ())?, opts: { collisionOnly: boolean? }?): RoomInfo?
	local collisionOnly = opts ~= nil and opts.collisionOnly == true
	generation += 1
	local myGen = generation
	local t0 = os.clock()
	local info = MapBuilder.infoFromMap(map)
	MapBuilder.current = nil
	if not collisionOnly then
		MapBuilder.setUnlit(false) -- a block room: normal lighting (a textured one goes unlit in attachModel)
	end
	local folder = newFolder(info)
	local parts = map.parts
	local total = #parts
	local batch = Config.BATCH
	local hasImagined = false
	for i, p in parts do
		local part = template:Clone()
		local sx, sy, sz = p[4], p[5], p[6]
		part.Size = Vector3.new(sx, sy, sz)
		part.CFrame = CFrame.new(p[1], p[2], p[3])
		part.Color = Color3.fromRGB(p[7], p[8], p[9])
		part.CastShadow = math.min(sx, sy, sz) >= 1 and not collisionOnly
		part.CanCollide = math.max(sx, sy, sz) >= 0.6
		if collisionOnly then
			part.Transparency = 1
			part.CanQuery = math.max(sx, sy, sz) >= 0.6 -- spawn raycasts still find the floor
		elseif p[10] == 1 then
			hasImagined = true
			CollectionService:AddTag(part, "DVImagined")
		end
		part.Parent = folder
		if i % batch == 0 then
			if onProgress then
				onProgress(i, total)
			end
			task.wait()
			if generation ~= myGen then
				return nil
			end
			if i == batch then
				addBounds(folder, info)
			end
		end
	end
	if not folder:FindFirstChild("Bounds") then
		addBounds(folder, info)
	end
	folder:SetAttribute("HasImagined", hasImagined)
	if onProgress then
		onProgress(total, total)
	end
	print(string.format("[DejaView] built %s: %d parts in %.2fs (batch %d)", info.sceneId, total, os.clock() - t0, batch))
	MapBuilder.current = info
	return info
end

local function prepareModel(model: Instance, meshCollision: boolean)
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			d.Anchored = true
			d.CanTouch = false
			d.CanCollide = meshCollision
			d.CanQuery = meshCollision
			-- Baked textures already hold the photo's light: no extra shading on top (Update 10)
			d.Material = Enum.Material.SmoothPlastic
			d.Reflectance = 0
			d.CastShadow = false
		elseif d:IsA("Script") or d:IsA("LocalScript") then
			d:Destroy() -- an imported or uploaded room must never run code
		end
	end
end

-- A loaded room as a Model (ScaleTo and PivotTo need one): a Folder's children move into a new Model; anything else
-- (a lone MeshPart) goes into it as it is.
local function asModel(container: Instance): Model
	if container:IsA("Model") then
		return container :: Model
	end
	local m = Instance.new("Model")
	m.Name = container.Name
	for k, v in container:GetAttributes() do
		m:SetAttribute(k, v)
	end
	if container:IsA("Folder") then
		for _, c in container:GetChildren() do
			c.Parent = m
		end
		container:Destroy()
	else
		container.Parent = m
	end
	return m
end

-- The world box of every BasePart in a model: the corners of CFrame * Size / 2 (GetBoundingBox is oriented).
local function partsBox(model: Instance): (Vector3?, Vector3?)
	local mn = Vector3.new(math.huge, math.huge, math.huge)
	local mx = -mn
	local any = false
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			local cf, half = d.CFrame, d.Size / 2
			for i = 0, 7 do
				local corner = cf * Vector3.new(
					if i % 2 == 0 then -half.X else half.X,
					if i % 4 < 2 then -half.Y else half.Y,
					if i < 4 then -half.Z else half.Z
				)
				mn = mn:Min(corner)
				mx = mx:Max(corner)
			end
			any = true
		end
	end
	if not any then
		return nil, nil
	end
	return mn, mx
end

-- How far off a loaded model may be before it is turned, scaled or moved. Against the server's own box for that model
-- (exact) any scale error over 2 % is fixed, a turn is taken when the swapped extents fit and the unswapped ones
-- clearly do not (a nearly square room differs by only a few percent), and the box always lands on it. Against the
-- block map's bounds (loose: a room imported in Studio) only gross errors are fixed: a wrong unit (3.57x), which
-- scales x, y and z alike, or a model left outside the map. A model may cover much less ground than the map (newer
-- ones only cover the walk box), so a different size alone is no reason to scale or move it.
local EXACT_SCALE = 0.02
local EXACT_TURN = 0.02 -- the swapped extents agree this well
local EXACT_TURN_OFF = 0.04 -- and the unswapped ones are at least this far apart (and twice as far as the swapped)
local LOOSE_SCALE = 0.25
local LOOSE_AGREE = 0.15 -- the x, y and z ratios of a wrong unit agree this well
local LOOSE_TURN = 0.1
local LOOSE_OFFSET = 0.1 -- of the larger horizontal extent
local LOOSE_DROP = 2 -- studs

-- How far apart some ratios are: the largest over the smallest, minus 1.
local function spread(a: number, b: number, c: number?): number
	local cc = c or a
	return math.max(a, b, cc) / math.min(a, b, cc) - 1
end

-- Whether two boxes have the same proportions (x : y : z within 3 %), as two boxes of one model do; a quarter turn
-- about Y counts.
local function sameShape(a: Vector3, b: Vector3): boolean
	if a.X <= 0 or a.Y <= 0 or a.Z <= 0 or b.X <= 0 or b.Y <= 0 or b.Z <= 0 then
		return false
	end
	return spread(a.X / b.X, a.Y / b.Y, a.Z / b.Z) < 0.03 or spread(a.X / b.Z, a.Y / b.Y, a.Z / b.X) < 0.03
end

-- Turns, scales and moves `model` so its world box matches emin..emax: centres on x and z, bottoms on y. A quarter
-- turn about Y when its x and z extents are swapped; one uniform scale (the mean of the x and z ratios); then a
-- move. Prints what it did. The collision blocks never move: they are the ground truth.
local function alignModel(model: Model, emin: Vector3, emax: Vector3, loose: boolean)
	local amin, amax = partsBox(model)
	if not amin or not amax then
		return
	end
	local esize, asize = emax - emin, amax - amin
	if esize.X <= 0 or esize.Z <= 0 or asize.X <= 0 or asize.Z <= 0 then
		return
	end
	-- the y ratio (a turn about Y keeps it); nil when either box is flat
	local ry = if esize.Y > 0 and asize.Y > 0 then esize.Y / asize.Y else nil
	-- swapped: the x and z ratios agree against the other axis, not against their own (loose: y agrees as well)
	local turned = 0
	local own = spread(asize.X / esize.X, asize.Z / esize.Z)
	local swapped = spread(asize.X / esize.Z, asize.Z / esize.X)
	local turn = if loose
		then ry ~= nil and own >= LOOSE_TURN and spread(esize.Z / asize.X, esize.X / asize.Z, ry) < LOOSE_TURN
		else swapped < EXACT_TURN and own > math.max(EXACT_TURN_OFF, 2 * swapped)
	if turn then
		local centre = (amin + amax) / 2
		model:PivotTo(CFrame.new(centre) * CFrame.Angles(0, math.pi / 2, 0) * CFrame.new(-centre) * model:GetPivot())
		turned = 90
		amin, amax = partsBox(model)
		if not amin or not amax then
			return
		end
		asize = amax - amin
	end
	local rx, rz = esize.X / asize.X, esize.Z / asize.Z
	local factor = (rx + rz) / 2
	local scaled = 1
	local rescale = math.abs(factor - 1) > (if loose then LOOSE_SCALE else EXACT_SCALE)
	if rescale and loose then
		rescale = ry ~= nil and spread(rx, rz, ry) < LOOSE_AGREE
	end
	if rescale then
		local ok, err = pcall(function()
			model:ScaleTo(model:GetScale() * factor)
		end)
		if ok then
			scaled = factor
			amin, amax = partsBox(model)
			if not amin or not amax then
				return
			end
		else
			warn("[DejaView] could not scale the room model:", err)
		end
	end
	local ac, ec = (amin + amax) / 2, (emin + emax) / 2
	local delta = Vector3.new(ec.X - ac.X, emin.Y - amin.Y, ec.Z - ac.Z)
	if loose and scaled == 1 and turned == 0 then
		local tol = LOOSE_OFFSET * math.max(esize.X, esize.Z)
		local inside = amin.X >= emin.X - tol and amax.X <= emax.X + tol and amin.Z >= emin.Z - tol and amax.Z <= emax.Z + tol
		if inside and math.abs(delta.Y) < LOOSE_DROP then
			delta = Vector3.zero -- within the block map and on its floor: it is in the map frame already
		end
	end
	if delta.Magnitude > 0.001 then
		model:PivotTo(model:GetPivot() + delta)
	end
	print(string.format("[DejaView] room model aligned on the %s: scale x%.3f, turned %d deg, offset (%.2f, %.2f, %.2f)",
		if loose then "block map" else "model box", scaled, turned, delta.X, delta.Y, delta.Z))
end

-- Lines one part of a multi-part room model up on the server's box for that part ({min, max} in studs), so a part
-- that loads somewhere of its own still joins the others.
function MapBuilder.alignPart(model: Model, box: any?)
	local emin, emax = parseBox(box)
	if emin and emax then
		alignModel(model, emin, emax, false)
	end
end

-- The server's box for a model ({min, max} in studs) to align it on exactly, or nil. With `checkShape` (a room
-- imported in Studio, which may be another build than the one the server describes) only when the model has the
-- box's proportions.
local function serverBox(model: Model, box: any?, checkShape: boolean?): (Vector3?, Vector3?)
	local emin, emax = parseBox(box)
	if not emin or not emax then
		return nil, nil
	end
	if checkShape then
		local amin, amax = partsBox(model)
		if not amin or not amax or not sameShape(amax - amin, emax - emin) then
			return nil, nil
		end
	end
	return emin, emax
end

-- Puts a textured room model into the current Workspace.Room (over invisible collision blocks), turned, scaled and
-- moved onto `box` ({min, max} in studs): the server's own box for the model it loaded, else the block map's bounds
-- (loose). `checkShape`: see serverBox. Returns the model as placed.
function MapBuilder.attachModel(container: Instance, box: any?, checkShape: boolean?): Model?
	local room = workspace:FindFirstChild("Room")
	if not room then
		container:Destroy()
		return nil
	end
	local model = asModel(container)
	prepareModel(model, false)
	local emin, emax = serverBox(model, box, checkShape)
	local loose = false
	if not emin or not emax then
		local info = MapBuilder.current
		if info then
			emin, emax, loose = info.boundsMin, info.boundsMax, true
		end
	end
	if emin and emax then
		alignModel(model, emin, emax, loose)
	end
	model.Name = "RoomModel"
	model.Parent = room
	room:SetAttribute("HasModel", true)
	MapBuilder.setUnlit(true)
	return model
end

-- A textured room with no block map (map fetch failed): the meshes are the collision. `frame` is the server's model
-- details (walkBounds, spawn, spawnYaw); `box` the server's own box for this model, to align it on, when known
-- (`checkShape`: see serverBox).
function MapBuilder.buildFromModel(sceneId: string, name: string, container: Instance, frame: any?, box: any?,
	checkShape: boolean?): RoomInfo?
	generation += 1
	local model = asModel(container)
	prepareModel(model, true)
	local emin, emax = serverBox(model, box, checkShape)
	if emin and emax then
		alignModel(model, emin, emax, false)
	end
	local mn, mx = partsBox(model)
	if not mn or not mx then
		mn, mx = Vector3.new(-15, 0, -15), Vector3.new(15, 10, 15)
	end
	local f = if type(frame) == "table" then frame else {}
	local spawnAttr = model:GetAttribute("Spawn")
	local fs = f.spawn
	local spawn = if typeof(spawnAttr) == "Vector3"
		then spawnAttr
		elseif type(fs) == "table" and tonumber(fs[1]) and tonumber(fs[3])
		then Vector3.new(tonumber(fs[1]) :: number, tonumber(fs[2]) or 0, tonumber(fs[3]) :: number)
		else Vector3.new((mn.X + mx.X) / 2, if emin then 0 else mn.Y, (mn.Z + mx.Z) / 2)
	local wmin, wmax = parseBox(f.walkBounds)
	local info: RoomInfo = {
		sceneId = sceneId,
		name = name,
		spawn = spawn,
		spawnYaw = tonumber(f.spawnYaw),
		walkMin = if wmin then Vector3.new(wmin.X, mn.Y, wmin.Z) else nil,
		walkMax = if wmax then Vector3.new(wmax.X, mx.Y, wmax.Z) else nil,
		boundsMin = mn,
		boundsMax = mx,
		ceilingY = mx.Y,
		studsPerMeter = model:GetAttribute("StudsPerMeter") or tonumber(f.studsPerMeter) or 3.57,
		count = #model:GetDescendants(),
	}
	local folder = newFolder(info)
	model.Name = "RoomModel"
	model.Parent = folder
	folder:SetAttribute("HasModel", true)
	addBounds(folder, info)
	MapBuilder.setUnlit(true)
	MapBuilder.current = info
	print("[DejaView] loaded room model for", sceneId, "(no block map)")
	return info
end

-- No room (everyone back in the lobby): removes Workspace.Room and puts the normal lighting back.
function MapBuilder.clear()
	generation += 1
	local old = workspace:FindFirstChild("Room")
	if old then
		old:Destroy()
	end
	MapBuilder.current = nil
	MapBuilder.setUnlit(false)
end

function MapBuilder.hasBaked(sceneId: string): boolean
	local baked = ServerStorage:FindFirstChild("BakedRooms")
	return baked ~= nil and baked:FindFirstChild(sceneId) ~= nil
end

-- Clones ServerStorage.BakedRooms[sceneId] (a copy of a built Workspace.Room) into Workspace.
function MapBuilder.buildBaked(sceneId: string): RoomInfo?
	local baked = ServerStorage:FindFirstChild("BakedRooms")
	local src = baked and baked:FindFirstChild(sceneId)
	if not src then
		return nil
	end
	generation += 1
	local old = workspace:FindFirstChild("Room")
	if old then
		old:Destroy()
	end
	local folder = src:Clone()
	folder.Name = "Room"
	folder.Parent = workspace
	local info: RoomInfo = {
		sceneId = sceneId,
		name = folder:GetAttribute("RoomName") or sceneId,
		spawn = folder:GetAttribute("Spawn") or Vector3.zero,
		boundsMin = folder:GetAttribute("BoundsMin") or Vector3.new(-15, 0, -15),
		boundsMax = folder:GetAttribute("BoundsMax") or Vector3.new(15, 10, 15),
		ceilingY = folder:GetAttribute("CeilingY") or 10,
		studsPerMeter = folder:GetAttribute("StudsPerMeter") or 3.57,
		count = folder:GetAttribute("Count") or #folder:GetChildren(),
	}
	MapBuilder.setUnlit(folder:GetAttribute("HasModel") == true)
	print("[DejaView] loaded baked room", sceneId)
	MapBuilder.current = info
	return info
end

local OFFSETS = { Vector2.new(0, 0), Vector2.new(3, 0), Vector2.new(-3, 0), Vector2.new(0, 3), Vector2.new(0, -3),
	Vector2.new(3, 3), Vector2.new(-3, -3), Vector2.new(3, -3), Vector2.new(-3, 3) }

-- Places a character around spawn, on the floor, facing the room centre.
function MapBuilder.place(character: Model, index: number)
	local info = MapBuilder.current
	if not info then
		return
	end
	local off = OFFSETS[(index - 1) % #OFFSETS + 1]
	local x, z = info.spawn.X + off.X, info.spawn.Z + off.Y
	local floorY = info.spawn.Y
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Include
	local room = workspace:FindFirstChild("Room")
	if room then
		params.FilterDescendantsInstances = { room }
		local hit = workspace:Raycast(Vector3.new(x, floorY + 10, z), Vector3.new(0, -30, 0), params)
		if hit then
			floorY = hit.Position.Y
		end
	end
	-- Face the way the server says (spawnYaw: into the part of the world the camera saw), else the room centre.
	local centre = (info.boundsMin + info.boundsMax) / 2
	local dx, dz = centre.X - x, centre.Z - z
	local yaw = info.spawnYaw or (if math.abs(dx) + math.abs(dz) > 0.01 then math.atan2(-dx, -dz) else 0)
	character:PivotTo(CFrame.new(x, floorY + 3, z) * CFrame.Angles(0, yaw, 0))
end

return MapBuilder
