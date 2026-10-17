-- Ping pong on the real table (team/shivin.md Update 5, item 1). Simple and fun over realistic: the server picks each
-- shot (a bounce point on the far half and an end point past the far edge) and every client animates the same arcs
-- locally, so the ball is smooth everywhere. Stand at an end of the table and press HIT (button, E, click or the Quest
-- trigger) while the ball is coming to you after its bounce. First to 7. Alone, a bot returns the ball.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local World = require(script.Parent.World)
local Theme = require(ReplicatedStorage.Shared.Theme)
local Stats = require(script.Parent.Stats)

local PongHit = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("PongHit") :: RemoteEvent

local Pong = {}

local WIN_SCORE = 7
local HIT_REACH = 9 -- studs from the player's root to the ball
local SIDE_ZONE = 12 -- how far behind/around an end counts as standing at it
local LATE = 0.35 -- seconds after the ball passes the end that a hit still counts
local BOT_RETURN = 0.85

-- Table in its own frame: long axis along Z, net at z = 0, top at y = 0. Side "A" is -Z, side "B" is +Z.
local tableCf = CFrame.new()
local LEN, WID = 14, 8
local folder: Folder? = nil
local scoreLabel: TextLabel? = nil

local sides: { [string]: Player? } = { A = nil, B = nil }
local score = { A = 0, B = 0 }
local server = "A" -- who serves next
local rally = 0
local best = 0
local over = false
local roundId = ""
local startedAt = 0

-- The ball in flight: towards `to` (the side that must return it).
local shot: any = nil
local shotId = 0

local function now(): number
	return workspace:GetServerTimeNow()
end

local function other(s: string): string
	return if s == "A" then "B" else "A"
end

local function local2world(v: Vector3): Vector3
	return tableCf:PointToWorldSpace(v)
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

local function nameOf(s: string): string
	local p = sides[s]
	return if p then p.DisplayName elseif sides[other(s)] then "Bot" else "—"
end

local function updateBoard()
	if scoreLabel then
		scoreLabel.Text = string.format("%s  %d  ·  %d  %s\nrally %d · best %d", nameOf("A"), score.A, score.B, nameOf("B"),
			rally, best)
	end
	workspace:SetAttribute("PongActive", folder ~= nil)
end

-- Launch a shot from `fromSide` towards the other side. `origin` is the world point the ball leaves from.
local function launch(fromSide: string, origin: Vector3, speedUp: number)
	shotId += 1
	local to = other(fromSide)
	local dir = if to == "B" then 1 else -1
	local rng = Random.new()
	-- bounce somewhere on the receiver's half, then carry on past their end
	local bounce = Vector3.new(rng:NextNumber(-WID / 2 + 1, WID / 2 - 1), 0.25, dir * rng:NextNumber(LEN * 0.15, LEN * 0.42))
	local finish = Vector3.new(bounce.X + rng:NextNumber(-1.5, 1.5), 2.8, dir * (LEN / 2 + 2.5))
	local pace = math.clamp(1 + rally * 0.04, 1, 1.6) * speedUp
	local t1 = 0.75 / pace
	local t2 = 0.45 / pace
	local t0 = now() + 0.05
	shot = {
		id = shotId, to = to, t0 = t0, t1 = t1, t2 = t2,
		p0 = origin, b = local2world(bounce), p2 = local2world(finish),
		h1 = 3.2, h2 = 1.6,
	}
	World.Moment:FireAllClients({ type = "pongShot", id = shotId, t0 = t0, t1 = t1, t2 = t2,
		p0 = shot.p0, b = shot.b, p2 = shot.p2, h1 = shot.h1, h2 = shot.h2 })
	local myId = shotId
	-- the receiver (or the bot) must answer before the ball is gone
	task.delay(0.05 + t1 + t2 + LATE, function()
		if shot and shot.id == myId then
			Pong.point(fromSide, nameOf(to) .. " missed")
		end
	end)
	if not sides[to] then
		-- bot: returns most balls, a moment after the bounce
		task.delay(0.05 + t1 + t2 * 0.6, function()
			if shot and shot.id == myId and not over then
				if rng:NextNumber() < BOT_RETURN then
					rally += 1
					best = math.max(best, rally)
					updateBoard()
					-- the bot stands at the receiving end (`to`), so the ball leaves from there
					launch(to, local2world(Vector3.new(rng:NextNumber(-2, 2), 2.6, dir * (LEN / 2 + 1.5))), 1)
				end
			end
		end)
	end
end

local function serve()
	if over or not folder then
		return
	end
	rally = 0
	updateBoard()
	local dir = if server == "A" then -1 else 1
	local origin = local2world(Vector3.new(0, 2.6, dir * (LEN / 2 + 1)))
	World.Moment:FireAllClients({ type = "pongServe", side = server, name = nameOf(server) })
	if sides[server] or not sides[other(server)] then
		-- a person serves with HIT (or, with nobody playing yet, the first HIT starts it); the ball waits at that end
		shot = { id = shotId + 1, to = server, serving = true, p0 = origin }
		shotId += 1
		World.Moment:FireAllClients({ type = "pongWait", pos = origin })
	else
		task.delay(1.2, function()
			if not over and folder then
				launch(server, origin, 1)
			end
		end)
	end
end

function Pong.point(winnerSide: string, why: string)
	shot = nil
	score[winnerSide] += 1
	World.Moment:FireAllClients({ type = "pongEnd" })
	World.toast(why .. " · point " .. nameOf(winnerSide))
	print(string.format("[Pong] %s · point %s · %d-%d · rally %d", why, nameOf(winnerSide), score.A, score.B, rally))
	updateBoard()
	if score[winnerSide] >= WIN_SCORE then
		over = true
		local finalScore = string.format("%d-%d", score.A, score.B)
		World.Moment:FireAllClients({ type = "winner", title = string.upper(nameOf(winnerSide)) .. " WINS PING PONG",
			mvp = finalScore .. " · best rally " .. best })
		local sceneId = workspace:GetAttribute("SceneId")
		Backend.gameResult({ game = "pingpong", round = roundId, winner = sides[winnerSide], loser = sides[other(winnerSide)],
			score = string.format("%d-%d", score[winnerSide], score[other(winnerSide)]), startedAt = startedAt })
		Stats.win(sides[winnerSide], "pingpong")
		if sceneId == "the-courts" then
			Stats.badge(sides[winnerSide], "court")
		end
		if type(sceneId) == "string" then
			Backend.sendEvent(sceneId, { type = "game", game = "pingpong", winner = nameOf(winnerSide), score = finalScore,
				bestRally = best })
		end
		return
	end
	-- serve changes every 2 points
	if (score.A + score.B) % 2 == 0 then
		server = other(server)
	end
	task.delay(1.5, serve)
end

-- Where the ball is on a shot right now (same arcs the clients draw).
local function ballAt(s: any, t: number): Vector3?
	if not s or s.serving then
		return if s then s.p0 else nil
	end
	local dt = t - s.t0
	if dt < 0 then
		return s.p0
	elseif dt <= s.t1 then
		local a = dt / s.t1
		return s.p0:Lerp(s.b, a) + Vector3.new(0, 4 * s.h1 * a * (1 - a), 0)
	elseif dt <= s.t1 + s.t2 + LATE then
		local a = math.min((dt - s.t1) / s.t2, 1.3)
		return s.b:Lerp(s.p2, a) + Vector3.new(0, 4 * s.h2 * a * (1 - a), 0)
	end
	return nil
end

local function onHit(player: Player)
	if over or not folder or not shot then
		return
	end
	local side = sideOf(player)
	if not side then
		return
	end
	-- claim an empty end
	if not sides[side] and sides[other(side)] ~= player then
		sides[side] = player
		World.toast(player.DisplayName .. " plays the " .. (if side == "A" then "near" else "far") .. " end")
		updateBoard()
	end
	-- nobody at the serving end: the bot there serves once a person has taken the other end
	if shot.serving and not sides[shot.to] and sides[other(shot.to)] == player then
		launch(shot.to, shot.p0, 1)
		return
	end
	if sides[side] ~= player or shot.to ~= side then
		return
	end
	local hrp = player.Character and player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	local t = now()
	local ball = ballAt(shot, t)
	if not hrp or not ball then
		return
	end
	if shot.serving then
		launch(side, ball, 1)
		return
	end
	-- only after the bounce, and within reach
	if t - shot.t0 < shot.t1 * 0.85 or (ball - hrp.Position).Magnitude > HIT_REACH then
		return
	end
	rally += 1
	best = math.max(best, rally)
	updateBoard()
	-- a hit right at the top of the bounce is a little faster
	local timing = 1 - math.abs(((t - shot.t0 - shot.t1) / shot.t2) - 0.5)
	launch(side, ball, 0.9 + timing * 0.3)
end

function Pong.remove()
	shot = nil
	if folder then
		folder:Destroy()
	end
	folder, scoreLabel = nil, nil
	World.Moment:FireAllClients({ type = "pongEnd" })
	workspace:SetAttribute("PongActive", false)
end

local function block(parent: Instance, name: string, size: Vector3, cf: CFrame, color: Color3, transparency: number?)
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored, p.CanTouch = true, false
	p.Size = size
	p.CFrame = cf
	p.Color = color
	p.Material = Enum.Material.SmoothPlastic
	p.Transparency = transparency or 0
	p.Parent = parent
	return p
end

-- centre: the table top centre in world space; yaw: direction of the long axis (side A at the back).
local lastPlace: any = nil

-- Rematch: the same game again in the same spot (Update 6 item 1).
function Pong.isActive(): boolean
	return lastPlace ~= nil and workspace:FindFirstChild("Room") ~= nil and workspace.Room:FindFirstChild("PingPong") ~= nil
end

function Pong.rematch()
	if lastPlace then
		Pong.place(table.unpack(lastPlace, 1, lastPlace.n))
	end
end

function Pong.place(centre: Vector3, yaw: number, length: number?, width: number?, visible: boolean?)
	lastPlace = table.pack(centre, yaw, length, width, visible)
	Pong.remove()
	local room = workspace:FindFirstChild("Room")
	if not room then
		return
	end
	LEN, WID = length or 14, width or 8
	tableCf = CFrame.new(centre) * CFrame.Angles(0, yaw, 0)
	local f = Instance.new("Folder")
	f.Name = "PingPong"
	f.Parent = room
	folder = f
	-- On a real table from the world (features), only draw the net and lines; otherwise build the whole table.
	if visible ~= false then
		block(f, "Top", Vector3.new(WID, 0.3, LEN), tableCf * CFrame.new(0, -0.15, 0), Color3.fromRGB(24, 74, 140))
		for _, x in { -WID / 2 + 0.4, WID / 2 - 0.4 } do
			for _, z in { -LEN / 2 + 0.6, LEN / 2 - 0.6 } do
				block(f, "Leg", Vector3.new(0.4, 2.6, 0.4), tableCf * CFrame.new(x, -1.6, z), Color3.fromRGB(40, 40, 46))
			end
		end
	end
	block(f, "Line", Vector3.new(0.12, 0.02, LEN), tableCf * CFrame.new(0, 0.02, 0), Color3.new(1, 1, 1))
	block(f, "Net", Vector3.new(WID + 0.6, 0.6, 0.08), tableCf * CFrame.new(0, 0.3, 0), Color3.fromRGB(235, 235, 235), 0.2)
	-- scoreboard over the net
	local sign = block(f, "Score", Vector3.one, tableCf * CFrame.new(0, 5, 0), Color3.new(), 1)
	sign.CanCollide, sign.CanQuery = false, false
	local gui = Theme.make("BillboardGui", { Size = UDim2.fromOffset(360, 84), AlwaysOnTop = true, LightInfluence = 0,
		MaxDistance = 200, Parent = sign })
	local card = Theme.make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg, BackgroundTransparency = 0.08,
		Parent = gui }, { Theme.corner(14), Theme.stroke(Theme.Accent, 1.5) })
	scoreLabel = Theme.label({ Text = "", FontFace = Theme.Heading, TextXAlignment = Enum.TextXAlignment.Center,
		Size = UDim2.new(1, -20, 1, -12), Position = UDim2.fromOffset(10, 6), MaxText = 26, Parent = card })
	sides, score, server, rally, over = { A = nil, B = nil }, { A = 0, B = 0 }, "A", 0, false
	roundId, startedAt = Backend.newRound("pingpong"), os.clock()
	updateBoard()
	World.toast("Ping pong: stand at an end of the table and press HIT")
	task.delay(2, serve)
end

-- features.pingPongTable: 4 top corners (studs) + height. Long axis = the longer pair of sides.
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
	local yaw = math.atan2(-long.X, -long.Z)
	Pong.place(centre, yaw, long.Magnitude, short.Magnitude, false)
	return true
end

function Pong.placeForRoom(host: Player?, features: any?, cameraLook: Vector3?)
	if features and placeFromFeature(features.pingPongTable) then
		return
	end
	local sceneId = workspace:GetAttribute("SceneId")
	local tuned = type(sceneId) == "string" and Config.PINGPONG_TABLES[sceneId]
	if tuned then
		Pong.place(Vector3.new(tuned.centre[1], tuned.centre[2], tuned.centre[3]), tuned.yaw or 0, tuned.length, tuned.width,
			tuned.visible)
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
	-- table top 2.9 studs up, its near end (side A) 6 studs in front of the host
	local centre = Vector3.new(hrp.Position.X, floorY + 2.9, hrp.Position.Z) + look * (6 + 7)
	Pong.place(centre, math.atan2(look.X, look.Z), 14, 8, true)
end

function Pong.start()
	PongHit.OnServerEvent:Connect(onHit)
	Players.PlayerRemoving:Connect(function(p)
		for s, q in sides do
			if q == p then
				sides[s] = nil
			end
		end
		updateBoard()
	end)
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		shot, folder, scoreLabel = nil, nil, nil
		workspace:SetAttribute("PongActive", false)
	end)
end

return Pong
