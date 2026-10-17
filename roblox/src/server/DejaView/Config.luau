-- Constants plus live values from Experience Configs (Creator Hub -> Configs).
local ConfigServiceOk, ConfigService = pcall(function()
	return game:GetService("ConfigService")
end)

local Config = {
	-- Flip to false once the public BASE is live (or create a boolean config "use_mock").
	USE_MOCK = true,
	BASE_FALLBACK = "http://localhost:8788",
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
	DEFAULT_SCENE = "",
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

local function read(key: string): any
	if values[key] ~= nil then
		return values[key]
	end
	if snapshot then
		local ok, v = pcall(function()
			return snapshot:GetValue(key)
		end)
		if ok then
			return v
		end
	end
	return nil
end

function Config.init()
	if not ConfigServiceOk or not ConfigService then
		warn("[DejaView] ConfigService unavailable, using built-in defaults")
		return
	end
	local ok, snap = pcall(function()
		return (ConfigService :: any):GetConfigAsync()
	end)
	if not ok or not snap then
		warn("[DejaView] GetConfigAsync failed, using defaults:", snap)
		return
	end
	snapshot = snap
	pcall(function()
		snap.UpdateAvailable:Connect(function()
			snap:Refresh()
		end)
	end)
	print("[DejaView] config: base =", Config.base(), "mock =", Config.useMock(), "round =", Config.roundSeconds())
end

-- Runtime override from the server console: require(...Config).set("dejaview_base", "https://...")
function Config.set(key: string, value: any)
	values[key] = value
end

function Config.base(): string
	local v = read("dejaview_base")
	if type(v) == "string" and v ~= "" then
		return (v:gsub("/+$", ""))
	end
	return Config.BASE_FALLBACK
end

function Config.useMock(): boolean
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
