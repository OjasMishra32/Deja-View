-- 4 Hz presence loop: posts our room players, buffers everyone else, fans ghosts out to clients.
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local MapBuilder = require(script.Parent.MapBuilder)
local MockServer = require(script.Parent.MockServer)
local World = require(script.Parent.World)
local Interp = require(ReplicatedStorage.Shared.Interp)
local Util = require(ReplicatedStorage.Shared.Util)

local GhostState = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("GhostState") :: UnreliableRemoteEvent

local Presence = {}

export type Person = { id: string, name: string, kind: string, buf: Interp.Buffer, lastSeen: number }

Presence.people = {} :: { [string]: Person }
Presence.onActive = nil :: ((active: any) -> ())?
Presence.onHostEvent = nil :: ((ev: any) -> ())?
Presence.stateOf = nil :: ((player: Player) -> string?)?

local serverId = if game.JobId ~= "" then game.JobId else "studio-" .. HttpService:GenerateGUID(false)
local failures = 0
local appliedEvents: { [any]: boolean } = {}
local postedScene: string? = nil

local function myIds(): { [string]: boolean }
	local ids = {}
	for _, p in game:GetService("Players"):GetPlayers() do
		ids["rbx-" .. p.UserId] = true
	end
	return ids
end

local function buildPayload()
	local players = {}
	if workspace:GetAttribute("Phase") == "room" then
		for _, p in World.inRoom() do
			if not p:GetAttribute("Out") and p.Character then
				local feet = Util.feetOf(p.Character)
				local hrp = p.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
				if feet and hrp then
					local entry: { [string]: any } = {
						id = "rbx-" .. p.UserId,
						name = string.sub(p.DisplayName, 1, 40),
						x = feet.X, y = feet.Y, z = feet.Z,
						yaw = Util.yawOf(hrp.CFrame),
					}
					local st = Presence.stateOf and Presence.stateOf(p)
					if st then
						entry.state = st
					end
					table.insert(players, entry)
				end
			end
		end
	end
	return { players = players, server = serverId }
end

function Presence.clear()
	for id in Presence.people do
		World.Moment:FireAllClients({ type = "gone", id = id })
	end
	Presence.people = {}
end

-- The first VR person (the judge), or nil.
function Presence.vr(): Person?
	local best: Person? = nil
	for _, person in Presence.people do
		if person.kind == "vr" and (not best or person.id < best.id) then
			best = person
		end
	end
	return best
end

local function handle(res: any)
	local now = workspace:GetServerTimeNow()
	local spm = (MapBuilder.current and MapBuilder.current.studsPerMeter) or 3.57
	local mine = myIds()
	local others = if type(res.others) == "table" then res.others else {}
	if workspace:GetAttribute("MockJudge") and not Config.useMock() then
		local hasVr = false
		for _, o in others do
			hasVr = hasVr or o.kind == "vr"
		end
		if not hasVr then
			table.insert(others, MockServer.mockVr(os.clock()))
		end
	end
	local seen = {}
	local judge: Person? = nil
	for _, o in others do
		if type(o) == "table" and type(o.id) == "string" and not mine[o.id] then
			local pos = Vector3.new(tonumber(o.x) or 0, tonumber(o.y) or 0, tonumber(o.z) or 0)
			local head = Util.vec(o.head) or (pos + Vector3.new(0, 1.6 * spm, 0))
			local hl, hr = nil, nil
			if type(o.hands) == "table" then
				hl, hr = Util.vec(o.hands[1]), Util.vec(o.hands[2])
			end
			local person = Presence.people[o.id]
			if not person then
				person = { id = o.id, name = tostring(o.name or o.id), kind = tostring(o.kind or "web"),
					buf = Interp.new(), lastSeen = now }
				Presence.people[o.id] = person
			end
			person.name = tostring(o.name or person.name)
			person.kind = tostring(o.kind or person.kind)
			person.lastSeen = now
			local yaw = tonumber(o.yaw) or 0
			Interp.push(person.buf, { stamp = now, pos = pos, yaw = yaw, head = head, hl = hl, hr = hr })
			seen[o.id] = true
			if person.kind == "vr" and (not judge or person.id < judge.id) then
				judge = person
			end
			GhostState:FireAllClients({
				id = person.id, kind = person.kind, name = person.name, stamp = now,
				pos = pos, yaw = yaw, head = head, hl = hl, hr = hr,
			})
		end
	end
	for id in Presence.people do
		if not seen[id] then
			Presence.people[id] = nil
			World.Moment:FireAllClients({ type = "gone", id = id })
		end
	end
	workspace:SetAttribute("JudgeHere", judge ~= nil)
	workspace:SetAttribute("JudgeName", if judge then judge.name else "")
	if res.active ~= nil and Presence.onActive then
		Presence.onActive(res.active)
	end
	if type(res.events) == "table" and Presence.onHostEvent then
		for _, ev in res.events do
			local key = ev.id or HttpService:JSONEncode(ev)
			if not appliedEvents[key] then
				appliedEvents[key] = true
				Presence.onHostEvent(ev)
			end
		end
	end
end

function Presence.start()
	task.spawn(function()
		while true do
			local started = os.clock()
			local sceneId = workspace:GetAttribute("SceneId")
			if type(sceneId) ~= "string" or sceneId == "" then
				task.wait(0.5)
				continue
			end
			if postedScene ~= sceneId then
				postedScene = sceneId
				Presence.clear()
			end
			local ok, res, status = Backend.presence(sceneId, buildPayload())
			if workspace:GetAttribute("SceneId") ~= sceneId then
				continue -- room changed mid-request; drop the stale answer
			end
			if ok and type(res) == "table" then
				failures = 0
				workspace:SetAttribute("Offline", false)
				if workspace:GetAttribute("Banner") ~= "" then
					workspace:SetAttribute("Banner", "")
				end
				handle(res)
			else
				failures += 1
				if status == 401 then
					workspace:SetAttribute("Banner", "Key rejected")
				elseif failures >= 3 then
					workspace:SetAttribute("Banner", "Reconnecting to Déjà View...")
					workspace:SetAttribute("Offline", true)
				end
			end
			local delay = if failures == 0 then Config.PRESENCE_PERIOD else math.min(0.5 * 2 ^ (failures - 1), 4)
			if status == 429 then
				delay = 5
			end
			task.wait(math.max(0, delay - (os.clock() - started)))
		end
	end)
end

return Presence
