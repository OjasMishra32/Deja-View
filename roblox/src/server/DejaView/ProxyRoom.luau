-- Painted box rooms (pipeline/roblox_proxy.py): for a place whose scan is too thin to stand in, a floor of tiles
-- rendered straight down and wall panels rendered from the middle, shown as Decals on thin parts. The tiles' upload
-- ids and placement (studs, map frame) come from ProxyTiles; the game adds the real tables in 3D.
local ProxyTiles = require(script.Parent.ProxyTiles)

local ProxyRoom = {}

function ProxyRoom.has(sceneId: string): boolean
	return ProxyTiles[sceneId] ~= nil
end

-- Builds the painted room into `parent`. `image(decalId)` turns an uploaded Decal id into its image.
function ProxyRoom.build(sceneId: string, parent: Instance, image: (string) -> string): Folder?
	local doc = ProxyTiles[sceneId]
	if not doc then
		return nil
	end
	local folder = Instance.new("Folder")
	folder.Name = "PaintedRoom"
	for i, t in doc.tiles do
		local p = Instance.new("Part")
		p.Name = t.kind .. i
		p.Anchored, p.CanCollide, p.CanQuery, p.CanTouch, p.CastShadow = true, false, false, false, false
		p.Material = Enum.Material.SmoothPlastic
		-- only the painted side shows: the part itself is invisible, so from behind (a camera outside the room) the
		-- panel is see-through instead of a black slab
		p.Transparency = 1
		p.TopSurface, p.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
		local c = Vector3.new(t.c[1], t.c[2], t.c[3])
		local d = Instance.new("Decal")
		d.Texture = image(t.asset)
		if t.kind == "floor" then
			p.Size = Vector3.new(t.s[1], 0.1, t.s[2])
			p.CFrame = CFrame.new(c.X, -0.06, c.Z)
			d.Face = Enum.NormalId.Top
		else
			p.Size = Vector3.new(t.s[1], t.s[2], 0.1)
			local n = Vector3.new(t.n[1], t.n[2], t.n[3])
			p.CFrame = CFrame.lookAt(c, c + n) -- the front face looks into the room
			d.Face = Enum.NormalId.Front
		end
		d.Parent = p
		p.Parent = folder
	end
	folder.Parent = parent
	return folder
end

return ProxyRoom
