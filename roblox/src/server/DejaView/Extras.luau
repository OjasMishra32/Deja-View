-- Gemini labels, the "Hunt" round and notes in the room (team/shivin.md Update 4, items 2 and 3).
-- Labels and notes come in room metres; studs = metres * studsPerMeter, the same transform as the map.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TextService = game:GetService("TextService")
local HttpService = game:GetService("HttpService")
local Backend = require(script.Parent.Backend)
local Config = require(script.Parent.Config)
local MapBuilder = require(script.Parent.MapBuilder)
local World = require(script.Parent.World)
local Theme = require(ReplicatedStorage.Shared.Theme)

local LeaveNote = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("LeaveNote") :: RemoteEvent

local Extras = {}

local HUNT_RADIUS = 6 -- studs, horizontal
local HUNT_SECONDS = 120
local NOTE_MAX = 140
local NOTE_COOLDOWN = 5

local labels: { { label: string, blurb: string, pos: Vector3 } } = {}
local labelsScene: string? = nil
local notesShown: { [string]: BasePart } = {}
local filtered: { [string]: string } = {}
local lastNoteAt: { [Player]: number } = {}

local hunt = {
	active = false,
	endsAt = 0,
	found = {} :: { [Player]: { [number]: boolean } },
	round = 0,
}

local function spm(): number
	return (MapBuilder.current and MapBuilder.current.studsPerMeter) or 3.57
end

local function toStuds(o: any): Vector3?
	local x, y, z = tonumber(o.x), tonumber(o.y), tonumber(o.z)
	if not x or not y or not z then
		return nil
	end
	return Vector3.new(x, y, z) * spm()
end

local function anchorPart(name: string, pos: Vector3, parent: Instance): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored, p.CanCollide, p.CanQuery, p.CanTouch = true, false, false, false
	p.Transparency = 1
	p.Size = Vector3.one
	p.CFrame = CFrame.new(pos)
	p.Parent = parent
	return p
end

local function roomFolder(name: string): Folder?
	local room = workspace:FindFirstChild("Room")
	if not room then
		return nil
	end
	local f = room:FindFirstChild(name)
	if not f then
		f = Instance.new("Folder")
		f.Name = name
		f.Parent = room
	end
	return f :: Folder
end

-- Text typed by people must be filtered before other players see it. Outside text (the headset, Seb's map) is
-- filtered as if the experience owner sent it.
local function filter(text: string, fromUserId: number): string?
	local ok, result = pcall(function()
		local r = TextService:FilterStringAsync(text, fromUserId)
		return r:GetNonChatStringForBroadcastAsync()
	end)
	return if ok then result else nil
end

local function ownerId(): number
	if game.CreatorType == Enum.CreatorType.User and game.CreatorId ~= 0 then
		return game.CreatorId
	end
	local first = Players:GetPlayers()[1]
	return if first then first.UserId else 1
end

------------------------------------------------------------------ labels

local function buildLabels()
	local f = roomFolder("Labels")
	if not f then
		return
	end
	f:ClearAllChildren()
	for i, l in labels do
		local p = anchorPart("Label" .. i, l.pos, f)
		p:SetAttribute("Label", l.label)
		-- a small pill with the name only, seen from nearby and hidden behind walls, so labels never pile up
		local gui = Theme.make("BillboardGui", {
			Size = UDim2.fromOffset(168, 30),
			StudsOffset = Vector3.new(0, 1.0, 0),
			AlwaysOnTop = false,
			LightInfluence = 0,
			MaxDistance = 40,
			Parent = p,
		})
		local card = Theme.make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg,
			BackgroundTransparency = 0.25, Parent = gui }, { Theme.corner(15), Theme.stroke(Theme.Accent, 1) })
		Theme.label({ Name = "Title", Text = string.upper(l.label), FontFace = Theme.Heading, TextColor3 = Theme.Accent,
			Size = UDim2.new(1, -16, 1, -6), Position = UDim2.fromOffset(8, 3), MaxText = 16, Parent = card })
		-- a small lime dot marks the exact spot
		local dot = anchorPart("Dot", l.pos, p)
		dot.Shape = Enum.PartType.Ball
		dot.Size = Vector3.new(0.35, 0.35, 0.35)
		dot.Material = Enum.Material.Neon
		dot.Color = Theme.Accent
		dot.Transparency = 0.1
	end
	workspace:SetAttribute("LabelCount", #labels)
end

-- Whether `pos` (studs) lies on the room's chess board (Config.CHESS_BOARDS): the game starts its pieces afresh, so
-- labels the scan put on the pieces it saw there would point at the wrong ones.
local function onChessBoard(sceneId: string, pos: Vector3): boolean
	local b = Config.CHESS_BOARDS[sceneId]
	if type(b) ~= "table" or type(b.centre) ~= "table" or pos.Y > (b.centre[2] or 0) + 4 then
		return false -- not a piece: pieces stand under 4 studs (a giant king is 2.3)
	end
	local frame = CFrame.new(b.centre[1], 0, b.centre[3]) * CFrame.Angles(0, b.yaw or 0, 0)
	local rel = frame:PointToObjectSpace(Vector3.new(pos.X, 0, pos.Z))
	local half = (b.size or 32) / 2 + 0.5
	return math.abs(rel.X) <= half and math.abs(rel.Z) <= half
end

-- Whether `pos` is on the screen the chess game shows its turn on (a hand-built room's ChessScreen): a pill there
-- would hide the game.
local function onGameScreen(pos: Vector3): boolean
	local room = workspace:FindFirstChild("Room")
	local screen = room and room:FindFirstChild("ChessScreen", true)
	if not (screen and screen:IsA("BasePart")) then
		return false
	end
	return (pos - screen.Position).Magnitude <= math.max(screen.Size.X, screen.Size.Y) / 2 + 1
end

local function refreshLabels(sceneId: string): boolean
	local ok, res = Backend.hotspots(sceneId)
	if not ok or type(res) ~= "table" or type(res.hotspots) ~= "table" then
		return false
	end
	local fresh = {}
	for _, h in res.hotspots do
		local pos = type(h) == "table" and toStuds(h)
		if pos and not onChessBoard(sceneId, pos) and not onGameScreen(pos) then
			table.insert(fresh, { label = tostring(h.label or "?"), blurb = tostring(h.blurb or ""), pos = pos })
		end
	end
	local changed = #fresh ~= #labels or labelsScene ~= sceneId
	if not changed then
		for i, l in fresh do
			changed = changed or l.label ~= labels[i].label or (l.pos - labels[i].pos).Magnitude > 0.01
		end
	end
	if changed then
		labels, labelsScene = fresh, sceneId
		buildLabels()
	end
	return #fresh > 0
end

------------------------------------------------------------------ notes

local function showNote(n: any)
	local id = tostring(n.id or (tostring(n.author) .. tostring(n.text)))
	if notesShown[id] then
		return
	end
	local pos = toStuds(n)
	local f = roomFolder("Notes")
	if not pos or not f then
		return
	end
	local text = filtered[id]
	if not text then
		text = filter(tostring(n.text or ""):sub(1, NOTE_MAX), ownerId())
		if not text then
			return -- could not filter: never show unfiltered text
		end
		filtered[id] = text
	end
	local p = anchorPart("Note", pos, f)
	local gui = Theme.make("BillboardGui", {
		Size = UDim2.fromOffset(200, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		StudsOffset = Vector3.new(0, 0.6, 0),
		AlwaysOnTop = false,
		LightInfluence = 0,
		MaxDistance = 90,
		Parent = p,
	})
	-- a grey message bubble with the author on top
	local bubble = Theme.make("Frame", { Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = Color3.fromRGB(233, 233, 235), Parent = gui }, {
		Theme.corner(14),
		Theme.make("UIPadding", { PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10),
			PaddingTop = UDim.new(0, 6), PaddingBottom = UDim.new(0, 8) }),
		Theme.make("UIListLayout", { Padding = UDim.new(0, 2), SortOrder = Enum.SortOrder.LayoutOrder }),
	})
	Theme.make("TextLabel", { Text = tostring(n.author or "Someone"), FontFace = Theme.Heading, TextSize = 13,
		TextColor3 = Color3.fromRGB(110, 110, 118), BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 15),
		TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = 1, Parent = bubble })
	Theme.make("TextLabel", { Text = text, FontFace = Theme.Body, TextSize = 16, TextWrapped = true,
		TextColor3 = Color3.fromRGB(20, 20, 24), BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = 2,
		Parent = bubble })
	notesShown[id] = p
end

local function refreshNotes(sceneId: string)
	local ok, res = Backend.notes(sceneId)
	if not ok or type(res) ~= "table" or type(res.notes) ~= "table" then
		return
	end
	local seen = {}
	for _, n in res.notes do
		if type(n) == "table" then
			showNote(n)
			seen[tostring(n.id or (tostring(n.author) .. tostring(n.text)))] = true
		end
	end
	for id, part in notesShown do
		if not seen[id] and not part:GetAttribute("Local") then
			part:Destroy()
			notesShown[id] = nil
		end
	end
end

local function onLeaveNote(player: Player, text: any)
	if type(text) ~= "string" then
		return
	end
	text = text:gsub("^%s+", ""):gsub("%s+$", ""):sub(1, NOTE_MAX)
	if text == "" then
		return
	end
	if os.clock() - (lastNoteAt[player] or -NOTE_COOLDOWN) < NOTE_COOLDOWN then
		World.toast("One note every few seconds", player)
		return
	end
	lastNoteAt[player] = os.clock()
	local sceneId = workspace:GetAttribute("SceneId")
	local hrp = player.Character and player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if type(sceneId) ~= "string" or sceneId == "" or not hrp or World.where(player) ~= "room" then
		World.toast("Walk into a room to leave a note", player)
		return
	end
	local clean = filter(text, player.UserId)
	if not clean then
		World.toast("Couldn't check that note, try again", player)
		return
	end
	local pos = (hrp.Position + Vector3.new(0, 2, 0)) / spm()
	local body = { author = string.sub(player.DisplayName, 1, 40), text = clean, x = pos.X, y = pos.Y, z = pos.Z }
	task.spawn(function()
		local ok, res = Backend.addNote(sceneId, body)
		if not ok then
			World.toast("Notes are offline", player)
			-- still show it here, so the player sees where it would be
			local localNote = table.clone(body)
			localNote.id = "local-" .. HttpService:GenerateGUID(false)
			filtered[localNote.id] = clean
			showNote(localNote)
			local part = notesShown[localNote.id]
			if part then
				part:SetAttribute("Local", true)
			end
			return
		end
		if type(res) == "table" and res.id then
			filtered[tostring(res.id)] = clean
		end
		refreshNotes(sceneId)
		World.toast("Note left · the headset can see it", player)
	end)
end

------------------------------------------------------------------ hunt

local function publishHunt()
	local rows = {}
	for p, set in hunt.found do
		if p.Parent then
			local n = 0
			for _ in set do
				n += 1
			end
			table.insert(rows, { name = p.DisplayName, found = n })
		end
	end
	table.sort(rows, function(a, b)
		return a.found > b.found
	end)
	workspace:SetAttribute("HuntJson", HttpService:JSONEncode({ total = #labels, rows = rows }))
end

function Extras.huntActive(): boolean
	return hunt.active
end

function Extras.endHunt(winner: Player?)
	if not hunt.active then
		return
	end
	hunt.active = false
	hunt.round += 1
	workspace:SetAttribute("RoundState", "ended")
	workspace:SetAttribute("RoundEndsAt", 0)
	World.Moment:FireAllClients({
		type = "winner",
		title = if winner then string.upper(winner.DisplayName) .. " FOUND THEM ALL" else "TIME'S UP",
		mvp = if winner then "Hunt · " .. #labels .. " labels" else "Nobody found every label",
	})
	local myRound = hunt.round
	task.delay(5, function()
		if hunt.round == myRound and not hunt.active then
			workspace:SetAttribute("RoundState", "idle")
		end
	end)
end

function Extras.startHunt(by: Player?): boolean
	if hunt.active then
		return false
	end
	if #labels == 0 then
		World.toast("No labels in this room yet", by)
		return false
	end
	local players = World.inRoom()
	if #players == 0 then
		World.toast("Nobody is in the room yet: press JOIN", by)
		return false
	end
	hunt.active = true
	hunt.round += 1
	hunt.found = {}
	for _, p in players do
		hunt.found[p] = {}
	end
	hunt.endsAt = workspace:GetServerTimeNow() + HUNT_SECONDS
	workspace:SetAttribute("RoundState", "hunt")
	workspace:SetAttribute("RoundEndsAt", hunt.endsAt)
	World.Moment:FireAllClients({ type = "countdown", seconds = 3, text = "HUNT: TOUCH EVERY LABEL" })
	publishHunt()
	return true
end

local function checkHunt()
	if not hunt.active then
		return
	end
	if workspace:GetServerTimeNow() >= hunt.endsAt then
		Extras.endHunt(nil)
		return
	end
	local sceneId = workspace:GetAttribute("SceneId")
	for _, p in World.inRoom() do
		hunt.found[p] = hunt.found[p] or {}
		local hrp = p.Character and p.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
		if hrp then
			local set = hunt.found[p]
			for i, l in labels do
				local d = Vector3.new(hrp.Position.X - l.pos.X, 0, hrp.Position.Z - l.pos.Z).Magnitude
				if not set[i] and d <= HUNT_RADIUS then
					set[i] = true
					local n = 0
					for _ in set do
						n += 1
					end
					World.Moment:FireAllClients({ type = "found", userId = p.UserId, name = p.DisplayName,
						label = l.label, index = i, found = n, total = #labels })
					if type(sceneId) == "string" then
						Backend.sendEvent(sceneId, { type = "hunt", by = "rbx-" .. p.UserId, found = n,
							total = #labels, label = l.label, name = p.DisplayName })
					end
					publishHunt()
					if n >= #labels then
						Extras.endHunt(p)
						return
					end
				end
			end
		end
	end
end

------------------------------------------------------------------ loops

function Extras.start()
	LeaveNote.OnServerEvent:Connect(onLeaveNote)
	Players.PlayerRemoving:Connect(function(p)
		lastNoteAt[p] = nil
		hunt.found[p] = nil
	end)
	-- A new room: drop the old labels and notes and stop any hunt.
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		labels, labelsScene = {}, nil
		notesShown, filtered = {}, {}
		workspace:SetAttribute("LabelCount", 0)
		if hunt.active then
			hunt.active = false
			workspace:SetAttribute("RoundState", "idle")
		end
	end)
	-- Labels: every 15 s until a room has some, then every 60 s. Notes: every 2 s (Update 4).
	task.spawn(function()
		local nextLabels = 0
		while true do
			task.wait(2)
			local sceneId = workspace:GetAttribute("SceneId")
			if workspace:GetAttribute("Phase") == "room" and type(sceneId) == "string" and sceneId ~= "" then
				pcall(function()
					if os.clock() >= nextLabels or labelsScene ~= sceneId then
						local has = refreshLabels(sceneId)
						nextLabels = os.clock() + (if has then 60 else 15)
					end
					refreshNotes(sceneId)
				end)
			end
		end
	end)
	task.spawn(function()
		while true do
			task.wait(0.2)
			local ok, err = pcall(checkHunt)
			if not ok then
				warn("[DejaView] hunt check:", err)
			end
		end
	end)
end

return Extras
