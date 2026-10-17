-- Boots Déjà View: lobby -> loading -> room. Owns remotes and host actions.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DV = script.Parent:WaitForChild("DejaView")
local Config = require(DV.Config)
local World = require(DV.World)
local Rooms = require(DV.Rooms)
local Presence = require(DV.Presence)
local TagGame = require(DV.TagGame)

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Vote = Remotes:WaitForChild("Vote") :: RemoteEvent
local HostAction = Remotes:WaitForChild("HostAction") :: RemoteEvent

for name, value in {
	Phase = "lobby", SceneId = "", RoomName = "", LoadProgress = 0, LoadStage = "", Banner = "",
	Offline = false, JudgeHere = false, JudgeName = "", RoundState = "idle", RoundEndsAt = 0,
	CountdownEndsAt = 0, RoundIt = "", ScoresJson = "", RoomsJson = "[]", AutoJoin = Config.AUTO_JOIN_DEFAULT,
	Follow = true, MockJudge = false, HasImagined = false, UsingMock = Config.useMock(),
} do
	workspace:SetAttribute(name, value)
end

-- GetConfigAsync can block for ~30 s when the place is unpublished; never hold up the boot for it.
task.spawn(function()
	Config.init()
	workspace:SetAttribute("UsingMock", Config.useMock())
end)
World.init()

Presence.stateOf = TagGame.stateOf
Presence.onActive = Rooms.onActive
Presence.onHostEvent = function(ev)
	if ev.type == "start_round" then
		TagGame.start(nil)
	elseif ev.type == "end_round" then
		TagGame.finish()
	elseif ev.type == "join" then
		Rooms.joinAll(false)
	end
end
workspace:GetAttributeChangedSignal("JudgeHere"):Connect(function()
	Rooms.onJudgeHere(workspace:GetAttribute("JudgeHere") == true)
end)

Rooms.onSwitchStart = function()
	TagGame.abort()
end

Vote.OnServerEvent:Connect(function(player, sceneId)
	Rooms.vote(player, sceneId)
end)

local actions: { [string]: (Player, any) -> () } = {
	join = function()
		task.spawn(function()
			Rooms.joinAll(false)
			if workspace:GetAttribute("JudgeHere") then
				TagGame.start(nil)
			end
		end)
	end,
	start_round = function(p)
		TagGame.start(p)
	end,
	end_round = function()
		TagGame.finish()
	end,
	auto_join = function(_, v)
		workspace:SetAttribute("AutoJoin", v == true)
	end,
	follow = function(_, v)
		workspace:SetAttribute("Follow", v == true)
	end,
	mock_judge = function(_, v)
		workspace:SetAttribute("MockJudge", v == true)
	end,
	lobby_all = function()
		TagGame.abort()
		for _, p in Players:GetPlayers() do
			World.toLobby(p)
		end
	end,
}

-- Anyone may hop in (or back to the lobby) themselves; everything else is host-only.
HostAction.OnServerEvent:Connect(function(player, action, value)
	if action == "hop_in" then
		Rooms.joinOne(player)
		return
	elseif action == "to_lobby" then
		if not TagGame.isPlaying() then
			World.toLobby(player)
		end
		return
	end
	if not World.isHost(player) then
		return
	end
	local fn = actions[action]
	if fn then
		fn(player, value)
	end
end)

TagGame.start10Hz()
-- First requests wait for the live config so they go to dejaview_base, not the built-in fallback.
-- (Unpublished places take ~30 s to fail; 10 s is the cap.)
Config.waitLoaded(10)
Presence.start()
Rooms.start()

-- Boot room: a deep link's launch data wins, otherwise the default / newest ready room.
task.spawn(function()
	local launchScene: string? = nil
	local t0 = os.clock()
	while os.clock() - t0 < 4 and not launchScene do
		for _, p in Players:GetPlayers() do
			local ok, data = pcall(p.GetJoinData, p)
			if ok and type(data) == "table" and type(data.LaunchData) == "string" and data.LaunchData ~= "" then
				launchScene = data.LaunchData
			end
		end
		if #Players:GetPlayers() > 0 then
			break
		end
		task.wait(0.25)
	end
	local reached = Rooms.waitForList(15)
	local target = launchScene or Rooms.newestReady()
	if target then
		Rooms.switchTo(target)
		return
	end
	if not reached then
		-- Déjà View unreachable: put up a baked or fixture room now, then switch to a real one once it answers.
		warn("[DejaView] Déjà View unreachable at boot; loading a fallback room")
		Rooms.loadFallback()
		local fallbackScene = workspace:GetAttribute("SceneId")
		while not Rooms.isListLoaded() do
			task.wait(3)
		end
		local real = Rooms.newestReady()
		if real and workspace:GetAttribute("SceneId") == fallbackScene then
			Rooms.switchTo(real)
		end
		return
	end
	warn("[DejaView] no ready rooms yet; waiting in the lobby")
end)

-- Later deep-link joiners: if we are still in the lobby phase, load their room.
Players.PlayerAdded:Connect(function(p)
	local ok, data = pcall(p.GetJoinData, p)
	if ok and type(data) == "table" and type(data.LaunchData) == "string" and data.LaunchData ~= ""
		and workspace:GetAttribute("Phase") == "lobby" then
		Rooms.waitForList(10)
		Rooms.switchTo(data.LaunchData, { joinLobby = false })
	end
end)

print("[DejaView] server up; mock =", Config.useMock(), "base =", Config.base())
