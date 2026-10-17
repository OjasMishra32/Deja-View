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

local function request(method: string, path: string, body: any?, timeout: number?)
	local opts: { [string]: any } = {
		Url = Config.base() .. path,
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
		return false, tostring(res), 0
	end
	local okJson, data = pcall(HttpService.JSONDecode, HttpService, res.Body)
	if not okJson then
		return false, "not JSON (tunnel down?)", res.StatusCode
	end
	return res.Success, data, res.StatusCode
end

local function enc(id: string): string
	return HttpService:UrlEncode(id)
end

function Api.scenes()
	return request("GET", "/api/scenes")
end

function Api.map(sceneId: string, maxParts: number?)
	local q = if maxParts then "?maxParts=" .. tostring(maxParts) else ""
	return request("GET", "/api/roblox/" .. enc(sceneId) .. "/map" .. q, nil, 20)
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
