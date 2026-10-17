-- Lobby, player locations (lobby vs room), host checks and the Moment remote.
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(script.Parent.Config)
local MapBuilder = require(script.Parent.MapBuilder)
local Theme = require(ReplicatedStorage.Shared.Theme)

local World = {}

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
World.Moment = Remotes:WaitForChild("Moment") :: RemoteEvent

local firstPlayer: Player? = nil
local lobbySpawn: SpawnLocation? = nil

function World.toast(text: string, target: Player?)
	if target then
		World.Moment:FireClient(target, { type = "toast", text = text })
	else
		World.Moment:FireAllClients({ type = "toast", text = text })
	end
end

function World.isHost(player: Player): boolean
	if table.find(Config.HOST_USER_IDS, player.UserId) then
		return true
	end
	if game.CreatorType == Enum.CreatorType.User and player.UserId == game.CreatorId then
		return true
	end
	if game.CreatorType == Enum.CreatorType.Group then
		local ok, rank = pcall(player.GetRankInGroup, player, game.CreatorId)
		if ok and rank >= 255 then
			return true
		end
	end
	return (RunService:IsStudio() or game.CreatorId == 0) and player == firstPlayer
end

function World.where(player: Player): string
	return player:GetAttribute("Where") or "lobby"
end

function World.inRoom(): { Player }
	local list = {}
	for _, p in Players:GetPlayers() do
		if World.where(p) == "room" then
			table.insert(list, p)
		end
	end
	return list
end

local function setAnchored(character: Model?, anchored: boolean)
	local hrp = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if hrp then
		hrp.Anchored = anchored
	end
end
World.setAnchored = setAnchored

function World.toLobby(player: Player)
	player:SetAttribute("Where", "lobby")
	local character = player.Character
	if character and lobbySpawn then
		setAnchored(character, false)
		character:PivotTo(lobbySpawn.CFrame + Vector3.new(math.random(-6, 6), 4, math.random(-2, 2)))
	end
end

-- Moves players into the built room around spawn.
function World.toRoom(list: { Player })
	for i, player in list do
		player:SetAttribute("Where", "room")
		local character = player.Character
		if character and MapBuilder.current then
			MapBuilder.place(character, i)
			setAnchored(character, workspace:GetAttribute("Phase") ~= "room")
		end
	end
end

-- Hold everyone in the room in place while a new room builds.
function World.holdRoomPlayers(anchored: boolean)
	for _, p in World.inRoom() do
		setAnchored(p.Character, anchored)
	end
end

local function buildLobby()
	local c = Config.LOBBY_CENTER
	local lobby = Instance.new("Model")
	lobby.Name = "Lobby"
	local function part(name, size, pos, color, material, props)
		local p = Instance.new("Part")
		p.Name = name
		p.Anchored = true
		p.Size = size
		p.CFrame = CFrame.new(c + pos)
		p.Color = color
		p.Material = material or Enum.Material.SmoothPlastic
		p.TopSurface, p.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
		for k, v in props or {} do
			(p :: any)[k] = v
		end
		p.Parent = lobby
		return p
	end
	part("Floor", Vector3.new(80, 2, 70), Vector3.new(0, -1, 0), Theme.Bg)
	part("Trim", Vector3.new(80, 0.2, 0.6), Vector3.new(0, 0.1, -20), Theme.Accent, Enum.Material.Neon)
	for _, side in { -1, 1 } do
		part("Wall", Vector3.new(2, 30, 70), Vector3.new(side * 41, 15, 0), Theme.Surface)
	end
	part("Back", Vector3.new(80, 30, 2), Vector3.new(0, 15, 36), Theme.Surface)
	part("Front", Vector3.new(80, 30, 2), Vector3.new(0, 15, -36), Theme.Surface)
	part("Roof", Vector3.new(84, 2, 74), Vector3.new(0, 31, 0), Theme.Bg, nil, { Transparency = 0.2 })
	-- The board faces +Z (towards the spawn). The client puts a SurfaceGui on it.
	local board = part("Board", Vector3.new(44, 22, 1), Vector3.new(0, 13, -30), Theme.Surface)
	board.CFrame = CFrame.new(c + Vector3.new(0, 13, -30)) * CFrame.Angles(0, math.pi, 0)
	local light = Instance.new("PointLight")
	light.Color = Theme.Accent
	light.Range = 40
	light.Brightness = 1
	light.Parent = board

	local spawn = Instance.new("SpawnLocation")
	spawn.Name = "LobbySpawn"
	spawn.Anchored = true
	spawn.Size = Vector3.new(10, 1, 10)
	spawn.CFrame = CFrame.new(c + Vector3.new(0, 0.5, 12))
	spawn.Color = Theme.Accent
	spawn.Material = Enum.Material.Neon
	spawn.Transparency = 0.6
	spawn.Duration = 0
	spawn.Neutral = true
	spawn.Parent = lobby
	lobbySpawn = spawn

	-- Remove the template Baseplate/SpawnLocation if the place still has them.
	for _, name in { "Baseplate", "SpawnLocation" } do
		local x = workspace:FindFirstChild(name)
		if x and x:IsA("BasePart") then
			x:Destroy()
		end
	end
	lobby.Parent = workspace
end

local function onCharacter(player: Player, character: Model)
	local hum = character:WaitForChild("Humanoid") :: Humanoid
	hum.WalkSpeed = Config.WALK_SPEED
	task.defer(function()
		if World.where(player) == "room" and MapBuilder.current and not player:GetAttribute("Out") then
			MapBuilder.place(character, math.random(1, 9))
			setAnchored(character, workspace:GetAttribute("Phase") ~= "room")
		else
			if World.where(player) ~= "room" then
				player:SetAttribute("Where", "lobby")
			end
		end
	end)
end

function World.init()
	buildLobby()
	local function added(player: Player)
		firstPlayer = firstPlayer or player
		player:SetAttribute("Where", "lobby")
		player:SetAttribute("IsHost", World.isHost(player))
		player.CharacterAdded:Connect(function(ch)
			onCharacter(player, ch)
		end)
		if player.Character then
			onCharacter(player, player.Character)
		end
	end
	Players.PlayerAdded:Connect(added)
	for _, p in Players:GetPlayers() do
		added(p)
	end
	Players.PlayerRemoving:Connect(function(player)
		if player == firstPlayer then
			firstPlayer = Players:GetPlayers()[1]
			if firstPlayer == player then
				firstPlayer = Players:GetPlayers()[2]
			end
			for _, p in Players:GetPlayers() do
				p:SetAttribute("IsHost", World.isHost(p))
			end
		end
	end)

	-- Fall guard: anyone below the room falls back to spawn; lobby fallers back to the lobby.
	task.spawn(function()
		while true do
			task.wait(0.5)
			for _, p in Players:GetPlayers() do
				local ch = p.Character
				local hrp = ch and ch:FindFirstChild("HumanoidRootPart") :: BasePart?
				if hrp and not hrp.Anchored then
					local y = hrp.Position.Y
					if World.where(p) == "room" and not p:GetAttribute("Out") then
						if y < Config.FALL_Y then
							MapBuilder.place(ch :: Model, 1)
						end
					elseif y < Config.LOBBY_CENTER.Y - 20 then
						World.toLobby(p)
					end
				end
			end
		end
	end)
end

return World
