-- Real-physics ping pong on the Game Lawn table (team/seb.md Update 5, section B).
-- The server owns the ball and the rules; clients send paddle poses and hits. One match at a time, winner stays.
-- Its own files only: this module, PingPongSim (shared), Games.client + PingPongView (client). One line in Main.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local World = require(script.Parent.World)
local Stats = require(script.Parent.Stats)
local Rooms = require(script.Parent.Rooms)
local Pong = require(script.Parent.Pong)
local Sim = require(ReplicatedStorage.Shared.PingPongSim)

local PingPong = {}

local SCORE_TO_WIN = Sim.WIN_SCORE
local SIDE_ZONE = 12
local HIT_SLACK = 1.8
local BOT_DELAY = 0.28

local frame = CFrame.new()
local len, wid = Sim.LEN, Sim.WID
local folder: Folder? = nil
local ball: Part? = nil
local net: Part? = nil
local board: TextLabel? = nil
local prompt: ProximityPrompt? = nil

local sides: { [string]: Player? } = { A = nil, B = nil }
local queue: { Player } = {}
local score = { A = 0, B = 0 }
local serverSide = "A"
local pointsPlayed = 0
local matchStart = 0
local roundId = ""
local over = false
local state: any = nil
local lastHitter: string? = nil
local lastBounce: string? = nil
local botBusy = false

local Remotes: Folder
local PPHit: RemoteEvent
local PPPaddle: UnreliableRemoteEvent
local PPState: RemoteEvent
local PPSide: RemoteEvent

local function now(): number
	return workspace:GetServerTimeNow()
end

local function other(s: string): string
	return if s == "A" then "B" else "A"
end

local function nameOf(s: string?): string
	if not s then
		return "—"
	end
	local p = sides[s]
	return if p and p.Parent then p.DisplayName elseif s then "Bot" else "—"
end

local function playerSide(p: Player): string?
	for s, q in sides do
		if q == p then
			return s
		end
	end
	return nil
end

local function updateBoard()
	if board then
		board.Text = string.format(
			"%s  %d  ·  %d  %s\nserve %s · rally %d · best %d",
			nameOf("A"),
			score.A,
			score.B,
			nameOf("B"),
			nameOf(serverSide),
			state and state.rally or 0,
			state and state.best or 0
		)
	end
	workspace:SetAttribute("PPActive", folder ~= nil and not over)
	if PPState then
		PPState:FireAllClients({
			active = folder ~= nil,
			over = over,
			A = nameOf("A"),
			B = nameOf("B"),
			scoreA = score.A,
			scoreB = score.B,
			serve = serverSide,
			to = state and state.to or nil,
			bounce = lastBounce,
			serving = state and state.serving or false,
		})
	end
end

local function broadcastState()
	if PPState then
		PPState:FireAllClients({
			state = state and { p = state.p, v = state.v, t = state.t, to = state.to } or nil,
			shot = state and state.shot or 0,
		})
	end
end

local function ensurePart(name: string, size: Vector3, colour: Color3, parent: Instance): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.Size = size
	p.Color = colour
	p.Material = Enum.Material.SmoothPlastic
	p.Parent = parent
	return p
end

local function destroyTable()
	if folder then
		folder:Destroy()
	end
	if ball then
		ball:Destroy()
	end
	folder, ball, net, board, prompt = nil, nil, nil, nil, nil
	state = nil
	lastHitter, lastBounce, botBusy = nil, nil, false
	workspace:SetAttribute("PPActive", false)
end

-- Build the visible table (a real table gets only the net and the lines) and the prompt.
local function buildTable(tableCf: CFrame, length: number, width: number, visible: boolean)
	destroyTable()
	frame, len, wid = tableCf, length, width
	local root = workspace:FindFirstChild("Room")
	folder = Instance.new("Folder")
	folder.Name = "PingPongTable"
	folder.Parent = if root and root:IsA("Folder") then root else workspace

	if visible then
		local top = ensurePart("Top", Vector3.new(width, 0.12, length), Color3.fromRGB(28, 66, 54), folder)
		top.CFrame = frame * CFrame.new(0, -0.06, 0)
		for _, z in { -length / 2, length / 2 } do
			local line = ensurePart("Line", Vector3.new(width, 0.02, 0.06), Color3.fromRGB(245, 245, 245), folder)
			line.CFrame = frame * CFrame.new(0, 0.01, z)
		end
		local centre = ensurePart("Line", Vector3.new(0.06, 0.02, length), Color3.fromRGB(245, 245, 245), folder)
		centre.CFrame = frame * CFrame.new(0, 0.01, 0)
	end

	net = ensurePart("Net", Vector3.new(Sim.NET_L, Sim.NET_H, 0.05), Color3.fromRGB(235, 235, 235), folder)
	net.Transparency = 0.15
	net.CFrame = frame * CFrame.new(0, Sim.NET_H / 2, 0)

	ball = Instance.new("Part")
	ball.Name = "PPBall"
	ball.Shape = Enum.PartType.Ball
	ball.Size = Vector3.new(0.36, 0.36, 0.36)
	ball.Color = Color3.fromRGB(255, 170, 40)
	ball.Material = Enum.Material.Neon
	ball.Anchored, ball.CanCollide, ball.CanQuery, ball.CanTouch = true, false, false, false
	ball.Parent = folder
	ball.CFrame = frame * CFrame.new(Sim.servePos("A", len))

	local anchor = ensurePart("Board", Vector3.new(4, 1.2, 0.2), Color3.fromRGB(20, 20, 20), folder)
	anchor.Transparency = 1
	anchor.CFrame = frame * CFrame.new(0, 3.1, 0)
	local gui = Instance.new("BillboardGui")
	gui.Name = "Scoreboard"
	gui.Size = UDim2.fromOffset(420, 96)
	gui.AlwaysOnTop = true
	gui.Parent = anchor
	board = Instance.new("TextLabel")
	board.Size = UDim2.fromScale(1, 1)
	board.BackgroundTransparency = 1
	board.Font = Enum.Font.GothamBold
	board.TextScaled = false
	board.TextSize = 22
	board.TextColor3 = Color3.fromRGB(245, 245, 245)
	board.TextStrokeTransparency = 0.4
	board.TextWrapped = true
	board.Text = ""
	board.Parent = gui

	prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = "Play real ping pong"
	prompt.ObjectText = "Game Lawn"
	prompt.HoldDuration = 0
	prompt.MaxActivationDistance = 10
	prompt.Parent = anchor
	prompt.Triggered:Connect(function(p)
		PingPong.join(p)
	end)

	updateBoard()
end

local function placeForScene(host: Player?, features: any?, cameraLook: Vector3?)
	local sceneId = workspace:GetAttribute("SceneId")
	local ft = features and features.pingPongTable
	local centre, yaw, l, w = Sim.fromCorners(ft and ft.corners or nil)
	if centre and yaw and l and w then
		buildTable(CFrame.new(centre) * CFrame.Angles(0, yaw, 0), l, w, false)
		return
	end
	local tuned = type(sceneId) == "string" and Config.PINGPONG_TABLES[sceneId]
	if tuned then
		local c = Vector3.new(tuned.centre[1], tuned.centre[2], tuned.centre[3])
		buildTable(
			CFrame.new(c) * CFrame.Angles(0, tuned.yaw or 0, 0),
			tuned.length or Sim.LEN,
			tuned.width or Sim.WID,
			tuned.visible == true
		)
		return
	end
	local hrp = host and host.Character and host.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not hrp then
		World.toast("Walk into the room first", host)
		return
	end
	local dir = if typeof(cameraLook) == "Vector3" then cameraLook else hrp.CFrame.LookVector
	local flat = Vector3.new(dir.X, 0, dir.Z)
	local look = if flat.Magnitude > 0.01 then flat.Unit else Vector3.new(0, 0, -1)
	local hum = (hrp.Parent :: Model):FindFirstChildOfClass("Humanoid")
	local floorY = hrp.Position.Y - ((hum and hum.HipHeight or 2) + hrp.Size.Y / 2)
	local centre2 = Vector3.new(hrp.Position.X, floorY + 2.71, hrp.Position.Z) + look * (6 + len / 2)
	buildTable(CFrame.new(centre2) * CFrame.Angles(0, math.atan2(look.X, look.Z), 0), Sim.LEN, Sim.WID, true)
end

local function launch(to: string, p0: Vector3, flight: number, aim: number)
	state.to = to
	state.p = p0
	state.t = now()
	state.live = true
	state.serving = false
	state.lastTouch = state.t
	state.bounces = 0
	state.shot += 1
	state.rally = state.rally or 0
	lastHitter = other(to)
	lastBounce = nil
	local v = Sim.assistReturn(p0, other(to), aim, flight, len, wid)
	state.v = v
	ball.CFrame = frame * CFrame.new(state.p)
	broadcastState()
	updateBoard()
end

local function serve(wait: boolean)
	if over or not folder then
		return
	end
	state = state or { rally = 0, best = 0, shot = 0 }
	state.rally = 0
	local p = Sim.servePos(serverSide, len)
	state.p, state.v, state.t = p, Vector3.zero, now()
	state.live, state.lastTouch, state.bounces = true, now(), 0
	state.to = serverSide
	state.serving = true
	lastHitter, lastBounce = nil, nil
	ball.CFrame = frame * CFrame.new(p)
	updateBoard()
	broadcastState()
	if wait and sides[serverSide] then
		World.toast("Your serve, " .. nameOf(serverSide), sides[serverSide])
	end
	if not sides[serverSide] then
		-- the bot serves after a moment
		task.delay(0.9, function()
			if folder and state and state.serving and not over then
				launch(other(serverSide), state.p, 0.8, 0)
			end
		end)
	end
end

local function finish(winnerSide: string)
	over = true
	local winner, loser = sides[winnerSide], sides[other(winnerSide)]
	local duration = math.max(0, math.floor(now() - matchStart))
	local wId = winner and `rbx-{winner.UserId}` or "bot"
	local lId = loser and `rbx-{loser.UserId}` or "bot"
	local wName = winner and winner.DisplayName or "Bot"
	local lName = loser and loser.DisplayName or "Bot"
	Backend.sendEvent(workspace:GetAttribute("SceneId"), {
		type = "game.result",
		game = "pingpong",
		round = roundId,
		winner = wId,
		winnerName = wName:sub(1, 40),
		loser = lId,
		loserName = lName:sub(1, 40),
		score = string.format("%d-%d", score[winnerSide], score[other(winnerSide)]),
		durationS = duration,
	})
	Stats.win(winner, "pingpong")
	World.toast(string.format("%s wins %d-%d", wName, score[winnerSide], score[other(winnerSide)]))
	updateBoard()
	task.delay(6, function()
		if not folder then
			return
		end
		over = false
		score.A, score.B = 0, 0
		pointsPlayed = 0
		matchStart = now()
		local loserSide = other(winnerSide)
		local nextPlayer = table.remove(queue, 1)
		if nextPlayer and nextPlayer.Parent then
			sides[loserSide] = nextPlayer
			if PPSide then
				PPSide:FireClient(nextPlayer, loserSide)
			end
			World.toast("You are up next", nextPlayer)
		end
		serverSide = other(serverSide)
		serve(true)
	end)
end

local function point(winnerSide: string, why: string)
	if over or not folder then
		return
	end
	score[winnerSide] += 1
	pointsPlayed += 1
	state.live = false
	World.toast(why)
	print(string.format("[PingPong] %s · %s · %d-%d", why, nameOf(winnerSide), score.A, score.B))
	updateBoard()
	local target = if score[winnerSide] >= SCORE_TO_WIN and score[winnerSide] - score[other(winnerSide)] >= 2
		then winnerSide
		else nil
	if target then
		finish(target)
		return
	end
	if pointsPlayed % 2 == 0 and not (score.A >= 10 and score.B >= 10) then
		serverSide = other(serverSide)
	end
	task.delay(1.2, function()
		if folder and not over then
			serve(true)
		end
	end)
end

local function botReturn()
	if botBusy or not folder or over or not state or not state.live then
		return
	end
	if sides[state.to] then
		return
	end
	botBusy = true
	task.delay(BOT_DELAY, function()
		botBusy = false
		if not folder or over or not state or not state.live then
			return
		end
		if sides[state.to] then
			return
		end
		local from = state.p
		state.rally = (state.rally or 0) + 1
		state.best = math.max(state.best or 0, state.rally)
		launch(other(state.to), from, math.max(0.55, 0.8 - state.rally * 0.02), (math.random() * 2 - 1) * 0.7)
	end)
end

local function step(dt: number)
	if not state or not state.live or not ball then
		return
	end
	local ev = Sim.step(state, dt, len, wid)
	ball.CFrame = frame * CFrame.new(state.p)
	if ev.table then
		lastBounce = ev.table
		state.serveInFlight = false
		state.lastTouch = state.t
		updateBoard()
		if ev.table == state.to then
			botReturn()
		end
	end
	if ev.net then
		if state.serveInFlight then
			state.serveInFlight = false
			World.toast("Let, serve again")
			serve(true)
			return
		end
		-- a net touch kills the rally; the receiver takes the point
		point(state.to, "Net")
		return
	end
	if ev.dead then
		local winner
		if not lastHitter then
			winner = other(serverSide)
		elseif lastBounce == state.to then
			winner = lastHitter -- it bounced on the receiver's half; they failed to return it
		else
			winner = state.to -- it never reached the far half: the hitter's fault
		end
		point(winner, "Out")
	end
end

local lastHitAt: { [number]: number } = {}

local function onHit(player: Player, payload: any)
	if over or not folder or not state or not state.live then
		return
	end
	local t = os.clock()
	if t - (lastHitAt[player.UserId] or 0) < 0.2 then
		return
	end
	lastHitAt[player.UserId] = t
	local side = playerSide(player)
	if not side or side ~= state.to or state.serving then
		return
	end
	if lastBounce ~= side then
		return -- they must let it bounce on their half first
	end
	if type(payload) ~= "table" then
		return
	end
	local aim = tonumber(payload.aim) or 0
	local flight = tonumber(payload.flight) or 0.75
	local p0 = state.p
	state.serving = false
	state.rally = (state.rally or 0) + 1
	state.best = math.max(state.best or 0, state.rally)
	if payload.vr == true and typeof(payload.cf) == "CFrame" and typeof(payload.vel) == "Vector3" then
		-- the paddle really hit it: reflect off the blade and let the ball fly
		local blade = payload.cf :: CFrame
		local claimed = payload.p
		if typeof(claimed) == "Vector3" and (claimed - state.p).Magnitude > 2 then
			broadcastState()
			return
		end
		if (blade.Position - state.p).Magnitude > 2.2 then
			broadcastState()
			return
		end
		local before = state.v
		Sim.paddleHit(state, blade.UpVector, payload.vel :: Vector3, 0.8)
		if state.v == before then
			broadcastState() -- the ball was moving away; nothing to return
			return
		end
		state.to = other(side)
		lastHitter = side
		lastBounce = nil
		state.lastTouch = state.t
		ball.CFrame = frame * CFrame.new(state.p)
		broadcastState()
		updateBoard()
		return
	end
	launch(other(side), p0, flight, aim)
end

local function serveHit(player: Player, payload: any)
	local side = playerSide(player)
	if not side or side ~= serverSide or not state or not state.serving then
		return false
	end
	state.serving = false
	state.serveInFlight = true
	local aim = type(payload) == "table" and (tonumber(payload.aim) or 0) or 0
	launch(other(side), state.p, 0.8, aim)
	return true
end

local stepAccum = 0
local function onHeartbeat(dt: number)
	if not folder or not state then
		return
	end
	stepAccum = math.min(stepAccum + dt, 0.2)
	local h = 1 / 60
	while stepAccum >= h do
		stepAccum -= h
		if state.serving then
			-- the ball floats where it is until the serve is hit
			state.t = now()
			state.lastTouch = now()
		elseif not state.live then
			break
		else
			for _ = 1, 2 do
				step(h / 2)
			end
		end
	end
end

function PingPong.isActive(): boolean
	return folder ~= nil
end

function PingPong.join(player: Player)
	if not folder then
		World.toast("No table here yet", player)
		return
	end
	if Pong.isActive() then
		World.toast("Finish the arcade game first", player)
		return
	end
	local side = playerSide(player)
	if side then
		return
	end
	for _, s in { "A", "B" } do
		if not sides[s] then
			sides[s] = player
			if PPSide then
				PPSide:FireClient(player, s)
			end
			World.toast(if s == "A" then "You are on the near side" else "You are on the far side", player)
			if over then
				return
			end
			if state == nil or not state.live then
				serve(true)
			end
			updateBoard()
			return
		end
	end
	if #queue < 6 then
		table.insert(queue, player)
		World.toast("Queued for the next match", player)
	end
end

function PingPong.stop(): void
	destroyTable()
	sides.A, sides.B = nil, nil
	queue = {}
	score.A, score.B = 0, 0
	over = false
end

function PingPong.start()
	local RemotesFolder = ReplicatedStorage:WaitForChild("Remotes")
	Remotes = RemotesFolder :: Folder

	local function remote(name: string, class: string): any
		local r = Remotes:FindFirstChild(name) or Instance.new(class)
		r.Name = name
		r.Parent = Remotes
		return r
	end
	PPHit = remote("PPHit", "RemoteEvent")
	PPPaddle = remote("PPPaddle", "UnreliableRemoteEvent")
	PPState = remote("PPState", "RemoteEvent")
	PPSide = remote("PPSide", "RemoteEvent")

	PPHit.OnServerEvent:Connect(function(player, payload)
		if state and state.serving then
			if serveHit(player, payload) then
				return
			end
		end
		onHit(player, payload)
	end)

	PPPaddle.OnServerEvent:Connect(function(player, cf)
		if typeof(cf) == "CFrame" then
			-- fan the pose out to everyone so every client draws the other paddles
			PPPaddle:FireAllClients(player.UserId, cf)
		end
	end)

	Players.PlayerRemoving:Connect(function(p)
		for s, q in sides do
			if q == p then
				sides[s] = nil
			end
		end
		for i = #queue, 1, -1 do
			if queue[i] == p then
				table.remove(queue, i)
			end
		end
		updateBoard()
		if folder and state and state.serving then
			serve(true)
		end
	end)

	local function maybePlace()
		if workspace:GetAttribute("Phase") ~= "room" then
			return
		end
		if workspace:GetAttribute("SceneId") ~= "the-courts" or folder then
			return
		end
		if Pong.isActive() then
			return
		end
		local info = Rooms.modelInfo("the-courts")
		local features = info and info.features or nil
		if not (features and features.pingPongTable) and not Config.PINGPONG_TABLES["the-courts"] then
			-- Temporary: the model has no features yet. Put a visible table in the middle of the lawn so the game is
			-- playable today; features.pingPongTable replaces it as soon as the server sends it.
			local room = workspace:FindFirstChild("Room")
			local mn = room and room:GetAttribute("BoundsMin")
			local mx = room and room:GetAttribute("BoundsMax")
			if typeof(mn) == "Vector3" and typeof(mx) == "Vector3" then
				local c = (mn + mx) / 2
				buildTable(CFrame.new(c.X, c.Y + 2.71, c.Z), Sim.LEN, Sim.WID, true)
				roundId = string.format(
					"pp-%s",
					string.upper(
						(game.JobId:sub(1, 8) ~= "" and game.JobId:sub(1, 8) or "studio")
							.. tostring(math.floor(os.clock() * 1000))
					)
				)
				matchStart = now()
				score.A, score.B = 0, 0
				pointsPlayed, over = 0, false
				serverSide = "A"
				state = nil
				sides.A, sides.B = nil, nil
				updateBoard()
				return
			end
		end
		PingPong.placeForRoom(nil, features, nil)
	end

	workspace:GetAttributeChangedSignal("Phase"):Connect(function()
		if workspace:GetAttribute("Phase") ~= "room" then
			PingPong.stop()
		else
			task.delay(1, maybePlace)
		end
	end)
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		PingPong.stop()
		task.delay(2, maybePlace)
	end)
	task.delay(3, maybePlace)
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		PingPong.stop()
	end)

	RunService.Heartbeat:Connect(onHeartbeat)
	print("[PingPong] ready")
end

-- Kept for the host action Shivin wires: open the table on the current room.
function PingPong.placeForRoom(host: Player?, features: any?, cameraLook: Vector3?)
	placeForScene(host, features, cameraLook)
	roundId = string.format(
		"pp-%s",
		string.upper(
			(game.JobId:sub(1, 8) ~= "" and game.JobId:sub(1, 8) or "studio") .. tostring(math.floor(os.clock() * 1000))
		)
	)
	matchStart = now()
	score.A, score.B = 0, 0
	pointsPlayed, over = 0, false
	serverSide = "A"
	state = nil
	sides.A, sides.B = nil, nil
	updateBoard()
end

return PingPong
