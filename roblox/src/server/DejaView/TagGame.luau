-- Tag rounds; this server is the referee (team/shivin.md 7.5).
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local MapBuilder = require(script.Parent.MapBuilder)
local Presence = require(script.Parent.Presence)
local World = require(script.Parent.World)
local Interp = require(ReplicatedStorage.Shared.Interp)
local Stats = require(script.Parent.Stats)

local TagGame = {}

type Runner = { player: Player, id: string, name: string, lives: number, immuneUntil: number, lastTag: number }

local state = "idle" -- idle | countdown | playing | ended
local runners: { [Player]: Runner } = {}
local vrTags = 0
local vrId = "quest-1"
local vrName = "Judge"
local endsAt = 0
local roundId = 0

local function now()
	return workspace:GetServerTimeNow()
end

local function scores(): { [string]: number }
	local s: { [string]: number } = { [vrId] = vrTags }
	for _, r in runners do
		s[r.id] = r.lives
	end
	return s
end

local function publish()
	local list = {}
	for _, r in runners do
		table.insert(list, { id = r.id, name = r.name, lives = r.lives, out = r.lives <= 0,
			immune = r.immuneUntil > now() })
	end
	table.sort(list, function(a, b)
		return a.name < b.name
	end)
	workspace:SetAttribute("ScoresJson", HttpService:JSONEncode({ vrName = vrName, vrTags = vrTags, runners = list }))
end

local function setState(s: string)
	state = s
	workspace:SetAttribute("RoundState", s)
end

function TagGame.stateOf(player: Player): string?
	local r = runners[player]
	if not r or state ~= "playing" then
		return nil
	end
	if r.lives <= 0 then
		return "out"
	elseif r.immuneUntil > now() then
		return "caught"
	end
	return "playing"
end

function TagGame.isPlaying(): boolean
	return state == "playing" or state == "countdown"
end

local function addRunner(p: Player)
	if runners[p] then
		return
	end
	runners[p] = { player = p, id = "rbx-" .. p.UserId, name = p.DisplayName, lives = Config.LIVES,
		immuneUntil = now() + Config.IMMUNITY, lastTag = now() }
end

local function shield(p: Player, seconds: number)
	local ch = p.Character
	if not ch then
		return
	end
	local ff = Instance.new("ForceField")
	ff.Visible = true
	ff.Parent = ch
	task.delay(seconds, function()
		ff:Destroy()
	end)
end

local function restore(p: Player)
	p:SetAttribute("Out", false)
	if World.where(p) == "room" and p.Character and MapBuilder.current then
		World.setAnchored(p.Character, false)
		MapBuilder.place(p.Character, math.random(1, 9))
	end
end

function TagGame.finish(winner: string?)
	if state ~= "playing" and state ~= "countdown" then
		return
	end
	local wasPlaying = state == "playing"
	roundId += 1
	local list = {}
	for _, r in runners do
		table.insert(list, r)
	end
	local survivors = 0
	for _, r in list do
		if r.lives > 0 then
			survivors += 1
		end
	end
	winner = winner or (if survivors > 0 then "roblox" else "vr")
	table.sort(list, function(a, b)
		if a.lives ~= b.lives then
			return a.lives > b.lives
		end
		return a.lastTag < b.lastTag -- longest since their last tag
	end)
	local mvp = list[1]
	if wasPlaying and winner == "roblox" and mvp then
		Stats.win(mvp.player, "tag") -- the MVP of a surviving team takes the tag win
	end
	local sceneId = workspace:GetAttribute("SceneId")
	if wasPlaying and type(sceneId) == "string" then
		Backend.sendEvent(sceneId, { type = "round", state = "end", scores = scores(), winner = winner,
			mvp = mvp and mvp.id or nil, mvpName = mvp and mvp.name or nil })
	end
	setState("ended")
	workspace:SetAttribute("RoundEndsAt", 0)
	World.Moment:FireAllClients({
		type = "winner",
		title = if winner == "vr" then "THE JUDGE WINS" else "ROBLOX SURVIVES",
		mvp = if winner == "vr" then vrName .. " · " .. vrTags .. " tags" else (mvp and ("MVP " .. mvp.name) or ""),
	})
	publish()
	local myRound = roundId
	task.delay(5, function()
		if roundId ~= myRound then
			return
		end
		setState("idle")
		for p in runners do
			if p.Parent then
				restore(p)
			end
		end
	end)
end

function TagGame.abort()
	if state == "idle" then
		return
	end
	roundId += 1
	setState("idle")
	workspace:SetAttribute("RoundEndsAt", 0)
	for p in runners do
		if p.Parent then
			p:SetAttribute("Out", false)
		end
	end
end

-- Returns false (and toasts) when there is no headset.
function TagGame.start(by: Player?): boolean
	if state == "countdown" or state == "playing" then
		return false
	end
	local vr = Presence.vr()
	if not vr then
		World.toast("Waiting for the headset...", by)
		return false
	end
	if #World.inRoom() == 0 then
		World.toast("Nobody is in the room yet: press JOIN", by)
		return false
	end
	roundId += 1
	local myRound = roundId
	vrId, vrName, vrTags = vr.id, vr.name, 0
	runners = {}
	for _, p in World.inRoom() do
		addRunner(p)
		p:SetAttribute("Out", false)
	end
	setState("countdown")
	workspace:SetAttribute("CountdownEndsAt", now() + Config.COUNTDOWN)
	World.Moment:FireAllClients({ type = "countdown", seconds = Config.COUNTDOWN, text = "TAG: THE JUDGE IS IT" })
	publish()
	task.delay(Config.COUNTDOWN, function()
		if roundId ~= myRound then
			return
		end
		local duration = Config.roundSeconds()
		endsAt = now() + duration
		for _, r in runners do
			r.immuneUntil = now() + Config.IMMUNITY
			r.lastTag = now()
			shield(r.player, Config.IMMUNITY)
		end
		setState("playing")
		for _, r in runners do
			Stats.badge(r.player, "judge")
		end
		workspace:SetAttribute("RoundEndsAt", endsAt)
		workspace:SetAttribute("RoundIt", vrName)
		World.Moment:FireAllClients({ type = "roundStart", it = vrName, duration = duration })
		local sceneId = workspace:GetAttribute("SceneId")
		if type(sceneId) == "string" then
			Backend.sendEvent(sceneId, { type = "round", state = "start", scores = scores(), duration = duration, it = vrId })
		end
		publish()
	end)
	return true
end

local function tag(r: Runner)
	local t = now()
	r.lives -= 1
	r.immuneUntil = t + Config.IMMUNITY
	r.lastTag = t
	vrTags += 1
	local hrp = r.player.Character and r.player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	World.Moment:FireAllClients({ type = "tagged", userId = r.player.UserId, name = r.name,
		pos = hrp and hrp.Position or Vector3.zero, lives = r.lives })
	local sceneId = workspace:GetAttribute("SceneId")
	if type(sceneId) == "string" then
		Backend.sendEvent(sceneId, { type = "tag", by = vrId, target = r.id, targetName = r.name, livesLeft = r.lives })
	end
	if r.lives <= 0 then
		-- Spectator: park out of the room (the judge stops seeing them), camera follows the ghost.
		r.player:SetAttribute("Out", true)
		local ch = r.player.Character
		if ch then
			ch:PivotTo(CFrame.new(Config.LOBBY_CENTER + Vector3.new(0, 4, 20)))
		end
	else
		task.delay(0.4, function()
			local ch = r.player.Character
			if ch and state == "playing" then
				MapBuilder.place(ch, math.random(1, 9))
				shield(r.player, Config.IMMUNITY - 0.4)
			end
		end)
	end
	publish()
end

local function check()
	if state ~= "playing" then
		return
	end
	local t = now()
	if t >= endsAt then
		TagGame.finish()
		return
	end
	local anyAlive = false
	for p, r in runners do
		if not p.Parent then
			runners[p] = nil
		elseif r.lives > 0 then
			anyAlive = true
		end
	end
	if not anyAlive then
		TagGame.finish("vr")
		return
	end
	-- late joiners into the room get 3 lives
	for _, p in World.inRoom() do
		if not runners[p] then
			addRunner(p)
			publish()
		end
	end
	local vr = Presence.people[vrId] or Presence.vr()
	if not vr then
		return
	end
	local s = Interp.sample(vr.buf, t - Interp.DELAY, t)
	if not s or s.age > Interp.STALE then
		return
	end
	local changed = false
	for p, r in runners do
		if r.lives > 0 and r.immuneUntil <= t and World.where(p) == "room" then
			local hrp = p.Character and p.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
			if hrp then
				local pos = hrp.Position
				local hit = false
				if s.hl or s.hr then
					hit = (s.hl ~= nil and (s.hl - pos).Magnitude <= Config.TAG_RADIUS)
						or (s.hr ~= nil and (s.hr - pos).Magnitude <= Config.TAG_RADIUS)
				else
					local d = Vector3.new(pos.X - s.pos.X, 0, pos.Z - s.pos.Z)
					hit = d.Magnitude <= Config.TAG_RADIUS
				end
				if hit then
					tag(r)
					changed = true
				end
			end
		end
	end
	if changed then
		publish()
	end
end

function TagGame.start10Hz()
	setState("idle")
	task.spawn(function()
		while true do
			task.wait(1 / Config.TAG_CHECK_HZ)
			local ok, err = pcall(check)
			if not ok then
				warn("[DejaView] tag check error:", err)
			end
		end
	end)
	Players.PlayerRemoving:Connect(function(p)
		runners[p] = nil
	end)
end

return TagGame
