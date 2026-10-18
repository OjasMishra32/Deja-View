-- Constants plus live values from Experience Configs (Creator Hub -> Configs).
local ConfigServiceOk, ConfigService = pcall(function()
	return game:GetService("ConfigService")
end)

local Config = {
	-- Flip to false once the public BASE is live (or create a boolean config "use_mock").
	USE_MOCK = false,
	-- Ojasva's public link (Update 4). A dejaview_base Experience Config overrides it.
	BASE_FALLBACK = "https://deja-view.photo",
	SECRET_NAME = "dejaview_key",

	ROUND_SECONDS = 90,
	LIVES = 3,
	TAG_RADIUS = 4,
	IMMUNITY = 3,
	COUNTDOWN = 3,
	TAG_CHECK_HZ = 10,

	-- Unlit textured rooms are applied per player on the client; true switches to the server's global version
	SERVER_UNLIT = false,
	MAX_PARTS = 12000, -- finer blocks (1.1-stud voxels on Tilted Towers vs 1.64 at 6000); max_parts config lowers it
	BATCH = 400,

	PRESENCE_PERIOD = 0.25,
	ROOMS_PERIOD = 3,
	PICKER_MAX = 12,

	LOBBY_CENTER = Vector3.new(0, 300, 0),
	WALK_SPEED = 12,
	FALL_Y = -4, -- root part height; the room floor is at y = 0 and its safety floor 8 studs under it

	-- Scene the server builds on boot if it is ready (falls back to the newest ready room).
	DEFAULT_SCENE = "the-courts",
	-- Rooms shown as a photo sphere: the sky is the whole place seen from the middle, the scanned mesh is hidden, and
	-- the game builds its own solid tables where the real ones stand (the scan is too thin outdoors to stand in).
	SPHERE_ROOMS = {} :: { [string]: boolean },
	-- Rooms drawn with painted Decal panels (ProxyTiles.luau) around the game's tables. None: rooms are blocks.
	PAINTED_ROOMS = {} :: { [string]: boolean },
	-- Rooms are the block maps only: uploaded room meshes are never loaded (Shivin's call; the meshes stay on the
	-- server for later).
	BLOCK_ROOMS = true,
	-- Rooms built by hand from parts instead of their block map, at the scan's real size and in its frame. The games
	-- draw their own real tables in these.
	BUILT_ROOMS = { ["the-courts"] = true } :: { [string]: boolean },
	-- Rooms always listed first on the picker, in this order (Update 8: "the-courts loads first in your picker").
	PINNED_SCENES = { "the-courts" } :: { string },
	-- Auto-join on boot. Set false for the skit (everyone waits in the lobby until JOIN).
	AUTO_JOIN_DEFAULT = true,
	-- Hand-tuned chess boards per scene until /model sends features.chessBoard (Update 5):
	-- ["chess-room"] = { centre = { x, y, z }, yaw = 0, size = 32 }   (studs; yaw = the way white looks)
	CHESS_BOARDS = {} :: { [string]: any },
	-- Hand-tuned ping pong tables until features.pingPongTable (studs; centre = table top centre; yaw: long axis):
	-- ["the-courts"] = { centre = { x, y, z }, yaw = 0, length = 14, width = 8, visible = false }
	PINGPONG_TABLES = {
		-- The real table at the Infinity Hall Game Lawn (features.json: 2.74 x 1.525 m, top 0.76 m, long side 48.6
		-- degrees round from +z), drawn in full: the room is built by hand. Shared with Seb's real-physics ping pong.
		["the-courts"] = { centre = { 1.88, 2.713, -16.885 }, yaw = 0.8484, length = 9.78, width = 5.44, visible = true },
	} :: { [string]: any },
	-- Hand-tuned foosball tables until features.foosballTable (same shape as PINGPONG_TABLES; length 16, width 9)
	-- `auto`: placed as soon as the room loads. `extra`: the measured rod height above the field and rod positions.
	FOOSBALL_TABLES = {
		-- The real table at the Game Lawn (features.json: field 1.185 x 0.703 m at 0.74 m, rods 9 cm above it)
		["the-courts"] = {
			centre = { -0.543, 2.642, -6.861 },
			yaw = -2.9173,
			length = 4.23,
			width = 2.51,
			visible = true,
			auto = true,
			extra = { rodY = 0.33, rodZs = { 1.839, 1.321, 0.793, 0.261, -0.261, -0.796, -1.296, -1.831 } },
		},
	} :: { [string]: any },
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
