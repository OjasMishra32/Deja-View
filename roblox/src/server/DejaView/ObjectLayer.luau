-- Builds the proxy object layer from the server's objects.json (docs/object-layer.md).
-- The proxy is inflated so it covers the rough scanned original. No data means no change.
local InsertService = game:GetService("InsertService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Backend = require(script.Parent.Backend)
local ObjectFixtures = require(ReplicatedStorage.Shared.ObjectFixtures)
local ObjectLayout = require(ReplicatedStorage.Shared.ObjectLayout)

local ObjectLayer = {}

local function colour(c: { number }): Color3
	return Color3.fromRGB(c[1] or 240, c[2] or 240, c[3] or 240)
end

local function makePart(plan: any, parent: Instance): Part
	local p = Instance.new("Part")
	p.Name = plan.name or plan.id or "Object"
	p.Anchored = true
	p.CanCollide = true
	p.CastShadow = true
	p.TopSurface, p.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
	p.Material = if plan.name == "handle" then Enum.Material.Metal else Enum.Material.SmoothPlastic
	p.Color = colour(plan.color)
	p.Transparency = plan.transparency or 0
	local sx, sy, sz = plan.size[1], plan.size[2], plan.size[3]
	local base = CFrame.new(plan.center[1], plan.center[2], plan.center[3]) * CFrame.Angles(0, plan.yaw or 0, 0)
	if plan.shape == "cylinder" then
		-- Roblox's cylinder axis is X; the schema's cylinder axis is Y.
		p.Shape = Enum.PartType.Cylinder
		p.Size = Vector3.new(sy, sx, sz)
		p.CFrame = base * CFrame.Angles(0, 0, math.pi / 2)
	elseif plan.shape == "sphere" then
		p.Shape = Enum.PartType.Ball
		p.Size = Vector3.new(sx, sy, sz)
		p.CFrame = base
	else
		p.Shape = Enum.PartType.Block
		p.Size = Vector3.new(sx, sy, sz)
		p.CFrame = base
	end
	p:SetAttribute("ObjectId", plan.id)
	p:SetAttribute("Label", plan.label or plan.id)
	if plan.source and plan.source.splats then
		p:SetAttribute("SourceSplats", plan.source.splats)
	end
	p.Parent = parent
	return p
end

-- Load the uploaded Model for one object. The proxy part stays as the collision shape.
local function loadMesh(plan: any, parent: Instance): boolean
	local assetId = tonumber(plan.assetId)
	if not assetId then return false end
	local ok, model = pcall(function()
		return InsertService:LoadAsset(assetId)
	end)
	if not ok or not model then
		warn(`[DejaView] could not load object mesh {assetId}: {tostring(model)}`)
		return false
	end
	model.Name = plan.id or "ObjectMesh"
	for _, part in model:GetDescendants() do
		if part:IsA("BasePart") then
			part.Anchored = true
			part.CanCollide = false
			part.CastShadow = true
		end
	end
	model.Parent = parent
	return true
end

function ObjectLayer.build(sceneId: string, room: Instance?)
	local ok, doc, status = Backend.objects(sceneId)
	if not ok or type(doc) ~= "table" or type(doc.objects) ~= "table" or #doc.objects == 0 then
		doc = ObjectFixtures[sceneId]
		if not doc then
			if status ~= 404 then
				warn("[DejaView] object layer unavailable for", sceneId, status)
			end
			return
		end
		print(`[DejaView] using baked object layer for {sceneId}`)
	end
	local plan = ObjectLayout.plan(doc, { style = doc.style or "flat", inflate = 0.15 })
	local container = room or workspace:FindFirstChild("Room") or workspace
	local old = container:FindFirstChild("ObjectLayer")
	if old then
		old:Destroy()
	end
	local model = Instance.new("Model")
	model.Name = "ObjectLayer"
	for _, obj in plan.objects do
		local proxy = makePart(obj, model)
		local hasMesh = false
		if obj.assetId then
			hasMesh = loadMesh(obj, model)
			if hasMesh then proxy.Transparency = 1 end
		end
		for _, child in obj.parts or {} do
			local childProxy = makePart(child, model)
			if hasMesh then childProxy.Transparency = 1 end
		end
	end
	if plan.outline then
		local highlight = Instance.new("Highlight")
		highlight.Name = "ObjectOutline"
		highlight.Adornee = model
		highlight.FillTransparency = 1
		highlight.OutlineColor = Color3.new(0, 0, 0)
		highlight.OutlineTransparency = 0
		highlight.Parent = model
	end
	model.Parent = container
	print(`[DejaView] object layer {sceneId}: {#plan.objects} objects`)
end

return ObjectLayer
