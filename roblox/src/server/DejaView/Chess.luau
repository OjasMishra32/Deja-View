-- Giant chess on the floor of the room (team/shivin.md Update 5, item 3). Click or tap a piece to see its legal moves,
-- then a highlighted square to move. The first player to touch a white piece plays white, likewise black; someone
-- alone plays the bot (ChessBot), and a second player takes the bot's side over by touching one of its pieces.
-- Every game starts from the opening position.
-- Placement: the server's features.chessBoard when /model sends it, else Config.CHESS_BOARDS for the scene, else the
-- host drops a board in front of them (host bar: CHESS). A board marked `auto` is placed as soon as its room loads.
-- In a hand-built room (Config.BUILT_ROOMS) the board is the real mat at its real size with giant pieces, and the
-- game shows on the room's TV (a part named ChessScreen) when it has one.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Config = require(script.Parent.Config)
local Backend = require(script.Parent.Backend)
local World = require(script.Parent.World)
local ChessPieces = require(script.Parent.ChessPieces)
local Theme = require(ReplicatedStorage.Shared.Theme)
local R = require(ReplicatedStorage.Shared.ChessRules)
local ChessBot = require(ReplicatedStorage.Shared.ChessBot)
local Stats = require(script.Parent.Stats)

local Chess = {}

-- Pieces carry bold letters in scanned rooms, where a small piece is hard to make out; pawns stay plain.
local GLYPH = { K = "K", Q = "Q", R = "R", B = "B", N = "N", P = "" }
local LIGHT, DARK = Color3.fromRGB(226, 220, 206), Color3.fromRGB(58, 58, 68)
-- the real mat's interlocking rubber tiles
local MAT_LIGHT, MAT_DARK = Color3.fromRGB(232, 232, 228), Color3.fromRGB(30, 30, 32)
local WHITE, BLACK = Color3.fromRGB(244, 244, 245), Color3.fromRGB(28, 28, 34)
local BOT_DELAY = 1.2 -- seconds the bot waits before it moves

local folder: Folder? = nil
local origin = CFrame.new() -- centre of the board, Y = board top, -Z towards black
local square = 4 -- studs per square
local drawn = false -- a hand-built room: the real mat and giant pieces at real proportions
local state: R.State = R.new()
local pieces: { [number]: Model } = {}
local seats: { [string]: Player? } = { w = nil, b = nil }
local selected: { [Player]: number } = {}
local over = false
local roundId = ""
local startedAt = 0
local lastMove = ""
local turnLabel: TextLabel? = nil
local screenGui: SurfaceGui? = nil
local lastMarks: { BasePart } = {}
local botTurn = 0 -- bumped on every move and seat change, so a bot move planned for an older position is dropped
local hidden: { [BasePart]: { number } } = {} -- world blocks cleared away for the board: {transparency, collide}

-- Clears world blocks that poke up into the board area (a voxel world is rarely flat), so the board is visible
-- and walkable; restored when the board goes away.
local function clearArea(centre: CFrame, size: number)
	local room = workspace:FindFirstChild("Room")
	if not room then
		return
	end
	local params = OverlapParams.new()
	params.FilterType = Enum.RaycastFilterType.Include
	params.FilterDescendantsInstances = { room }
	local box = Vector3.new(size + square * 2, 14, size + square * 4)
	for _, part in workspace:GetPartBoundsInBox(centre * CFrame.new(0, 7.1, 0), box, params) do
		if part:IsA("BasePart") and not part:IsDescendantOf(folder :: any) and not hidden[part]
			and part.Parent and part.Parent.Name ~= "Bounds" then
			hidden[part] = { part.Transparency, if part.CanCollide then 1 else 0 }
			part.Transparency = 1
			part.CanCollide = false
		end
	end
end

local function restoreArea()
	for part, saved in hidden do
		if part.Parent then
			part.Transparency = saved[1]
			part.CanCollide = saved[2] == 1
		end
	end
	hidden = {}
end

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

-- The colour the bot plays: the empty seat while exactly one player is seated.
local function botSide(): string?
	if over then
		return nil
	end
	if seats.w and not seats.b then
		return "b"
	elseif seats.b and not seats.w then
		return "w"
	end
	return nil
end

local function updateTurnBoard()
	if not turnLabel then
		return
	end
	local function who(c: string): string
		local p = seats[c]
		if p then
			return p.DisplayName
		elseif botSide() == c then
			return "Bot  (tap a " .. (if c == "w" then "white" else "black") .. " piece to take over)"
		end
		return "tap a " .. (if c == "w" then "white" else "black") .. " piece to play"
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
	local kind = string.sub(p, 2, 2)
	-- real proportions on the real mat; shorter on a big host-placed board, where a real king would tower
	local model = ChessPieces.build(p, squareCFrame(sq), square * (if drawn then 1 else 0.65))
	model:SetAttribute("Square", sq)
	local top = model:FindFirstChild("Top") :: BasePart?
	if not drawn and top and GLYPH[kind] ~= "" then
		local c = string.sub(p, 1, 1)
		local gui = Theme.make("BillboardGui", {
			Size = UDim2.fromScale(square * 0.7, square * 0.7),
			StudsOffset = Vector3.new(0, square * 0.55, 0),
			LightInfluence = 0,
			MaxDistance = 160,
			Adornee = top,
			Parent = top,
		})
		Theme.make("TextLabel", { Size = UDim2.fromScale(1, 1), BackgroundTransparency = 1, Text = GLYPH[kind],
			TextScaled = true, FontFace = Theme.Heading, TextColor3 = if c == "w" then WHITE else BLACK,
			TextStrokeColor3 = if c == "w" then BLACK else WHITE, TextStrokeTransparency = 0, Parent = gui })
	end
	local cd = Instance.new("ClickDetector")
	cd.MaxActivationDistance = 400
	cd.Parent = model
	cd.MouseClick:Connect(function(player)
		-- the piece's square now (it may have moved since it was built)
		local at = model:GetAttribute("Square")
		if type(at) ~= "number" then
			return
		end
		-- a click on a piece is a selection, or a capture when the player already holds a piece
		local held = selected[player]
		if held and held ~= at and string.sub(model.Name, 1, 1) ~= string.sub(state.board[held] or "", 1, 1) then
			onSquareClicked(player, at)
		else
			onPieceClicked(player, at)
		end
	end)
	model.Parent = folder
	pieces[sq] = model
end

-- Makes the pieces on the board match the game: removes the ones that are gone (or changed, a promoted pawn) and
-- builds the missing ones.
local function reconcile()
	for sq, m in pieces do
		if state.board[sq] ~= m.Name then
			m:Destroy()
			pieces[sq] = nil
		end
	end
	for sq = 0, 63 do
		local p = state.board[sq]
		if p and not pieces[sq] then
			buildPiece(sq, p)
		end
	end
end

-- Slides a piece to its new square with a little hop.
local function glide(model: Model, sq: number)
	local from, to = model:GetPivot(), squareCFrame(sq)
	local hop = square * 0.5
	task.spawn(function()
		local t0 = os.clock()
		while model.Parent do
			local a = math.min(1, (os.clock() - t0) / 0.35)
			local e = a * a * (3 - 2 * a)
			model:PivotTo(from:Lerp(to, e) + Vector3.new(0, math.sin(math.pi * a) * hop, 0))
			if a >= 1 then
				break
			end
			RunService.Heartbeat:Wait()
		end
	end)
end

local function movePiece(from: number, to: number)
	local m = pieces[from]
	pieces[from] = nil
	if pieces[to] then
		pieces[to]:Destroy()
	end
	pieces[to] = m
	if m then
		m:SetAttribute("Square", to)
		glide(m, to)
	end
end

-- Tints the last move's two squares for everyone, so the bot's (or the other player's) move is easy to follow.
local function markLastMove(from: number, to: number)
	for _, mark in lastMarks do
		mark:Destroy()
	end
	lastMarks = {}
	for _, sq in { from, to } do
		local mark = Instance.new("Part")
		mark.Name = "LastMove"
		mark.Anchored, mark.CanCollide, mark.CanQuery, mark.CanTouch = true, false, false, false
		mark.Material = Enum.Material.SmoothPlastic
		mark.Color = Color3.fromRGB(240, 200, 60)
		mark.Transparency = 0.55
		mark.CastShadow = false
		mark.Size = Vector3.new(square * 0.98, 0.02, square * 0.98)
		mark.CFrame = squareCFrame(sq) * CFrame.new(0, 0.011, 0)
		mark.Parent = folder
		table.insert(lastMarks, mark)
	end
end

local function finish(status: string)
	over = true
	local sceneId = workspace:GetAttribute("SceneId")
	local winnerColour = if status == "checkmate" then R.other(state.turn) else nil
	local winnerPlayer: Player? = if winnerColour then seats[winnerColour] else nil
	local winnerName = if winnerPlayer then (winnerPlayer :: Player).DisplayName
		elseif winnerColour and seats[R.other(winnerColour)] then "Bot"
		elseif winnerColour then (if winnerColour == "w" then "White" else "Black")
		else "draw"
	local score = if winnerColour == "w" then "1-0" elseif winnerColour == "b" then "0-1" else "1/2-1/2"
	Backend.gameResult({ game = "chess", round = roundId, startedAt = startedAt,
		winner = if winnerColour then seats[winnerColour] else seats.w,
		loser = if winnerColour then seats[R.other(winnerColour)] else seats.b,
		score = if winnerColour then "1-0" else "draw", draw = winnerColour == nil })
	if winnerPlayer then
		Stats.win(winnerPlayer, "chess")
		Stats.badge(winnerPlayer, "checkmate")
	end
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

local scheduleBot: () -> ()

-- Plays a legal move `m` for the side to move (`by` names who: "rbx-<id>" or "bot").
local function play(m: R.Move, by: string)
	local from, to = m.from, m.to
	local piece = state.board[from] :: string
	state = R.apply(state, m)
	lastMove = R.name(from) .. "→" .. R.name(to)
	clearSelection(nil)
	movePiece(from, to)
	if m.castle then
		-- the rook comes round the king
		local rookFrom = if m.castle == "K" then from + 3 else from - 4
		movePiece(rookFrom, if m.castle == "K" then from + 1 else from - 1)
	end
	reconcile() -- en passant captures and promotions
	markLastMove(from, to)
	local status = R.status(state)
	updateTurnBoard()
	print("[DejaView] chess", piece, lastMove, "by", by, status)
	local sceneId = workspace:GetAttribute("SceneId")
	if type(sceneId) == "string" then
		Backend.sendEvent(sceneId, { type = "chess", move = lastMove, piece = piece, by = by, status = status })
	end
	if status == "check" then
		World.toast("CHECK")
	elseif status == "checkmate" or status == "stalemate" then
		finish(status)
	end
	scheduleBot()
end

-- When the side to move is the bot's, it moves after a short pause (if nothing changed in the meantime).
scheduleBot = function()
	botTurn += 1
	local token = botTurn
	if botSide() ~= state.turn then
		return
	end
	task.delay(BOT_DELAY, function()
		if token ~= botTurn or folder == nil or botSide() ~= state.turn then
			return
		end
		local m = ChessBot.choose(R, state)
		if m then
			play(m, "bot")
		end
	end)
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
		local fromBot = botSide() == c
		seats[c] = player
		World.toast(player.DisplayName .. (if fromBot then " takes over " else " plays ")
			.. (if c == "w" then "white" else "black"))
		updateTurnBoard()
		scheduleBot() -- the other side may be the bot's now, or no longer
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
			play(m, "rbx-" .. player.UserId)
			return
		end
	end
	-- not a legal target: drop the selection
	clearSelection(player)
end

function Chess.remove()
	restoreArea()
	if folder then
		folder:Destroy()
	end
	if screenGui then
		screenGui:Destroy()
	end
	folder, turnLabel, screenGui = nil, nil, nil
	pieces, lastMarks = {}, {}
	botTurn += 1
	clearSelection(nil)
	workspace:SetAttribute("ChessActive", false)
end

-- Builds a fresh game. centre: board centre at floor height; yaw: direction white looks (0 faces -Z).
local lastPlace: any = nil

-- Rematch: the same game again in the same spot (Update 6 item 1).
function Chess.isActive(): boolean
	return lastPlace ~= nil and workspace:FindFirstChild("Room") ~= nil and workspace.Room:FindFirstChild("Chess") ~= nil
end

function Chess.rematch()
	if lastPlace then
		Chess.place(table.unpack(lastPlace, 1, lastPlace.n))
	end
end

-- The game on the room's TV: a full-screen card with the turn, the players and the last move.
local function showOnScreen(screen: BasePart): TextLabel
	local gui = Theme.make("SurfaceGui", { Face = Enum.NormalId.Front, SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud,
		PixelsPerStud = 90, LightInfluence = 0, Brightness = 1.3, Parent = screen })
	screenGui = gui
	local card = Theme.make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg, BorderSizePixel = 0, Parent = gui })
	Theme.label({ Text = "GIANT CHESS", FontFace = Theme.Heading, TextColor3 = Theme.Accent,
		TextXAlignment = Enum.TextXAlignment.Center, Size = UDim2.new(1, -40, 0.22, 0), Position = UDim2.new(0, 20, 0.06, 0),
		MaxText = 60, Parent = card })
	return Theme.label({ Text = "", FontFace = Theme.Heading, TextXAlignment = Enum.TextXAlignment.Center,
		Size = UDim2.new(1, -40, 0.6, 0), Position = UDim2.new(0, 20, 0.32, 0), MaxText = 44, Parent = card })
end

function Chess.place(centre: Vector3, yaw: number, size: number?)
	lastPlace = table.pack(centre, yaw, size)
	Chess.remove()
	local room = workspace:FindFirstChild("Room")
	if not room then
		return
	end
	local sceneId = workspace:GetAttribute("SceneId")
	drawn = type(sceneId) == "string" and (Config.BUILT_ROOMS[sceneId] == true or Config.SPHERE_ROOMS[sceneId] == true)
	square = (size or 32) / 8
	-- the real mat is a few centimetres of rubber on the floor; a placed board is a thick slab sunk into the world
	local thick = if drawn then 0.1 else 0.4
	origin = CFrame.new(centre + Vector3.new(0, if drawn then thick else 0.2, 0)) * CFrame.Angles(0, yaw, 0)
	state, seats, over, lastMove = R.new(), { w = nil, b = nil }, false, ""
	roundId, startedAt = Backend.newRound("chess"), os.clock()
	local f = Instance.new("Folder")
	f.Name = "Chess"
	f.Parent = room
	folder = f
	for sq = 0, 63 do
		local part = Instance.new("Part")
		part.Name = "Sq" .. sq
		part.Size = Vector3.new(square, thick, square)
		part.CFrame = squareCFrame(sq) * CFrame.new(0, -thick / 2, 0)
		local dark = (sq % 8 + sq // 8) % 2 == 0
		if drawn then
			part.Color = if dark then MAT_DARK else MAT_LIGHT
			part.Material = Enum.Material.Plastic
		else
			part.Color = if dark then DARK else LIGHT
			part.Material = Enum.Material.SmoothPlastic
		end
		part.Anchored, part.CanTouch = true, false
		part.CastShadow = false
		part:SetAttribute("Square", sq)
		part.Parent = f
		local cd = Instance.new("ClickDetector")
		cd.MaxActivationDistance = 400
		cd.Parent = part
		cd.MouseClick:Connect(function(player)
			onSquareClicked(player, sq)
		end)
	end
	local screen = drawn and room:FindFirstChild("ChessScreen", true)
	if screen and screen:IsA("BasePart") then
		turnLabel = showOnScreen(screen)
	else
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
	end
	if not drawn then
		-- a hand-built room has nothing in the way; a scanned one is rarely flat
		clearArea(origin, square * 8)
	end
	reconcile()
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
	local centre = (pts[1] + pts[2] + pts[3] + pts[4]) / 4
	local side = tonumber(fb.size) or (pts[1] - pts[2]).Magnitude
	local forward: Vector3
	local wf = fb.whiteForward
	if type(wf) == "table" then
		-- the server says which way white looks (contract 6.6)
		forward = Vector3.new(wf[1] or wf.x or 0, 0, wf[3] or wf.z or 0).Unit
	else
		-- white sits behind a1 and looks from a1 towards the centre, turned 45 degrees right (a1 is white's left)
		local a1p = pts[tonumber(fb.a1) or 1]
		local toCentre = Vector3.new(centre.X - a1p.X, 0, centre.Z - a1p.Z).Unit
		forward = CFrame.Angles(0, math.pi / 4, 0):VectorToWorldSpace(toCentre)
	end
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
		scheduleBot() -- the one left plays the bot
	end)
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		-- the old room (and this board) is torn down with it; never carry a board into another room
		folder, turnLabel, screenGui, pieces, hidden, lastMarks = nil, nil, nil, {}, {}, {}
		selected = {}
		botTurn += 1
		workspace:SetAttribute("ChessActive", false)
	end)
	-- rooms whose real board is part of the room get it (in the opening position) as soon as they load
	workspace:GetAttributeChangedSignal("Phase"):Connect(function()
		local sceneId = workspace:GetAttribute("SceneId")
		local tuned = type(sceneId) == "string" and Config.CHESS_BOARDS[sceneId]
		if workspace:GetAttribute("Phase") ~= "room" or not (tuned and tuned.auto) then
			return
		end
		task.delay(1, function()
			if folder == nil and workspace:GetAttribute("SceneId") == sceneId and workspace:GetAttribute("Phase") == "room" then
				Chess.placeForRoom(nil, nil, nil)
			end
		end)
	end)
end

return Chess
