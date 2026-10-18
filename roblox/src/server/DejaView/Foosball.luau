-- Foosball on the real table (team/shivin.md Update 5, item 2). Two teams, one per end of the table. Each team has a
-- defence rod and an attack rod; a player slides both rods together (◀ ▶ buttons, or Z / X) and KICKs (button or C).
-- The server runs the ball: it bounces off the side walls and off the little players, and a goal counts when it
-- crosses an end inside the goal mouth. First to 5. An empty end is played by a bot that tracks the ball.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local World = require(script.Parent.World)
local Theme = require(ReplicatedStorage.Shared.Theme)
local Stats = require(script.Parent.Stats)

local FoosInput = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("FoosInput") :: RemoteEvent

local Foosball = {}

local WIN_SCORE = 5
local SIDE_ZONE = 12
-- Sizes follow the table (set in place): a big arcade table (16 x 9) or the real one at the court (4.2 x 2.5).
local BALL_R = 0.45
local MAN_HALF = 0.55 -- half width of a little player along X
local GOAL_HALF = 1.8
local SPEED = 14 -- studs/s after a hit
local KICK_SPEED = 24
local MIN_SPEED = 2
local ROD_Y, MAN_H = 1.6, 1.6 -- rod height above the pitch, height of a little player
local FRICTION = 0.35 -- speed lost per second, fraction
local ROD_SPEED = 14 -- studs/s a rod slides (set per table)

-- Table frame: long axis along Z, team A defends -Z, team B defends +Z, top at y = 0.
local tableCf = CFrame.new()
local LEN, WID = 16, 9
local folder: Folder? = nil
local scoreLabel: TextLabel? = nil
local ballPart: BasePart? = nil
local conn: RBXScriptConnection? = nil

-- rods: { team, z, men = {x offsets}, offset, target, parts = {BasePart}, range }
local rods: { any } = {}
local teams: { [string]: Player? } = { A = nil, B = nil }
local input: { [string]: number } = { A = 0, B = 0 } -- -1 .. 1 slide direction
local kickAt: { [string]: number } = { A = 0, B = 0 }
local score = { A = 0, B = 0 }
local ball = { pos = Vector2.zero, vel = Vector2.zero } -- (x, z) on the table
local paused = true
local over = false
local roundId = ""
local startedAt = 0
local botError: { [string]: number } = { A = 0, B = 0 } -- bots aim a little off, so they can be beaten
local botErrorAt = 0

local function other(s: string): string
	return if s == "A" then "B" else "A"
end

local function nameOf(s: string): string
	local p = teams[s]
	return if p then p.DisplayName else "Bot"
end

local function updateBoard()
	if scoreLabel then
		scoreLabel.Text = string.format("%s  %d  ·  %d  %s", nameOf("A"), score.A, score.B, nameOf("B"))
	end
end

local function sideOf(player: Player): string?
	local hrp = player.Character and player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not hrp then
		return nil
	end
	-- players stand on the long sides (where the rod handles are): team A on -X, team B on +X
	local p = tableCf:PointToObjectSpace(hrp.Position)
	if math.abs(p.Z) > LEN / 2 + 3 or math.abs(p.X) > WID / 2 + SIDE_ZONE then
		return nil
	end
	if p.X < -WID / 2 + 0.3 then
		return "A"
	elseif p.X > WID / 2 - 0.3 then
		return "B"
	end
	return nil
end

local function world(x: number, y: number, z: number): CFrame
	return tableCf * CFrame.new(x, y, z)
end

local function drop(towards: string?)
	-- the ball comes in from the side at midfield, drifting a little towards one team
	local rng = Random.new()
	ball.pos = Vector2.new(0, 0)
	local dir = if towards == "A" then -1 elseif towards == "B" then 1 else (if rng:NextNumber() < 0.5 then -1 else 1)
	local k = LEN / 16
	ball.vel = Vector2.new(rng:NextNumber(-4, 4) * k, dir * 5 * k)
	paused = false
end

local function goal(scorer: string)
	paused = true
	score[scorer] += 1
	updateBoard()
	World.toast("GOAL · " .. nameOf(scorer))
	print(string.format("[Foos] goal %s · %d-%d", nameOf(scorer), score.A, score.B))
	if score[scorer] >= WIN_SCORE then
		over = true
		local final = string.format("%d-%d", score.A, score.B)
		World.Moment:FireAllClients({ type = "winner", title = string.upper(nameOf(scorer)) .. " WINS FOOSBALL", mvp = final })
		local sceneId = workspace:GetAttribute("SceneId")
		Backend.gameResult({ game = "foosball", round = roundId, winner = teams[scorer], loser = teams[other(scorer)],
			score = string.format("%d-%d", score[scorer], score[other(scorer)]), startedAt = startedAt })
		Stats.win(teams[scorer], "foosball")
		if sceneId == "the-courts" then
			Stats.badge(teams[scorer], "court")
		end
		if type(sceneId) == "string" then
			Backend.sendEvent(sceneId, { type = "game", game = "foosball", winner = nameOf(scorer), score = final })
		end
		return
	end
	task.delay(1.5, function()
		if folder and not over then
			drop(scorer) -- the team that conceded gets the ball's drift
		end
	end)
end

local function step(dt: number)
	if not folder then
		return
	end
	-- rods: people slide with input; bots follow the ball (with a drifting aiming error, and kick when it's close)
	if os.clock() - botErrorAt > 1.2 then
		botErrorAt = os.clock()
		local rng = Random.new()
		local e = MAN_HALF * 2.6
		botError = { A = rng:NextNumber(-e, e), B = rng:NextNumber(-e, e) }
		for _, t in { "A", "B" } do
			if not teams[t] and rng:NextNumber() < 0.5 then
				kickAt[t] = os.clock()
			end
		end
	end
	for _, rod in rods do
		local dir = input[rod.team]
		if not teams[rod.team] then
			-- bot: keep the nearest man under the ball
			local bestD = math.huge
			for _, mx in rod.men do
				local d = ball.pos.X + botError[rod.team] - (mx + rod.offset)
				if math.abs(d) < math.abs(bestD) then
					bestD = d
				end
			end
			dir = math.clamp(bestD * 0.8, -1, 1) * 0.75
		end
		rod.offset = math.clamp(rod.offset + dir * ROD_SPEED * dt, -rod.range, rod.range)
		for i, part in rod.parts do
			part.CFrame = world(rod.men[i] + rod.offset, MAN_H / 2, rod.z)
		end
		rod.bar.CFrame = world(rod.offset, ROD_Y, rod.z)
		if rod.grip then
			rod.grip.CFrame = world(rod.offset + rod.gripX, ROD_Y, rod.z)
		end
	end
	if paused then
		return
	end
	-- ball
	local p, v = ball.pos, ball.vel
	v *= math.max(0, 1 - FRICTION * dt)
	if v.Magnitude < MIN_SPEED then
		v = v.Unit * MIN_SPEED -- never stall on the table
	end
	local np = p + v * dt
	-- side walls
	if math.abs(np.X) > WID / 2 - BALL_R then
		np = Vector2.new(math.sign(np.X) * (WID / 2 - BALL_R), np.Y)
		v = Vector2.new(-v.X, v.Y)
	end
	-- the little players: crossing a rod's line with a man there sends it back the other way
	for _, rod in rods do
		local crossed = (p.Y - rod.z) * (np.Y - rod.z) <= 0
		if crossed then
			for _, mx in rod.men do
				local manX = mx + rod.offset
				if math.abs(np.X - manX) <= MAN_HALF + BALL_R then
					-- a rod always plays towards the other team's goal
					local towards = if rod.team == "A" then 1 else -1
					local kicking = os.clock() - kickAt[rod.team] < 0.35
					local speed = if kicking then KICK_SPEED else SPEED
					local spin = (np.X - manX) / (MAN_HALF + BALL_R) -- off-centre hits angle away
					v = Vector2.new(spin * speed * 0.5, towards * speed)
					np = Vector2.new(np.X, rod.z + towards * (BALL_R + 0.1))
					break
				end
			end
		end
	end
	-- ends: a goal inside the mouth, otherwise a bounce
	if math.abs(np.Y) > LEN / 2 - BALL_R then
		if math.abs(np.X) <= GOAL_HALF then
			goal(if np.Y > 0 then "A" else "B")
			ball.pos = Vector2.zero
			if ballPart then
				ballPart.CFrame = world(0, BALL_R, 0)
			end
			return
		end
		np = Vector2.new(np.X, math.sign(np.Y) * (LEN / 2 - BALL_R))
		v = Vector2.new(v.X, -v.Y)
	end
	ball.pos, ball.vel = np, v
	if ballPart then
		ballPart.CFrame = world(np.X, BALL_R, np.Y)
	end
end

local function part(parent: Instance, name: string, size: Vector3, cf: CFrame, color: Color3, transparency: number?): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored, p.CanTouch, p.CanCollide = true, false, true
	p.Size = size
	p.CFrame = cf
	p.Color = color
	p.Material = Enum.Material.SmoothPlastic
	p.Transparency = transparency or 0
	p.Parent = parent
	return p
end

function Foosball.remove()
	if conn then
		conn:Disconnect()
		conn = nil
	end
	if folder then
		folder:Destroy()
	end
	folder, scoreLabel, ballPart, rods = nil, nil, nil, {}
	workspace:SetAttribute("FoosActive", false)
end

-- centre: table top centre; yaw: long axis direction (team A at the back). visible=false: the real table is the world's.
local lastPlace: any = nil

-- Rematch: the same game again in the same spot (Update 6 item 1).
function Foosball.isActive(): boolean
	return lastPlace ~= nil and workspace:FindFirstChild("Room") ~= nil and workspace.Room:FindFirstChild("Foosball") ~= nil
end

function Foosball.rematch()
	if lastPlace then
		Foosball.place(table.unpack(lastPlace, 1, lastPlace.n))
	end
end

-- extra (real table): { rodZs = { local z of each rod }, rodY = rod height above the pitch }
function Foosball.place(centre: Vector3, yaw: number, length: number?, width: number?, visible: boolean?, extra: any?)
	lastPlace = table.pack(centre, yaw, length, width, visible, extra)
	Foosball.remove()
	local room = workspace:FindFirstChild("Room")
	if not room then
		return
	end
	LEN, WID = length or 16, width or 9
	tableCf = CFrame.new(centre) * CFrame.Angles(0, yaw, 0)
	local k = LEN / 16 -- 1 for the arcade table
	-- real proportions (ball ~3.5 % of the width, a player ~6 %), so a ball can slip between players like on a real table
	BALL_R, MAN_HALF, GOAL_HALF = math.min(0.45 * k, WID * 0.035), math.min(0.55 * k, WID * 0.03), WID * 0.16
	SPEED, KICK_SPEED, MIN_SPEED, ROD_SPEED = 14 * k, 24 * k, 2 * k, WID * 1.6
	ROD_Y = if extra and tonumber(extra.rodY) then extra.rodY else 1.6 * k
	MAN_H = math.max(ROD_Y + 0.15 * k, 0.5 * k)
	local f = Instance.new("Folder")
	f.Name = "Foosball"
	f.Parent = room
	folder = f
	-- a real cabinet's proportions at any size: light wood walls up to the rim, a deep box under the field, dark
	-- corner caps and four legs down to the floor (y = 0)
	local wood, field, dark = Color3.fromRGB(196, 170, 128), Color3.fromRGB(62, 108, 146), Color3.fromRGB(34, 34, 38)
	local rimH, depth, t = 0.195 * WID, 0.3 * WID, 0.04 * WID
	if visible ~= false then
		part(f, "Pitch", Vector3.new(WID, 0.04 * WID, LEN), world(0, -0.02 * WID, 0), field)
		for _, sx in { -1, 1 } do
			part(f, "Side", Vector3.new(t, rimH + depth, LEN + 2 * t), world(sx * (WID / 2 + t / 2), (rimH - depth) / 2, 0), wood)
		end
		for _, sz in { -1, 1 } do
			-- end walls with the goal mouth left open, a lintel over it and the dark goal box behind it
			local w = (WID - GOAL_HALF * 2) / 2
			for _, sx in { -1, 1 } do
				part(f, "End", Vector3.new(w, rimH + depth, t), world(sx * (GOAL_HALF + w / 2), (rimH - depth) / 2, sz * (LEN / 2 + t / 2)), wood)
			end
			part(f, "Lintel", Vector3.new(GOAL_HALF * 2, rimH * 0.35, t), world(0, rimH * 0.825, sz * (LEN / 2 + t / 2)), wood)
			part(f, "Goal", Vector3.new(GOAL_HALF * 2, depth, t), world(0, -depth / 2, sz * (LEN / 2 + t * 1.5)), dark)
			-- the penalty box lines
			part(f, "Line", Vector3.new(GOAL_HALF * 3, 0.01, 0.012 * WID), world(0, 0.005, sz * (LEN / 2 - 0.12 * WID)), Color3.new(1, 1, 1))
		end
		local legH = math.max(0.5, tableCf.Position.Y - depth)
		for _, sx in { -1, 1 } do
			for _, sz in { -1, 1 } do
				part(f, "Cap", Vector3.new(t * 1.6, rimH + depth + 0.02 * WID, t * 1.6),
					world(sx * (WID / 2 + t / 2), (rimH - depth) / 2, sz * (LEN / 2 + t / 2)), dark)
				part(f, "Leg", Vector3.new(0.09 * WID, legH, 0.09 * WID),
					world(sx * (WID / 2 - 0.03 * WID), -depth - legH / 2, sz * (LEN / 2 - 0.08 * WID)), wood)
			end
		end
	end
	part(f, "Line", Vector3.new(WID, 0.02, 0.12), world(0, 0.02, 0), Color3.new(1, 1, 1))
	-- 8 rods like a real table, from team A's goal (-Z) to team B's: goalie, defence, their attack, midfield,
	-- their midfield, attack, their defence, their goalie (1, 2, 3, 5, 5, 3, 2, 1 players)
	rods = {}
	local teamsOrder = { "A", "A", "B", "A", "B", "A", "B", "B" }
	local counts = { 1, 2, 3, 5, 5, 3, 2, 1 }
	local zs = {}
	if extra and type(extra.rodZs) == "table" and #extra.rodZs == 8 then
		zs = table.clone(extra.rodZs)
		table.sort(zs)
	else
		for i = 1, 8 do
			zs[i] = -LEN / 2 + LEN * (i - 0.5) / 8
		end
	end
	for i = 1, 8 do
		local n = counts[i]
		local spacing = WID / (n + 0.6)
		local men = {}
		for j = 1, n do
			table.insert(men, (j - (n + 1) / 2) * spacing)
		end
		local outer = math.abs(men[1])
		local rod = { team = teamsOrder[i], z = zs[i], men = men, offset = 0, parts = {},
			range = math.max(0, WID / 2 - 0.05 * WID - outer - MAN_HALF) }
		local colour = if rod.team == "A" then Theme.Accent else Color3.fromRGB(255, 77, 109)
		local d = 0.07 + 0.11 * k
		local over = t + 0.12 * WID -- how far a rod reaches past the field's edge
		rod.bar = part(f, "Rod", Vector3.new(WID + 2 * over, d, d), world(0, ROD_Y, zs[i]), Color3.fromRGB(200, 200, 205))
		rod.bar.Shape = Enum.PartType.Cylinder
		rod.bar.Material = Enum.Material.Metal
		rod.bar.CanCollide = false
		-- team A stands on -X, team B on +X
		rod.gripX = (if rod.team == "A" then -1 else 1) * (WID / 2 + over + 0.06 * WID)
		rod.grip = part(f, "Grip", Vector3.new(0.14 * WID, d * 2.2, d * 2.2), world(rod.gripX, ROD_Y, zs[i]),
			Color3.fromRGB(112, 70, 40))
		rod.grip.Shape = Enum.PartType.Cylinder
		rod.grip.CanCollide = false
		for _, mx in men do
			local man = part(f, "Man", Vector3.new(MAN_HALF * 2, MAN_H, 0.12 + 0.38 * k), world(mx, MAN_H / 2, zs[i]), colour)
			man.CanCollide = false
			table.insert(rod.parts, man)
		end
		table.insert(rods, rod)
	end
	local b = part(f, "Ball", Vector3.new(BALL_R * 2, BALL_R * 2, BALL_R * 2), world(0, BALL_R, 0), Color3.new(1, 1, 1))
	b.Shape = Enum.PartType.Ball
	b.CanCollide = false
	ballPart = b
	-- scoreboard
	local sign = part(f, "Score", Vector3.one, world(0, 5, 0), Color3.new(), 1)
	sign.CanCollide, sign.CanQuery = false, false
	local gui = Theme.make("BillboardGui", { Size = UDim2.fromOffset(340, 64), AlwaysOnTop = true, LightInfluence = 0,
		MaxDistance = 200, Parent = sign })
	local card = Theme.make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg, BackgroundTransparency = 0.08,
		Parent = gui }, { Theme.corner(14), Theme.stroke(Theme.Accent, 1.5) })
	scoreLabel = Theme.label({ Text = "", FontFace = Theme.Heading, TextXAlignment = Enum.TextXAlignment.Center,
		Size = UDim2.new(1, -20, 1, -12), Position = UDim2.fromOffset(10, 6), MaxText = 26, Parent = card })
	teams, input, score, over, paused = { A = nil, B = nil }, { A = 0, B = 0 }, { A = 0, B = 0 }, false, true
	roundId, startedAt = Backend.newRound("foosball"), os.clock()
	ball.pos, ball.vel = Vector2.zero, Vector2.zero
	updateBoard()
	workspace:SetAttribute("FoosActive", true)
	World.toast("Foosball: stand at a long side, ◀ ▶ (Z / X) pull and push your rods, KICK (C)")
	conn = RunService.Heartbeat:Connect(function(dt)
		local ok, err = pcall(step, math.min(dt, 0.05))
		if not ok then
			warn("[DejaView] foosball:", err)
		end
	end)
	task.delay(2, function()
		if folder and not over then
			drop(nil)
		end
	end)
end

local function placeFromFeature(ft: any): boolean
	if type(ft) ~= "table" or type(ft.corners) ~= "table" or #ft.corners < 4 then
		return false
	end
	local c = {}
	for i = 1, 4 do
		local v = ft.corners[i]
		c[i] = Vector3.new(v[1] or v.x, v[2] or v.y, v[3] or v.z)
	end
	local centre = (c[1] + c[2] + c[3] + c[4]) / 4
	local e1, e2 = c[2] - c[1], c[3] - c[2]
	local long, short = if e1.Magnitude >= e2.Magnitude then e1 else e2, if e1.Magnitude >= e2.Magnitude then e2 else e1
	local extra = {}
	if type(ft.rodOffsets) == "table" and #ft.rodOffsets == 8 then
		extra.rodZs = {}
		for i, o in ft.rodOffsets do
			extra.rodZs[i] = -o -- contract: local z = -offset
		end
	end
	if tonumber(ft.rodHeight) and tonumber(ft.fieldHeight) then
		extra.rodY = ft.rodHeight - ft.fieldHeight
	end
	-- the table's own frame: y = 0 is the pitch (corners and height are the field)
	local sceneId = workspace:GetAttribute("SceneId")
	local drawn = type(sceneId) == "string" and (Config.SPHERE_ROOMS[sceneId] == true or Config.BUILT_ROOMS[sceneId] == true)
	Foosball.place(centre, math.atan2(-long.X, -long.Z), long.Magnitude, short.Magnitude, drawn, extra)
	return true
end

function Foosball.placeForRoom(host: Player?, features: any?, cameraLook: Vector3?)
	if features and placeFromFeature(features.foosballTable) then
		return
	end
	local sceneId = workspace:GetAttribute("SceneId")
	local tuned = type(sceneId) == "string" and Config.FOOSBALL_TABLES[sceneId]
	if tuned then
		Foosball.place(Vector3.new(tuned.centre[1], tuned.centre[2], tuned.centre[3]), tuned.yaw or 0, tuned.length,
			tuned.width, tuned.visible, tuned.extra)
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
	-- turned so the host stands at the middle of a long side (team A), the table running left to right
	local centre = Vector3.new(hrp.Position.X, floorY + 3, hrp.Position.Z) + look * (9 / 2 + 3)
	Foosball.place(centre, math.atan2(-look.Z, look.X), 16, 9, true)
end

local function onInput(player: Player, kind: any, value: any)
	if not folder or over then
		return
	end
	local side = sideOf(player)
	if not side then
		return
	end
	if not teams[side] and teams[other(side)] ~= player then
		teams[side] = player
		World.toast(player.DisplayName .. " takes the " .. (if side == "A" then "near" else "far") .. " end")
		updateBoard()
	end
	if teams[side] ~= player then
		return
	end
	if kind == "slide" and type(value) == "number" then
		-- ▶ pushes your rods away from you, ◀ pulls them in: team A stands on -X, team B on +X
		local v = math.clamp(value, -1, 1)
		input[side] = if side == "A" then v else -v
	elseif kind == "kick" then
		kickAt[side] = os.clock()
	end
end

function Foosball.start()
	FoosInput.OnServerEvent:Connect(onInput)
	Players.PlayerRemoving:Connect(function(p)
		for s, q in teams do
			if q == p then
				teams[s] = nil
				input[s] = 0
			end
		end
		updateBoard()
	end)
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		if conn then
			conn:Disconnect()
			conn = nil
		end
		folder, scoreLabel, ballPart, rods = nil, nil, nil, {}
		workspace:SetAttribute("FoosActive", false)
	end)
	-- rooms whose real table is part of the room get it as soon as they load
	workspace:GetAttributeChangedSignal("Phase"):Connect(function()
		local sceneId = workspace:GetAttribute("SceneId")
		local tuned = type(sceneId) == "string" and Config.FOOSBALL_TABLES[sceneId]
		if workspace:GetAttribute("Phase") ~= "room" or not (tuned and tuned.auto) then
			return
		end
		task.delay(1, function()
			if folder == nil and workspace:GetAttribute("SceneId") == sceneId and workspace:GetAttribute("Phase") == "room" then
				Foosball.placeForRoom(nil, nil, nil)
			end
		end)
	end)
end

return Foosball
