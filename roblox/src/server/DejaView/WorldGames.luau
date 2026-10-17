-- A game per world (team/shivin.md Update 9, item 2), each playable in any room:
--   hide and seek (the apartment): the judge seeks (or a random player), the rest hide, then get found.
--   floor is lava (Tilted Towers): when the floor turns to lava, anyone standing on it is out; last ones standing win.
--   cooking rush (the kitchen): ingredients appear on the real counters; carry them to the stove before time runs out.
-- Shared: RoundState = "game", RoundEndsAt for the timer, GameJson for the scoreboard, a winner card at the end and
-- {type:"game", game, winner, score} sent to the server.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Backend = require(script.Parent.Backend)
local MapBuilder = require(script.Parent.MapBuilder)
local Presence = require(script.Parent.Presence)
local Stats = require(script.Parent.Stats)
local World = require(script.Parent.World)
local Interp = require(ReplicatedStorage.Shared.Interp)
local Theme = require(ReplicatedStorage.Shared.Theme)

local WorldGames = {}

local current: string? = nil -- "hideseek" | "lava" | "cooking"
local round = 0
local folder: Folder? = nil

local function now(): number
	return workspace:GetServerTimeNow()
end

local function hrpOf(p: Player): BasePart?
	return p.Character and p.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
end

local function publish(title: string, rows: { { name: string, right: string, hi: boolean? } })
	workspace:SetAttribute("GameJson", HttpService:JSONEncode({ title = title, rows = rows }))
end

local function gameFolder(): Folder?
	local room = workspace:FindFirstChild("Room")
	if not room then
		return nil
	end
	local f = Instance.new("Folder")
	f.Name = "WorldGame"
	f.Parent = room
	return f
end

function WorldGames.active(): boolean
	return current ~= nil
end

function WorldGames.stop()
	round += 1
	current = nil
	if folder then
		folder:Destroy()
		folder = nil
	end
	for _, p in Players:GetPlayers() do
		local hrp = hrpOf(p)
		if hrp and hrp.Anchored and World.where(p) == "room" then
			hrp.Anchored = false
		end
	end
	World.Moment:FireAllClients({ type = "blind", on = false })
	if workspace:GetAttribute("RoundState") == "game" then
		workspace:SetAttribute("RoundState", "idle")
	end
	workspace:SetAttribute("RoundEndsAt", 0)
end

local function finish(gameKey: string, title: string, sub: string, winners: { Player }, score: string, winnerName: string)
	local myRound = round
	current = nil
	workspace:SetAttribute("RoundState", "ended")
	workspace:SetAttribute("RoundEndsAt", 0)
	World.Moment:FireAllClients({ type = "blind", on = false })
	World.Moment:FireAllClients({ type = "winner", title = title, mvp = sub })
	for _, p in winners do
		Stats.win(p, gameKey)
	end
	local sceneId = workspace:GetAttribute("SceneId")
	if type(sceneId) == "string" then
		Backend.sendEvent(sceneId, { type = "game", game = gameKey, winner = winnerName, score = score })
	end
	task.delay(5, function()
		if round == myRound then
			WorldGames.stop()
		end
	end)
end

local function begin(key: string, seconds: number): number
	WorldGames.stop()
	round += 1
	current = key
	folder = gameFolder()
	workspace:SetAttribute("RoundState", "game")
	workspace:SetAttribute("RoundEndsAt", now() + seconds)
	return round
end

------------------------------------------------------------------ hide and seek

local HIDE_SECONDS, SEEK_SECONDS, CATCH = 20, 90, 5

function WorldGames.hideAndSeek(by: Player?): boolean
	local players = World.inRoom()
	local vr = Presence.vr()
	if #players < (if vr then 1 else 2) then
		World.toast("Hide and seek needs " .. (if vr then "someone in the room" else "two players (or the judge)"), by)
		return false
	end
	local seeker: Player? = nil
	if not vr then
		seeker = players[math.random(1, #players)]
	end
	local hiders = {}
	for _, p in players do
		if p ~= seeker then
			hiders[p] = false -- not found yet
		end
	end
	local my = begin("hideseek", HIDE_SECONDS + SEEK_SECONDS)
	local seekerName = if seeker then seeker.DisplayName else (if vr then vr.name else "Judge")
	World.Moment:FireAllClients({ type = "countdown", seconds = 3, text = "HIDE! " .. string.upper(seekerName) .. " SEEKS" })
	if seeker then
		local hrp = hrpOf(seeker)
		if hrp then
			hrp.Anchored = true
		end
		World.Moment:FireClient(seeker, { type = "blind", on = true, text = "Count to " .. HIDE_SECONDS .. "… they're hiding" })
	end
	local function rows()
		local r = {}
		for p, found in hiders do
			table.insert(r, { name = p.DisplayName, right = if found then "FOUND" else "hiding", hi = not found })
		end
		return r
	end
	publish("HIDE & SEEK · " .. string.upper(seekerName), rows())
	task.spawn(function()
		task.wait(HIDE_SECONDS)
		if round ~= my then
			return
		end
		if seeker then
			local hrp = hrpOf(seeker)
			if hrp then
				hrp.Anchored = false
			end
			World.Moment:FireClient(seeker, { type = "blind", on = false })
		end
		World.Moment:FireAllClients({ type = "toast", text = string.upper(seekerName) .. " IS COMING" })
		local endsAt = now() + SEEK_SECONDS
		while round == my and now() < endsAt do
			task.wait(0.2)
			-- seeker positions: a Roblox seeker's root, or the headset's hands and feet
			local points = {}
			if seeker then
				local hrp = hrpOf(seeker)
				if hrp then
					table.insert(points, hrp.Position)
				end
			elseif vr then
				local t = now()
				local s = Interp.sample(vr.buf, t - Interp.DELAY, t)
				if s then
					table.insert(points, s.pos + Vector3.new(0, 3, 0))
					for _, h in { s.hl, s.hr } do
						if h then
							table.insert(points, h)
						end
					end
				end
			end
			local left = 0
			for p, found in hiders do
				local hrp = hrpOf(p)
				if not found and hrp and p.Parent then
					for _, pt in points do
						if (pt - hrp.Position).Magnitude <= CATCH then
							hiders[p] = true
							found = true
							World.Moment:FireAllClients({ type = "toast", text = string.upper(p.DisplayName) .. " WAS FOUND" })
							publish("HIDE & SEEK · " .. string.upper(seekerName), rows())
							break
						end
					end
				end
				if not found and p.Parent then
					left += 1
				end
			end
			if left == 0 then
				local n = 0
				for _ in hiders do
					n += 1
				end
				finish("hideseek", string.upper(seekerName) .. " FOUND EVERYONE", "in " .. math.floor(SEEK_SECONDS - (endsAt - now())) .. " s",
					if seeker then { seeker } else {}, n .. "/" .. n, seekerName)
				return
			end
		end
		if round ~= my then
			return
		end
		local survivors, total, found = {}, 0, 0
		for p, f in hiders do
			total += 1
			if f then
				found += 1
			elseif p.Parent then
				table.insert(survivors, p)
			end
		end
		local names = {}
		for _, p in survivors do
			table.insert(names, p.DisplayName)
		end
		finish("hideseek", "THE HIDERS WIN", table.concat(names, ", ") .. " stayed hidden", survivors, found .. "/" .. total,
			table.concat(names, ", "))
	end)
	return true
end

------------------------------------------------------------------ floor is lava

local LAVA_CYCLES = { { warn = 6, lava = 8 }, { warn = 5, lava = 10 }, { warn = 4, lava = 12 }, { warn = 3, lava = 14 } }

function WorldGames.lava(by: Player?): boolean
	local info = MapBuilder.current
	local players = World.inRoom()
	if not info or #players == 0 then
		World.toast("Walk into a room first", by)
		return false
	end
	local total = 0
	for _, c in LAVA_CYCLES do
		total += c.warn + c.lava
	end
	local my = begin("lava", total + 3)
	local floorY = info.spawn.Y
	local mn, mx = info.walkMin or info.boundsMin, info.walkMax or info.boundsMax
	local slab = Instance.new("Part")
	slab.Name = "Lava"
	slab.Anchored, slab.CanCollide, slab.CanQuery, slab.CanTouch = true, false, false, false
	slab.Material = Enum.Material.Neon
	slab.Color = Color3.fromRGB(255, 90, 30)
	slab.Size = Vector3.new(mx.X - mn.X, 0.5, mx.Z - mn.Z)
	slab.CFrame = CFrame.new((mn.X + mx.X) / 2, floorY + 0.3, (mn.Z + mx.Z) / 2)
	slab.Transparency = 1
	slab.Parent = folder
	Theme.make("PointLight", { Color = slab.Color, Range = 20, Brightness = 0, Parent = slab })
	local alive: { [Player]: boolean } = {}
	for _, p in players do
		alive[p] = true
	end
	local function rows()
		local r = {}
		for p, a in alive do
			table.insert(r, { name = p.DisplayName, right = if a then "ALIVE" else "OUT", hi = a })
		end
		return r
	end
	publish("FLOOR IS LAVA", rows())
	World.Moment:FireAllClients({ type = "countdown", seconds = 3, text = "FLOOR IS LAVA · GET OFF THE FLOOR" })
	task.spawn(function()
		task.wait(3)
		for i, c in LAVA_CYCLES do
			if round ~= my then
				return
			end
			-- warning: the floor glows
			World.Moment:FireAllClients({ type = "toast", text = "LAVA IN " .. c.warn .. " · CLIMB!" })
			slab.Transparency = 0.75
			task.wait(c.warn)
			if round ~= my then
				return
			end
			slab.Transparency = 0.15
			(slab:FindFirstChildOfClass("PointLight") :: PointLight).Brightness = 3
			local lavaEnds = os.clock() + c.lava
			while os.clock() < lavaEnds and round == my do
				task.wait(0.15)
				for p, a in alive do
					if a and p.Parent then
						local ch = p.Character
						local hrp = hrpOf(p)
						local hum = ch and ch:FindFirstChildOfClass("Humanoid")
						if hrp and hum then
							local feetY = hrp.Position.Y - (hum.HipHeight + hrp.Size.Y / 2)
							local onGround = hum.FloorMaterial ~= Enum.Material.Air
							if onGround and feetY < floorY + 1.0 then
								alive[p] = false
								World.Moment:FireAllClients({ type = "tagged", userId = p.UserId, name = p.DisplayName,
									pos = hrp.Position, lives = 0 })
								publish("FLOOR IS LAVA", rows())
							end
						end
					end
				end
			end
			slab.Transparency = 1
			(slab:FindFirstChildOfClass("PointLight") :: PointLight).Brightness = 0
			local left = 0
			for _, a in alive do
				if a then
					left += 1
				end
			end
			if left <= (if #players > 1 then 1 else 0) or i == #LAVA_CYCLES then
				break
			end
		end
		if round ~= my then
			return
		end
		local winners, names = {}, {}
		for p, a in alive do
			if a and p.Parent then
				table.insert(winners, p)
				table.insert(names, p.DisplayName)
			end
		end
		finish("lava", if #winners > 0 then "STILL STANDING" else "THE LAVA WINS",
			if #winners > 0 then table.concat(names, ", ") else "Nobody made it", winners,
			#winners .. "/" .. #players, if #winners > 0 then table.concat(names, ", ") else "lava")
	end)
	return true
end

------------------------------------------------------------------ cooking rush

local COOK_SECONDS = 90
local INGREDIENTS = {
	{ "TOMATO", Color3.fromRGB(230, 60, 50) },
	{ "EGG", Color3.fromRGB(250, 245, 230) },
	{ "CHEESE", Color3.fromRGB(250, 200, 60) },
	{ "LETTUCE", Color3.fromRGB(110, 200, 90) },
	{ "BREAD", Color3.fromRGB(210, 160, 100) },
}

-- Counter tops: points 2.2 to 4.8 studs above the floor where a ray from above lands on an upward-facing surface.
local function counterSpots(info: any): { Vector3 }
	local room = workspace:FindFirstChild("Room")
	local spots, floorSpots = {}, {}
	if not room then
		return spots
	end
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Include
	params.FilterDescendantsInstances = { room }
	local mn, mx = info.walkMin or info.boundsMin, info.walkMax or info.boundsMax
	local floorY = info.spawn.Y
	local top = math.min(info.ceilingY, floorY + 14)
	for x = mn.X + 2, mx.X - 2, 3 do
		for z = mn.Z + 2, mx.Z - 2, 3 do
			local hit = workspace:Raycast(Vector3.new(x, top, z), Vector3.new(0, -(top - floorY + 2), 0), params)
			if hit and hit.Normal.Y > 0.8 then
				local h = hit.Position.Y - floorY
				if h >= 2.2 and h <= 4.8 then
					table.insert(spots, hit.Position)
				elseif h < 0.6 then
					table.insert(floorSpots, hit.Position)
				end
			end
		end
	end
	if #spots < 6 then
		-- no real counters found: fall back to the floor
		for _, p in floorSpots do
			table.insert(spots, p)
		end
	end
	return spots
end

function WorldGames.cooking(by: Player?): boolean
	local info = MapBuilder.current
	local players = World.inRoom()
	if not info or #players == 0 then
		World.toast("Walk into a room first", by)
		return false
	end
	local spots = counterSpots(info)
	if #spots < 4 then
		World.toast("No room to cook here", by)
		return false
	end
	local my = begin("cooking", COOK_SECONDS + 3)
	local f = folder :: Folder
	-- the stove: the spot nearest the room's middle
	local centre = (info.spawn + Vector3.new(0, 0, 0))
	table.sort(spots, function(a, b)
		return (a - centre).Magnitude < (b - centre).Magnitude
	end)
	local stovePos = spots[1]
	local stove = Instance.new("Part")
	stove.Name = "Stove"
	stove.Anchored, stove.CanCollide, stove.CanQuery, stove.CanTouch = true, false, false, false
	stove.Shape = Enum.PartType.Cylinder
	stove.Size = Vector3.new(0.3, 5, 5)
	stove.CFrame = CFrame.new(stovePos + Vector3.new(0, 0.2, 0)) * CFrame.Angles(0, 0, math.pi / 2)
	stove.Material = Enum.Material.Neon
	stove.Color = Color3.fromRGB(255, 120, 40)
	stove.Transparency = 0.3
	stove.Parent = f
	local sgui = Theme.make("BillboardGui", { Size = UDim2.fromOffset(160, 44), StudsOffset = Vector3.new(0, 3, 0),
		AlwaysOnTop = true, LightInfluence = 0, MaxDistance = 160, Parent = stove })
	Theme.label({ Text = "STOVE", FontFace = Theme.Heading, TextColor3 = Color3.fromRGB(255, 140, 60),
		TextXAlignment = Enum.TextXAlignment.Center, TextStrokeTransparency = 0.3, Size = UDim2.fromScale(1, 1),
		MaxText = 34, Parent = sgui })
	local scores: { [Player]: number } = {}
	for _, p in players do
		scores[p] = 0
	end
	local carrying: { [Player]: BasePart } = {}
	local function rows()
		local r = {}
		for p, n in scores do
			table.insert(r, { name = p.DisplayName, right = tostring(n) .. " cooked", hi = n > 0 })
		end
		table.sort(r, function(a, b)
			return a.right > b.right
		end)
		return r
	end
	publish("COOKING RUSH", rows())
	local function spawnIngredient()
		if round ~= my then
			return
		end
		local spot = spots[math.random(2, #spots)]
		local kind = INGREDIENTS[math.random(1, #INGREDIENTS)]
		local item = Instance.new("Part")
		item.Name = kind[1]
		item.Shape = Enum.PartType.Ball
		item.Size = Vector3.new(1.4, 1.4, 1.4)
		item.Color = kind[2]
		item.Material = Enum.Material.SmoothPlastic
		item.Anchored, item.CanCollide, item.CanTouch = true, false, false
		item.CFrame = CFrame.new(spot + Vector3.new(0, 0.9, 0))
		item.Parent = f
		local bb = Theme.make("BillboardGui", { Size = UDim2.fromOffset(110, 30), StudsOffset = Vector3.new(0, 1.4, 0),
			LightInfluence = 0, MaxDistance = 90, Parent = item })
		Theme.label({ Text = kind[1], FontFace = Theme.Heading, TextXAlignment = Enum.TextXAlignment.Center,
			TextStrokeTransparency = 0.3, Size = UDim2.fromScale(1, 1), MaxText = 20, Parent = bb })
		local prompt = Instance.new("ProximityPrompt")
		prompt.ActionText = "Pick up"
		prompt.ObjectText = kind[1]
		prompt.HoldDuration = 0
		prompt.MaxActivationDistance = 9
		prompt.RequiresLineOfSight = false
		prompt.Parent = item
		prompt.Triggered:Connect(function(p)
			if round ~= my or carrying[p] or not scores[p] then
				return
			end
			prompt:Destroy()
			carrying[p] = item
		end)
	end
	for _ = 1, math.min(4, #spots - 1) do
		spawnIngredient()
	end
	World.Moment:FireAllClients({ type = "countdown", seconds = 3, text = "COOKING RUSH · CARRY FOOD TO THE STOVE" })
	task.spawn(function()
		task.wait(3)
		local endsAt = os.clock() + COOK_SECONDS
		while round == my and os.clock() < endsAt do
			task.wait(0.1)
			for p, item in carrying do
				local hrp = hrpOf(p)
				if not hrp or not p.Parent or not item.Parent then
					carrying[p] = nil
					continue
				end
				item.CFrame = hrp.CFrame * CFrame.new(0, 3.2, 0) -- held overhead
				local d = Vector3.new(hrp.Position.X - stovePos.X, 0, hrp.Position.Z - stovePos.Z).Magnitude
				if d <= 4.5 then
					carrying[p] = nil
					item:Destroy()
					scores[p] = (scores[p] or 0) + 1
					World.Moment:FireAllClients({ type = "toast", text = string.upper(p.DisplayName) .. " COOKED " .. item.Name })
					publish("COOKING RUSH", rows())
					spawnIngredient()
				end
			end
		end
		if round ~= my then
			return
		end
		local best, bestN, total = {}, 0, 0
		for p, n in scores do
			total += n
			if n > bestN then
				best, bestN = { p }, n
			elseif n == bestN and n > 0 then
				table.insert(best, p)
			end
		end
		local names = {}
		for _, p in best do
			table.insert(names, p.DisplayName)
		end
		finish("cooking", if bestN > 0 then string.upper(table.concat(names, " & ")) .. " RUNS THE KITCHEN" else "NOTHING GOT COOKED",
			bestN .. " dishes · " .. total .. " total", best, tostring(bestN), table.concat(names, ", "))
	end)
	return true
end

function WorldGames.start()
	workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
		if current then
			WorldGames.stop()
		end
	end)
end

return WorldGames
