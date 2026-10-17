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
local BALL_R = 0.45
local MAN_HALF = 0.55 -- half width of a little player along X
local GOAL_HALF = 1.8
local SPEED = 14 -- studs/s after a hit
local KICK_SPEED = 24
local FRICTION = 0.35 -- speed lost per second, fraction
local ROD_SPEED = 14 -- studs/s a rod slides

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
	local p = tableCf:PointToObjectSpace(hrp.Position)
	if math.abs(p.X) > WID / 2 + SIDE_ZONE then
		return nil
	end
	if p.Z < -LEN / 2 + 3 and p.Z > -LEN / 2 - SIDE_ZONE then
		return "A"
	elseif p.Z > LEN / 2 - 3 and p.Z < LEN / 2 + SIDE_ZONE then
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
	ball.vel = Vector2.new(rng:NextNumber(-4, 4), dir * 5)
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
		botError = { A = rng:NextNumber(-1.4, 1.4), B = rng:NextNumber(-1.4, 1.4) }
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
			part.CFrame = world(rod.men[i] + rod.offset, 0.9, rod.z)
		end
		rod.bar.CFrame = world(rod.offset, 1.6, rod.z) * CFrame.Angles(0, 0, math.pi / 2)
	end
	if paused then
		return
	end
	-- ball
	local p, v = ball.pos, ball.vel
	v *= math.max(0, 1 - FRICTION * dt)
	if v.Magnitude < 2 then
		v = v.Unit * 2 -- never stall on the table
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

function Foosball.place(centre: Vector3, yaw: number, length: number?, width: number?, visible: boolean?)
	lastPlace = table.pack(centre, yaw, length, width, visible)
	Foosball.remove()
	local room = workspace:FindFirstChild("Room")
	if not room then
		return
	end
	LEN, WID = length or 16, width or 9
	tableCf = CFrame.new(centre) * CFrame.Angles(0, yaw, 0)
	local f = Instance.new("Folder")
	f.Name = "Foosball"
	f.Parent = room
	folder = f
	local green, wood = Color3.fromRGB(46, 120, 70), Color3.fromRGB(120, 84, 52)
	if visible ~= false then
		part(f, "Pitch", Vector3.new(WID, 0.3, LEN), world(0, -0.15, 0), green)
		for _, sx in { -1, 1 } do
			part(f, "Side", Vector3.new(0.4, 1.4, LEN), world(sx * (WID / 2 + 0.2), 0.5, 0), wood)
		end
		for _, sz in { -1, 1 } do
			-- end walls with the goal mouth left open
			local w = (WID - GOAL_HALF * 2) / 2
			for _, sx in { -1, 1 } do
				part(f, "End", Vector3.new(w, 1.4, 0.4), world(sx * (GOAL_HALF + w / 2), 0.5, sz * (LEN / 2 + 0.2)), wood)
			end
		end
		for _, x in { -WID / 2 + 0.5, WID / 2 - 0.5 } do
			for _, z in { -LEN / 2 + 0.5, LEN / 2 - 0.5 } do
				part(f, "Leg", Vector3.new(0.5, 2.8, 0.5), world(x, -1.6, z), wood)
			end
		end
	end
	part(f, "Line", Vector3.new(WID, 0.02, 0.12), world(0, 0.02, 0), Color3.new(1, 1, 1))
	-- rods: defence near each team's own goal, attack in the other half (interleaved like a real table)
	rods = {}
	local layout = {
		{ team = "A", z = -LEN * 0.32, men = { -2.4, 0, 2.4 } },
		{ team = "B", z = -LEN * 0.12, men = { -2.6, 0, 2.6 } },
		{ team = "A", z = LEN * 0.12, men = { -2.6, 0, 2.6 } },
		{ team = "B", z = LEN * 0.32, men = { -2.4, 0, 2.4 } },
	}
	for _, def in layout do
		local rod = { team = def.team, z = def.z, men = def.men, offset = 0, parts = {}, range = WID / 2 - 2.9 - MAN_HALF }
		local colour = if def.team == "A" then Theme.Accent else Color3.fromRGB(255, 77, 109)
		rod.bar = part(f, "Rod", Vector3.new(WID + 3, 0.18, 0.18), world(0, 1.6, def.z), Color3.fromRGB(200, 200, 205))
		rod.bar.Shape = Enum.PartType.Cylinder
		rod.bar.CanCollide = false
		for _, mx in def.men do
			local man = part(f, "Man", Vector3.new(MAN_HALF * 2, 1.6, 0.5), world(mx, 0.9, def.z), colour)
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
	ball.pos, ball.vel = Vector2.zero, Vector2.zero
	updateBoard()
	workspace:SetAttribute("FoosActive", true)
	World.toast("Foosball: stand at an end, slide with ◀ ▶ (Z / X), KICK (C)")
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
	Foosball.place(centre, math.atan2(-long.X, -long.Z), long.Magnitude, short.Magnitude, false)
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
			tuned.width, tuned.visible)
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
	local centre = Vector3.new(hrp.Position.X, floorY + 3, hrp.Position.Z) + look * (5 + 8)
	Foosball.place(centre, math.atan2(look.X, look.Z), 16, 9, true)
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
		-- ▶ means "to my right": team A looks along +Z, so its right is -X; team B looks along -Z (right is +X)
		local v = math.clamp(value, -1, 1)
		input[side] = if side == "A" then -v else v
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
end

return Foosball
