-- Fake Déjà View server with the same interface and shapes as Api (team/shivin.md 9.1):
-- fixture scenes, procedural rooms, a fake VR player, latency and failure injection.
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(script.Parent.Config)
local Fixtures = require(ReplicatedStorage.Shared.Fixtures)

local MockServer = {}

local SPM = 3.57
local T0 = time() -- game time: restarts with every play-test
local FINALE_READY_AT = 30
local FINALE_MEASURING = 5
local JUDGE_MOVES_AT = 40

local lastScene: string? = nil

local function elapsed(): number
	return time() - T0
end

local function now(): number
	return DateTime.now().UnixTimestampMillis / 1000
end

-- Returns false when this call should "fail".
local function jitter(): boolean
	local lo, hi = Config.MOCK_LATENCY[1], Config.MOCK_LATENCY[2]
	task.wait(lo + math.random() * (hi - lo))
	return math.random() >= Config.MOCK_FAIL_RATE
end

local function scenes()
	local list = HttpService:JSONDecode(Fixtures.SCENES)
	for _, s in list do
		if s.id == "mock-finale" then
			local t = elapsed()
			if t >= FINALE_READY_AT then
				s.status, s.stage, s.progress = "ready", "Ready", 1
			else
				s.progress = 0.4 + 0.6 * t / FINALE_READY_AT
			end
		end
	end
	if Config.MOCK_STRESS_ROOMS then
		table.insert(list, { id = "mock-stress-6000", name = "Stress 6k", mode = "photo", status = "ready",
			stage = "Ready", progress = 1, createdAt = "2026-10-17T09:00:00Z" })
		table.insert(list, { id = "mock-stress-12000", name = "Stress 12k", mode = "photo", status = "ready",
			stage = "Ready", progress = 1, createdAt = "2026-10-17T08:00:00Z" })
	end
	-- newest first
	table.sort(list, function(a, b)
		return a.createdAt > b.createdAt
	end)
	return list
end

local function nameOf(id: string): string
	for _, s in scenes() do
		if s.id == id then
			return s.name
		end
	end
	return id
end

-- A floor, 4 walls with a window gap, a couch, a table, a TV and voxel noise up to `count` parts.
local function proceduralMap(id: string, count: number)
	local seed = 0
	for i = 1, #id do
		seed = (seed * 31 + id:byte(i)) % 2147483647
	end
	local rng = Random.new(seed)
	local W, D, H = 30, 26, 10.5
	local wall = { 214, 208, 196 }
	local tint = { rng:NextInteger(60, 200), rng:NextInteger(60, 200), rng:NextInteger(60, 200) }
	local parts = {
		{ 0, -0.5, 0, W, 1, D, 120, 104, 90 },
		{ 0, H / 2, -D / 2 - 0.5, W, H, 1, wall[1], wall[2], wall[3] },
		{ 0, H / 2, D / 2 + 0.5, W, H, 1, wall[1], wall[2], wall[3] },
		{ -W / 2 - 0.5, H / 2, 0, 1, H, D, 205, 199, 188 },
		-- right wall with a window gap
		{ W / 2 + 0.5, 1.75, 0, 1, 3.5, D, 205, 199, 188 },
		{ W / 2 + 0.5, H - 1.25, 0, 1, 2.5, D, 205, 199, 188 },
		{ W / 2 + 0.5, 5.25, -D / 2 + 3, 1, 4, 6, 205, 199, 188 },
		{ W / 2 + 0.5, 5.25, D / 2 - 3, 1, 4, 6, 205, 199, 188 },
		{ W / 2 + 0.5, 5.25, 0, 0.2, 4, D - 12, 170, 210, 255, 1 },
		-- couch
		{ -6, 1, -8, 10, 2, 4, tint[1], tint[2], tint[3] },
		{ -6, 2.6, -9.6, 10, 2.4, 1, tint[1], tint[2], tint[3] },
		-- table
		{ -6, 1.6, -2, 6, 0.4, 3, 150, 110, 70 },
		{ -6, 0.7, -2, 0.6, 1.4, 0.6, 90, 70, 50 },
		-- TV
		{ -6, 5, 12.4, 9, 5, 0.4, 20, 20, 24 },
		{ -6, 1.2, 12, 7, 2.4, 1.5, 60, 50, 45 },
	}
	while #parts < count do
		local sx, sy, sz = rng:NextNumber(0.4, 1.6), rng:NextNumber(0.4, 1.6), rng:NextNumber(0.4, 1.6)
		local onWall = rng:NextNumber() < 0.5
		local x, y, z
		if onWall then
			local side = rng:NextInteger(1, 2)
			x = rng:NextNumber(-W / 2, W / 2)
			z = if side == 1 then -D / 2 + sz / 2 else D / 2 - sz / 2
			y = rng:NextNumber(0, H)
		else
			x, z = rng:NextNumber(-W / 2, W / 2), rng:NextNumber(-D / 2, D / 2)
			y = sy / 2
		end
		local g = rng:NextInteger(90, 230)
		table.insert(parts, { x, y, z, sx, sy, sz, g, math.floor(g * 0.92), math.floor(g * 0.85),
			if rng:NextNumber() < 0.3 then 1 else 0 })
	end
	table.sort(parts, function(a, b)
		return a[2] - a[5] / 2 < b[2] - b[5] / 2
	end)
	return {
		sceneId = id,
		name = nameOf(id),
		studsPerMeter = SPM,
		spawn = { 0, 0, 6 },
		ceilingY = H,
		parts = parts,
	}
end

function MockServer.mockVr(t: number)
	local a = t * 0.6
	local x, z = math.cos(a) * 6, math.sin(a * 0.8) * 4.5
	local dx, dz = -math.sin(a) * 6, math.cos(a * 0.8) * 3.6
	local yaw = math.atan2(-dx, -dz)
	local side = Vector3.new(math.cos(yaw), 0, -math.sin(yaw)) * 1.4
	return {
		id = "quest-1", name = "Judge", kind = "vr", x = x, y = 0, z = z, yaw = yaw,
		head = { x, 5.7 + math.sin(t * 3) * 0.15, z },
		hands = { { x - side.X, 4.3 + math.sin(t * 5), z - side.Z }, { x + side.X, 4.3, z + side.Z } },
	}
end

local function judgeScene(): string?
	if elapsed() >= JUDGE_MOVES_AT then
		return "mock-finale"
	end
	return lastScene
end

function MockServer.scenes()
	if not jitter() then
		return false, "mock failure", 0
	end
	return true, scenes(), 200
end

function MockServer.map(sceneId: string, maxParts: number?)
	if not jitter() then
		return false, "mock failure", 0
	end
	if sceneId == "fixture-room" then
		return true, HttpService:JSONDecode(Fixtures.MAP_SMALL), 200
	end
	if sceneId == "mock-broken" then
		return false, { error = "Scene is not ready", status = "failed" }, 409
	end
	if sceneId == "mock-finale" then
		local t = elapsed()
		if t < FINALE_READY_AT then
			return false, { error = "Scene is not ready", status = "running" }, 409
		elseif t < FINALE_READY_AT + FINALE_MEASURING then
			return true, { status = "building", retryAfter = 2 }, 202
		end
	end
	local count = Config.MOCK_NOISE_PARTS
	local stress = tonumber(sceneId:match("^mock%-stress%-(%d+)$"))
	if stress then
		count = stress
	end
	count = math.min(count, maxParts or 12000)
	return true, proceduralMap(sceneId, count), 200
end

function MockServer.presence(sceneId: string, body: any)
	lastScene = lastScene or sceneId
	if elapsed() < JUDGE_MOVES_AT then
		lastScene = sceneId
	end
	if not jitter() then
		return false, "mock failure", 0
	end
	local others = {}
	local js = judgeScene()
	if js == sceneId then
		table.insert(others, MockServer.mockVr(os.clock()))
		local a = os.clock() * 0.3
		table.insert(others, { id = "web-7f3a19c2", name = "Maya", kind = "web",
			x = -3.57 + math.cos(a) * 2, y = 0, z = 2.86 + math.sin(a) * 2, yaw = -a })
	end
	return true, {
		t = now(),
		others = others,
		active = if js then { sceneId = js, name = nameOf(js) } else nil,
	}, 200
end

function MockServer.event(sceneId: string, body: any)
	if not jitter() then
		return false, "mock failure", 0
	end
	print("[MockServer] event", sceneId, HttpService:JSONEncode(body))
	return true, { ok = true }, 200
end

function MockServer.people(sceneId: string)
	if not jitter() then
		return false, "mock failure", 0
	end
	local people = {}
	if judgeScene() == sceneId then
		local v = MockServer.mockVr(os.clock())
		table.insert(people, { id = v.id, name = v.name, kind = "vr", x = v.x / SPM, y = 0, z = v.z / SPM,
			yaw = v.yaw, age = 0.1 })
	end
	return true, { t = now(), people = people }, 200
end

return MockServer
