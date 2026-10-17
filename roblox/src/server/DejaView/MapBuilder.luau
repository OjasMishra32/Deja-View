-- Map JSON -> anchored Parts in batches, with progress, teardown, invisible bounds and baked fallback.
local CollectionService = game:GetService("CollectionService")
local ServerStorage = game:GetService("ServerStorage")
local Config = require(script.Parent.Config)

local MapBuilder = {}

export type RoomInfo = {
	sceneId: string,
	name: string,
	spawn: Vector3,
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

local function invisible(parent: Instance, name: string, size: Vector3, pos: Vector3)
	local p = template:Clone()
	p.Name = name
	p.Size = size
	p.CFrame = CFrame.new(pos)
	p.Transparency = 1
	p.CastShadow = false
	p.CanQuery = false
	p.Parent = parent
end

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
	-- safety floor under everything
	invisible(bounds, "SafetyFloor", Vector3.new(size.X + 8, 2, size.Z + 8), Vector3.new(c.X, math.min(mn.Y, 0) - 1.5, c.Z))
	invisible(bounds, "WallN", Vector3.new(size.X + 8, h, 2), Vector3.new(c.X, midY, mn.Z - 2))
	invisible(bounds, "WallS", Vector3.new(size.X + 8, h, 2), Vector3.new(c.X, midY, mx.Z + 2))
	invisible(bounds, "WallW", Vector3.new(2, h, size.Z + 8), Vector3.new(mn.X - 2, midY, c.Z))
	invisible(bounds, "WallE", Vector3.new(2, h, size.Z + 8), Vector3.new(mx.X + 2, midY, c.Z))
	invisible(bounds, "Lid", Vector3.new(size.X + 8, 1, size.Z + 8), Vector3.new(c.X, info.ceilingY + 0.5, c.Z))
	bounds.Parent = folder
end

function MapBuilder.infoFromMap(map: any): RoomInfo
	local mn, mx, ceilingY = boundsOf(map)
	local s = map.spawn or { 0, 0, 0 }
	return {
		sceneId = map.sceneId or "?",
		name = map.name or map.sceneId or "Room",
		spawn = Vector3.new(s[1] or s.x or 0, s[2] or s.y or 0, s[3] or s.z or 0),
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
		elseif d:IsA("Script") or d:IsA("LocalScript") then
			d:Destroy() -- an imported or uploaded room must never run code
		end
	end
end

-- Puts a textured room model into the current Workspace.Room (over invisible collision blocks).
function MapBuilder.attachModel(model: Instance)
	local room = workspace:FindFirstChild("Room")
	if not room then
		return
	end
	prepareModel(model, false)
	model.Name = "RoomModel"
	model.Parent = room
	room:SetAttribute("HasModel", true)
end

-- A textured room with no block map (map fetch failed): the meshes are the collision.
function MapBuilder.buildFromModel(sceneId: string, name: string, model: Instance): RoomInfo?
	generation += 1
	prepareModel(model, true)
	local cf, size
	if model:IsA("Model") then
		cf, size = model:GetBoundingBox()
	else
		local tmp = Instance.new("Model")
		for _, c in model:GetChildren() do
			c.Parent = tmp
		end
		cf, size = tmp:GetBoundingBox()
		for _, c in tmp:GetChildren() do
			c.Parent = model
		end
	end
	local half = size / 2
	local mn, mx = cf.Position - half, cf.Position + half
	local spawnAttr = model:GetAttribute("Spawn")
	local info: RoomInfo = {
		sceneId = sceneId,
		name = name,
		spawn = if typeof(spawnAttr) == "Vector3" then spawnAttr else Vector3.new(cf.Position.X, mn.Y, cf.Position.Z),
		boundsMin = mn,
		boundsMax = mx,
		ceilingY = mx.Y,
		studsPerMeter = model:GetAttribute("StudsPerMeter") or 3.57,
		count = #model:GetDescendants(),
	}
	local folder = newFolder(info)
	model.Name = "RoomModel"
	model.Parent = folder
	folder:SetAttribute("HasModel", true)
	addBounds(folder, info)
	MapBuilder.current = info
	print("[DejaView] loaded room model for", sceneId, "(no block map)")
	return info
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
	local centre = (info.boundsMin + info.boundsMax) / 2
	local dx, dz = centre.X - x, centre.Z - z
	local yaw = if math.abs(dx) + math.abs(dz) > 0.01 then math.atan2(-dx, -dz) else 0
	character:PivotTo(CFrame.new(x, floorY + 3, z) * CFrame.Angles(0, yaw, 0))
end

return MapBuilder
