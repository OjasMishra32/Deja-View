-- Room list, prefetch + swatches, votes, switching, auto-join, JOIN and Follow (team/shivin.md 7.2).
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local MapBuilder = require(script.Parent.MapBuilder)
local World = require(script.Parent.World)
local Fixtures = require(game:GetService("ReplicatedStorage").Shared.Fixtures)

local Rooms = {}

type Entry = { map: any?, swatches: { string }?, measuring: boolean, failed: boolean, tries: number, nextTry: number }

local list: { any } = {} -- last /api/scenes answer
local cache: { [string]: Entry } = {}
local firstSeen: { [string]: number } = {}
local listLoaded = false
local votes: { [Player]: string } = {}
local switching = 0
local judgeScene: string? = nil
local activeSeenAt = 0
local lastFollowed: string? = nil
local lastBoardJson = ""

Rooms.onSwitchStart = nil :: (() -> ())?
Rooms.onRoomReady = nil :: ((joined: boolean) -> ())?

local function now()
	return workspace:GetServerTimeNow()
end

local function sceneById(id: string): any?
	for _, s in list do
		if s.id == id then
			return s
		end
	end
	return nil
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
		local r, g, b = bit32.rshift(k, 10) * 8 + 4, bit32.band(bit32.rshift(k, 5), 31) * 8 + 4, bit32.band(k, 31) * 8 + 4
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

-- One map fetch attempt. Returns "ok" | "wait" | "fail".
local function fetchOnce(id: string): string
	local e = entry(id)
	local ok, data, status = Backend.map(id, Config.maxParts())
	if ok and status == 200 and type(data) == "table" and type(data.parts) == "table" then
		data.sceneId = data.sceneId or id
		e.map, e.swatches, e.measuring, e.failed = data, swatches(data), false, false
		return "ok"
	end
	e.tries += 1
	if status == 202 then
		e.measuring = true
		e.nextTry = os.clock() + (tonumber(type(data) == "table" and data.retryAfter) or 2)
		return "wait"
	elseif status == 404 then
		e.failed = true
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
	e.tries, e.failed = 0, false
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
		if s.status == "failed" then
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

local function refreshList()
	local ok, data = Backend.scenes()
	if not ok or type(data) ~= "table" then
		return
	end
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
	table.sort(fresh, function(a, b)
		return (a.createdAt or "") > (b.createdAt or "")
	end)
	list = fresh
	listLoaded = true
end

local function prefetchOne()
	for _, s in list do
		if s.status == "ready" then
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
		if s.status == "ready" and s.id ~= current then
			return s.id
		end
	end
	return nil
end

-- Builds sceneId. moveRoom: players already in a room come along. joinLobby: lobby players too.
function Rooms.switchTo(sceneId: string, opts: { moveRoom: boolean?, joinLobby: boolean? }?)
	opts = opts or {}
	switching += 1
	local mySwitch = switching
	votes = {}
	local s = sceneById(sceneId)
	local name = (s and s.name) or sceneId
	if Rooms.onSwitchStart then
		Rooms.onSwitchStart()
	end
	local moveRoom = opts.moveRoom ~= false
	local previousRoomPlayers = World.inRoom()
	World.holdRoomPlayers(true)
	workspace:SetAttribute("Phase", "loading")
	workspace:SetAttribute("RoomName", name)
	workspace:SetAttribute("LoadProgress", 0)
	workspace:SetAttribute("LoadBuilt", 0)
	workspace:SetAttribute("LoadTotal", 0)
	workspace:SetAttribute("LoadStage", "Moving in...")
	workspace:SetAttribute("SceneId", sceneId)

	local map, reason = fetchMap(sceneId)
	if mySwitch ~= switching then
		return
	end
	local info = nil
	if map then
		info = MapBuilder.build(map, function(built, total)
			if mySwitch == switching then
				workspace:SetAttribute("LoadProgress", built / math.max(total, 1))
				workspace:SetAttribute("LoadBuilt", built)
				workspace:SetAttribute("LoadTotal", total)
				workspace:SetAttribute("LoadStage", "Moving in...")
			end
		end)
		if not info then
			return -- cancelled by a newer switch
		end
	elseif MapBuilder.hasBaked(sceneId) then
		info = MapBuilder.buildBaked(sceneId)
	else
		World.toast("Couldn't load " .. name .. ": " .. tostring(reason))
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
	if moveRoom then
		World.toRoom(previousRoomPlayers)
	end
	World.holdRoomPlayers(false)
	local joinLobby = opts.joinLobby
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

function Rooms.vote(player: Player, sceneId: string)
	if type(sceneId) ~= "string" or not sceneById(sceneId) then
		return
	end
	local s = sceneById(sceneId)
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
	if not s or s.status ~= "ready" then
		return
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
		if s.status == "ready" then
			return s.id
		end
	end
	return nil
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
