-- Room list, prefetch + swatches, votes, switching, auto-join, JOIN and Follow (team/shivin.md 7.2).
local AssetService = game:GetService("AssetService")
local HttpService = game:GetService("HttpService")
local ServerStorage = game:GetService("ServerStorage")
local Players = game:GetService("Players")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local MapBuilder = require(script.Parent.MapBuilder)
local ObjectLayer = require(script.Parent.ObjectLayer)
local World = require(script.Parent.World)
local Fixtures = require(game:GetService("ReplicatedStorage").Shared.Fixtures)

local Rooms = {}

type Entry = {
	map: any?,
	swatches: { string }?,
	measuring: boolean,
	failed: boolean,
	tries: number,
	nextTry: number,
	gone: boolean?,
}

local list: { any } = {} -- last /api/scenes answer
local cache: { [string]: Entry } = {}
local firstSeen: { [string]: number } = {}
local listLoaded = false
local playableSeen: { [string]: boolean } = {}
local votes: { [Player]: string } = {}
local switching = 0
local judgeScene: string? = nil
local activeSeenAt = 0
local lastFollowed: string? = nil
local lastBoardJson = ""
local closedRooms: { [string]: boolean } = {} -- archived or deleted on the server while we knew them
local closing = false

Rooms.onSwitchStart = nil :: (() -> ())?
Rooms.onRoomReady = nil :: ((joined: boolean) -> ())?

local function now()
	return workspace:GetServerTimeNow()
end

-- Only Photo worlds become Roblox places; a video memory stays in the headset (shivin.md Update 2).
-- The live server still reports its internal mode names: "thirdwheel" is a video memory.
local function isVideo(s: any): boolean
	return s ~= nil and (s.mode == "video" or s.mode == "thirdwheel")
end

local function playable(s: any): boolean
	return s ~= nil and s.status == "ready" and not isVideo(s)
end

local function sceneById(id: string): any?
	for _, s in list do
		if s.id == id then
			return s
		end
	end
	return nil
end

-- The colour of the room's own ground, from the map: area-weighted over the boxes that sit on the floor.
local function groundColour(map: any): Color3?
	local r, g, b, w = 0, 0, 0, 0
	for _, p in map.parts do
		if p[2] - p[5] / 2 <= 0.6 and p[5] <= 1.5 then
			local a = p[4] * p[6]
			r, g, b, w = r + p[7] * a, g + p[8] * a, b + p[9] * a, w + a
		end
	end
	return if w > 0 then Color3.fromRGB(r / w, g / w, b / w) else nil
end

-- Sky faces go up as Decals; a Sky needs the image inside the decal, so look it up once per face.
local InsertService = game:GetService("InsertService")
local skyImages: { [string]: string } = {}
local function skyImage(id: string): string
	if skyImages[id] then
		return skyImages[id]
	end
	local url = "rbxassetid://" .. id
	local ok, m = pcall(InsertService.LoadAsset, InsertService, tonumber(id))
	if ok and typeof(m) == "Instance" then
		local d = m:FindFirstChildWhichIsA("Decal", true)
		if d and d.Texture ~= "" then
			url = d.Texture
		end
		m:Destroy()
	end
	skyImages[id] = url
	return url
end

local function swatches(map: any): { string }
	local weight: { [number]: number } = {}
	for _, p in map.parts do
		local key = bit32.bor(bit32.lshift(p[7] // 8, 10), bit32.lshift(p[8] // 8, 5), p[9] // 8)
		weight[key] = (weight[key] or 0) + p[4] * p[5] * p[6]
	end
	local keys = {}
	for k in weight do
		table.insert(keys, k)
	end
	table.sort(keys, function(a, b)
		return weight[a] > weight[b]
	end)
	local out = {}
	for i = 1, math.min(4, #keys) do
		local k = keys[i]
		local r, g, b =
			bit32.rshift(k, 10) * 8 + 4, bit32.band(bit32.rshift(k, 5), 31) * 8 + 4, bit32.band(k, 31) * 8 + 4
		table.insert(out, Color3.fromRGB(r, g, b):ToHex())
	end
	return out
end

local function entry(id: string): Entry
	local e = cache[id]
	if not e then
		e = { map = nil, swatches = nil, measuring = false, failed = false, tries = 0, nextTry = 0 }
		cache[id] = e
	end
	return e
end

-- The textured room imported in Studio ahead of time (demo worlds), if any.
local function storedRoom(sceneId: string): Instance?
	local rooms = ServerStorage:FindFirstChild("Rooms")
	return rooms and rooms:FindFirstChild(sceneId)
end

-- GET /api/roblox/<id>/model (contract 6.2b): assetId, walkBounds, chunks. Cached once it answers 200.
local modelInfos: { [string]: any } = {}
local function modelInfo(sceneId: string): any?
	if modelInfos[sceneId] == nil then
		local ok, info, status = Backend.model(sceneId)
		if ok and type(info) == "table" then
			modelInfos[sceneId] = info
		elseif status == 404 then
			modelInfos[sceneId] = false -- not built for this scene (yet); try again next switch
			task.delay(30, function()
				modelInfos[sceneId] = nil
			end)
		end
	end
	return modelInfos[sceneId] or nil
end

Rooms.modelInfo = function(sceneId: string): any?
	return modelInfo(sceneId)
end

-- Table and board positions (contract 6.6): /model's features, else the map's (chess-room has no model yet).
function Rooms.featuresFor(sceneId: string): any?
	local merged = {}
	local e = cache[sceneId]
	if e and e.map and type(e.map.features) == "table" then
		for k, v in e.map.features do
			merged[k] = v
		end
	end
	local mi = modelInfo(sceneId)
	if mi and type(mi.features) == "table" then
		for k, v in mi.features do
			merged[k] = v
		end
	end
	return if next(merged) then merged else nil
end

-- The union of {min, max} boxes (studs), or nil when any is missing.
local function unionBox(boxes: { any }): any?
	local mn, mx = nil, nil
	for _, b in boxes do
		local lo, hi = type(b) == "table" and b.min, type(b) == "table" and b.max
		if type(lo) ~= "table" or type(hi) ~= "table" then
			return nil
		end
		local a = Vector3.new(tonumber(lo[1]) or 0, tonumber(lo[2]) or 0, tonumber(lo[3]) or 0)
		local z = Vector3.new(tonumber(hi[1]) or 0, tonumber(hi[2]) or 0, tonumber(hi[3]) or 0)
		mn = if mn then mn:Min(a) else a
		mx = if mx then mx:Max(z) else z
	end
	if not mn or not mx then
		return nil
	end
	return { min = { mn.X, mn.Y, mn.Z }, max = { mx.X, mx.Y, mx.Z } }
end

-- The textured room the server uploaded with Open Cloud (contract 6.2b), loaded by asset id; nil without one. A model
-- in several parts (roblox.glb, roblox-2.glb, ...) loads every part into one Model, each part lined up on its own box
-- when the server sends one. Also returns the box the loaded
-- parts occupy according to the server (studs, map frame), to centre and scale the model on; nil when unknown.
local function uploadedRoom(sceneId: string): (Instance?, any?)
	local info = modelInfo(sceneId)
	local assetId = info and tonumber(info.assetId)
	if not assetId then
		return nil, nil
	end
	local items = {}
	local total = 1
	if type(info.parts) == "table" and #info.parts > 1 then
		total = #info.parts
		for _, p in info.parts do
			local id = type(p) == "table" and tonumber(p.assetId)
			if id then
				table.insert(items, { id = id, bounds = p.bounds })
			end
		end
	end
	if #items == 0 then
		items, total = { { id = assetId, bounds = info.bounds } }, 1
	end
	local room = Instance.new("Model")
	room.Name = "RoomModel"
	local loaded, boxes, allBoxes = 0, {}, true
	for i, it in items do
		local okLoad, container = pcall(AssetService.LoadAssetAsync, AssetService, it.id)
		if okLoad and typeof(container) == "Instance" then
			-- a Model or Folder wrapping the asset hands over its children; a lone MeshPart comes over as it is
			local part = Instance.new("Model")
			part.Name = "Part" .. i
			if container:IsA("Model") or container:IsA("Folder") then
				for _, c in container:GetChildren() do
					c.Parent = part
				end
				container:Destroy()
			else
				container.Parent = part
			end
			if #items > 1 then
				MapBuilder.alignPart(part, it.bounds)
			end
			-- the photo light is baked into the textures: no extra shadows, sheen or reflections on the room itself
			for _, d in part:GetDescendants() do
				if d:IsA("MeshPart") then
					d.CastShadow = false
					d.Material = Enum.Material.SmoothPlastic
					d.Reflectance = 0
				end
			end
			part.Parent = room
			loaded += 1
			if type(it.bounds) == "table" then
				table.insert(boxes, it.bounds)
			else
				allBoxes = false
			end
		else
			warn("[DejaView] LoadAssetAsync failed for", sceneId, it.id, container)
		end
	end
	if loaded == 0 then
		room:Destroy()
		return nil, nil
	end
	print("[DejaView] loaded uploaded room model", sceneId, assetId, "(" .. loaded .. "/" .. total .. " parts)")
	local box = nil
	if loaded == total and type(info.bounds) == "table" then
		box = info.bounds
	elseif allBoxes then
		box = unionBox(boxes) -- only the parts that loaded: never stretch half a room over the whole one
	end
	return room, box
end

-- One map fetch attempt. Returns "ok" | "wait" | "fail".
local function fetchOnce(id: string): string
	local e = entry(id)
	local ok, data, status = Backend.map(id, Config.maxParts())
	if ok and status == 200 and type(data) == "table" and type(data.parts) == "table" then
		data.sceneId = data.sceneId or id
		e.map, e.swatches, e.measuring, e.failed, e.gone = data, swatches(data), false, false, false
		closedRooms[id] = nil -- back on the server
		return "ok"
	end
	e.tries += 1
	if status == 202 then
		e.measuring = true
		e.nextTry = os.clock() + (tonumber(type(data) == "table" and data.retryAfter) or 2)
		return "wait"
	elseif status == 404 then
		e.failed = true
		e.gone = type(data) == "table" -- our server's JSON 404: no such room (archived, deleted, or a video)
		return "fail"
	elseif status == 409 then
		e.nextTry = os.clock() + 3
		if e.tries >= 20 then
			e.failed = true
			return "fail"
		end
		return "wait"
	elseif status == 401 then
		workspace:SetAttribute("Banner", "Key rejected")
		e.nextTry = os.clock() + 10
		return "fail"
	end
	e.nextTry = os.clock() + math.min(2 ^ e.tries, 10)
	return "wait"
end

-- Blocking: get a map for id, retrying per the contract. Returns map or nil, reason.
local function fetchMap(id: string): (any?, string?)
	local e = entry(id)
	if e.map then
		return e.map
	end
	e.tries, e.failed, e.gone = 0, false, false
	local netFails = 0
	for _ = 1, 40 do
		local r = fetchOnce(id)
		if r == "ok" then
			return e.map
		elseif r == "fail" then
			return nil, if workspace:GetAttribute("Banner") == "Key rejected" then "Key rejected" else "No such room"
		end
		if not e.measuring then
			netFails += 1
			if netFails >= 6 then
				return nil, "Couldn't reach Déjà View"
			end
		else
			workspace:SetAttribute("LoadStage", "Measuring the room...")
		end
		task.wait(math.max(0.25, e.nextTry - os.clock()))
	end
	return nil, "Timed out"
end

local function publishBoard()
	local cards = {}
	for _, s in list do
		if #cards >= Config.PICKER_MAX then
			break
		end
		if s.status == "failed" or isVideo(s) then
			continue
		end
		local e = cache[s.id]
		table.insert(cards, {
			id = s.id,
			name = s.name or s.id,
			mode = if s.mode == "video" then "VIDEO" else "PHOTO",
			status = s.status,
			progress = s.progress or 0,
			createdAt = s.createdAt,
			blocks = e and e.map and #e.map.parts or nil,
			swatches = e and e.swatches or nil,
			measuring = e ~= nil and e.measuring and not e.map,
			loadable = e ~= nil and e.map ~= nil,
			newUntil = firstSeen[s.id],
			judge = judgeScene == s.id,
		})
	end
	local json = HttpService:JSONEncode(cards)
	if json ~= lastBoardJson then
		lastBoardJson = json
		workspace:SetAttribute("RoomsJson", json)
	end
end

local listFailures = 0

local function refreshList()
	local ok, data, status = Backend.scenes()
	if not ok or type(data) ~= "table" then
		-- The presence loop owns the banner once a room is loaded; before that, the room list does.
		listFailures += 1
		if listFailures >= 3 and (workspace:GetAttribute("SceneId") or "") == "" then
			workspace:SetAttribute("Banner", if status == 401 then "Key rejected" else "Reconnecting to Déjà View...")
		end
		return
	end
	if listFailures >= 3 and (workspace:GetAttribute("SceneId") or "") == "" then
		workspace:SetAttribute("Banner", "")
	end
	listFailures = 0
	local fresh = {}
	for _, s in data do
		if type(s) == "table" and type(s.id) == "string" then
			if not firstSeen[s.id] and listLoaded and s.status ~= "failed" then
				firstSeen[s.id] = now() + 60
			elseif not firstSeen[s.id] then
				firstSeen[s.id] = 0
			end
			table.insert(fresh, s)
		end
	end
	local pin: { [string]: number } = {}
	for i, id in Config.PINNED_SCENES do
		pin[id] = i
	end
	table.sort(fresh, function(a, b)
		local pa, pb = pin[a.id] or math.huge, pin[b.id] or math.huge
		if pa ~= pb then
			return pa < pb
		end
		return (a.createdAt or "") > (b.createdAt or "")
	end)
	-- "New room unlocked": a Photo world that turns ready after we started (the finale) gets a JOIN prompt.
	for _, s in fresh do
		if playable(s) and not playableSeen[s.id] then
			playableSeen[s.id] = true
			if listLoaded then
				World.Moment:FireAllClients({ type = "unlocked", id = s.id, name = s.name or s.id })
			end
		end
	end
	list = fresh
	listLoaded = true
end

local function prefetchOne()
	for _, s in list do
		if playable(s) then
			local e = entry(s.id)
			if not e.map and not e.failed and os.clock() >= e.nextTry then
				fetchOnce(s.id)
				return
			end
		end
	end
end

local function newestReadyOther(): string?
	local current = workspace:GetAttribute("SceneId")
	for _, s in list do
		if playable(s) and s.id ~= current then
			return s.id
		end
	end
	return nil
end

-- Builds sceneId. moveRoom: players already in a room come along. joinLobby: lobby players too.
function Rooms.switchTo(sceneId: string, opts: { moveRoom: boolean?, joinLobby: boolean? }?)
	local o = opts or {}
	switching += 1
	local mySwitch = switching
	votes = {}
	local s = sceneById(sceneId)
	local name = (s and s.name) or sceneId
	if Rooms.onSwitchStart then
		Rooms.onSwitchStart()
	end
	local moveRoom = o.moveRoom ~= false
	local previousRoomPlayers = World.inRoom()
	World.holdRoomPlayers(true)
	workspace:SetAttribute("Phase", "loading")
	workspace:SetAttribute("RoomName", name)
	workspace:SetAttribute("LoadProgress", 0)
	workspace:SetAttribute("LoadBuilt", 0)
	workspace:SetAttribute("LoadTotal", 0)
	workspace:SetAttribute("LoadStage", "Moving in...")
	workspace:SetAttribute("SceneId", sceneId)

	-- A room imported in Studio (ServerStorage.Rooms.<sceneId>) needs only one quick try at the block map, which is
	-- just its invisible floor; everything else waits for the map per the contract.
	local stored = storedRoom(sceneId)
	local map, reason
	if stored then
		local e = entry(sceneId)
		if not e.map then
			fetchOnce(sceneId)
		end
		map = e.map
	else
		map, reason = fetchMap(sceneId)
	end
	if mySwitch ~= switching then
		return
	end
	-- An uploaded model comes with the server's box for it (exact alignment); a room imported in Studio uses that box
	-- only when it has the same proportions (it may be another build), else it is aligned loosely on the block map. A
	-- room the server no longer has (404) gets neither.
	local visual, box = nil, nil
	local gone = not map and entry(sceneId).gone == true
	if stored and not gone then
		visual = stored:Clone()
		local smi = modelInfo(sceneId)
		box = smi and smi.bounds
	elseif not gone then
		visual, box = uploadedRoom(sceneId)
	end
	-- Walk limits come with the room model's details (Update 4).
	local mi = modelInfo(sceneId)
	if map and mi and mi.walkBounds and not map.walkBounds then
		map.walkBounds = mi.walkBounds
	end
	if mySwitch ~= switching then
		return
	end
	local info = nil
	if not map and visual then
		info = MapBuilder.buildFromModel(sceneId, name, visual, mi, box, stored ~= nil)
	elseif map then
		info = MapBuilder.build(map, function(built, total)
			if mySwitch == switching then
				workspace:SetAttribute("LoadProgress", built / math.max(total, 1))
				workspace:SetAttribute("LoadBuilt", built)
				workspace:SetAttribute("LoadTotal", total)
				workspace:SetAttribute("LoadStage", "Moving in...")
			end
		end, { collisionOnly = visual ~= nil })
		if not info then
			return -- cancelled by a newer switch
		end
		if visual then
			MapBuilder.attachModel(visual, box, stored ~= nil)
			local e = cache[sceneId]
			MapBuilder.addGround(e and e.map and groundColour(e.map) or nil)
		end
		-- Per-world skybox rendered from the splat viewer (Update 10): six asset ids for the clients to show
		local sky = mi and mi.sky
		local room = workspace:FindFirstChild("Room")
		if room and type(sky) == "table" then
			for key, attr in
				{ front = "SkyFt", back = "SkyBk", left = "SkyLf", right = "SkyRt", up = "SkyUp", down = "SkyDn" }
			do
				if sky[key] then
					room:SetAttribute(attr, skyImage(tostring(sky[key])))
				end
			end
			print("[DejaView] skybox set for", sceneId)
		end
	elseif not gone and MapBuilder.hasBaked(sceneId) then
		info = MapBuilder.buildBaked(sceneId)
	else
		if gone then
			closedRooms[sceneId] = true
		end
		local here = MapBuilder.current
		if here and closedRooms[here.sceneId] and workspace:FindFirstChild("Room") then
			-- the room we are in is gone too: never keep it; go to the default room or the lobby
			workspace:SetAttribute("SceneId", here.sceneId)
			task.spawn(Rooms.roomClosed, here.sceneId)
			return
		end
		World.toast(if gone then "That room was closed" else "Couldn't load " .. name .. ": " .. tostring(reason))
		if not MapBuilder.current or workspace:FindFirstChild("Room") == nil then
			info = MapBuilder.build(game:GetService("HttpService"):JSONDecode(Fixtures.MAP_SMALL))
			sceneId = "fixture-room"
		else
			-- keep the room we had
			local cur = MapBuilder.current
			sceneId = cur and cur.sceneId or sceneId
			info = cur
		end
	end
	if mySwitch ~= switching or not info then
		return
	end
	workspace:SetAttribute("SceneId", sceneId)
	workspace:SetAttribute("RoomName", info.name)
	workspace:SetAttribute("HasImagined", (workspace:FindFirstChild("Room") :: any):GetAttribute("HasImagined") == true)
	workspace:SetAttribute("Phase", "room")
	local builtRoom = workspace:FindFirstChild("Room")
	task.spawn(function()
		ObjectLayer.build(sceneId, builtRoom)
	end)
	if moveRoom then
		World.toRoom(previousRoomPlayers)
	end
	World.holdRoomPlayers(false)
	local joinLobby = o.joinLobby
	if joinLobby == nil then
		joinLobby = workspace:GetAttribute("AutoJoin") == true
	end
	if joinLobby then
		Rooms.joinAll(true)
	end
	if Rooms.onRoomReady then
		Rooms.onRoomReady(joinLobby == true)
	end
	publishBoard()
end

-- Move every lobby player into the built room (with an optional 3-2-1).
function Rooms.joinAll(countdown: boolean?)
	if workspace:GetAttribute("Phase") ~= "room" then
		return
	end
	local lobby = {}
	for _, p in Players:GetPlayers() do
		if World.where(p) ~= "room" then
			table.insert(lobby, p)
		end
	end
	if #lobby == 0 then
		return
	end
	local scene = workspace:GetAttribute("SceneId")
	if countdown then
		World.Moment:FireAllClients({ type = "countdown", seconds = 3, text = "MOVING IN" })
		task.wait(3)
		if workspace:GetAttribute("SceneId") ~= scene or workspace:GetAttribute("Phase") ~= "room" then
			return
		end
	end
	World.toRoom(lobby)
end

function Rooms.joinOne(player: Player)
	if workspace:GetAttribute("Phase") == "room" and World.where(player) ~= "room" then
		World.toRoom({ player })
	end
end

-- Everyone back to the lobby, with no room loaded.
local function closeToLobby()
	if Rooms.onSwitchStart then
		Rooms.onSwitchStart()
	end
	World.holdRoomPlayers(false)
	for _, p in Players:GetPlayers() do
		if World.where(p) == "room" then
			World.toLobby(p)
		end
	end
	MapBuilder.clear()
	workspace:SetAttribute("SceneId", "")
	workspace:SetAttribute("RoomName", "")
	workspace:SetAttribute("HasImagined", false)
	workspace:SetAttribute("Phase", "lobby")
end

-- The server answered 404 for the room we are in (archived or deleted): not a connection problem, so no
-- "Reconnecting" banner. Toast it, move everyone to Config.DEFAULT_SCENE (the lobby if that fails too) and refresh
-- the room list. Only for the room that is built (a room still loading is handled by its switch) and never for the
-- fixture room, which the server does not know by design.
function Rooms.roomClosed(sceneId: string)
	local cur = MapBuilder.current
	if closing or sceneId == "fixture-room" or not (cur and cur.sceneId == sceneId) then
		return
	end
	closing = true
	local ok, err = pcall(function()
		closedRooms[sceneId] = true
		cache[sceneId] = nil
		modelInfos[sceneId] = nil
		if workspace:GetAttribute("Banner") == "Reconnecting to Déjà View..." then
			workspace:SetAttribute("Banner", "")
		end
		workspace:SetAttribute("Offline", false)
		World.toast("That room was closed")
		warn("[DejaView] room " .. sceneId .. " was closed on the server")
		pcall(refreshList)
		local target = Config.DEFAULT_SCENE
		local okTarget = target ~= "" and target ~= sceneId and not closedRooms[target] and playable(sceneById(target))
		local before = switching
		if okTarget then
			local okSwitch, errSwitch = pcall(Rooms.switchTo, target, { moveRoom = true })
			if not okSwitch then
				warn("[DejaView] could not open " .. target .. ":", errSwitch)
			end
		end
		-- a newer switch (a vote, the judge) took over meanwhile: leave it alone
		local superseded = switching > before + (if okTarget then 1 else 0)
		local arrived = okTarget
			and workspace:GetAttribute("SceneId") == target
			and workspace:GetAttribute("Phase") == "room"
		if not superseded and not arrived then
			closeToLobby()
		end
		publishBoard()
	end)
	closing = false
	if not ok then
		warn("[DejaView] closing room " .. sceneId .. " failed:", err)
	end
end

function Rooms.vote(player: Player, sceneId: string)
	if type(sceneId) ~= "string" or not sceneById(sceneId) then
		return
	end
	local s = sceneById(sceneId)
	if isVideo(s) then
		World.toast("Video memories live in the headset only", player)
		return
	end
	if s.status ~= "ready" then
		World.toast("That room is still building", player)
		return
	end
	if sceneId == workspace:GetAttribute("SceneId") and workspace:GetAttribute("Phase") ~= "loading" then
		Rooms.joinOne(player)
		return
	end
	if World.isHost(player) then
		task.spawn(Rooms.switchTo, sceneId)
		return
	end
	votes[player] = sceneId
	local count, total = 0, #Players:GetPlayers()
	for p, v in votes do
		if p.Parent and v == sceneId then
			count += 1
		end
	end
	World.toast(player.DisplayName .. " voted for " .. (s.name or sceneId) .. " (" .. count .. "/" .. total .. ")")
	if count > total / 2 then
		task.spawn(Rooms.switchTo, sceneId)
	end
end

-- The judge is in sceneId (from presence.active, or a vr person in that room).
local function judgeIn(sceneId: string?)
	if judgeScene ~= sceneId then
		judgeScene = sceneId
		publishBoard()
	end
	if not sceneId or sceneId == workspace:GetAttribute("SceneId") then
		lastFollowed = sceneId
		return
	end
	if workspace:GetAttribute("Follow") ~= true or lastFollowed == sceneId then
		return
	end
	local s = sceneById(sceneId)
	if not playable(s) then
		return -- not a Roblox room (a video memory, or still building)
	end
	lastFollowed = sceneId
	World.toast("Judge entered " .. (s.name or sceneId))
	task.spawn(function()
		local anyoneInRoom = #World.inRoom() > 0
		if anyoneInRoom then
			World.Moment:FireAllClients({ type = "countdown", seconds = 3, text = "FOLLOWING THE JUDGE" })
			task.wait(3)
		end
		-- lobby players stay in the lobby until JOIN
		Rooms.switchTo(sceneId, { moveRoom = true, joinLobby = false })
	end)
end

function Rooms.onActive(active: any)
	activeSeenAt = os.clock()
	-- Where the judge is, even when it is not a Roblox room (the game-night video): the lobby board shows it.
	local name = if type(active) == "table"
		then (active.name or (sceneById(active.sceneId or "") or {}).name or "")
		else ""
	if workspace:GetAttribute("JudgeRoom") ~= name then
		workspace:SetAttribute("JudgeRoom", name)
	end
	if type(active) == "table" and type(active.sceneId) == "string" then
		judgeIn(active.sceneId)
	end
end

function Rooms.onJudgeHere(here: boolean)
	if here and os.clock() - activeSeenAt > 5 then
		judgeIn(workspace:GetAttribute("SceneId"))
	end
end

function Rooms.newestReady(): string?
	if Config.DEFAULT_SCENE ~= "" and sceneById(Config.DEFAULT_SCENE) then
		return Config.DEFAULT_SCENE
	end
	for _, s in list do
		if playable(s) then
			return s.id
		end
	end
	return nil
end

-- Something to stand in when Déjà View cannot be reached: the first baked room, else the fixture room.
function Rooms.loadFallback()
	local baked = game:GetService("ServerStorage"):FindFirstChild("BakedRooms")
	local first = baked and baked:GetChildren()[1]
	local info = if first then MapBuilder.buildBaked(first.Name) else nil
	if not info then
		info = MapBuilder.build(HttpService:JSONDecode(Fixtures.MAP_SMALL))
	end
	if not info then
		return
	end
	workspace:SetAttribute("SceneId", info.sceneId)
	workspace:SetAttribute("RoomName", info.name)
	workspace:SetAttribute("Phase", "room")
	if workspace:GetAttribute("AutoJoin") == true then
		Rooms.joinAll(true)
	end
	publishBoard()
end

function Rooms.isListLoaded(): boolean
	return listLoaded
end

function Rooms.waitForList(timeout: number)
	local t0 = os.clock()
	while not listLoaded and os.clock() - t0 < timeout do
		task.wait(0.25)
	end
	return listLoaded
end

function Rooms.start()
	task.spawn(function()
		while true do
			local started = os.clock()
			local ok, err = pcall(function()
				refreshList()
				-- Follow fallback: no `active` field lately -> check the newest other ready room.
				if os.clock() - activeSeenAt > 5 then
					local other = newestReadyOther()
					if other then
						local okP, res = Backend.people(other)
						if okP and type(res) == "table" and type(res.people) == "table" then
							for _, person in res.people do
								if person.kind == "vr" then
									judgeIn(other)
									break
								end
							end
						end
					end
				end
				prefetchOne()
				publishBoard()
			end)
			if not ok then
				warn("[DejaView] rooms loop:", err)
			end
			task.wait(math.max(0.2, Config.ROOMS_PERIOD - (os.clock() - started)))
		end
	end)
	Players.PlayerRemoving:Connect(function(p)
		votes[p] = nil
	end)
end

return Rooms
