-- Constants plus live values from Experience Configs (Creator Hub -> Configs).
local ConfigServiceOk, ConfigService = pcall(function()
	return game:GetService("ConfigService")
end)

local Config = {
	-- Flip to false once the public BASE is live (or create a boolean config "use_mock").
	USE_MOCK = false,
	-- Ojasva's public link (Update 4). A dejaview_base Experience Config overrides it.
	BASE_FALLBACK = "https://prozac-covered-burke-oklahoma.trycloudflare.com",
	SECRET_NAME = "dejaview_key",

	ROUND_SECONDS = 90,
	LIVES = 3,
	TAG_RADIUS = 4,
	IMMUNITY = 3,
	COUNTDOWN = 3,
	TAG_CHECK_HZ = 10,

	MAX_PARTS = 6000,
	BATCH = 400,

	PRESENCE_PERIOD = 0.25,
	ROOMS_PERIOD = 3,
	PICKER_MAX = 12,

	LOBBY_CENTER = Vector3.new(0, 300, 0),
	WALK_SPEED = 12,
	FALL_Y = -30,

	-- Scene the server builds on boot if it is ready (falls back to the newest ready room).
	DEFAULT_SCENE = "fortnite-tilted-night", -- Update 4: the test world to join until the real four arrive
	-- Auto-join on boot. Set false for the skit (everyone waits in the lobby until JOIN).
	AUTO_JOIN_DEFAULT = true,
	-- Extra Roblox user ids that get host controls (the owner always does).
	HOST_USER_IDS = {} :: { number },

	-- Mock knobs
	MOCK_LATENCY = { 0.05, 0.25 },
	MOCK_FAIL_RATE = 0.05,
	MOCK_NOISE_PARTS = 120, -- random filler blocks in mock rooms (stress rooms still use 6k/12k)
	MOCK_STRESS_ROOMS = true, -- adds 6k and 12k part rooms to the mock list
}

local snapshot: any = nil
local values: { [string]: any } = {}

-- Cache per config version: GetValue warns on every call for a key that is not defined yet,
-- and presence reads use_mock 4 times a second.
local MISSING = newproxy()
local cache: { [string]: any } = {}

local function read(key: string): any
	if values[key] ~= nil then
		return values[key]
	end
	if not snapshot then
		return nil
	end
	local v = cache[key]
	if v == nil then
		local ok, got = pcall(function()
			return snapshot:GetValue(key)
		end)
		v = if ok and got ~= nil then got else MISSING
		cache[key] = v
	end
	return if v == MISSING then nil else v
end

Config.loaded = false

-- Blocks until the live config has loaded (or failed), at most `timeout` seconds.
function Config.waitLoaded(timeout: number)
	local t0 = os.clock()
	while not Config.loaded and os.clock() - t0 < timeout do
		task.wait(0.1)
	end
end

function Config.init()
	if not ConfigServiceOk or not ConfigService then
		warn("[DejaView] ConfigService unavailable, using built-in defaults")
		Config.loaded = true
		return
	end
	local ok, snap = pcall(function()
		return (ConfigService :: any):GetConfigAsync()
	end)
	if not ok or not snap then
		warn("[DejaView] GetConfigAsync failed, using defaults:", snap)
		Config.loaded = true
		return
	end
	snapshot = snap
	pcall(function()
		snap.UpdateAvailable:Connect(function()
			snap:Refresh()
			cache = {}
		end)
	end)
	Config.loaded = true
	print("[DejaView] config: base =", Config.base(), "mock =", Config.useMock(), "round =", Config.roundSeconds())
end

-- Runtime override from the server console: require(...Config).set("dejaview_base", "https://...")
function Config.set(key: string, value: any)
	values[key] = value
end

-- Emergency override that works from the F9 server console (a console `require` gets its own copy of this module,
-- so Config.set from there does not reach the game; workspace attributes are shared):
--   workspace:SetAttribute("DejaViewBase", "https://...")   workspace:SetAttribute("DejaViewMock", false)
function Config.base(): string
	local o = workspace:GetAttribute("DejaViewBase")
	if type(o) == "string" and o ~= "" then
		return (o:gsub("/+$", ""))
	end
	local v = read("dejaview_base")
	if type(v) == "string" and v ~= "" then
		return (v:gsub("/+$", ""))
	end
	return Config.BASE_FALLBACK
end

function Config.useMock(): boolean
	local o = workspace:GetAttribute("DejaViewMock")
	if type(o) == "boolean" then
		return o
	end
	local v = read("use_mock")
	if type(v) == "boolean" then
		return v
	end
	return Config.USE_MOCK
end

function Config.roundSeconds(): number
	local v = read("round_seconds")
	if type(v) == "number" and v > 0 then
		return v
	end
	return Config.ROUND_SECONDS
end

function Config.maxParts(): number
	local v = read("max_parts")
	if type(v) == "number" and v > 0 then
		return math.min(v, 12000)
	end
	return Config.MAX_PARTS
end

return Config
