-- How the world is lit on this client (Update 10). Inside a room with a textured model, show the baked texture colours
-- as they are (no extra lighting, shadows or effects) and the world's own skybox; in the lobby or a block room, the
-- normal look. Lighting changes made by a client stay on that client, so lobby players keep the lobby look.
local Lighting = game:GetService("Lighting")

local RoomLook = {}

local saved: { [string]: any } = {}
local effectsSaved: { [Instance]: boolean } = {}
local sky: Sky? = nil
local active = false

local UNLIT = {
	GlobalShadows = false,
	Ambient = Color3.new(1, 1, 1),
	OutdoorAmbient = Color3.new(1, 1, 1),
	Brightness = 0,
	EnvironmentDiffuseScale = 0,
	EnvironmentSpecularScale = 0,
	ExposureCompensation = 0,
}

local function setSky(room: Instance?)
	if sky and room and sky.Parent and sky.SkyboxFt == (room:GetAttribute("SkyFt") or "") then
		return -- same world, same sky
	end
	if sky then
		sky:Destroy()
		sky = nil
	end
	if not room or not room:GetAttribute("SkyFt") then
		return
	end
	local s = Instance.new("Sky")
	s.Name = "DejaViewSky"
	s.SkyboxFt = room:GetAttribute("SkyFt") or ""
	s.SkyboxBk = room:GetAttribute("SkyBk") or ""
	s.SkyboxLf = room:GetAttribute("SkyLf") or ""
	s.SkyboxRt = room:GetAttribute("SkyRt") or ""
	s.SkyboxUp = room:GetAttribute("SkyUp") or ""
	s.SkyboxDn = room:GetAttribute("SkyDn") or ""
	s.CelestialBodiesShown = false
	s.StarCount = 0
	s.Parent = Lighting
	sky = s
	print("[RoomLook] world skybox on")
end

local function enter(room: Instance)
	if not active then
		active = true
		for k in UNLIT do
			saved[k] = (Lighting :: any)[k]
		end
		for _, e in Lighting:GetChildren() do
			if e:IsA("PostEffect") or e:IsA("Atmosphere") then
				local wasOn = if e:IsA("PostEffect") then e.Enabled else true
				effectsSaved[e] = wasOn
				if e:IsA("PostEffect") then
					e.Enabled = false
				else
					e.Parent = nil
				end
			end
		end
		for k, v in UNLIT do
			(Lighting :: any)[k] = v
		end
		print("[RoomLook] unlit textured room look on")
	end
	setSky(room)
end

local function leave()
	setSky(nil)
	if not active then
		return
	end
	active = false
	for k, v in saved do
		(Lighting :: any)[k] = v
	end
	for e, wasOn in effectsSaved do
		if e:IsA("PostEffect") then
			e.Enabled = wasOn
		else
			e.Parent = Lighting
		end
	end
	effectsSaved = {}
end

-- inRoom: this player is in the room (not the lobby).
function RoomLook.update(inRoom: boolean)
	local room = workspace:FindFirstChild("Room")
	if inRoom and room and room:GetAttribute("HasModel") then
		enter(room)
	else
		leave()
	end
end

return RoomLook
