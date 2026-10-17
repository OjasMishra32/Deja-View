-- The ONLY code that touches HttpService. Same interface as MockServer.
-- Every call returns ok, decodedBodyOrError, statusCode.
local HttpService = game:GetService("HttpService")
local Config = require(script.Parent.Config)

local Api = {}

local secret: any = nil
local secretTried = false
local timeoutSupported = true

local function getSecret()
	if not secretTried then
		secretTried = true
		local ok, s = pcall(function()
			return HttpService:GetSecret(Config.SECRET_NAME)
		end)
		if ok then
			secret = s
		else
			warn("[DejaView] secret '" .. Config.SECRET_NAME .. "' unavailable, sending without key:", s)
		end
	end
	return secret
end

local function headers(isPost: boolean)
	local h: { [string]: any } = {}
	if isPost then
		h["content-type"] = "application/json"
	end
	local s = getSecret()
	if s then
		h["x-dejaview-key"] = s
	end
	return h
end

-- Failover between the configured address (Experience Config) and the one built into the code: a stale
-- dejaview_base or a tunnel that died must never strand the game. Only "nobody answered" counts (DNS, refused,
-- timeout, Cloudflare 530 for a gone tunnel); an app error like a 502 from one route does not.
local useFallback = false
local deadStreak = 0
local DEAD_LIMIT = 3

local function currentBase(): string
	local configured = Config.base()
	if workspace:GetAttribute("DejaViewBase") then
		return configured -- an explicit console override always wins
	end
	local fallback = (Config.BASE_FALLBACK:gsub("/+$", ""))
	return if useFallback and fallback ~= configured then fallback else configured
end

local function noteResult(answered: boolean)
	if answered then
		deadStreak = 0
		return
	end
	deadStreak += 1
	if deadStreak >= DEAD_LIMIT then
		deadStreak = 0
		local configured = Config.base()
		local fallback = (Config.BASE_FALLBACK:gsub("/+$", ""))
		if configured ~= fallback and not workspace:GetAttribute("DejaViewBase") then
			useFallback = not useFallback
			warn("[DejaView] no answer from the server; switching to " .. currentBase())
		end
	end
end

local function request(method: string, path: string, body: any?, timeout: number?)
	local opts: { [string]: any } = {
		Url = currentBase() .. path,
		Method = method,
		Headers = headers(body ~= nil),
		Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
	}
	if timeoutSupported then
		opts.Timeout = timeout or 5
	end
	local ok, res = pcall(HttpService.RequestAsync, HttpService, opts)
	if not ok and timeoutSupported and tostring(res):find("Timeout") then
		timeoutSupported = false
		opts.Timeout = nil
		ok, res = pcall(HttpService.RequestAsync, HttpService, opts)
	end
	if not ok then
		noteResult(false)
		return false, tostring(res), 0
	end
	noteResult(res.StatusCode ~= 530)
	local okJson, data = pcall(HttpService.JSONDecode, HttpService, res.Body)
	if not okJson then
		return false, "not JSON (tunnel down?)", res.StatusCode
	end
	return res.Success, data, res.StatusCode
end

-- Scene ids are like "game-night-k3x9a": keep unreserved characters as they are
-- (HttpService:UrlEncode turns "-" into "%2D", which some servers do not decode in paths).
local function enc(id: string): string
	return (id:gsub("[^%w%-%._~]", function(c)
		return string.format("%%%02X", string.byte(c))
	end))
end

function Api.scenes()
	return request("GET", "/api/scenes")
end

function Api.map(sceneId: string, maxParts: number?)
	local q = if maxParts then "?maxParts=" .. tostring(maxParts) else ""
	return request("GET", "/api/roblox/" .. enc(sceneId) .. "/map" .. q, nil, 20)
end

-- Textured room model details (contract 6.2b): units, chunks, spawn, and assetId once uploaded.
function Api.model(sceneId: string)
	return request("GET", "/api/roblox/" .. enc(sceneId) .. "/model")
end

-- Gemini labels (Update 4): {hotspots:[{label, blurb, x, y, z}]} in room metres.
function Api.hotspots(sceneId: string)
	return request("GET", "/api/scenes/" .. enc(sceneId) .. "/hotspots")
end

-- Notes (Update 4): {notes:[{id, author, text, x, y, z}]} in metres; POST {author, text, x, y, z}.
function Api.notes(sceneId: string)
	return request("GET", "/api/notes/" .. enc(sceneId))
end

function Api.addNote(sceneId: string, body: any)
	return request("POST", "/api/notes/" .. enc(sceneId), body)
end

function Api.presence(sceneId: string, body: any)
	return request("POST", "/api/roblox/" .. enc(sceneId) .. "/presence", body)
end

function Api.event(sceneId: string, body: any)
	return request("POST", "/api/roblox/" .. enc(sceneId) .. "/event", body)
end

-- Metres; use only the count and kind (Follow).
function Api.people(sceneId: string)
	return request("GET", "/api/presence/" .. enc(sceneId))
end

return Api
