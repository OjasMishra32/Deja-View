-- Giant chess on the floor of the room (team/shivin.md Update 5, item 3). Click or tap a piece to see its legal moves,
-- then a highlighted square to move. The first player to touch a white piece plays white, likewise black.
-- Placement: the server's features.chessBoard when /model sends it, else Config.CHESS_BOARDS for the scene, else the
-- host drops a board in front of them (host bar: CHESS).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local World = require(script.Parent.World)
local Theme = require(ReplicatedStorage.Shared.Theme)
local R = require(ReplicatedStorage.Shared.ChessRules)

local Chess = {}

-- Roblox's fonts have no chess symbols (they render as empty boxes), so pieces carry bold letters; pawns stay plain.
local GLYPH = { K = "K", Q = "Q", R = "R", B = "B", N = "N", P = "" }
local HEIGHT = { K = 4.4, Q = 4, R = 3, B = 3.2, N = 3, P = 2.2 }
local LIGHT, DARK = Color3.fromRGB(226, 220, 206), Color3.fromRGB(58, 58, 68)
local WHITE, BLACK = Color3.fromRGB(244, 244, 245), Color3.fromRGB(28, 28, 34)

local folder: Folder? = nil
local origin = CFrame.new() -- centre of the board, Y = board top, -Z towards black
local square = 4 -- studs per square
local state: R.State = R.new()
local pieces: { [number]: Model } = {}
local seats: { [string]: Player? } = { w = nil, b = nil }
local selected: { [Player]: number } = {}
local over = false
local lastMove = ""
local turnLabel: TextLabel? = nil

-- Square index -> world CFrame at the square's top centre. a1 is at the near-left corner, seen from white's side.
local function squareCFrame(sq: number): CFrame
	local f, r = sq % 8, sq // 8
	return origin * CFrame.new((f - 3.5) * square, 0, (3.5 - r) * square)
end

local function sendTargets(player: Player, list: { number })
	World.Moment:FireClient(player, { type = "chessTargets", squares = list })
end

local function clearSelection(player: Player?)
	if player then
		selected[player] = nil
		sendTargets(player, {})
	else
		for p in selected do
			sendTargets(p, {})
		end
		selected = {}
	end
end

local function updateTurnBoard()
	if not turnLabel then
		return
	end
	local function who(c: string): string
		local p = seats[c]
		return if p then p.DisplayName else "tap a " .. (if c == "w" then "white" else "black") .. " piece to play"
	end
	local status = R.status(state)
	local side = if state.turn == "w" then "WHITE" else "BLACK"
	if status == "checkmate" then
		turnLabel.Text = "CHECKMATE · " .. (if state.turn == "w" then "BLACK" else "WHITE") .. " WINS"
	elseif status == "stalemate" then
		turnLabel.Text = "STALEMATE · DRAW"
	else
		turnLabel.Text = side .. " TO MOVE" .. (if status == "check" then " · CHECK" else "") .. "\n" .. who(state.turn)
			.. (if lastMove ~= "" then "  ·  last " .. lastMove else "")
	end
end

local onPieceClicked: (Player, number) -> ()
local onSquareClicked: (Player, number) -> ()

local function buildPiece(sq: number, p: string)
	local c, kind = string.sub(p, 1, 1), string.sub(p, 2, 2)
	local h = HEIGHT[kind] * (square / 4)
	local model = Instance.new("Model")
	model.Name = p
	local body = Instance.new("Part")
	body.Name = "Body"
	body.Shape = Enum.PartType.Cylinder
	body.Size = Vector3.new(h, square * 0.62, square * 0.62)
	body.CFrame = squareCFrame(sq) * CFrame.new(0, h / 2, 0) * CFrame.Angles(0, 0, math.pi / 2)
	body.Color = if c == "w" then WHITE else BLACK
	body.Material = Enum.Material.SmoothPlastic
	body.Anchored, body.CanCollide, body.CanTouch = true, false, false
	body.Parent = model
	local cap = Instance.new("Part")
	cap.Name = "Cap"
	cap.Shape = Enum.PartType.Ball
	cap.Size = Vector3.new(square * 0.5, square * 0.5, square * 0.5)
	cap.CFrame = squareCFrame(sq) * CFrame.new(0, h, 0)
	cap.Color = body.Color
	cap.Material = Enum.Material.SmoothPlastic
	cap.Anchored, cap.CanCollide, cap.CanTouch = true, false, false
	cap.Parent = model
	local gui = Theme.make("BillboardGui", {
		Size = UDim2.fromScale(square * 0.7, square * 0.7),
		StudsOffset = Vector3.new(0, square * 0.55, 0),
		LightInfluence = 0,
		MaxDistance = 160,
		Adornee = cap,
		Parent = cap,
	})
	Theme.make("TextLabel", { Size = UDim2.fromScale(1, 1), BackgroundTransparency = 1, Text = GLYPH[kind],
		TextScaled = true, FontFace = Theme.Heading, TextColor3 = if c == "w" then WHITE else BLACK,
		TextStrokeColor3 = if c == "w" then BLACK else WHITE, TextStrokeTransparency = 0, Parent = gui })
	for _, part in { body, cap } do
		local cd = Instance.new("ClickDetector")
		cd.MaxActivationDistance = 400
		cd.Parent = part
		cd.MouseClick:Connect(function(player)
			-- a click on a piece is a selection, or a capture when the player already holds a piece
			local held = selected[player]
			if held and held ~= sq and string.sub(p, 1, 1) ~= string.sub(state.board[held] or "", 1, 1) then
				onSquareClicked(player, sq)
			else
				onPieceClicked(player, sq)
			end
		end)
	end
	model.Parent = folder
	pieces[sq] = model
end

local function syncPieces()
	for sq, m in pieces do
		m:Destroy()
		pieces[sq] = nil
	end
	for sq = 0, 63 do
		local p = state.board[sq]
		if p then
			buildPiece(sq, p)
		end
	end
end

local function finish(status: string)
	over = true
	local sceneId = workspace:GetAttribute("SceneId")
	local winnerColour = if status == "checkmate" then R.other(state.turn) else nil
	local winnerPlayer: Player? = if winnerColour then seats[winnerColour] else nil
	local winnerName = if winnerPlayer then (winnerPlayer :: Player).DisplayName
		elseif winnerColour then (if winnerColour == "w" then "White" else "Black")
		else "draw"
	local score = if winnerColour == "w" then "1-0" elseif winnerColour == "b" then "0-1" else "1/2-1/2"
	World.Moment:FireAllClients({
		type = "winner",
		title = if winnerColour then "CHECKMATE" else "STALEMATE",
		mvp = if winnerColour then string.upper(winnerName) .. " WINS · " .. score else "Draw · " .. score,
	})
	if type(sceneId) == "string" then
		Backend.sendEvent(sceneId, { type = "game", game = "chess", winner = winnerName, score = score,
			white = seats.w and seats.w.DisplayName or nil, black = seats.b and seats.b.DisplayName or nil })
	end
end

onPieceClicked = function(player: Player, sq: number)
	if over then
		World.toast("Game over · host can start a new board", player)
		return
	end
	local p = state.board[sq]
	if not p then
		return
	end
	local c = string.sub(p, 1, 1)
	if not seats[c] and seats[R.other(c)] ~= player then
		seats[c] = player
		World.toast(player.DisplayName .. " plays " .. (if c == "w" then "white" else "black"))
		updateTurnBoard()
	end
	local owner = seats[c]
	if owner ~= player then
		World.toast("That's " .. (if owner then owner.DisplayName else "someone else") .. "'s side", player)
		return
	end
	if c ~= state.turn then
		World.toast("Wait for your turn", player)
		return
	end
	local moves = R.legalFrom(state, sq)
	selected[player] = sq
	local targets = {}
	for _, m in moves do
		table.insert(targets, m.to)
	end
	if #targets == 0 then
		World.toast("That piece can't move", player)
	end
	sendTargets(player, targets)
end

onSquareClicked = function(player: Player, sq: number)
	local from = selected[player]
	if not from or over then
		return
	end
	for _, m in R.legalFrom(state, from) do
		if m.to == sq then
			local piece = state.board[from] :: string
			state = R.apply(state, m)
			lastMove = R.name(from) .. "→" .. R.name(sq)
			clearSelection(nil)
			syncPieces()
			local status = R.status(state)
			updateTurnBoard()
			local sceneId = workspace:GetAttribute("SceneId")
			if type(sceneId) == "string" then
				Backend.sendEvent(sceneId, { type = "chess", move = lastMove, piece = piece, by = "rbx-" .. player.UserId,
					status = status })
			end
			if status == "check" then
				World.toast("CHECK")
			elseif status == "checkmate" or status == "stalemate" then
				finish(status)
			end
			return
		end
	end
	-- not a legal target: drop the selection
	clearSelection(player)
end

function Chess.remove()
	if folder then
		folder:Destroy()
	end
	folder, turnLabel = nil, nil
	pieces = {}
	clearSelection(nil)
	workspace:SetAttribute("ChessActive", false)
end

-- Builds a fresh game. centre: board centre at floor height; yaw: direction white looks (0 faces -Z).
function Chess.place(centre: Vector3, yaw: number, size: number?)
	Chess.remove()
	local room = workspace:FindFirstChild("Room")
	if not room then
		return
	end
	square = (size or 32) / 8
	origin = CFrame.new(centre + Vector3.new(0, 0.2, 0)) * CFrame.Angles(0, yaw, 0)
	state, seats, over, lastMove = R.new(), { w = nil, b = nil }, false, ""
	local f = Instance.new("Folder")
	f.Name = "Chess"
	f.Parent = room
	folder = f
	for sq = 0, 63 do
		local part = Instance.new("Part")
		part.Name = "Sq" .. sq
		part.Size = Vector3.new(square, 0.4, square)
		part.CFrame = squareCFrame(sq) * CFrame.new(0, -0.2, 0)
		part.Color = if (sq % 8 + sq // 8) % 2 == 0 then DARK else LIGHT
		part.Material = Enum.Material.SmoothPlastic
		part.Anchored, part.CanTouch = true, false
		part:SetAttribute("Square", sq)
		part.Parent = f
		local cd = Instance.new("ClickDetector")
		cd.MaxActivationDistance = 400
		cd.Parent = part
		cd.MouseClick:Connect(function(player)
			onSquareClicked(player, sq)
		end)
	end
	-- turn board floating above black's side
	local sign = Instance.new("Part")
	sign.Name = "TurnBoard"
	sign.Anchored, sign.CanCollide, sign.CanQuery, sign.CanTouch = true, false, false, false
	sign.Transparency = 1
	sign.Size = Vector3.one
	sign.CFrame = origin * CFrame.new(0, square * 3, -square * 5)
	sign.Parent = f
	local gui = Theme.make("BillboardGui", { Size = UDim2.fromOffset(420, 96), AlwaysOnTop = true, LightInfluence = 0,
		MaxDistance = 220, Parent = sign })
	local card = Theme.make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg, BackgroundTransparency = 0.08,
		Parent = gui }, { Theme.corner(14), Theme.stroke(Theme.Accent, 1.5) })
	turnLabel = Theme.label({ Text = "", FontFace = Theme.Heading, TextXAlignment = Enum.TextXAlignment.Center,
		Size = UDim2.new(1, -20, 1, -12), Position = UDim2.fromOffset(10, 6), MaxText = 28, Parent = card })
	syncPieces()
	updateTurnBoard()
	workspace:SetAttribute("ChessActive", true)
end

-- Board from features.chessBoard: 4 corners (studs) with the a1 corner named. Accepts {corners=[[x,y,z]x4], a1=index}.
local function placeFromFeature(fb: any): boolean
	if type(fb) ~= "table" or type(fb.corners) ~= "table" or #fb.corners < 4 then
		return false
	end
	local pts = {}
	for i = 1, 4 do
		local c = fb.corners[i]
		pts[i] = Vector3.new(c[1] or c.x, c[2] or c.y, c[3] or c.z)
	end
	local a1 = tonumber(fb.a1) or 1
	local centre = (pts[1] + pts[2] + pts[3] + pts[4]) / 4
	-- white sits behind a1; white looks from a1 towards the board centre
	local a1p = pts[a1]
	local toCentre = Vector3.new(centre.X - a1p.X, 0, centre.Z - a1p.Z)
	local side = (pts[1] - pts[2]).Magnitude
	-- a1 -> centre is 45 degrees left of white's forward direction
	local forward = CFrame.Angles(0, -math.pi / 4, 0):VectorToWorldSpace(toCentre.Unit)
	Chess.place(centre, math.atan2(-forward.X, -forward.Z), side)
	return true
end

-- Host: put a board in this room (server features > hand-tuned table > in front of the host).
function Chess.placeForRoom(host: Player?, features: any?, cameraLook: Vector3?)
	local sceneId = workspace:GetAttribute("SceneId")
	if features and placeFromFeature(features.chessBoard) then
		return
	end
	local tuned = type(sceneId) == "string" and Config.CHESS_BOARDS[sceneId]
	if tuned then
		Chess.place(Vector3.new(tuned.centre[1], tuned.centre[2], tuned.centre[3]), tuned.yaw or 0, tuned.size)
		return
	end
	local hrp = host and host.Character and host.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not hrp then
		World.toast("Walk into the room first", host)
		return
	end
	-- In front of where the host is looking (their camera), so the board appears in view.
	local dir = if typeof(cameraLook) == "Vector3" then cameraLook else hrp.CFrame.LookVector
	local flat = Vector3.new(dir.X, 0, dir.Z)
	local look = if flat.Magnitude > 0.01 then flat.Unit else Vector3.new(0, 0, -1)
	local spot = hrp.Position + look * 24
	-- The host stands on the floor: use their feet height (a ray from above can land on a tower top instead).
	local hum = (hrp.Parent :: Model):FindFirstChildOfClass("Humanoid")
	local floorY = hrp.Position.Y - ((hum and hum.HipHeight or 2) + hrp.Size.Y / 2)
	-- white faces away from the host, so the host stands on white's side
	Chess.place(Vector3.new(spot.X, floorY, spot.Z), math.atan2(-look.X, -look.Z), 32)
end

function Chess.start()
	Players.PlayerRemoving:Connect(function(p)
		selected[p] = nil
		for c, s in seats do
			if s == p then
				seats[c] = nil
			end
		end
		updateTurnBoard()
	end)
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		folder, turnLabel, pieces = nil, nil, {}
		selected = {}
		workspace:SetAttribute("ChessActive", false)
	end)
end

return Chess
