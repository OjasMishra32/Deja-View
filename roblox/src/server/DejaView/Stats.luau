-- Hall of fame and badges (team/shivin.md Update 6, items 2 and 3). Wins per player per game live in DataStores so
-- they last across sessions; the lobby shows the top 5 of each game. Badges are in-game: a card pops up the first time
-- a player earns one, and the set is saved with their stats. Without DataStore access (Studio with API access off)
-- everything still works for the session.
local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local World = require(script.Parent.World)
local Theme = require(ReplicatedStorage.Shared.Theme)

local Stats = {}

Stats.GAMES = { "tag", "chess", "pingpong", "foosball", "hideseek", "lava", "cooking", "pool" }
local GAME_TITLE = { tag = "TAG", chess = "CHESS", pingpong = "PING PONG", foosball = "FOOSBALL", hideseek = "HIDE & SEEK",
	lava = "FLOOR IS LAVA", cooking = "COOKING", pool = "POOL" }

Stats.BADGES = {
	memory = "Walked into a memory",
	judge = "Tag with the judge",
	checkmate = "Checkmate",
	court = "21 at the Game Lawn",
}

local profileStore: DataStore? = nil
local winStores: { [string]: OrderedDataStore } = {}
local online = true

local profiles: { [number]: any } = {} -- userId -> { name, wins = {}, badges = {} }
local sessionWins: { [string]: { [number]: number } } = {} -- fallback when DataStores are off
local names: { [number]: string } = {}
local board: Frame? = nil

local function init()
	local ok = pcall(function()
		profileStore = DataStoreService:GetDataStore("DejaViewProfiles")
		for _, g in Stats.GAMES do
			winStores[g] = DataStoreService:GetOrderedDataStore("DejaViewWins_" .. g)
		end
	end)
	online = ok
	for _, g in Stats.GAMES do
		sessionWins[g] = {}
	end
end

local function save(userId: number)
	local data = profiles[userId]
	if not data or not online or not profileStore then
		return
	end
	task.spawn(pcall, function()
		(profileStore :: DataStore):SetAsync("u" .. userId, data)
	end)
end

local function load(player: Player)
	-- A profile exists at once, so badges and wins never wait on the DataStore (it can hang, e.g. in Studio).
	local data = { name = player.DisplayName, wins = {}, badges = {} }
	profiles[player.UserId] = data
	names[player.UserId] = player.DisplayName
	local fetched, saved = false, nil
	if online and profileStore then
		task.spawn(function()
			local ok, res = pcall(function()
				return (profileStore :: DataStore):GetAsync("u" .. player.UserId)
			end)
			if ok then
				saved = res
			else
				online = false -- no DataStore access: stay in session mode
			end
			fetched = true
		end)
	else
		fetched = true
	end
	-- wait briefly for saved data, then merge it in (wins and badges are unions)
	local t0 = os.clock()
	while not fetched and os.clock() - t0 < 5 do
		task.wait(0.2)
	end
	if type(saved) == "table" then
		for k, v in saved.wins or {} do
			data.wins[k] = math.max(data.wins[k] or 0, v)
		end
		for k, v in saved.badges or {} do
			data.badges[k] = data.badges[k] or v
		end
		data.seenIntro = saved.seenIntro
	end
	print("[Stats] profile", player.DisplayName, if type(saved) == "table" then "loaded" elseif fetched then "new" else "not loaded (timeout)")
	-- First-join controls card (Update 6 item 5), once per player
	if not data.seenIntro and player.Parent then
		data.seenIntro = os.time()
		save(player.UserId)
		print("[Stats] controls card ->", player.DisplayName, "(saved stats:", online, ")")
		World.Moment:FireClient(player, { type = "intro" })
	end
end

local function nameFor(userId: number): string
	if names[userId] then
		return names[userId]
	end
	local ok, n = pcall(Players.GetNameFromUserIdAsync, Players, userId)
	names[userId] = if ok and n then n else ("Player " .. userId)
	return names[userId]
end

local function topFive(gameKey: string): { { name: string, wins: number } }
	local rows = {}
	if online and winStores[gameKey] then
		local ok, pages = pcall(function()
			return winStores[gameKey]:GetSortedAsync(false, 5)
		end)
		if ok and pages then
			for _, entry in pages:GetCurrentPage() do
				table.insert(rows, { name = nameFor(tonumber(entry.key) or 0), wins = entry.value })
			end
			return rows
		end
	end
	for userId, wins in sessionWins[gameKey] do
		table.insert(rows, { name = nameFor(userId), wins = wins })
	end
	table.sort(rows, function(a, b)
		return a.wins > b.wins
	end)
	while #rows > 5 do
		table.remove(rows)
	end
	return rows
end

function Stats.refreshBoard()
	if not board then
		return
	end
	task.spawn(function()
		for _, g in Stats.GAMES do
			local col = (board :: Frame):FindFirstChild(g)
			if col then
				local rows = topFive(g)
				for i = 1, 5 do
					local label = col:FindFirstChild("Row" .. i) :: TextLabel?
					if label then
						local r = rows[i]
						label.Text = if r then string.format("%d. %s · %d", i, r.name, r.wins) else ""
					end
				end
			end
		end
	end)
end

-- A win for a real player in one of Stats.GAMES.
function Stats.win(player: Player?, gameKey: string)
	if not player or not player.Parent or not sessionWins[gameKey] then
		return
	end
	local id = player.UserId
	sessionWins[gameKey][id] = (sessionWins[gameKey][id] or 0) + 1
	local data = profiles[id]
	if data then
		data.wins[gameKey] = (data.wins[gameKey] or 0) + 1
		save(id)
	end
	if online and winStores[gameKey] then
		task.spawn(pcall, function()
			winStores[gameKey]:IncrementAsync(tostring(id), 1)
		end)
	end
	task.delay(1, Stats.refreshBoard)
end

-- Awards an in-game badge once per player (shows a card on their screen).
function Stats.badge(player: Player?, key: string)
	if not player or not player.Parent or not Stats.BADGES[key] then
		return
	end
	local data = profiles[player.UserId]
	if not data or data.badges[key] then
		return
	end
	data.badges[key] = os.time()
	save(player.UserId)
	print("[Stats] badge", key, "->", player.DisplayName)
	World.Moment:FireClient(player, { type = "badge", title = Stats.BADGES[key] })
end

local function buildBoard()
	local lobby = workspace:WaitForChild("Lobby", 30)
	if not lobby then
		return
	end
	local c = (lobby :: Model):GetPivot().Position
	local part = Instance.new("Part")
	part.Name = "HallOfFame"
	part.Anchored = true
	part.Size = Vector3.new(1, 16, 46)
	part.Color = Theme.Surface
	part.Material = Enum.Material.SmoothPlastic
	-- flat against the lobby's left wall (thin along X), its Right face looking into the room
	part.CFrame = CFrame.new(c.X - 39.4, c.Y + 9, c.Z)
	part.Parent = lobby
	local sg = Theme.make("SurfaceGui", { Face = Enum.NormalId.Right, SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud,
		PixelsPerStud = 24, LightInfluence = 0, Parent = part })
	local root = Theme.make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg, Parent = sg },
		{ Theme.make("UIPadding", { PaddingLeft = UDim.new(0, 24), PaddingRight = UDim.new(0, 24), PaddingTop = UDim.new(0, 18) }) })
	Theme.label({ Text = "HALL OF FAME", FontFace = Theme.Heading, TextColor3 = Theme.Accent, Size = UDim2.new(1, 0, 0, 56),
		MaxText = 56, Parent = root })
	local grid = Theme.make("Frame", { BackgroundTransparency = 1, Position = UDim2.new(0, 0, 0, 70), Size = UDim2.new(1, 0, 1, -90),
		Parent = root }, { Theme.make("UIGridLayout", { CellSize = UDim2.new(0.117, 0, 1, 0), CellPadding = UDim2.new(0.009, 0, 0, 0),
		SortOrder = Enum.SortOrder.LayoutOrder }) })
	for i, g in Stats.GAMES do
		local col = Theme.make("Frame", { Name = g, BackgroundColor3 = Theme.Surface, LayoutOrder = i, Parent = grid },
			{ Theme.corner(14), Theme.make("UIPadding", { PaddingLeft = UDim.new(0, 12), PaddingTop = UDim.new(0, 10) }),
			  Theme.make("UIListLayout", { Padding = UDim.new(0, 6), SortOrder = Enum.SortOrder.LayoutOrder }) })
		Theme.label({ Text = GAME_TITLE[g], FontFace = Theme.Heading, Size = UDim2.new(1, -12, 0, 36), MaxText = 30,
			LayoutOrder = 0, Parent = col })
		for r = 1, 5 do
			Theme.label({ Name = "Row" .. r, Text = "", TextColor3 = if r == 1 then Theme.Accent else Theme.Text,
				Size = UDim2.new(1, -12, 0, 30), MaxText = 24, LayoutOrder = r, Parent = col })
		end
	end
	board = root
	Stats.refreshBoard()
end

function Stats.start()
	init()
	Players.PlayerAdded:Connect(load)
	for _, p in Players:GetPlayers() do
		task.spawn(load, p)
	end
	Players.PlayerRemoving:Connect(function(p)
		save(p.UserId)
		profiles[p.UserId] = nil
	end)
	task.spawn(buildBoard)
	task.spawn(function()
		while true do
			task.wait(60)
			Stats.refreshBoard()
		end
	end)
end

return Stats
